"""
E11.  The honest bet on the geometry of the one live "BTC >= K" contract: 66.5c, 11 days out,
maximum leverage 16x.  Reference mid on the half-cent lattice (the live book moved in half-cent steps).
Under the venue's own volatility model (variance p(1-p)/tau per second) that is 0.0094 half-cent
changes per second: 2.8 per slow-price time constant.  200,000 paths per cell.
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import lattice_value
NP, TAU_S, h = 200_000, 300.0, 0.005
st, pr = [-1, 1], [0.5, 0.5]
p0 = 0.665
tau_e = 11 * 86400.0
lam_model = p0 * (1 - p0) / (tau_e * h * h)
print(f"model speed: {lam_model:.4f} half-cent changes per second = {lam_model * TAU_S:.2f} per slow time constant")
for side, own in [(+1, p0), (-1, 1 - p0)]:
    L = 16
    ex = lattice_value(own, L, h, st, pr, policy="hold")
    print(f"{'YES' if side > 0 else 'NO '} at own price {own:.3f}, {L}x: stop {ex['ds_ticks']:.2f} ticks, win {ex['dw_ticks']:.2f} ticks; exact lattice (no lag) EV {ex['ev']:+.4f}, P(win) {ex['p_win']:.4f} (claim {own:.3f})")
    for lt in [0.3, 1.0, lam_model * TAU_S]:
        for label, eps, conv in [("passive (collect only)", 1e-11, False), ("active (best manual close)", None, None)]:
            best = None
            for e_, c_ in ([(eps, conv)] if eps is not None else [(0.05, False), (0.2, False), (0.5, False), (0.2, True)]):
                leg = Leg(side, table_const(h, L), table_const(h, np.inf if not c_ else 2), tp_eps=e_, tp_converge=bool(c_))
                r = run(NP, int(round(p0 / h)), h, st, pr, lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=111)[0]
                mu, se = stat(r["pnl"])
                if best is None or mu > best[0]:
                    best = (mu, se, r["nwin"].mean(), r["nliq"].mean(), r["dur"].mean() / 3600)
            print(f"   lam*tau={lt:4.2f} {label:<27} EV {best[0]:+.4f} +-{best[1]:.4f} | P(paid a profit) {best[2]:.4f} P(liq) {best[3]:.4f} | hold {best[4]:.2f} h")
        sys.stdout.flush()
