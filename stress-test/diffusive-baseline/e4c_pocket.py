"""
E4c.  The stop-line pocket with the slow price modelled, on either cent sub-lattice.
Reference mid moves in whole-cent steps (half-cent lattice, steps of +-2), so a mid quoted at
x.xx5 (one-tick spread) stays at x.xx5.  400,000 paths per cell.
Exit policies:  fixed  = close when the worse-of price reaches (take-profit level - eps)
                conv   = close at any level >= take-profit once slow is within eps of mid (or at the cap)
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import lattice_value

NP = 400_000
TAU_S = 300.0
h, st, pr = 0.005, [-2, 2], [0.5, 0.5]

print(f"{'p0':>6} {'L':>3} {'stop':>6} {'tp':>4} | {'exact (no lag)':>14} | " + " | ".join(f"lam*tau={lt:<5}" + " " * 22 for lt in [0.01, 0.1, 0.3, 1.0]))
for p0, L, tp_ticks in [(0.255, 10, 7), (0.205, 8, 9), (0.18, 7, 11), (0.13, 5, 16), (0.105, 4, 20), (0.455, 18, 3), (0.505, 20, 2), (0.305, 12, 5), (0.46, 18, 3)]:
    ex = lattice_value(p0, L, h, st, pr, policy="tp", tp_k=2 * tp_ticks)
    cells = []
    for lt in [0.01, 0.1, 0.3, 1.0]:
        best = None
        for conv in [False, True]:
            for eps in [0.02, 0.1, 0.3]:
                leg = Leg(+1, table_const(h, L), table_const(h, 2 * tp_ticks), tp_eps=eps, tp_converge=conv)
                r = run(NP, int(round(p0 / h)), h, st, pr, lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=61)[0]
                mu, se = stat(r["pnl"])
                if best is None or mu > best[0]:
                    best = (mu, se, eps, conv, r["under"].mean(), r["fee"].mean(), r["lagcost"].mean())
        cells.append(f"{best[0]:+.4f}+-{best[1]:.4f} ({'conv' if best[3] else 'fixed'},{best[2]}) lag {best[6]:.3f}")
    print(f"{p0:6.3f} {L:3d} {ex['ds_ticks']:6.3f} {tp_ticks:4d} | {ex['ev']:+14.4f} | " + " | ".join(cells))
    sys.stdout.flush()
