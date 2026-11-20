"""
Candidate fixes for Boost, tested against the scheduled-jump attack (exact: one path per outcome)
and, where a simulation is needed, 200,000 paths.

  F-A  tau := time until the next SCHEDULED information event (in E3 and in the premium)
  F-B  scale the premium by realised volatility
  F-C  generic shorter tau (cap tau at 1 day / 7 days)
  F-D  cap Boost leverage
"""
import json, time
import numpy as np
from engine import *

DAY = 86400.0
N = 200_000
t00 = time.time()
OUT = {}


def outcomes(p0, d):
    if d is None:
        pu = (p0 - PMIN) / (PMAX - PMIN)
        return np.array([PMAX, PMIN]), np.array([pu, 1 - pu])
    return np.array([p0 + d, p0 - d]), np.array([0.5, 0.5])


def attack_grid(p0, d, lead, tau_after, variant, fc, mode="calendar", cap=None, Lmax=25, wait=900.0, rv_scale=None):
    """
    Exact trader EV per $ for every integer leverage, YES leg and straddle, opening `lead` seconds
    before a jump at a known time.
      mode "calendar": the contract's tau is the time to the event before it, tau_after after it
      mode "expiry"  : the contract's tau is the time to expiry (event + tau_after)   [current rule]
      mode "cap"     : as "expiry" but tau is capped at `cap` seconds
    """
    Ls = np.arange(1, Lmax + 1, dtype=float)
    outs, pr = outcomes(p0, d)
    dt = 4.0 if lead <= 4 * 3600 else 60.0
    kJ = int(round(lead / dt))
    nsteps = kJ + int(wait / dt)
    tJ = kJ * dt
    if mode == "calendar":
        tau_of = lambda t: (tJ - t) if t < tJ - 1e-9 else tau_after - (t - tJ)
    elif mode == "expiry":
        tau_of = lambda t: tJ + tau_after - t
    else:
        tau_of = lambda t: min(tJ + tau_after - t, cap)
    Lg = np.repeat(Ls, 2)
    p1 = np.tile(outs, len(Ls))
    w = ScheduledJump(p0, tJ, lambda n, rng: p1)
    y = Book(len(Lg), +1, True, variant=variant)
    no = Book(len(Lg), -1, True, variant=variant)
    run(w, [y, no], OpenHoldClose(0, Lg, nsteps), len(Lg), dt, nsteps, tau0=tau_of(0.0), force_close=fc, tau_of=tau_of, rv_scale=rv_scale)
    ty = (y.trader.reshape(-1, 2) * pr).sum(1)
    tn = (no.trader.reshape(-1, 2) * pr).sum(1)
    Lact = y.L.reshape(-1, 2)[:, 0]
    opened = y.n_opened.reshape(-1, 2)[:, 0] > 0
    valid = (Lact == Ls) & opened
    return Ls, valid, ty, (ty + tn) / 2


def best(Ls, valid, ev):
    e = np.where(valid, ev, -9.0)
    i = int(np.argmax(e))
    return Ls[i], e[i]


print("=" * 130)
print("F-A. tau := time to the next scheduled information event. Attacker opens `lead` before the event at any allowed leverage, holds through it.")
print("      Best attacker EV per $ of margin (YES leg; straddle is the same at p0=0.5). Expiry is 30 days after the event.")
print("=" * 130)
rowsA = []
for variant in ("brief", "code"):
    for fc in (True, False):
        print(f"\n premium = {variant}, keeper force-close = {'on' if fc else 'OFF (nobody calls it)'}")
        print(f"   {'lead':>8s} | {'to 0.99/0.01':>22s} | {'+-0.20':>22s} | {'+-0.10':>22s}")
        for lead in (60.0, 600.0, 1200.0, 1800.0, 2700.0, 3600.0, 4320.0, 7200.0, 21600.0, 86400.0):
            cells = []
            for d in (None, 0.20, 0.10):
                Ls, valid, ty, st = attack_grid(0.5, d, lead, 30 * DAY, variant, fc, "calendar")
                L, e = best(Ls, valid, ty)
                Lmax_avail = Ls[valid].max() if valid.any() else 0
                cells.append(f"{e:+.3f} (L={L:.0f}, max {Lmax_avail:.0f})")
                rowsA.append(dict(variant=variant, fc=fc, lead=lead, d=d, bestL=float(L), ev=float(e)))
            print(f"   {lead/60:>6.0f} m | {cells[0]:>22s} | {cells[1]:>22s} | {cells[2]:>22s}")
OUT["calendar_tau"] = rowsA

