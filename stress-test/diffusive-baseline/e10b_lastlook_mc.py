"""E10b.  Last look on exits, Monte Carlo with the slow price (400,000 paths, whole-cent steps).
The holder closes at the pre-change worse-of price on a share s of adverse mid changes; otherwise honest:
opened at the mid, closed at any level >= +1 tick once the slow price has caught up, or at the cap."""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import regime
NP, TAU_S = 400_000, 300.0
h, st, pr = regime("full")
print(f"{'p0':>6} {'L':>3} {'s':>5} | " + " | ".join(f"lam*tau={lt:<4} EV +- s.e.   P(liq)" for lt in [0.1, 0.3, 1.0]))
for p0, L in [(0.5, 25), (0.5, 10), (0.665, 16)]:
    k0 = int(round(p0 / h)) if abs(p0 / h - round(p0 / h)) < 1e-9 else None
    for s in [0.0, 0.1, 0.25, 0.5, 1.0]:
        cells = []
        for lt in [0.1, 0.3, 1.0]:
            best = None
            for eps in [0.05, 0.2]:
                if k0 is None:   # x.xx5 lattice: half-cent grid with whole-cent steps
                    hh, ss, pp, kk, tp = 0.005, [-2, 2], [0.5, 0.5], int(round(p0 / 0.005)), 2
                else:
                    hh, ss, pp, kk, tp = h, st, pr, k0, 1
                leg = Leg(+1, table_const(hh, L), table_const(hh, tp), tp_eps=eps, tp_converge=True, lastlook=s)
                r = run(NP, kk, hh, ss, pp, lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=101)[0]
                mu, se = stat(r["pnl"])
                if best is None or mu > best[0]:
                    best = (mu, se, r["nliq"].mean())
            cells.append(f"{best[0]:+.4f} +-{best[1]:.4f}  {best[2]:.3f}      ")
        print(f"{p0:6.3f} {L:3d} {s:5.2f} | " + " | ".join(cells))
        sys.stdout.flush()
