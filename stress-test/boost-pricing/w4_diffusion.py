"""
World D: pure diffusion, no jumps. p_t = Phi((z0 + W_c)/sqrt(1-c)), c = t/tau0 (information arrives
evenly; the price resolves to 0/1 exactly at expiry). Mid on the 1-cent grid, keeper acts every step.
How much does a booster overpay when the stop-loss actually works?
"""
import json, sys, time
import numpy as np
from engine import *

N = 200_000
DAY = 86400.0
OUT = {}
t00 = time.time()
which = sys.argv[1] if len(sys.argv) > 1 else "all"


def cell(label, p0, L, tau0, hold, dt, variant="brief", prem_mult=1.0, fc=True, seed=1, tp=None, boost=True):
    nsteps = int(hold / dt)
    w = InfoClockDiffusion(p0, lambda t: t / tau0)
    y = Book(N, +1, boost, variant=variant, prem_mult=prem_mult)
    no = Book(N, -1, boost, variant=variant, prem_mult=prem_mult)
    pol = OpenHoldClose(0, L, nsteps) if tp is None else OpenThenTakeProfit(0, L, tp=tp, eps=0.0101, horizon_step=nsteps)
    run(w, [y, no], pol, N, dt, nsteps, tau0=tau0, seed=seed, force_close=fc)
    sy = summarize([y], label + " | one leg")
    ss = summarize([y, no], label + " | STRADDLE")
    tot = y.trader + no.trader
    ss["p_profit"] = float((tot > 0).mean())
    print(fmt(sy), flush=True)
    print(fmt(ss) + f"  P(straddle>0)={ss['p_profit']:.3f}", flush=True)
    return dict(label=label, L=L, tau_days=tau0 / DAY, hold_h=hold / 3600, variant=variant, prem_mult=prem_mult, leg=sy, straddle=ss)


rows = []
if which in ("all", "a"):
    print("=" * 150)
    print("D1. 30 days to expiry, p0 = 0.5, hold 24 h (or until liquidated / force-closed), dt = 60 s, 200,000 paths")
    print("=" * 150, flush=True)
    rows.append(cell("tau=30d L=10 brief premium", 0.5, 10, 30 * DAY, DAY, 60.0, "brief", seed=10))
    rows.append(cell("tau=30d L=10 premium OFF  ", 0.5, 10, 30 * DAY, DAY, 60.0, "brief", prem_mult=0.0, seed=10))
    rows.append(cell("tau=30d L=10 coded premium", 0.5, 10, 30 * DAY, DAY, 60.0, "code", seed=10))
    rows.append(cell("tau=30d L=25 brief premium", 0.5, 25, 30 * DAY, DAY, 60.0, "brief", seed=25))
    rows.append(cell("tau=30d L=25 premium OFF  ", 0.5, 25, 30 * DAY, DAY, 60.0, "brief", prem_mult=0.0, seed=25))
    rows.append(cell("tau=30d L=5  brief premium", 0.5, 5, 30 * DAY, DAY, 60.0, "brief", seed=5))
    json.dump(rows, open(f"out_w4_diffusion_{which}.json", "w"), indent=1, default=float)
if which in ("all", "b"):
    print("\n" + "=" * 150)
    print("D2. closer to expiry (7 days, 2 days), 200,000 paths")
    print("=" * 150, flush=True)
    rows.append(cell("tau=7d  L=10 brief, hold 24 h (dt=60s)", 0.5, 10, 7 * DAY, DAY, 60.0, "brief", seed=71))
    rows.append(cell("tau=2d  L=10 brief, hold 6 h (dt=8s)", 0.5, 10, 2 * DAY, 6 * 3600.0, 8.0, "brief", seed=21))
    rows.append(cell("tau=2d  L=10 premium OFF, hold 6 h (dt=8s)", 0.5, 10, 2 * DAY, 6 * 3600.0, 8.0, "brief", prem_mult=0.0, seed=21))
    json.dump(rows, open(f"out_w4_diffusion_{which}.json", "w"), indent=1, default=float)
print(f"\nelapsed {time.time()-t00:.0f}s")
