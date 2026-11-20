"""
Deterministic dollar examples on the exact-integer model (model.py), deploy.js parameters:
vault seeded with 2,000,000 USDC, event market: 50x max, 10% profit share, kappa 0.5,
maxGap 5 points, tau 300 s, reaction 120 s, hazardScale 1; crypto: 5% profit share, 1000x.

Each block prints what the vault's share price says, what the clamped liability says, and
what a sequence of permissionless calls extracts.
"""
from model import (Oracle, Vault, Engine, Config, Revert, WAD, BPS, UNIT, HOUR, DAY)

USD = 10**6
BTC, EVT = 1, 101
T0 = 1_800_000_000


def usd(x):
    return int(round(x * USD))


def f(x):
    return f"{x / USD:,.2f}"


class Sys:
    def __init__(self, variant="code", lp=2_000_000, expiry_days=30, boost=False, staked=True, depth=40_000,
                 btc_fee=500, evt_fee=1000, hazard=WAD, p_init=0.50):
        v = dict(code=dict(free_cap_ceiling=True, crowd_rate="code", liq_fee_from_vault=False),
                 task=dict(free_cap_ceiling=False, crowd_rate="task", liq_fee_from_vault=True))[variant]
        self.o, self.v = Oracle(), Vault()
        self.e = Engine(self.o, self.v, staked=staked, **v)
        self.now = T0
        self.v.now = T0
        self.o.tau[BTC] = 60
        self.o.tau[EVT] = 300
        self.expiry = T0 + expiry_days * DAY
        self.e.setMarket(BTC, Config(profitFeeBps=btc_fee), T0)
        self.e.setMarket(EVT, Config(isEvent=True, boostEnabled=boost, maxLeverage=50, profitFeeBps=evt_fee,
                                     maxGapBps=500, reactionSeconds=120, expiry=self.expiry,
                                     maxPositionNotional=100_000 * USD, crowdingPerDay=0, hazardScale=hazard), T0)
        self.v.deposit("lp", usd(lp))
        self.depth = usd(depth)
        self.push(BTC, 60_000.0)
        self.push(EVT, p_init)

    def push(self, mkt, price, resolved=False, depth=None):
        px = int(round(price * 10**6)) * 10**12
        d = (20_000_000 * USD if mkt == BTC else self.depth) if depth is None else depth
        self.o.push(mkt, px, 0 if resolved else d, self.now, resolved, self.now)

    def adv(self, s):
        self.now += s
        self.v.now = self.now

    def hold(self, mkt, price, seconds, step=60):
        t = 0
        while t < seconds:
            self.adv(step)
            t += step
            self.push(mkt, price)

    def fair(self):
        owed = 0
        for pid, p in self.e.positions.items():
            owed += self.e.view(pid, self.now)["equityAtMid"] - p.margin
        return self.v.cash - self.v.marginHeld - owed

    def value(self, who):
        return self.v._toAssets(self.v.balance.get(who, 0))


def line(title):
    print("\n" + "=" * 100 + "\n" + title + "\n" + "=" * 100)


# ---------------------------------------------------------------------------------------------
def s1_resolution_jit(L=10, n_traders=10, margin=200, variant="code"):
    line(f"S1 [{variant}]  Resolution jump, YES-only leveraged free book: deposit -> settle -> redeem (3 calls, no price risk)")
    s = Sys(variant)
    s.e.open("bob", BTC, True, usd(50_000), 2, False, s.now)          # an unrelated 2x BTC long (flat)
    for i in range(n_traders):
        s.e.open(f"t{i}", EVT, True, usd(margin), L, False, s.now)   # free-mode YES at 0.50
    st = s.e.states[EVT]
    B = (st.longBorrowed - st.shortBorrowed) / 1e18 / USD
    nav_before = s.v.totalAssets()
    s.adv(30)
    s.push(EVT, 1.0, resolved=True)
    s.push(BTC, 60_000.0)
    marked, fair = s.v.totalAssets(), s.fair()
    print(f"side notional {n_traders*margin*L:,} USDC, borrowed shares net {B:,.0f}; formula (1-p)*B = {0.5*B:,.2f}")
    print(f"NAV before {f(nav_before)} | after resolution: vault marks {f(marked)}, clamped liability leaves {f(fair)}"
          f" | mis-mark {f(fair-marked)}")
    for k in (1, 9):
        s2 = Sys(variant)
        s2.e.open("bob", BTC, True, usd(50_000), 2, False, s2.now)
        for i in range(n_traders):
            s2.e.open(f"t{i}", EVT, True, usd(margin), L, False, s2.now)
        s2.adv(30)
        s2.push(EVT, 1.0, resolved=True)
        s2.push(BTC, 60_000.0)
        x = k * s2.v.totalAssets()
        s2.v.deposit("carol", x)
        for pid in [p for p, q in s2.e.positions.items() if q.marketId == EVT]:
            s2.e.close("carol", pid, s2.now)
        got = s2.v.redeem("carol", s2.v.maxRedeem("carol"))
        gain = got + s2.value("carol") - x
        print(f"  depositor puts in {k}x the pool ({f(x)}), settles the {n_traders} winners, redeems: gain {f(gain)}"
              f" ; original LP's 2,000,000 is now worth {f(s2.value('lp'))}")


