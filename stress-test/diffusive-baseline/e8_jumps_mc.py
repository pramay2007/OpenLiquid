"""
E8 (Monte Carlo confirmation of the exact jump numbers, with the slow price modelled).
Whole-cent walk; a share mu of mid changes are +-J cent jumps (symmetric, so the mid stays a martingale).
Plain honest bet: YES at the maximum leverage for the price, held to the cap (close within eps) or liquidation.
400,000 paths.
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import lattice_value, regime, max_int_leverage
NP, TAU_S = 400_000, 300.0
print(f"{'p0':>5} {'L':>3} {'J':>3} {'mu':>6} {'lam*tau':>8} | {'exact hold (no lag)':>19} | {'MC EV':>8} {'s.e.':>7} | {'clamp gain':>10} {'fee':>7} {'forfeit/lag':>11} P(win) P(liq)")
for p0, J, mu in [(0.2, 5, 0.02), (0.2, 5, 0.05), (0.2, 10, 0.02), (0.2, 10, 0.05), (0.3, 5, 0.05), (0.3, 10, 0.05), (0.5, 5, 0.05), (0.8, 5, 0.05)]:
    L = max_int_leverage(p0, 30 * 86400.0)
    h, st, pr = regime("jump", mu=mu, J=J)
    ex = lattice_value(p0, L, h, st, pr, policy="hold")
    for lt in [0.1, 0.3]:
        best = None
        for eps in [0.05, 0.2]:
            leg = Leg(+1, table_const(h, L), table_const(h, np.inf), tp_eps=eps)
            r = run(NP, int(round(p0 / h)), h, st, pr, lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=81)[0]
            m_, s_ = stat(r["pnl"])
            if best is None or m_ > best[0]:
                best = (m_, s_, r)
        m_, s_, r = best
        print(f"{p0:5.2f} {L:3d} {J:3d} {mu:6.3f} {lt:8.2f} | {ex['ev']:+19.4f} | {m_:+8.4f} {s_:7.4f} | {r['under'].mean():10.4f} {r['fee'].mean():7.4f} {r['lagcost'].mean():11.4f} {r['nwin'].mean():.3f} {r['nliq'].mean():.3f}")
    sys.stdout.flush()
