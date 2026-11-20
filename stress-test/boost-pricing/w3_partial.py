"""
World C: partial jumps at unpredictable (Poisson) times. The price has the "uniform budget"
variance rate p(1-p)/tau that E3 assumes; a share f of it arrives as jumps of size delta, the
rest as diffusion. Boosted position opened fresh, closed after its first favourable jump
(once the slow price has caught up), otherwise held until liquidated.
"""
import json, sys, time
import numpy as np
from engine import *
import exact

N = 200_000
DAY = 86400.0
OUT = {}
t00 = time.time()
which = sys.argv[1] if len(sys.argv) > 1 else "all"

if which in ("all", "cf"):
    print("=" * 130)
    print("C1. closed form: premium collected / expected gap loss, worst jump size (twice the stop distance), all variance in jumps")
    print("     two-sided: 8(L-1)/L^2 (brief premium), half of that at p=0.5 for the coded premium; one-sided crashes: 4(L-1)/L^2")
    print("=" * 130)
    print(f"{'L':>4s} {'stop dist @p=.5':>16s} {'worst jump':>11s} | {'brief 2-sided':>13s} {'brief 1-sided':>13s} | {'code 2-sided':>12s} {'code 1-sided':>12s} | max jump share of variance the brief premium covers")
    for L in (2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25):
        r2, r1 = exact.gap_ratio_two_sided(L), exact.gap_ratio_one_sided(L)
        print(f"{L:>4d} {0.5/L:>16.3f} {1.0/L:>11.3f} | {r2:>13.2f} {r1:>13.2f} | {r2*0.5:>12.2f} {r1*0.5:>12.2f} | {min(1.0, r2):>6.0%} (two-sided), {min(1.0, r1):>4.0%} (one-sided)")
    print("\n per-position trader EV per $ margin, p0 = 0.5, two-sided jumps, all variance in jumps (closed form, slow-price lag ignored)")
    print(f"{'L':>4s} {'delta':>6s} | {'brief':>8s} {'code':>8s}")
    cf = []
    for L, ds in ((25, (0.02, 0.03, 0.04, 0.06, 0.10, 0.20)), (10, (0.05, 0.07, 0.10, 0.15, 0.20, 0.30)), (5, (0.10, 0.15, 0.20, 0.30, 0.40)), (3, (0.20, 0.33, 0.45))):
        for d in ds:
            a, b = exact.poisson_cycle(0.5, L, d, "brief"), exact.poisson_cycle(0.5, L, d, "code")
            print(f"{L:>4d} {d:>6.2f} | {a:>+8.3f} {b:>+8.3f}")
            cf.append((L, d, a, b))
    OUT["closed_form"] = cf


def cell(label, p0, L, d, f, variant, mode="two", fc=True, tau0=30 * DAY, seed=1, reopen=False, tp=None, straddle=False, horizon_mult=1.0):
    n, B, cap = exact.pos(p0, L)
    c = B * hazard(p0, variant)
    T = tau0 * (1 - np.exp(-(1 - MAINT) / c)) * horizon_mult
    dt = max(4.0, np.ceil(T / 3500 / 4) * 4)
    nsteps = int(T / dt) + int(3600 / dt) + 5
    w = PoissonJumps(p0, tau0, d, f_jump=f, mode=mode)
    books = [Book(N, +1, True, variant=variant)]
    if straddle:
        books.append(Book(N, -1, True, variant=variant))
    tp_ = tp if tp is not None else 0.5 * min(n * d, cap)
    pol = OpenThenTakeProfit(0, L, tp=tp_, eps=0.0051, reopen=reopen, reopen_until=nsteps - int(1800 / dt))
    run(w, books, pol, N, dt, nsteps, tau0=tau0, seed=seed, force_close=fc)
    s = summarize(books[:1], label)
    s["dt"] = dt; s["hours"] = T / 3600; s["positions_per_path"] = float(books[0].n_opened.mean())
    out = [s]
    print(fmt(s) + f"  [dt={dt:.0f}s, horizon={T/3600:.1f}h, positions/path={s['positions_per_path']:.2f}]", flush=True)
    if straddle:
        ss = summarize(books, label + " STRADDLE")
        tot = books[0].trader + books[1].trader
        ss["p_profit"] = float((tot > 0).mean())
        print(fmt(ss) + f"  P(straddle>0)={ss['p_profit']:.3f}", flush=True)
        out.append(ss)
    return out


