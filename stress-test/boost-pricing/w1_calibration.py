"""
World A (the world the premium is calibrated to): the price sits at p0 and makes ONE jump to
resolution (0.99 / 0.01) at a uniformly random time over the remaining life. Expiry itself does not move.
"""
import json, time
import numpy as np
from engine import *
import exact

N = 200_000
DAY = 86400.0
OUT = {}
t00 = time.time()

print("=" * 140)
print("A1. closed forms.  'rate' = house EV per $ of boosted margin per unit of (holding time / remaining life), short holds")
print("     'hold' = house EV per $ if the booster holds until the jump or until the premium liquidates the position")
print("=" * 140)
print(f"{'p0':>5s} {'L':>4s} | {'charged/fair':>12s} {'rate':>8s} {'hold':>8s} {'P(jump first)':>13s} | {'charged/fair':>12s} {'rate':>8s} {'hold':>8s} {'P(jump first)':>13s}")
print(f"{'':>10s} | {'--- premium as written in the brief: B(1-p)/tau ---':^46s} | {'--- as coded: B p(1-p)/tau ---':^46s}")
tab = []
for p0 in (0.2, 0.3, 0.5, 0.7, 0.8, 0.9):
    Lt = int(np.floor(min(p0, 1 - p0) / MIN_DIST + 1e-9))
    for L in sorted(set([2, 5, 10, Lt])):
        if L > Lt:
            continue
        row = [p0, L]
        line = f"{p0:>5.2f} {L:>4d} |"
        for variant in ("brief", "code"):
            n, B, cap = exact.pos(p0, L)
            fair = B * p0 * (1 - p0)  # borrowed dollars x hazard (1-p0)/tau, per unit 1/tau
            charged = B * hazard(p0, variant)
            rate = exact.calibration_rate(p0, L, variant)
            tr, ho, q = exact.calibration_hold_to_liq(p0, L, variant)
            line += f" {charged/fair:>12.2f} {rate:>+8.3f} {ho:>+8.3f} {q:>13.3f} |"
            row += [charged / fair, rate, ho, q]
        print(line)
        tab.append(row)
OUT["closed_form"] = tab

print("\n" + "=" * 140, flush=True)
print("A2. Monte Carlo, 200,000 paths, tau0 = 30 days, booster holds to the jump or to premium-liquidation; winner closes once slow has caught up")
print("=" * 140, flush=True)
rows = []
tau0 = 30 * DAY
CELLS = [  # p0, L, variant, force-close, straddle?
    (0.5, 10, "brief", False, True),
    (0.5, 10, "brief", True, False),
    (0.5, 10, "code", False, False),
    (0.5, 10, "code", True, False),
    (0.5, 25, "brief", False, False),
    (0.8, 10, "brief", False, False),
    (0.5, 4, "code", True, False),
]
for (p0, L, variant, fc, strad) in CELLS:
    tr, ho, q = exact.calibration_hold_to_liq(p0, L, variant)
    horizon = q * tau0
    dt = max(4.0, np.ceil(horizon / 1500 / 4) * 4)
    nsteps = int(horizon / dt) + int(5400 / dt) + 5
    w = FlatJumpToResolution(p0, tau0)
    books = [Book(N, +1, True, variant=variant)]
    if strad:
        books.append(Book(N, -1, True, variant=variant))
    pol = OpenThenTakeProfit(0, L, tp=0.3, eps=0.0051)
    run(w, books, pol, N, dt, nsteps, tau0=tau0, seed=int(p0 * 100) + L + (7 if fc else 0), force_close=fc)
    sy = summarize(books[:1], f"p0={p0:.2f} L={L} {variant:5s} fc={'on ' if fc else 'off'} one leg")
    print(fmt(sy) + f" [dt={dt:.0f}s]", flush=True)
    row = dict(p0=p0, L=L, variant=variant, fc=fc, leg=sy, cf_trader=tr, cf_house=ho)
    if strad:
        ss = summarize(books, f"p0={p0:.2f} L={L} {variant:5s} fc={'on ' if fc else 'off'} STRADDLE")
        print(fmt(ss), flush=True)
        row["straddle"] = ss
    if not fc:
        print(f"      closed form (one leg): trader {tr:+.4f}  house {ho:+.4f}", flush=True)
    rows.append(row)
OUT["mc_hold"] = rows

print("\n-- one-day hold at 30 days out (jump inside the day with probability 1/30)", flush=True)
rows = []
for (p0, L, variant) in ((0.5, 10, "brief"), (0.5, 10, "code")):
    dt = 60.0
    nsteps = int(DAY / dt)
    w = FlatJumpToResolution(p0, tau0)
    y = Book(N, +1, True, variant=variant)
    run(w, [y], OpenHoldClose(0, L, nsteps), N, dt, nsteps, tau0=tau0, seed=900 + L, force_close=False)
    sy = summarize([y], f"1-day hold p0={p0:.2f} L={L} {variant:5s} fc=off one leg")
    print(fmt(sy), flush=True)
    print(f"      closed-form rate x (1/30): house {exact.calibration_rate(p0, L, variant)/30:+.4f}", flush=True)
    rows.append(dict(p0=p0, L=L, variant=variant, leg=sy))
OUT["mc_1day"] = rows
json.dump(OUT, open("out_w1_calibration.json", "w"), indent=1, default=float)
print(f"\nelapsed {time.time()-t00:.0f}s")
