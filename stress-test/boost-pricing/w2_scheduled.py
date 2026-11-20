"""
World B: all (or a known share of) variance arrives at one scheduled time that is well before the
market's expiry. Boosted single legs and YES+NO straddles.

  A. tight window: open 60 s before the news, close 900 s after (slow price has covered 95% of the jump)
  B. the brief's window: open 24 h before, close 24 h after (exact, two outcomes x leverage grid)
  C. the night as a fast diffusion (no jump at all), 4 s keeper steps
  D. free mode through the same jump (control)
"""
import json, sys, time
import numpy as np
from engine import *

N = 200_000
DAY = 86400.0
OUT = {}
t00 = time.time()


def two_point(p0, d):
    return lambda n, rng: p0 + d * np.where(rng.random(n) < 0.5, 1.0, -1.0)


def resolution(p0):
    return lambda n, rng: np.where(rng.random(n) < (p0 - PMIN) / (PMAX - PMIN), PMAX, PMIN)


def law(vals, probs):
    vals, probs = np.array(vals), np.array(probs)
    return lambda n, rng: rng.choice(vals, size=n, p=probs / probs.sum())


def normal_jump(p0, sd):
    def f(n, rng):
        z = np.clip(rng.standard_normal(n), -4, 4)
        lim = min(p0, 1 - p0) - 0.02
        return p0 + np.clip(sd * z, -lim, lim)
    return f


def tight(label, p0, sampler, L, variant="brief", fc=True, boost=True, tau_J=30 * DAY, pre=60.0, wait=900.0,
          seed=1, rv_scale=None, tau_of=None, npaths=N):
    dt = 4.0
    kJ = int(pre / dt)
    nsteps = kJ + int(wait / dt)
    tau0 = tau_J + pre
    w = ScheduledJump(p0, kJ * dt, sampler)
    y = Book(npaths, +1, boost=boost, variant=variant)
    no = Book(npaths, -1, boost=boost, variant=variant)
    run(w, [y, no], OpenHoldClose(0, L, nsteps), npaths, dt, nsteps, tau0=tau0, seed=seed, force_close=fc,
        rv_scale=rv_scale, tau_of=tau_of)
    sy, sn, ss = summarize([y], label + " | YES leg"), summarize([no], label + " | NO leg"), summarize([y, no], label + " | STRADDLE")
    tot = y.trader + no.trader
    ss["p_straddle_profit"] = float((tot > 0).mean())
    ss["straddle_min"] = float(tot.min() / 2.0)
    ss["L_used"] = float(y.L.max())
    return sy, sn, ss


print("=" * 150)
print("A. TIGHT WINDOW (open 60 s before, close 900 s after), tau at the news = 30 days, 200,000 paths")
print("=" * 150)
rows = []
p0 = 0.5
tauJ = 30 * DAY
for d in (0.02, 0.03, 0.05, 0.10, 0.20, 0.30):
    for fc in (False, True):
        L = 25
        sy, sn, ss = tight(f"p0=.50 +-{d:.2f} L=25 brief fc={'on ' if fc else 'off'}", p0, two_point(p0, d), L, "brief", fc, seed=int(d * 1000) + fc)
        print(fmt(sy)); print(fmt(ss) + f"  P(straddle>0)={ss['p_straddle_profit']:.3f} min={ss['straddle_min']:+.2f}")
        rows.append(("two_point", d, L, "brief", fc, sy, ss))
        if fc:
            Ls = float(min(25.0, ltime_int(np.array([p0 + d]), tauJ)[0]))
            if Ls < 25:
                sy, sn, ss = tight(f"p0=.50 +-{d:.2f} L={Ls:.0f} (sized under post-jump Ltime) fc=on", p0, two_point(p0, d), Ls, "brief", True, seed=77)
                print(fmt(sy)); print(fmt(ss) + f"  P(straddle>0)={ss['p_straddle_profit']:.3f} min={ss['straddle_min']:+.2f}")
                rows.append(("two_point_sized", d, Ls, "brief", True, sy, ss))

# code-variant premium, same attack (shows the premium is irrelevant in the tight window)
sy, sn, ss = tight("p0=.50 +-0.10 L=25 CODE premium fc=off", p0, two_point(p0, 0.10), 25, "code", False, seed=5)
print(fmt(sy)); print(fmt(ss))
rows.append(("two_point_code", 0.10, 25, "code", False, sy, ss))

print("\n-- jump to (near) resolution 0.99 / 0.01, expiry still 30 days away")
for L, fc in ((25, False), (10, False), (25, True), (4, True)):
    sy, sn, ss = tight(f"p0=.50 resolution L={L} brief fc={'on ' if fc else 'off'}", p0, resolution(p0), L, "brief", fc, seed=31 + L)
    print(fmt(sy)); print(fmt(ss) + f"  P(straddle>0)={ss['p_straddle_profit']:.3f} min={ss['straddle_min']:+.2f}")
    rows.append(("resolution", 0.49, L, "brief", fc, sy, ss))