if which in ("all", "mc1"):
    print("\n" + "=" * 130)
    print("C2. Monte Carlo, 200,000 paths, tau0 = 30 days, p0 = 0.5, two-sided jumps, keeper force-close on")
    print("=" * 130)
    rows = []
    rows += cell("L=25 +-0.04 f=1.00 brief", 0.5, 25, 0.04, 1.0, "brief", seed=1, straddle=True)
    rows += cell("L=25 +-0.04 f=0.25 brief", 0.5, 25, 0.04, 0.25, "brief", seed=4)
    OUT["mc1"] = rows
    json.dump(OUT, open(f"out_w3_partial_{which}.json", "w"), indent=1, default=float)

if which in ("all", "mc2"):
    print("\n" + "=" * 130)
    print("C3. Monte Carlo, lower leverage")
    print("=" * 130)
    rows = []
    rows += cell("L=10 +-0.10 f=1.00 brief", 0.5, 10, 0.10, 1.0, "brief", seed=11, straddle=True)
    rows += cell("L=5  +-0.20 f=1.00 brief", 0.5, 5, 0.20, 1.0, "brief", seed=14)
    rows += cell("L=5  +-0.20 f=1.00 code ", 0.5, 5, 0.20, 1.0, "code", seed=15)
    OUT["mc2"] = rows
    json.dump(OUT, open(f"out_w3_partial_{which}.json", "w"), indent=1, default=float)

if which in ("all", "mc3"):
    print("\n" + "=" * 130)
    print("C4. Monte Carlo, ONE-SIDED crashes of delta compensated by upward drift (the YES side can only crash).")
    print("     Booster opens when slow has converged, takes profit at tp x margin measured at the close fill, re-opens. EV is per position per $ of margin.")
    print("=" * 130)

    def harvest(label, L, d, f, variant, tp, seed, hours=12.0, tau0=30 * DAY, dt=20.0):
        nsteps = int(hours * 3600 / dt)
        w = PoissonJumps(0.5, tau0, d, f_jump=f, mode="down")
        y = Book(N, +1, True, variant=variant)
        run(w, [y], Harvest(L, tp, reopen_until=nsteps - int(1800 / dt)), N, dt, nsteps, tau0=tau0, seed=seed, force_close=True)
        s_ = summarize([y], label)
        s_["positions_per_path"] = float(y.n_opened.mean()); s_["hours"] = hours
        s_["trader_per_path"] = float(y.trader.mean()); s_["trader_per_path_se"] = float(y.trader.std(ddof=1) / np.sqrt(N))
        print(fmt(s_) + f"  [positions/path={s_['positions_per_path']:.2f} in {hours:.0f}h; trader P&L per path {s_['trader_per_path']:+.3f} (se {s_['trader_per_path_se']:.3f}) with $1 at work]", flush=True)
        return s_

    rows = []
    rows.append(harvest("one-sided L=25 crash 0.04 f=1.00 brief tp=0.45", 25, 0.04, 1.0, "brief", 0.45, 21))
    rows.append(harvest("one-sided L=25 crash 0.04 f=0.25 brief tp=0.45", 25, 0.04, 0.25, "brief", 0.45, 22))
    rows.append(harvest("one-sided L=5  crash 0.20 f=1.00 brief tp=0.45", 5, 0.20, 1.0, "brief", 0.45, 24, hours=48.0, dt=60.0))
    rows.append(harvest("one-sided L=5  crash 0.20 f=1.00 code  tp=0.45", 5, 0.20, 1.0, "code", 0.45, 25, hours=48.0, dt=60.0))
    OUT["mc3"] = rows
    json.dump(OUT, open(f"out_w3_partial_{which}.json", "w"), indent=1, default=float)

print(f"\nelapsed {time.time()-t00:.0f}s")
