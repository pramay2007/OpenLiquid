"""
E7.  Crowding fee on an honest diffusive trader who is alone on his side (skewFrac = 1), and the
free reset.  Whole-cent steps, 50c, 30 days to expiry (tau treated as constant over the holding
period: a simplification that understates the fee for multi-day holds).
v = true variance of the price relative to the venue's model p(1-p)/tau (BS digital at the money: 0.64;
a market that barely moves early in its life: 0.1).
Reset: whenever the mid sits at the entry price with the slow price caught up, the trader closes
(P&L ~ 0, so the accrued fee is cancelled: "a losing position pays nothing") and re-opens.
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import regime

NP = 300_000
TAU_S = 300.0
TAU_E = 30 * 86400.0
h, st, pr = regime("full")
print(f"{'L':>3} {'v':>5} {'reset':>6} | {'EV':>8} {'s.e.':>7} | {'crowding paid':>13} {'% of gross wins':>15} {'profit share':>12} | {'resets':>6} {'hold (days)':>11}")
for L in [25, 10, 5, 3]:
    for v in [1.0, 0.64, 0.1]:
        lam = v * 0.25 / (TAU_E * h * h)
        for reset in [False, True]:
            leg = Leg(+1, table_const(h, L), table_const(h, np.inf), tp_eps=0.1, crowd_rate=1.0 / TAU_E, crowd_reset=reset, reset_eps=0.02)
            r = run(NP, 50, h, st, pr, lam=lam, legs=[leg], tau_s=TAU_S, seed=51)[0]
            mu, se = stat(r["pnl"])
            gw = r["gross_win"].mean()
            print(f"{L:3d} {v:5.2f} {str(reset):>6} | {mu:+8.4f} {se:7.4f} | {r['crowd'].mean():13.4f} {100 * r['crowd'].mean() / gw:14.1f}% {r['fee'].mean():12.4f} | "
                  f"{r['nreset'].mean():6.2f} {r['dur'].mean() / 86400:11.2f}")
    sys.stdout.flush()
