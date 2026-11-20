"""
Randomised sequence fuzz of the exact-integer model (model.py).

Each path: one crypto market + one event market sharing a vault; random traders open
YES/NO/long/short positions (free and boosted, 1x .. max leverage), prices move on the
1-cent grid (with jumps), the event may resolve (also early), a keeper sweeps with random
lateness, LPs deposit / withdraw, a JIT depositor sandwiches the sweep.

After EVERY operation the solvency / ledger invariants are checked; every close is checked
against the written rules. Nothing asserts: violations are counted and a few examples kept.

usage: python3 fuzz.py <paths> <steps> <variant> [procs]
  variant: code | task   (see model.py header)
"""
import sys
import random
import time
from multiprocessing import Pool

from model import (Oracle, Vault, Engine, Config, Revert, WAD, BPS, UNIT, HOUR, DAY,
                   CLOSE, LIQUIDATION, FORCECLOSE, SETTLEMENT, COLLECT, KIND_NAMES)

BTC, EVT = 1, 101
USD = 10**6
TICK = 10**16

VARIANTS = {
    "code": dict(free_cap_ceiling=True, crowd_rate="code", liq_fee_from_vault=False),
    "task": dict(free_cap_ceiling=False, crowd_rate="task", liq_fee_from_vault=True),
}


def new_stats():
    return dict(
        paths=0, ops=0, closes=[0] * 5, opens=0, open_reverts={}, lp_ops=0,
        viol={}, examples=[],
        # NAV marking
        nav_obs=0, mis_gt1=0, mis_pos=0, mis_neg=0, sum_abs_rel=0.0, max_under_rel=0.0, max_over_rel=0.0,
        max_under_usd=0, max_over_usd=0, nav_zero_states=0,
        fee_gap_sum_rel=0.0,
        # JIT sandwich
        sand_n=0, sand_pos=0, sand_gain_sum=0.0, sand_gain_sq=0.0, sand_rel_sum=0.0, sand_rel_sq=0.0,
        sand_max_rel=0.0, sand_dnav_sum=0.0,
        # payout facts
        max_out_over_lock=0.0, settle_checked=0, liq_zero_fee=0, liq_n=0,
        resolved_paths=0,
    )


def bump(d, k, n=1):
    d[k] = d.get(k, 0) + n


def violation(st, name, detail):
    bump(st["viol"], name)
    if len(st["examples"]) < 12:
        st["examples"].append((name, detail))


def check_close(st, eng, rec, variant):
    """Rules every close must satisfy (R4, R5, R7, E2, E4, E5)."""
    M, R = rec["margin"], rec["reserve"]
    out = rec["payout"] + rec["stakerFee"] + rec["liqFee"]
    st["closes"][rec["kind"]] += 1
    rel = out / (M + R) if M + R else 0.0
    if rel > st["max_out_over_lock"]:
        st["max_out_over_lock"] = rel
    if out > M + R:
        violation(st, "C1 paid more than margin+reserve", rec)
    if rec["result"] > R or rec["result"] < -M:
        violation(st, "C2 result outside [-M, +reserve]", rec)
    if rec["result"] > 0:
        if rec["crowding"] > rec["result"] or rec["fee"] > rec["result"] - rec["crowding"]:
            violation(st, "C3 fees exceed profit", rec)
        if rec["kind"] != LIQUIDATION and rec["payout"] < M:
            violation(st, "C3b winner paid less than its margin", rec)
        if rec["payout"] + rec["liqFee"] != M + rec["result"] - rec["crowding"] - rec["fee"]:
            violation(st, "C3c winner payout identity", rec)
    else:
        if rec["fee"] != 0 or rec["crowding"] != 0:
            violation(st, "C4 fee taken from a loser", rec)
        if variant == "code" and rec["payout"] + rec["liqFee"] != M + rec["result"]:
            violation(st, "C4b loser payout identity", rec)
    if not rec["boosted"]:
        # free mode / non-event: result is exactly the clamped price P&L, nothing else
        pnl = eng._pnl(rec["isEvent"], rec["isLong"], rec["notional"], rec["entry"], rec["exit"])
        if rec["result"] != max(-M, min(R, pnl)):
            violation(st, "C5 free result != clamp(pnl,-M,C)", rec)
    if rec["kind"] == SETTLEMENT and rec["isEvent"] and rec["exit"] in (0, WAD):
        st["settle_checked"] += 1
        won = (rec["exit"] == WAD) == rec["isLong"]
        e = rec["entry"]
        outright = (M * (WAD - e)) // e if rec["isLong"] else (M * e) // (WAD - e)
        if not rec["boosted"]:
            cap = outright if variant == "task" else min(outright, 10 * M)
            if won and rec["result"] != cap:
                violation(st, "C6 free winner at resolution not paid the outright cap", rec)
            if (not won) and rec["result"] != -M:
                violation(st, "C6b free loser at resolution did not lose exactly M", rec)
            if R != cap:
                violation(st, "C6c reserve != outright cap", rec)
    if rec["kind"] == LIQUIDATION:
        st["liq_n"] += 1
        if rec["liqFee"] == 0:
            st["liq_zero_fee"] += 1
        if rec["liqFee"] > (M * 500) // BPS:
            violation(st, "C7 liquidator paid more than 5% of M", rec)
        if rec["payout"] > (M * 2000) // BPS:
            violation(st, "C7b liquidated trader got back more than 20% of M", rec)
        if out > M:
            violation(st, "C7c liquidation paid out more than M", rec)
    if rec["kind"] == COLLECT and not rec["boosted"]:
        if rec["result"] != R:
            violation(st, "C8 collect did not pay the cap", rec)


