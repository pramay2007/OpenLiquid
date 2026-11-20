"""
E9.  When the next reference tick is predictable (Monte Carlo with the slow price, 400,000 paths).

(i)  Whole-cent walk; the trader opens at the mid with slow == mid knowing the next change is
     favourable with probability pi (pi = 1: sees the reference book change before the keeper's
     4 s poll relays it; pi < 1: a model of the underlying).  After that first change the walk
     is fair.  Exit: close at any level >= +1 tick once the slow price has caught up (or at the cap).
(ii) Paired half-steps (what the live BTC book showed): a quote shift is seen as two half-cent
     steps; after the first, the second follows in the same direction with probability rho.
     The trader opens in the direction of the first half-step, at the new mid (worse-of costs
     nothing: the mid has just moved the trader's way), and exits the same way.
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import regime, max_int_leverage

NP = 400_000
TAU_S = 300.0


def show(label, r):
    mu, se = stat(r["pnl"])
    took = r["nb"].mean()
    print(f"   {label:<46} EV {mu:+.4f} +-{se:.4f} per $1 margin | P(win) {r['nwin'].mean():.3f} P(liq) {r['nliq'].mean():.3f} "
          f"| fee {r['fee'].mean():.4f} exit lag {r['lagcost'].mean():.4f} | hold {r['dur'].sum() / max(r['nb'].sum(), 1) / 60:.0f} min | traded {took:.3f}")


which = sys.argv[1] if len(sys.argv) > 1 else "12"
if "1" in which:
    h, st, pr = regime("full")
    print("(i) known / predicted next tick, whole-cent walk")
    for p0, L in [(0.5, 25), (0.5, 10), (0.665, 16), (0.2, 10)]:
        print(f"  p0={p0}, {L}x  (one tick = {L / p0 * 0.01:.3f} of margin)")
        for pi in [1.0, 0.75, 0.6, 0.5]:
            for lt in [0.1, 0.3, 1.0]:
                best = None
                for eps in [0.05, 0.2, 0.5]:
                    leg = Leg(+1, table_const(h, L), table_const(h, 1), tp_eps=eps, tp_converge=True)
                    r = run(NP, int(round(p0 / h)), h, st, pr, lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=31,
                            first_up_prob=pi, first_wait=2.0)[0]
                    mu, _ = stat(r["pnl"])
                    if best is None or mu > best[0]:
                        best = (mu, eps, r)
                show(f"pi={pi:<4} lam*tau={lt:<4} (eps={best[1]})", best[2])
        sys.stdout.flush()

if "2" in which:
    h = 0.005
    print("\n(ii) paired half-steps: follow the first half-step of a quote shift")
    for p0, L in [(0.665, 16), (0.5, 25), (0.5, 10)]:
        k0 = int(round(p0 / h))
        print(f"  p0={p0}, {L}x  (half a tick = {L / p0 * 0.005:.3f} of margin)")
        for rho in [1.0, 0.9, 0.75, 0.6, 0.5]:
            for lt in [0.1, 0.3, 1.0]:
                best = None
                for eps in [0.05, 0.2, 0.5]:
                    leg = Leg(+1, table_const(h, L), table_const(h, 1), tp_eps=eps, tp_converge=True, follow=True, eps_in=0.05)
                    r = run(NP, k0, h, [-1, 1], [0.5, 0.5], lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=32,
                            paired=dict(delay=15.0, rho=rho), horizon_events=None, repeat=False)[0]
                    mu, _ = stat(r["pnl"])
                    if best is None or mu > best[0]:
                        best = (mu, eps, r)
                show(f"rho={rho:<4} shifts*tau={lt:<4} (eps={best[1]})", best[2])
        sys.stdout.flush()
