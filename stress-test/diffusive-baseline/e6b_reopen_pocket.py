"""
E6b.  The pocket as a repeated strategy, restricted to cheap-side prices (<= 30c) where the worse-of
exit matters least.  Whole-cent reference steps, slow price modelled, 200,000 paths.
The trader re-opens $1 of margin whenever the mid sits on a pocket price; otherwise he waits.
Speeds: lam = mid changes per second.  Horizon 30 days (so that slow markets complete enough bets).
"""
import sys
import numpy as np
from engine import Leg, run, stat
from lattice import lattice_value, regime, max_int_leverage

NP, TAU_S = 200_000, 300.0
h, st, pr = regime("full")
K = int(round(1 / h)) + 1
lev = np.zeros(K); tpk = np.full(K, np.inf)
for k in range(8, 31):
    p0 = k * h
    best = (0.02, 0, np.inf)
    for L in range(2, max_int_leverage(p0, 60 * 86400.0) + 1):
        r = lattice_value(p0, L, h, st, pr, policy="optimal")
        if r["ev"] > best[0]:
            pos = [s_ for s_ in r["stop_set"] if s_ > 0]
            best = (r["ev"], L, min(pos) if pos else np.inf)
    lev[k], tpk[k] = best[1], best[2]
print("pocket table (price c @ leverage, take-profit ticks):", ", ".join(f"{k}@{int(lev[k])}x/+{int(tpk[k]) if np.isfinite(tpk[k]) else 'cap'}" for k in range(K) if lev[k] > 0))
HOR = 30 * 86400.0
for lt in [0.02, 0.1, 0.3]:
    lam = lt / TAU_S
    for k0 in [18, 26]:
        for conv in [True]:
            leg = Leg(+1, lev, tpk, tp_eps=0.05, eps_in=0.02, tp_converge=conv)
            r = run(NP, k0, h, st, pr, lam=lam, legs=[leg], tau_s=TAU_S, repeat=True, horizon_time=HOR, seed=91 + k0, settle_at_end=True)[0]
            mu, se = stat(r["pnl"])
            nb = r["nb"].mean()
            busy = r["dur"].mean() / HOR
            print(f"   lam*tau={lt:<5} ({lam * 86400:5.1f} changes/day) start {k0}c: P&L over 30 days per $1 margin {mu:+.4f} +-{se:.4f} | bets {nb:6.2f} | per bet {mu / nb:+.4f} | "
                  f"clamp gain {r['under'].mean():.3f} fee {r['fee'].mean():.3f} | share of time in a position {busy:.2f} | P(30-day P&L > 0) {np.mean(r['pnl'] > 0):.3f}")
    sys.stdout.flush()