def s2_first_out(L=10, n_traders=10, margin=200):
    line("S2  Resolution jump, NO-only leveraged free book: an LP holding half the vault leaves before the settlements")
    s = Sys(lp=1_000_000)
    s.v.deposit("carol", usd(1_000_000))
    s.e.open("bob", BTC, True, usd(50_000), 2, False, s.now)
    for i in range(n_traders):
        s.e.open(f"t{i}", EVT, False, usd(margin), L, False, s.now)  # free-mode NO at 0.50
    s.adv(30)
    s.push(EVT, 1.0, resolved=True)
    s.push(BTC, 60_000.0)
    marked, fair = s.v.totalAssets(), s.fair()
    got = s.v.redeem("carol", s.v.maxRedeem("carol"))
    for pid in [p for p, q in s.e.positions.items() if q.marketId == EVT]:
        s.e.close("keeper", pid, s.now)
    print(f"vault marks {f(marked)}, clamped liability leaves {f(fair)} (traders can lose only their {n_traders*margin:,} of margin)")
    print(f"carol redeems her half for {f(got)} (fair half = {f(fair//2)}): takes {f(got - fair//2)} from the LP who stays, "
          f"who is left with {f(s.value('lp'))}")


def s3_fee_sandwich():
    line("S3  Fees only (1x positions, nothing capped): a stranger wraps the settlements in deposit/redeem")
    for k in (1, 9):
        s = Sys()
        for i in range(10):
            s.e.open(f"t{i}", EVT, True, usd(2_000), 1, False, s.now)      # 20,000 of outright YES at 0.50
        s.adv(30)
        s.push(EVT, 1.0, resolved=True)
        x = k * s.v.totalAssets()
        s.v.deposit("carol", x)
        fees = 0
        for pid in list(s.e.positions.keys()):
            r = s.e.close("carol", pid, s.now)
            fees += r["fee"] - r["stakerFee"]
        got = s.v.redeem("carol", s.v.maxRedeem("carol"))
        gain = got + s.value("carol") - x
        print(f"  winners' profit share kept by the vault {f(fees)}; depositor with {k}x the pool takes {f(gain)} "
              f"({100*gain/fees:.1f}%), LP keeps {f(fees-gain)}")


def s4_fee_rebate(variant="code"):
    line(f"S4 [{variant}]  The payer gets the crowding fee / Boost premium / profit share back by wrapping its own close")
    for mode in ("free (crowding fee)", "boost (premium)"):
        boost = mode.startswith("boost")
        for k in (0, 1, 9):
            s = Sys(variant, boost=boost)
            s.e.open("alice", EVT, True, usd(1_000), 10, boost, s.now)   # 10x YES at 0.50, alone on its side
            for _ in range(24):                                          # one day, keeper pokes hourly
                s.adv(HOUR)
                s.push(EVT, 0.50)
                s.e.poke(EVT, s.now)
            s.hold(EVT, 0.55, 3600, 60)                                  # the odds reach the win line and stay
            x = k * s.v.totalAssets()
            if k:
                s.v.deposit("alice", x)
            pid = list(s.e.positions.keys())[0]
            r = s.e.close("alice", pid, s.now)
            got = s.v.redeem("alice", s.v.maxRedeem("alice")) + s.value("alice") - x if k else 0
            charged = r["crowding"] + r["premium"] + r["fee"]
            print(f"  {mode:22s} deposit {k}x pool: price P&L {f(r['result'] + r['premium'])}, crowding {f(r['crowding'])}, "
                  f"premium {f(r['premium'])}, profit share {f(r['fee'])} (stakers {f(r['stakerFee'])}) -> charged {f(charged)}, "
                  f"recovered through shares {f(got)} ({100*got/charged if charged else 0:.1f}%)")


