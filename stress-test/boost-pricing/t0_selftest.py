"""Engine self-test against hand formulas (small, fast)."""
import time
import numpy as np
from engine import *
import exact

N = 200_000
t0 = time.time()

# 1. scheduled jump, tight window, two-point +-10 points, L = 25, p0 = 0.5, tau = 30 d
p0, L, d = 0.5, 25, 0.10
dt = 4.0
kJ, wait = 15, 900.0
nsteps = kJ + int(wait / dt)
world = ScheduledJump(p0, kJ * dt, lambda n, rng: p0 + d * np.where(rng.random(n) < 0.5, 1.0, -1.0))
b = Book(N, +1, boost=True, variant="brief")
run(world, [b], OpenHoldClose(0, L, nsteps), N, dt, nsteps, tau0=30 * 86400.0, seed=11)
s = summarize([b], "sched tight +-10pt L=25 (engine)")
print(fmt(s))
ex = 0.5 * exact.sched_tight_leg(p0, L, p0 + d, wait) + 0.5 * exact.sched_tight_leg(p0, L, p0 - d, wait)
print(f"   hand formula trader EV = {ex:+.4f}  (premium neglected)")

# 2. calibration world, hold to premium liquidation
for variant in ("brief", "code"):
    p0, L = 0.5, 10
    tau0 = 7 * 86400.0
    tr, ho, q = exact.calibration_hold_to_liq(p0, L, variant)
    dt = 30.0
    nsteps = int(q * tau0 / dt) + 200
    world = FlatJumpToResolution(p0, tau0)
    b = Book(N, +1, boost=True, variant=variant)
    pol = OpenThenTakeProfit(0, L, tp=1.0, eps=0.002, horizon_step=None)
    run(world, [b], pol, N, dt, nsteps, tau0=tau0, seed=12, force_close=False)
    s = summarize([b], f"calibration p0=.5 L=10 {variant} hold-to-liq (engine)")
    print(fmt(s))
    print(f"   closed form: trader {tr:+.4f} house {ho:+.4f}  P(jump first)={q:.4f}")
print(f"elapsed {time.time()-t0:.1f}s")