print("\n-- asymmetric laws (mean 0.50)")
# worst-case single-leg law at L=25: up to the 10x cap line 0.70 with prob 5/7... mean check: 0.70q + 0.01(1-q) = 0.5 -> q = 0.7101
q = (0.5 - 0.01) / (0.70 - 0.01)
sy, sn, ss = tight("p0=.50 law{0.70:71%, 0.01:29%} L=25 fc=off", p0, law([0.70, 0.01], [q, 1 - q]), 25, "brief", False, seed=41)
print(fmt(sy)); print(fmt(sn)); print(fmt(ss))
rows.append(("worst_law", 0.2, 25, "brief", False, sy, ss))
sy, sn, ss = tight("p0=.50 law{0.70:71%, 0.01:29%} L=24 fc=on", p0, law([0.70, 0.01], [q, 1 - q]), 24, "brief", True, seed=42)
print(fmt(sy)); print(fmt(sn)); print(fmt(ss))
rows.append(("worst_law_fc", 0.2, 24, "brief", True, sy, ss))
# small-up / big-down and the reverse
sy, sn, ss = tight("p0=.50 law{0.53:80%, 0.38:20%} L=25 fc=on", p0, law([0.53, 0.38], [0.8, 0.2]), 25, "brief", True, seed=43)
print(fmt(sy)); print(fmt(sn)); print(fmt(ss))
rows.append(("skew", 0.03, 25, "brief", True, sy, ss))
for sd in (0.03, 0.08):
    for L in (25, 15):
        sy, sn, ss = tight(f"p0=.50 jump ~ N(0,{sd:.2f}) L={L} fc=on", p0, normal_jump(p0, sd), L, "brief", True, seed=50 + L)
        print(fmt(sy)); print(fmt(ss) + f"  P(straddle>0)={ss['p_straddle_profit']:.3f} min={ss['straddle_min']:+.2f}")
        rows.append(("normal", sd, L, "brief", True, sy, ss))

print("\n-- other price levels (tick limit: L = min(p,1-p)/0.02)")
for p0_, d in ((0.30, 0.05), (0.30, 0.10), (0.80, 0.05), (0.80, 0.10), (0.15, 0.05)):
    L = float(lmax_open(np.array([p0_]), tauJ)[0])
    sy, sn, ss = tight(f"p0={p0_:.2f} +-{d:.2f} L={L:.0f} brief fc=on", p0_, two_point(p0_, d), L, "brief", True, seed=int(p0_ * 100 + d * 1000))
    print(fmt(sy)); print(fmt(sn)); print(fmt(ss) + f"  P(straddle>0)={ss['p_straddle_profit']:.3f}")
    rows.append(("level", (p0_, d), L, "brief", True, sy, ss))

print("\n-- shorter time to expiry at the news (E3 time limit binds); +-10 points")
for tj in (12 * DAY, 5 * DAY, 2 * DAY, 1 * DAY):
    L = float(min(lmax_open(np.array([0.5]), tj)[0], ltime_int(np.array([0.6]), tj)[0]))
    sy, sn, ss = tight(f"tau={tj/DAY:.0f}d p0=.50 +-0.10 L={L:.0f} brief fc=on", 0.5, two_point(0.5, 0.10), L, "brief", True, tau_J=tj, seed=int(tj))
    print(fmt(ss) + f"  P(straddle>0)={ss['p_straddle_profit']:.3f}")
    rows.append(("tau", tj / DAY, L, "brief", True, sy, ss))

OUT["tight"] = [dict(kind=str(r[0]), d=str(r[1]), L=r[2], variant=r[3], fc=r[4], leg=r[5], straddle=r[6]) for r in rows]

print("\n" + "=" * 150)
print("D. CONTROL: FREE MODE through the same scheduled jump (cap C = M(1-p0)/p0), tight window, fc=on")
print("=" * 150)
rows = []
for p0_, d in ((0.50, 0.05), (0.50, 0.10), (0.40, 0.05), (0.30, 0.05), (0.30, 0.10), (0.20, 0.08), (0.20, 0.10)):
    L = float(lmax_open(np.array([p0_]), tauJ)[0])
    sy, sn, ss = tight(f"FREE p0={p0_:.2f} +-{d:.2f} L={L:.0f}", p0_, two_point(p0_, d), L, "brief", True, boost=False, seed=int(p0_ * 100 + d * 1000) + 9)
    print(fmt(sy)); print(fmt(sn)); print(fmt(ss))
    rows.append((p0_, d, L, sy, sn, ss))
