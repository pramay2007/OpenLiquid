"""
E4p.  The passive user: opens at the mid and never closes by hand; the position ends when the keeper
can collect it (worse-of price >= win line) or when it is liquidated.  If the win line sits exactly on
a tick, the slow price only reaches it after ~25 tau here (36.8 tau = 3.1 h in the contract's 1e18
fixed point), unless the mid ticks beyond it.  400,000 paths, whole-cent steps.
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import regime
NP, TAU_S = 400_000, 300.0
h, st, pr = regime("full")
print(f"{'p0':>5} {'L':>3} {'lam*tau':>8} | {'EV passive':>11} {'s.e.':>7} {'P(collected)':>12} {'claim p0':>8} {'P(liq)':>7} | {'P(mid touched win line first)':>30} | hold h")
for p0, L in [(0.5, 25), (0.5, 10), (0.5, 5), (0.2, 10), (0.8, 10)]:
    # probability that the MID reaches the win line before liquidation (lattice, exact)
    from lattice import lattice_value
    ex = lattice_value(p0, L, h, st, pr, policy="hold")
    for lt in [0.01, 0.1, 0.3, 1.0]:
        leg = Leg(+1, table_const(h, L), table_const(h, np.inf), tp_eps=1e-11)
        r = run(NP, int(round(p0 / h)), h, st, pr, lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=71)[0]
        mu, se = stat(r["pnl"])
        print(f"{p0:5.2f} {L:3d} {lt:8.2f} | {mu:+11.4f} {se:7.4f} {r['nwin'].mean():12.4f} {p0:8.2f} {r['nliq'].mean():7.4f} | {ex['p_win']:30.4f} | {r['dur'].mean() / 3600:.2f}")
    sys.stdout.flush()