def s5_forceclose_winner():
    line("S5  A stranger force-closes a winner at the slow price inside deposit/redeem (E3 'normal close price')")
    for k in (0, 1):
        s = Sys(expiry_days=2)
        s.e.open("bob", BTC, True, usd(50_000), 2, False, s.now)
        s.e.open("alice", EVT, True, usd(1_000), 10, False, s.now)      # win line 0.55, cap 1,000
        s.adv(4)
        s.push(EVT, 0.80)                                                # jump in alice's favour
        pid = [p for p, q in s.e.positions.items() if q.marketId == EVT][0]
        v = s.e.view(pid, s.now)
        marked, fair = s.v.totalAssets(), s.fair()
        x = k * marked
        if k:
            s.v.deposit("carol", x)
        r = s.e.forceClose(pid, s.now)
        got = (s.v.redeem("carol", s.v.maxRedeem("carol")) + s.value("carol") - x) if k else 0
        print(f"  mid 0.80, slow {v['f'].slow/1e18:.4f}; time-limit leverage {s.e._timeLeverage(v['c'], v['f'].mid, s.now)}x < 10x; "
              f"vault marks {f(marked)} vs clamped {f(fair)}")
        print(f"  forceClose fills at {r['exit']/1e18:.4f}: alice is paid a profit of {f(r['result'])} instead of her cap 1,000.00"
              f"{'; depositor of 1x pool gains ' + f(got) if k else ''}")


def s6_reserve_lock():
    line("S6  Reserve locked per dollar of margin by an OUTRIGHT (1x) long-shot position (liquidity occupation)")
    print("entry  | reserve / margin: task text E2 (outright payoff) | contract (ceiling 10x)")
    for p in (0.01, 0.02, 0.05, 0.09, 0.10, 0.25, 0.50):
        out = []
        for variant in ("task", "code"):
            s = Sys(variant, depth=2_000_000, p_init=p)
            pid = s.e.open("x", EVT, True, usd(1_000), 1, False, s.now)
            out.append(s.e.positions[pid].reserve / usd(1_000))
        print(f" {p:.2f}  | {out[0]:7.2f}x                                          | {out[1]:5.2f}x")
    s = Sys("task", depth=50_000, p_init=0.02)
    cap = s.e._sideCap(s.e.markets[EVT], s.o.read(EVT, s.now))
    pid = s.e.open("x", EVT, True, cap, 1, False, s.now)
    print(f"example: book depth 50,000 -> side cap {f(cap)} of notional; one 1x YES at 0.02 for {f(cap)} locks "
          f"{f(s.e.positions[pid].reserve)} of the 2,000,000 vault until resolution, at no carrying cost")


def s7_longshot_ceiling():
    line("S7  Contract only: the 10x ceiling on a free-mode reserve vs E2/E3 for a 1x long shot")
    s = Sys("code", depth=2_000_000, p_init=0.05)
    s.e.open("bob", BTC, True, usd(50_000), 2, False, s.now)
    pid = s.e.open("alice", EVT, True, usd(1_000), 1, False, s.now)    # 20,000 shares at 5c, outright
    p = s.e.positions[pid]
    print(f"1x YES at 0.05, margin 1,000: outright win would be 19,000.00; reserve locked {f(p.reserve)}")
    s.hold(EVT, 0.55, 7200, 60)
    v = s.e.view(pid, s.now)
    print(f"at 0.55 held for 2 h (exactly the 10x line): collectable = {v['collectable']} "
          f"(slow is {(v['f'].mid - v['f'].slow)} wei short of the mid; P&L at the close price is 1 micro-USDC under the cap)")
    s.hold(EVT, 0.56, 1800, 60)
    v = s.e.view(pid, s.now)
    print(f"at 0.56 held for 30 min: collectable by anyone = {v['collectable']} (E3: 1x positions stay open through resolution)")
    s.adv(10)
    s.push(EVT, 1.0, resolved=True)
    s.push(BTC, 60_000.0)
    marked, fair = s.v.totalAssets(), s.fair()
    r = s.e.close("keeper", pid, s.now)
    print(f"resolves YES: vault marks {f(marked)} vs clamped {f(fair)} (mis-mark {f(fair-marked)}); alice is paid a profit of "
          f"{f(r['result'])} before the 10% share, not 19,000.00")


def s8_one_x_liquidation():
    line("S8  R4 applied literally to an outright position: a fully paid 1x YES bought at 0.50")
    for variant in ("code", "task"):
        s = Sys(variant)
        pid = s.e.open("alice", EVT, True, usd(1_000), 1, False, s.now)
        s.adv(4)
        s.push(EVT, 0.10)                                               # one print at 10c
        v = s.e.view(pid, s.now)
        r = s.e.liquidate(pid, s.now)
        print(f"  [{variant}] one print at 0.10: liquidatable={v['liquidatable']}; alice gets {f(r['payout'])}, liquidator {f(r['liqFee'])}, "
              f"vault keeps {f(r['margin'] - r['payout'] - r['liqFee'])}; her 2,000 shares would still pay 2,000 on YES")