OUT["free"] = [dict(p0=r[0], d=r[1], L=r[2], yes=r[3], no=r[4], straddle=r[5]) for r in rows]

print("\n" + "=" * 150)
print("B. THE BRIEF'S WINDOW: open 24 h before, close 24 h after. Exact (two outcomes), best integer leverage for the booster")
print("=" * 150)


def day_window(p0, d, tau_J, variant, fc, resolution_jump=False):
    """Exact EV for every integer leverage 1..25: paths = (leverage, outcome). Returns arrays over L."""
    Ls = np.arange(1, 26, dtype=float)
    dt = 60.0
    kJ = int(DAY / dt)
    nsteps = 2 * kJ
    if resolution_jump:
        outs = np.array([PMAX, PMIN]); pr = np.array([(p0 - PMIN) / (PMAX - PMIN), 1 - (p0 - PMIN) / (PMAX - PMIN)])
    else:
        outs = np.array([p0 + d, p0 - d]); pr = np.array([0.5, 0.5])
    Lgrid = np.repeat(Ls, 2)
    p1 = np.tile(outs, len(Ls))
    w = ScheduledJump(p0, kJ * dt, lambda n, rng: p1)
    y = Book(len(Lgrid), +1, True, variant=variant)
    no = Book(len(Lgrid), -1, True, variant=variant)
    tau0 = tau_J + DAY
    run(w, [y, no], OpenHoldClose(0, Lgrid, nsteps), len(Lgrid), dt, nsteps, tau0=tau0, force_close=fc)
    ty = (y.trader.reshape(-1, 2) * pr).sum(1)
    tn = (no.trader.reshape(-1, 2) * pr).sum(1)
    Lact = y.L.reshape(-1, 2)[:, 0]
    return Ls, Lact, ty, tn, (ty + tn) / 2


rowsB = []
for variant in ("brief", "code"):
    for fc in (True, False):
        print(f"\n premium variant = {variant}, keeper force-close = {'on' if fc else 'off'}")
        print(f"   {'tau at news':>11s} {'jump':>12s} | {'best L':>6s} {'YES-leg EV/$':>13s} {'straddle EV/$':>14s} | L=5 leg, L=10 leg, L=25 leg")
        for tj in (2 * DAY, 7 * DAY, 30 * DAY, 75 * DAY):
            for d in (0.05, 0.10, 0.20, None):
                Ls, Lact, ty, tn, st = day_window(0.5, d or 0.49, tj, variant, fc, resolution_jump=(d is None))
                valid = Lact == Ls  # leverage actually available at open
                tyv = np.where(valid, ty, -9)
                i = int(np.argmax(tyv))
                g = lambda L: (f"{ty[int(L)-1]:+.3f}" if valid[int(L) - 1] else "  n/a ")
                print(f"   {tj/DAY:>9.0f} d {('+-%.2f' % d) if d else 'to 0.99/0.01':>12s} | {Ls[i]:>6.0f} {ty[i]:>+13.3f} {st[i]:>+14.3f} | {g(5)}, {g(10)}, {g(25)}")
                rowsB.append(dict(variant=variant, fc=fc, tau_days=tj / DAY, d=d, bestL=float(Ls[i]), leg=float(ty[i]), straddle=float(st[i]),
                                  leg_by_L={int(L): float(v) for L, v, ok in zip(Ls, ty, valid) if ok}))
OUT["day_window"] = rowsB

# Monte Carlo confirmation of two cells of table B (200k paths, random outcome)
print("\n MC confirmation (200,000 paths) of two table-B cells, brief premium, fc=on:")
for tj, d, L in ((30 * DAY, 0.10, 24), (30 * DAY, 0.05, 10)):
    dt = 60.0; kJ = int(DAY / dt); nsteps = 2 * kJ
    w = ScheduledJump(0.5, kJ * dt, two_point(0.5, d))
    y = Book(N, +1, True, variant="brief"); no = Book(N, -1, True, variant="brief")
    run(w, [y, no], OpenHoldClose(0, L, nsteps), N, dt, nsteps, tau0=tj + DAY, seed=int(tj + L), force_close=True)
    print("  " + fmt(summarize([y], f"day-before/day-after tau=30d +-{d:.2f} L={L} YES leg")))
    print("  " + fmt(summarize([y, no], f"day-before/day-after tau=30d +-{d:.2f} L={L} STRADDLE")))
    OUT.setdefault("day_window_mc", []).append(dict(d=d, L=L, leg=summarize([y]), straddle=summarize([y, no])))

json.dump(OUT, open("out_w2_scheduled_ABD.json", "w"), indent=1, default=float)
print(f"\nelapsed {time.time()-t00:.0f}s")