def check_state(st, eng, vault, now, variant):
    """Ledger and solvency invariants, and how the LP mark compares with the clamped liability."""
    m = r = 0
    agg = {}
    side = {}
    owed_fair = 0
    net_out = 0
    for pid, p in eng.positions.items():
        m += p.margin
        r += p.reserve
        a = agg.setdefault(p.marketId, [0] * 6)
        isEv = eng.markets[p.marketId].isEvent
        u = eng._units(isEv, p.isLong, p.notional, p.entryPrice)
        k = 0 if p.isLong else 1
        a[k] += p.notional
        a[2 + k] += u
        a[4 + k] += p.borrowedUnits
        b = side.setdefault(p.marketId, [0] * 4)
        b[k] += p.margin
        b[2 + k] += p.reserve
        v = eng.view(pid, now)
        res = v["equityAtMid"] - p.margin
        owed_fair += res
        # what closing at the mid now would actually pay out (fees stay in the vault)
        if res > 0:
            c = v["c"]
            crowd = min(v["crowding"], res)
            fee = ((res - crowd) * c.profitFeeBps) // BPS
            net_out += res - crowd - fee + (fee * eng.stakerShareBps) // BPS
        else:
            net_out += res
    if vault.marginHeld != m:
        violation(st, "S1 marginHeld != sum of margins", (vault.marginHeld, m))
    if vault.reserved != r:
        violation(st, "S2 reserved != sum of reserves", (vault.reserved, r))
    if vault.cash < m + r:
        violation(st, "S3 cash < marginHeld + reserved", (vault.cash, m, r))
    for mid_, s in eng.states.items():
        a = agg.get(mid_, [0] * 6)
        if [s.longOI, s.shortOI, s.longUnits, s.shortUnits, s.longBorrowed, s.shortBorrowed] != a:
            violation(st, "S4 market totals != sum over positions", (mid_, a))
    try:
        marked = vault.totalAssets()
    except Revert as e:
        violation(st, "S5 totalAssets reverted", str(e))
        return
    fair = vault.cash - vault.marginHeld - owed_fair
    if fair < 0:
        violation(st, "S6 fair LP value negative", fair)
    st["nav_obs"] += 1
    d = fair - marked  # > 0: the vault's mark understates LP value; < 0: overstates
    if abs(d) > USD:
        st["mis_gt1"] += 1
        if d > 0:
            st["mis_pos"] += 1
        else:
            st["mis_neg"] += 1
    if fair > 0:
        rel = d / fair
        st["sum_abs_rel"] += abs(rel)
        if rel > st["max_under_rel"]:
            st["max_under_rel"] = rel
        if -rel > st["max_over_rel"]:
            st["max_over_rel"] = -rel
        st["fee_gap_sum_rel"] += (vault.cash - vault.marginHeld - net_out - fair) / fair
    if d > st["max_under_usd"]:
        st["max_under_usd"] = d
    if -d > st["max_over_usd"]:
        st["max_over_usd"] = -d
    if marked == 0 and vault.totalSupply > 0:
        st["nav_zero_states"] += 1

    # ---- candidate fix: clamp per market side with that side's own margin and reserve, and mark a
    # resolved market exactly (winners are owed their reserve, losers their margin). Evaluated at the
    # mid and at the slow price; deposits priced at the higher NAV of the two, withdrawals at the lower.
    def side_mark(use_slow):
        owed = 0
        for mk in eng.marketIds:
            sstate = eng.states[mk]
            fd = eng.oracle.read(mk, now)
            isEv = eng.markets[mk].isEvent
            mg = side.get(mk, [0] * 4)
            if fd.resolved and fd.mid in (0, WAD):
                yes = fd.mid == WAD
                owed += (mg[2] - mg[1]) if yes else (mg[3] - mg[0])
                continue
            px = fd.slow if use_slow else fd.mid
            if isEv and px > WAD:
                px = WAD
            linL = (sstate.longUnits * px) // UNIT - sstate.longOI
            if isEv:
                linS = (sstate.shortUnits * (WAD - px)) // UNIT - sstate.shortOI
            else:
                linS = sstate.shortOI - (sstate.shortUnits * px) // UNIT
            owed += max(-mg[0], min(mg[2], linL)) + max(-mg[1], min(mg[3], linS))
        return vault.cash - vault.marginHeld - owed
    nb_mid = side_mark(False)
    nb_slow = side_mark(True)
    dB = fair - nb_mid
    if abs(dB) > USD:
        st["B_gt1"] = st.get("B_gt1", 0) + 1
    if fair > 0:
        st["B_sum_abs_rel"] = st.get("B_sum_abs_rel", 0.0) + abs(dB) / fair
        st["max_B_under_rel"] = max(st.get("max_B_under_rel", 0.0), dB / fair)
        st["max_B_over_rel"] = max(st.get("max_B_over_rel", 0.0), -dB / fair)
    # what is left for a depositor (buys at the higher mark) and for a leaver (sells at the lower mark)
    dep_edge = fair - max(nb_mid, nb_slow)
    wd_edge = min(nb_mid, nb_slow) - fair
    if dep_edge > USD:
        st["C_dep_gt1"] = st.get("C_dep_gt1", 0) + 1
    if wd_edge > USD:
        st["C_wd_gt1"] = st.get("C_wd_gt1", 0) + 1
    if fair > 0:
        st["C_dep_sum_rel"] = st.get("C_dep_sum_rel", 0.0) + max(0, dep_edge) / fair
        st["C_wd_sum_rel"] = st.get("C_wd_sum_rel", 0.0) + max(0, wd_edge) / fair
        st["A_dep_sum_rel"] = st.get("A_dep_sum_rel", 0.0) + max(0, d) / fair
        st["A_wd_sum_rel"] = st.get("A_wd_sum_rel", 0.0) + max(0, -d) / fair
        st["max_C_dep_rel"] = max(st.get("max_C_dep_rel", 0.0), dep_edge / fair)
        st["max_C_wd_rel"] = max(st.get("max_C_wd_rel", 0.0), wd_edge / fair)