def s9_lazy_accrual(variant="code"):
    line(f"S9 [{variant}]  Crowding fee / Boost premium are indexed only when the market is touched")
    rows = []
    for label, poke_every, resolve in (("keeper pokes hourly", HOUR, False), ("nobody touches the market", None, False),
                                       ("nobody touches it, then it resolves YES", None, True)):
        for boost in (False, True):
            s = Sys(variant, expiry_days=10, boost=boost)
            s.e.open("alice", EVT, True, usd(1_000), 10, boost, s.now)    # alone on its side: skew 1
            total = 10 * DAY - HOUR                                      # held until one hour before expiry
            t = 0
            while t < total:
                s.adv(HOUR)
                t += HOUR
                s.push(EVT, 0.50)
                if poke_every:
                    s.e.poke(EVT, s.now)
            if resolve:
                s.adv(60)
                s.push(EVT, 1.0, resolved=True)
            else:
                s.hold(EVT, 0.56, 1800, 60)
            pid = list(s.e.positions.keys())[0]
            if pid in s.e.positions:
                r = s.e.close("alice", pid, s.now)
                rows.append((label, "boost" if boost else "free", r))
    for label, mode, r in rows:
        print(f"  {label:42s} {mode:5s}: accrued crowding {f(r['accruedCrowding'])} (taken {f(r['crowding'])}), premium {f(r['premium'])}, "
              f"result {f(r['result'])}, payout {f(r['payout'])}")


def s10_liquidation_reward():
    line("S10  Liquidator reward at the first liquidatable tick, and what one missed price change is worth")
    s = Sys()
    pid = s.e.open("alice", EVT, True, usd(400), 25, False, s.now)       # stop line exactly 2 ticks below
    s.adv(4)
    s.push(EVT, 0.49)
    print(f"  25x YES at 0.50: at 0.49 equity {f(s.e.view(pid, s.now)['equityAtMid'])}, liquidatable={s.e.view(pid, s.now)['liquidatable']}")
    s.adv(4)
    s.push(EVT, 0.48)
    v = s.e.view(pid, s.now)
    print(f"  at 0.48 equity {f(v['equityAtMid'])}, liquidatable={v['liquidatable']}")
    s2_marked = s.v.totalAssets()
    # not liquidated; the price ticks back
    s.adv(4)
    s.push(EVT, 0.49)
    v2 = s.e.view(pid, s.now)
    print(f"  nobody liquidates (reward would be 0.00); one tick back to 0.49: equity {f(v2['equityAtMid'])} -> "
          f"expected value of one missed +-1 tick change = {f(v2['equityAtMid']//2)} per 400 of margin")
    s = Sys()
    pid = s.e.open("alice", EVT, True, usd(400), 25, False, s.now)
    s.adv(4)
    s.push(EVT, 0.48)
    r = s.e.liquidate(pid, s.now)
    print(f"  liquidated at 0.48: trader {f(r['payout'])}, liquidator {f(r['liqFee'])}, vault keeps {f(r['margin']-r['payout']-r['liqFee'])}")
    s = Sys("task")
    pid = s.e.open("alice", EVT, True, usd(400), 25, False, s.now)
    s.adv(4)
    s.push(EVT, 0.48)
    r = s.e.liquidate(pid, s.now)
    print(f"  [literal R4: liquidator always gets 5% of M] trader {f(r['payout'])}, liquidator {f(r['liqFee'])}, vault keeps "
          f"{f(r['margin']-r['payout']-r['liqFee'])}")


def s11_same_payoff_any_leverage():
    line("S11  E2 at settlement: the same stake is paid the same at 1x, 5x and 25x when the market resolves without warning")
    for variant in ("code", "task"):
        s = Sys(variant, depth=2_000_000)
        ids = [s.e.open("a", EVT, True, usd(100), L, False, s.now) for L in (1, 5, 25)]
        ids += [s.e.open("b", EVT, False, usd(100), L, False, s.now) for L in (1, 5, 25)]
        s.adv(10)
        s.push(EVT, 1.0, resolved=True)
        res = [s.e.close("k", i, s.now) for i in ids]
        print(f"  [{variant}] YES 1x/5x/25x paid {[f(r['payout']) for r in res[:3]]}; NO 1x/5x/25x paid {[f(r['payout']) for r in res[3:]]}"
              f"; reserves {[f(r['reserve']) for r in res[:3]]}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "tail":
        s7_longshot_ceiling()
        s8_one_x_liquidation()
        s9_lazy_accrual("code")
        s9_lazy_accrual("task")
        s10_liquidation_reward()
        s11_same_payoff_any_leverage()
        sys.exit(0)
    s1_resolution_jit()
    s1_resolution_jit(L=25, n_traders=10, margin=80)
    s2_first_out()
    s3_fee_sandwich()
    s4_fee_rebate("code")
    s4_fee_rebate("task")
    s5_forceclose_winner()
    s6_reserve_lock()
    s7_longshot_ceiling()
    s8_one_x_liquidation()
    s9_lazy_accrual("code")
    s9_lazy_accrual("task")
    s10_liquidation_reward()
    s11_same_payoff_any_leverage()
