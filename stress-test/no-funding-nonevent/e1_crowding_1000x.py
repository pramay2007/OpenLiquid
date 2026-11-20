"""
(iv) Does the 0.05%/day crowding fee (taken from winnings only) do anything at 1000x?

One long position on the crowded side at full skew (skew = 1, the maximum rate), 1-second grid,
exact worse-of fills, liquidation at the mid, collect at the cap, 5% profit share, crowding fee
deducted from profit first.  Three exit styles:
  hold     : run to liquidation or to the cap (10x margin)
  tp1      : take profit as soon as the close fill shows +1x margin (a 10 bp scalp)
  timer300 : close after 5 minutes whatever the P&L
Entry: 'naive' opens as soon as R2 and the 30% entry guard allow (pays the mid/slow gap);
       'patient' opens only when the fill equals the mid.
Units: one margin M.

The price result of a position has a large variance (it is a +10M / -0.8M lottery), so its mean is
reported through an exact identity instead of the raw average: the mid is a martingale, hence
   E[result] = -E[entry gap cost] + E[result - (P&L at the exit-time mid, unclipped)]
and the second term is a sum of small pieces (worse-of exit cost, profit forfeited above the cap,
loss beyond margin that is never collected).
"""
import sys, math, time
import numpy as np
from olsim import *


def single_worker(args):
    (n, sigma_ann, L, policy, horizon_s, seed, skew, patient, dist, burn) = args
    rng = np.random.default_rng(seed)
    draw = Draw(rng, dist)
    s1 = sig1(sigma_ann)
    cap = min(CAP_MULT, float(L))
    w = 1.0 / (TAU + 1.0)
    mid, slow = burn_in(draw, n, s1, burn)
    gid = np.arange(n)
    st = np.zeros(n, np.int8)             # 0 waiting, 1 open, 2 done
    e = np.ones(n); t0 = np.zeros(n)
    out = {k: np.zeros(n) for k in ("life", "result", "raw", "crowd_acc", "crowd", "share", "liqfee",
                                    "entry_cost", "clip", "liq", "wait", "done")}
    rate = L * skew * CROWD_PER_DAY / SEC_DAY
    thr = -(1.0 - MAINT)

    def settle(loc, res, raw, k, is_liq):
        g = gid[loc]
        age = k - t0[loc]
        acc = rate * age
        pos = res > 0
        c = np.where(pos, np.minimum(acc, res), 0.0)
        out["life"][g] = age; out["crowd_acc"][g] = acc; out["result"][g] = res; out["raw"][g] = raw
        out["crowd"][g] = c; out["share"][g] = np.where(pos, PROFIT_SHARE * (res - c), 0.0)
        out["wait"][g] = t0[loc]; out["done"][g] = 1.0
        if is_liq:
            out["liqfee"][g] = np.minimum(LIQ_FEE, 1.0 + res)
            out["liq"][g] = 1.0
            out["clip"][g] = np.maximum(-raw - 1.0, 0.0)
        st[loc] = 2

    for k in range(0, horizon_s + 1):
        if k > 0:
            m = len(mid)
            prev = mid
            mid = prev * (1.0 + s1 * draw(m))
            slow = slow + (prev - slow) * w
            pm = L * (mid / e - 1.0)
            lq = (st == 1) & (pm <= thr)
            if lq.any():
                settle(np.where(lq)[0], np.maximum(pm[lq], -1.0), pm[lq], k, True)
            pc = L * (np.minimum(mid, slow) / e - 1.0)
            col = (st == 1) & (pc >= cap)
            if col.any():
                settle(np.where(col)[0], np.full(int(col.sum()), cap), pm[col], k, False)
            if policy == "tp1":
                ex = (st == 1) & (pc >= 1.0)
            elif policy == "timer300":
                ex = (st == 1) & (k - t0 >= 300)
            else:
                ex = None
            if ex is not None and ex.any():
                settle(np.where(ex)[0], np.clip(pc[ex], -1.0, cap), pm[ex], k, False)
        wt = st == 0
        if wt.any():
            hi = np.maximum(mid, slow)
            loss = L * (hi - mid) / hi
            ok = wt & (np.abs(mid - slow) <= MAX_GAP * slow)
            ok &= (loss <= 1e-12) if patient else (loss <= ENTRY_GUARD)
            if ok.any():
                e[ok] = hi[ok]; t0[ok] = k; st[ok] = 1
                out["entry_cost"][gid[ok]] = loss[ok]
        if k % 200 == 0:
            alive = st < 2
            na = int(alive.sum())
            if na == 0:
                break
            if na < 0.6 * len(st):
                gid, st, e, t0, mid, slow = gid[alive], st[alive], e[alive], t0[alive], mid[alive], slow[alive]
    op = st == 1
    if op.any():
        pm = L * (mid / e - 1.0)
        pc = L * (np.minimum(mid, slow) / e - 1.0)
        settle(np.where(op)[0], np.clip(pc[op], -1.0, cap), pm[op], horizon_s, False)
    d = out.pop("done") > 0
    return {k: v[d] for k, v in out.items()}