def run_path(seed, steps, variant):
    rng = random.Random(seed)
    st = new_stats()
    st["paths"] = 1
    oracle, vault = Oracle(), Vault()
    eng = Engine(oracle, vault, staked=rng.random() < 0.8, **VARIANTS[variant])
    now = 1_800_000_000
    vault.now = now
    oracle.tau[BTC] = 60
    oracle.tau[EVT] = 300
    horizon = rng.choice([2 * HOUR, 6 * HOUR, DAY, 5 * DAY, 30 * DAY, 300 * DAY])
    expiry = now + horizon
    eng.setMarket(BTC, Config(), now)
    eng.setMarket(EVT, Config(isEvent=True, boostEnabled=rng.random() < 0.7, maxLeverage=50, profitFeeBps=1000,
                              maxGapBps=500, reactionSeconds=120, expiry=expiry,
                              maxPositionNotional=100_000 * USD, crowdingPerDay=0, hazardScale=WAD), now)
    vault.deposit("lp0", rng.choice([50_000, 500_000, 5_000_000]) * USD)
    btc = 60_000 * WAD
    half_ticks = rng.random() < 0.2
    grid = 200 if half_ticks else 100
    tick = rng.randint(3, 97) * (grid // 100)
    btc_depth = 20_000_000 * USD
    evt_depth = rng.choice([5_000, 50_000, 2_000_000]) * USD
    resolved = False
    ts = now

    def push_prices(jumpy=True):
        nonlocal btc, tick, ts, resolved
        ts = now
        # crypto: small noise, occasional gap
        if rng.random() < 0.05:
            bps = rng.choice([-1, 1]) * rng.randint(30, 400)
        else:
            bps = rng.randint(-6, 6)
        btc = max(WAD, btc * (10_000 + bps) // 10_000)
        oracle.push(BTC, btc, btc_depth, ts, False, now)
        if resolved:
            return
        u = rng.random()
        if u < 0.03 or (now >= expiry + 2 * HOUR and u < 0.5):
            # resolution (possibly early, possibly a jump from mid-range)
            final = WAD if rng.random() < tick / grid else 0
            oracle.push(EVT, final, 0, ts, True, now)
            resolved = True
            st["resolved_paths"] = 1
            return
        if u < 0.06:
            tick = rng.randint(1, grid - 1)  # news jump to anywhere
        else:
            step = rng.choice([0, 1, 1, 1, 1, 2, 2, 3, 5]) * rng.choice([-1, 1])
            tick = min(grid - 1, max(1, tick + step))
        u2 = rng.random()
        depth = evt_depth if u2 < 0.9 else (evt_depth * 10 if u2 < 0.95 else evt_depth // 3)
        oracle.push(EVT, tick * WAD // grid, depth, ts, False, now)

    push_prices()
    traders = ["a", "b", "c", "d"]

    def drain():
        for rec in eng.closed_log:
            check_close(st, eng, rec, variant)
        eng.closed_log.clear()

    def sweep(only_gains=False, lateness=1.0):
        """The keeper: liquidate / collect / force-close / settle whatever is due."""
        for pid in list(eng.positions.keys()):
            if rng.random() > lateness:
                continue
            v = eng.view(pid, now)
            try:
                if v["f"].resolved:
                    if only_gains and v["equityAtMid"] - v["p"].margin <= 0:
                        continue
                    eng.close("keeper", pid, now)
                elif not v["fresh"]:
                    continue
                elif v["liquidatable"]:
                    if only_gains:
                        continue
                    eng.liquidate(pid, now)
                elif only_gains and v["equityAtMid"] - v["p"].margin <= 0:
                    continue
                elif v["collectable"]:
                    eng.collect(pid, now)
                elif v["forceClosable"]:
                    eng.forceClose(pid, now)
            except Revert as e:
                violation(st, "K keeper call reverted: " + str(e), pid)

    for _ in range(steps):
        st["ops"] += 1
        op = rng.random()
        try:
            if op < 0.30:
                now += rng.choice([1, 1, 4, 4, 12, 60, 600, 3600, 6 * HOUR])
                vault.now = now
                push_prices()
            elif op < 0.62:
                mkt = EVT if rng.random() < 0.7 else BTC
                c = eng.markets[mkt]
                f = oracle.read(mkt, now)
                isLong = rng.random() < 0.5
                margin = rng.choice([1, 10, 100, 1000, 5000]) * USD + rng.randint(0, 999_999)
                maxlev = eng._maxLeverage(c, f, now) if not f.resolved and f.timestamp else 1
                maxlev = max(1, maxlev)
                r = rng.random()
                lev = 1 if r < 0.15 else (maxlev if r < 0.55 else rng.randint(1, maxlev))
                boost = c.isEvent and c.boostEnabled and rng.random() < 0.35
                try:
                    eng.open(rng.choice(traders), mkt, isLong, margin, lev, boost, now)
                    st["opens"] += 1
                except Revert as e:
                    bump(st["open_reverts"], str(e))
            elif op < 0.72:
                if eng.positions:
                    pid = rng.choice(list(eng.positions.keys()))
                    p = eng.positions[pid]
                    try:
                        eng.close(p.owner, pid, now)
                    except Revert as e:
                        if str(e) != "StalePrice":
                            violation(st, "owner close reverted: " + str(e), pid)
            elif op < 0.84:
                sweep(lateness=rng.choice([1.0, 1.0, 0.5]))
            elif op < 0.90:
                who = rng.choice(["lp0", "lp1"])
                vault.deposit(who, rng.choice([1, 1000, 100_000]) * USD + rng.randint(0, 999_999))
                st["lp_ops"] += 1
            elif op < 0.95:
                who = rng.choice(["lp0", "lp1"])
                mx = vault.maxRedeem(who)
                if mx > 0:
                    before = vault.cash
                    free = vault.freeLiquidity()
                    got = vault.redeem(who, rng.randint(1, mx))
                    if got > free:
                        violation(st, "S7 LP withdrew locked funds", (got, free))
                    st["lp_ops"] += 1
            elif op < 0.97:
                eng.poke(rng.choice([BTC, EVT]), now)
            else:
                # JIT depositor: deposit an amount equal to the pool, run only the NAV-raising upkeep
                # (collect / settle winners / force-close), redeem. Same block, no price change.
                nav0 = vault.totalAssets()
                x = max(nav0, USD)
                sh = vault.deposit("jit", x)
                sweep(only_gains=True)
                drain()
                nav1 = vault.totalAssets()
                mx = vault.maxRedeem("jit")
                got = vault.redeem("jit", mx) if mx > 0 else 0
                left = vault._toAssets(vault.balance.get("jit", 0))
                gain = got + left - x
                st["sand_n"] += 1
                g = gain / USD
                st["sand_gain_sum"] += g
                st["sand_gain_sq"] += g * g
                rel = gain / x
                st["sand_rel_sum"] += rel
                st["sand_rel_sq"] += rel * rel
                st["sand_dnav_sum"] += (nav1 - nav0 - x) / USD
                if gain > USD // 100:
                    st["sand_pos"] += 1
                if rel > st["sand_max_rel"]:
                    st["sand_max_rel"] = rel
                # leftover shares (if redemption was limited by free liquidity) stay with "jit"
        except Revert as e:
            violation(st, "unexpected revert: " + str(e), op)
        drain()
        check_state(st, eng, vault, now, variant)

    # wind down: resolve if not yet, settle everything, all LPs leave
    now += 60
    vault.now = now
    if not resolved:
        oracle.push(EVT, WAD if rng.random() < tick / grid else 0, 0, now, True, now)
    oracle.push(BTC, btc, btc_depth, now, False, now)
    for pid in list(eng.positions.keys()):
        p = eng.positions[pid]
        try:
            eng.close(p.owner, pid, now)
        except Revert as e:
            violation(st, "final close reverted: " + str(e), pid)
    drain()
    check_state(st, eng, vault, now, variant)
    if vault.marginHeld != 0 or vault.reserved != 0:
        violation(st, "F1 locked balances not zero after all positions closed", (vault.marginHeld, vault.reserved))
    for who in ["lp0", "lp1", "jit"]:
        b = vault.balance.get(who, 0)
        if b:
            mx = vault.maxRedeem(who)
            if mx < b:
                # redeem(balanceOf) would revert: the caller has to ask for maxRedeem instead
                st["full_redeem_reverts"] = st.get("full_redeem_reverts", 0) + 1
            try:
                if mx:
                    vault.redeem(who, mx)
            except Revert as e:
                violation(st, "F2 LP could not exit an empty book: " + str(e), who)
            left = vault._toAssets(vault.balance.get(who, 0))
            if left > 1:
                violation(st, "F3 LP left with more than dust after exiting an empty book", (who, left))
    if vault.cash > 3:
        violation(st, "F4 cash stranded in an empty vault (micro-USDC)", vault.cash)
    return st


def merge(a, b):
    for k, v in b.items():
        if k in ("viol", "open_reverts"):
            for kk, vv in v.items():
                bump(a[k], kk, vv)
        elif k == "examples":
            a[k] = (a[k] + v)[:12]
        elif k == "closes":
            a[k] = [x + y for x, y in zip(a[k], v)]
        elif k.startswith("max_") or k == "sand_max_rel":
            a[k] = max(a.get(k, 0), v)
        else:
            a[k] = a.get(k, 0) + v
    return a


def worker(args):
    lo, hi, steps, variant = args
    st = new_stats()
    for seed in range(lo, hi):
        merge(st, run_path(seed, steps, variant))
    return st


if __name__ == "__main__":
    paths = int(sys.argv[1])
    steps = int(sys.argv[2])
    variant = sys.argv[3]
    procs = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    t0 = time.time()
    chunk = max(1, paths // (procs * 8))
    jobs = [(lo, min(paths, lo + chunk), steps, variant) for lo in range(0, paths, chunk)]
    total = new_stats()
    with Pool(procs) as pool:
        for st in pool.imap_unordered(worker, jobs):
            merge(total, st)
    el = time.time() - t0
    n = total["nav_obs"]
    print(f"variant={variant} paths={total['paths']} steps/path={steps} ops={total['ops']} time={el:.0f}s")
    print(f"opens={total['opens']} closes by kind={dict(zip(KIND_NAMES, total['closes']))} lp_ops={total['lp_ops']}")
    print(f"paths with a resolution inside the run={total['resolved_paths']}")
    print(f"open reverts={total['open_reverts']}")
    print(f"VIOLATIONS={total['viol']}")
    for ex in total["examples"][:8]:
        print("  example:", ex[0], str(ex[1])[:400])
    print(f"max (paid out)/(margin+reserve) over all closes = {total['max_out_over_lock']:.6f}")
    print(f"event settlements checked against the outright payoff = {total['settle_checked']}")
    print(f"liquidations={total['liq_n']}, with zero liquidator fee={total['liq_zero_fee']}")
    print("-- LP mark (vault.totalAssets) vs clamped liability, observed after every op --")
    print(f"states={n}  |mis-mark|>$1 in {total['mis_gt1']} ({100*total['mis_gt1']/n:.2f}%)  "
          f"understated in {total['mis_pos']}  overstated in {total['mis_neg']}")
    print(f"mean |mis-mark|/fair NAV = {100*total['sum_abs_rel']/n:.4f}%   "
          f"max understatement = {100*total['max_under_rel']:.2f}% (${total['max_under_usd']/USD:,.0f})   "
          f"max overstatement = {100*total['max_over_rel']:.2f}% (${total['max_over_usd']/USD:,.0f})")
    print(f"states where totalAssets()==0 with shares outstanding = {total['nav_zero_states']}")
    g = lambda k: total.get(k, 0)
    print("-- candidate marks on the same states --")
    print(f"A (contract, one global clamp):   |mis-mark|>$1 in {100*total['mis_gt1']/n:.2f}% of states; mean depositor edge {100*g('A_dep_sum_rel')/n:.4f}% of NAV, mean leaver edge {100*g('A_wd_sum_rel')/n:.4f}%; max under {100*total['max_under_rel']:.1f}%, max over {100*total['max_over_rel']:.1f}%")
    print(f"B (per-side clamp + exact mark of resolved markets, at the mid): |mis-mark|>$1 in {100*g('B_gt1')/n:.2f}% of states; mean |mis-mark| {100*g('B_sum_abs_rel')/n:.4f}% of NAV; max under {100*g('max_B_under_rel'):.1f}%, max over {100*g('max_B_over_rel'):.1f}%")
    print(f"C (B, deposits at max(NAV mid, NAV slow), withdrawals at min): depositor edge >$1 in {100*g('C_dep_gt1')/n:.2f}% of states (mean {100*g('C_dep_sum_rel')/n:.4f}% of NAV, max {100*g('max_C_dep_rel'):.1f}%); leaver edge >$1 in {100*g('C_wd_gt1')/n:.2f}% (mean {100*g('C_wd_sum_rel')/n:.4f}%, max {100*g('max_C_wd_rel'):.1f}%)")
    print(f"exits where redeem(balanceOf) would have reverted (must use maxRedeem) = {total.get('full_redeem_reverts', 0)}")
    print(f"mean (fees not yet in the mark)/fair NAV = {100*total['fee_gap_sum_rel']/n:.4f}%")
    k = total["sand_n"]
    if k:
        mean = total["sand_gain_sum"] / k
        se = ((total["sand_gain_sq"] / k - mean**2) / k) ** 0.5
        mr = total["sand_rel_sum"] / k
        ser = ((total["sand_rel_sq"] / k - mr**2) / k) ** 0.5
        print("-- JIT depositor (deposit = pool NAV, run NAV-raising upkeep, redeem; one block) --")
        print(f"attempts={k}  profitable (> $0.01) in {total['sand_pos']} ({100*total['sand_pos']/k:.2f}%)")
        print(f"mean gain = ${mean:,.2f} (SE {se:,.2f}) per attempt; mean gain/deposit = {1e4*mr:.3f} bps (SE {1e4*ser:.3f}); "
              f"max gain/deposit = {100*total['sand_max_rel']:.2f}%")
        print(f"mean NAV jump caused by the upkeep = ${total['sand_dnav_sum']/k:,.2f}")