print("\n   current rule for comparison (tau = time to expiry, 30 days after the event), lead 60 s:")
for d in (None, 0.20, 0.10, 0.05):
    for fc in (True, False):
        Ls, valid, ty, st = attack_grid(0.5, d, 60.0, 30 * DAY, "brief", fc, "expiry")
        L, e = best(Ls, valid, ty)
        print(f"     jump {('+-%.2f' % d) if d else 'to 0.99/0.01':>12s} fc={'on ' if fc else 'off'}: best L={L:.0f}  EV {e:+.3f} per $")

print("\n" + "=" * 130)
print("F-C. generic shorter tau (cap tau in BOTH the leverage limit and the premium), attacker opens 60 s before, closes 900 s after")
print("=" * 130)
rowsC = []
for cap in (30 * DAY, 7 * DAY, 2 * DAY, 1 * DAY, 6 * 3600.0, 3600.0):
    line = f"   tau cap {cap/DAY:>5.2f} d | max L at p=.5: {lmax_open(np.array([0.5]), cap)[0]:>3.0f} | "
    for d in (None, 0.20, 0.10, 0.05):
        Ls, valid, ty, st = attack_grid(0.5, d, 60.0, 30 * DAY, "brief", True, "cap", cap=cap)
        L, e = best(Ls, valid, ty)
        line += f"{('+-%.2f' % d) if d else 'resol.':>7s}: {e:+.3f} (L={L:.0f})  "
        rowsC.append(dict(cap_days=cap / DAY, d=d, bestL=float(L), ev=float(e)))
    # honest cost: premium per day as % of margin at the max leverage and at L=5 (brief), p=0.5
    Lm = lmax_open(np.array([0.5]), cap)[0]
    line += f"| honest premium/day: L=5 {4*0.5/0.5/(cap/DAY):.0%}, L={Lm:.0f} {(Lm-1)*0.5/0.5/(cap/DAY):.0%} of margin"
    print(line)
OUT["tau_cap"] = rowsC

print("\n" + "=" * 130)
print("F-D. cap on Boost leverage (current tau rule), attacker opens 60 s before, closes 900 s after; best leverage <= cap")
print("=" * 130)
rowsD = []
for Lcap in (25, 10, 7, 5, 3, 2):
    line = f"   Boost L <= {Lcap:>2d} | "
    for d in (None, 0.30, 0.20, 0.10, 0.05):
        for fc in (True,):
            Ls, valid, ty, st = attack_grid(0.5, d, 60.0, 30 * DAY, "brief", fc, "expiry", Lmax=Lcap)
            L, e = best(Ls, valid, ty)
            line += f"{('+-%.2f' % d) if d else 'resol.':>7s}: {e:+.3f} (L={L:.0f})  "
            rowsD.append(dict(Lcap=Lcap, d=d, bestL=float(L), ev=float(e)))
    print(line)
OUT["lev_cap"] = rowsD

print("\n" + "=" * 130)
print("F-B. premium scaled by realised volatility (1 h average, multiple clipped to [1, 10]); tight attack, 200,000 paths")
print("=" * 130)
rowsB = []
for d in (0.05, 0.10):
    for rv in (None, (3600.0, 10.0), (300.0, 10.0)):
        dt = 4.0; kJ = 15; nsteps = kJ + 225
        w = ScheduledJump(0.5, kJ * dt, lambda n, rng, d=d: 0.5 + d * np.where(rng.random(n) < 0.5, 1.0, -1.0))
        y = Book(N, +1, True, variant="brief"); no = Book(N, -1, True, variant="brief")
        run(w, [y, no], OpenHoldClose(0, 25, nsteps), N, dt, nsteps, tau0=30 * DAY + 60, seed=7, force_close=True, rv_scale=rv)
        s = summarize([y, no], f"+-{d:.2f} L=25 straddle, RV scaling {'off' if rv is None else 'avg %ds x<=%d' % (rv[0], rv[1])}")
        print(fmt(s))
        rowsB.append(dict(d=d, rv=rv, s=s))
OUT["rv_scale"] = rowsB

print("\n" + "=" * 130)
print("Honest-trader cost table: Boost premium per day as a share of margin, p = 0.5 (brief formula; the coded formula is half of this at p=0.5)")
print("=" * 130)
print(f"   {'L':>3s} | " + " | ".join(f"tau={d:>3d}d" for d in (365, 90, 30, 12, 7, 3, 1)))
for L in (2, 3, 5, 10, 25):
    print(f"   {L:>3d} | " + " | ".join(f"{(L-1)*0.5/0.5/d:>8.1%}" for d in (365, 90, 30, 12, 7, 3, 1)))
print("\n   E3 time limit at p=0.5 (max leverage) by time to the event: " + ", ".join(f"{h}h:{ltime_int(np.array([0.5]), h*3600.0)[0]:.0f}x" for h in (720, 187, 120, 72, 48, 24, 12, 6, 2, 1.2, 1)))

json.dump(OUT, open("out_fixes.json", "w"), indent=1, default=float)
print(f"\nelapsed {time.time()-t00:.0f}s")
