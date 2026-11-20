"""
World B, variant C: the scheduled night as a FAST DIFFUSION (no single jump). Information share
c(t) ramps linearly inside the night window; outside it nothing happens. Expiry is far away, so the
contract's E3 limit and Boost premium still see a quiet 30-day market.
  election night: 98% of all information in 6 hours
  debate:         15% of all information in 90 minutes
Booster opens 60 s before the window, holds through it, closes 15 min after (or is liquidated).
Keeper acts every 4 s.
"""
import json, sys, time
import numpy as np
from engine import *

N = 200_000
DAY = 86400.0
t00 = time.time()
which = sys.argv[1] if len(sys.argv) > 1 else "all"
rows = []


def night(label, L, c_end, dur, tau_after=30 * DAY, variant="brief", fc=True, seed=1, boost=True, prem_mult=1.0, tp=None):
    dt = 4.0
    pre, post = 60.0, 900.0
    nsteps = int((pre + dur + post) / dt)
    tau0 = tau_after + pre + dur + post
    clock = lambda t: c_end * min(max((t - pre) / dur, 0.0), 1.0)
    w = InfoClockDiffusion(0.5, clock)
    y = Book(N, +1, boost, variant=variant, prem_mult=prem_mult)
    no = Book(N, -1, boost, variant=variant, prem_mult=prem_mult)
    pol = OpenHoldClose(0, L, nsteps) if tp is None else OpenThenTakeProfit(0, L, tp=tp, eps=0.0201, horizon_step=nsteps)
    run(w, [y, no], pol, N, dt, nsteps, tau0=tau0, seed=seed, force_close=fc)
    sy = summarize([y], label + " | one leg")
    ss = summarize([y, no], label + " | STRADDLE")
    tot = y.trader + no.trader
    ss["p_profit"] = float((tot > 0).mean())
    print(fmt(sy), flush=True)
    print(fmt(ss) + f"  P(straddle>0)={ss['p_profit']:.3f}", flush=True)
    rows.append(dict(label=label, L=L, c_end=c_end, dur_h=dur / 3600, fc=fc, leg=sy, straddle=ss))


if which in ("all", "a"):
    print("=" * 150)
    print("election night as diffusion: 98% of information in 6 h, expiry 30 days later (contract allows L=25), 200,000 paths, 4 s steps")
    print("=" * 150, flush=True)
    night("night 6h  L=25 boost fc=on ", 25, 0.98, 6 * 3600.0, seed=25)
    night("night 6h  L=10 boost fc=on ", 10, 0.98, 6 * 3600.0, seed=10)
    json.dump(rows, open(f"out_w2c_burst_{which}.json", "w"), indent=1, default=float)
if which in ("all", "b"):
    print("\n" + "=" * 150)
    print("debate as diffusion: 15% of information in 90 min, expiry 30 days later")
    print("=" * 150, flush=True)
    night("debate 90m L=25 boost fc=on ", 25, 0.15, 5400.0, seed=125)
    night("debate 90m L=10 boost fc=on ", 10, 0.15, 5400.0, seed=110)
    night("debate 90m L=25 premium OFF ", 25, 0.15, 5400.0, seed=125, prem_mult=0.0)
    json.dump(rows, open(f"out_w2c_burst_{which}.json", "w"), indent=1, default=float)
print(f"\nelapsed {time.time()-t00:.0f}s")