def report(tag, o, L):
    res = o["result"]; win = res > 0
    resid = res - o["raw"]                      # small-variance pieces
    cv_result = resid - o["entry_cost"]         # E[result] by the martingale identity
    house_nofee = -cv_result + o["share"]
    house = house_nofee + o["crowd"]
    trader = cv_result - o["crowd"] - o["share"] - o["liqfee"]
    cyc = (o["life"] + o["wait"]).mean()
    print(f"--- {tag}   paths={len(res)}")
    print(f"  mean life            {fmt(o['life'],' s',1)}   (median {np.median(o['life']):.0f} s; winners {o['life'][win].mean():.0f} s)")
    print(f"  P(liquidated)        {fmt(o['liq'],'',4)}    P(closed in profit) {fmt(win.astype(float),'',4)}   mean win|win {res[win].mean():.3f} M")
    print(f"  entry gap cost       {fmt(o['entry_cost'],' M')}")
    print(f"  exit pieces (result - mid P&L): {fmt(resid,' M')}   of which loss beyond margin never collected {fmt(o['clip'],' M',5)}")
    print(f"  E[price result]      {fmt(cv_result,' M')}   (raw average, noisy: {fmt(res,' M')})")
    print(f"  profit share paid    {fmt(o['share'],' M',5)}")
    print(f"  crowding ACCRUED     {fmt(o['crowd_acc'],' M',5)}   (skew = 1)")
    print(f"  crowding PAID        {fmt(o['crowd'],' M',5)}   = {100*o['crowd'].mean()/max(o['crowd_acc'].mean(),1e-12):.1f}% of accrued;"
          f" {100*o['crowd'].sum()/res[win].sum():.3f}% of gross winnings; {100*o['crowd'].mean()/o['share'].mean():.1f}% of the profit share")
    print(f"  liquidator rewards   {fmt(o['liqfee'],' M',5)}")
    print(f"  trader EV            {fmt(trader,' M')}")
    print(f"  house EV per trade   without crowding fee {fmt(house_nofee,' M')}   with {fmt(house,' M')}"
          f"   -> crowding fee is {100*o['crowd'].mean()/house.mean():.2f}% of the house's edge")
    hs = (-res + o["share"] + o["crowd"])
    print(f"  house result per trade: sd {hs.std():.3f} M, worst {hs.min():.2f} M")
    print(f"  per day per $1 of crowded open interest: house edge {100*house.mean()/L*SEC_DAY/cyc:.4f}%,"
          f" crowding fee {100*o['crowd'].mean()/L*SEC_DAY/cyc:.4f}%  (cap 0.05%)")


if __name__ == "__main__":
    NP = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
    W = 8
    per = NP // W
    print("=== analytic scale of the fee at 1000x, skew = 1 ===")
    L = 1000
    per_min = L * CROWD_PER_DAY / (24 * 60)
    print(f"fee accrual: {CROWD_PER_DAY*1e4:.1f} bp of notional per day = {100*L*CROWD_PER_DAY:.0f}% of margin per day"
          f" = {100*per_min:.4f}% of margin per minute = {CROWD_PER_DAY*1e4/(24*60):.5f} bp of price per minute")
    for s in (0.5, 0.8):
        print(f"  1-minute price sd at {int(100*s)}% vol: {sig1(s)*math.sqrt(60)*1e4:.2f} bp  -> one minute of fee is "
              f"{100*CROWD_PER_DAY/(24*60)/(sig1(s)*math.sqrt(60)):.3f}% of one sd")
    t0 = time.time()
    runs = [(0.5, "hold", 4 * 3600, False), (0.5, "hold", 4 * 3600, True), (0.5, "tp1", 4 * 3600, False),
            (0.5, "timer300", 1200, False), (0.8, "hold", 4 * 3600, True)]
    for sigma, policy, hz, patient in runs:
        args = [(per, sigma, L, policy, hz, 1000 + 17 * i + int(100 * sigma), 1.0, patient, "normal", 600)
                for i in range(W)]
        o = run_parallel(single_worker, args, W)
        report(f"L=1000 vol={int(100*sigma)}% policy={policy} entry={'patient' if patient else 'naive'}", o, L)
        print(f"  [elapsed {time.time()-t0:.0f}s]", flush=True)
