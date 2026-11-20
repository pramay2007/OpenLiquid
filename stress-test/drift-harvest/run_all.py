"""
Production Monte Carlo for the drift-harvest stress test.  200,000 paths per configuration.
Usage: python3 run_all.py [group ...]      (groups: G1 G2 G3 G4 G5 G6 G7; default all)
Results are appended to results.json and printed as tables.
"""
import json, math, os, sys, time, zlib
from multiprocessing import Pool
from ol_sim import simulate, evaluate, DAY

N = int(os.environ.get("NPATHS", 200_000))
HERE = os.path.dirname(os.path.abspath(__file__))


def tasks():
    T = []

    def add(group, label, **kw):
        T.append((group, label, kw))

    # ---- G1: constant hazard, 30-day contract, 1c ticks, random tick phase -------------------
    for p0, Hd, dt in [(0.5, 5, 300.0), (0.9, 10, 600.0), (0.2, 8, 600.0)]:
        b = dict(T=30 * DAY, p0=p0, H=Hd * DAY, dt=dt, phase_random=True)
        g = f"G1 const hazard, tau0=30d, p0={p0}, window {Hd}d"
        add(g, "1x benchmark (no leverage)", strategy="one", fee_mode="E4", **b)
        add(g, "cap: no crowding fee", strategy="cap", fee_mode="none", **b)
        add(g, "cap: no fee, integer leverage", strategy="cap", fee_mode="none", int_lev=True, **b)
        add(g, "cap: E4 skewFrac=1", strategy="cap", fee_mode="E4", sf=1.0, **b)
        for sf in [0.9, 0.75, 0.5, 0.25]:
            add(g, f"cap: E4 skewFrac={sf}", strategy="cap", fee_mode="E4", sf=sf, **b)
        add(g, "bank each tick: no fee", strategy="bank", fee_mode="none", **b)
        add(g, "bank each tick, no resets: E4 sf=1", strategy="bank", fee_mode="E4", reset_every=1e18, **b)
        add(g, "RESET ATTACK (bank + reset 1h): E4 sf=1", strategy="bank", fee_mode="E4", reset_every=3600.0, **b)
        add(g, "reset attack, reset every 6h", strategy="bank", fee_mode="E4", reset_every=6 * 3600.0, **b)
        add(g, "reset attack, reset every 24h", strategy="bank", fee_mode="E4", reset_every=24 * 3600.0, **b)
        add(g, "reset attack, contract slow price (exp)", strategy="bank", fee_mode="E4", slow_mode="exp", **b)
        add(g, "reset attack vs FIX one-tick entry charge", strategy="bank", fee_mode="E4", entry_ticks=1.0, **b)
        add(g, "reset attack vs FIX side-level carry", strategy="bank", fee_mode="E4", carry=True, **b)
        add(g, "reset attack vs FIX price-space fee", strategy="bank", fee_mode="E4", price_fee=1.0, **b)
        add(g, "cap vs FIX price-space fee", strategy="cap", fee_mode="E4", price_fee=1.0, **b)
        add(g, "tick snipe (stale signed price): E4 sf=1", strategy="snipe", fee_mode="E4", **b)
        add(g, "tick snipe vs FIX one-tick entry charge", strategy="snipe", fee_mode="E4", entry_ticks=1.0, **b)

    # ---- G2: short-dated constant hazard --------------------------------------------------------
    for Td, Hd, dt, rs in [(3, 1.0, 60.0, 600.0), (1, 0.25, 30.0, 300.0), (7, 2.0, 120.0, 1200.0)]:
        b = dict(T=Td * DAY, p0=0.5, H=Hd * DAY, dt=dt, phase_random=True)
        g = f"G2 const hazard, tau0={Td}d, p0=0.5, window {Hd}d"
        add(g, "cap: no crowding fee", strategy="cap", fee_mode="none", **b)
        add(g, "cap: E4 skewFrac=1", strategy="cap", fee_mode="E4", **b)
        add(g, "bank each tick: no fee", strategy="bank", fee_mode="none", **b)
        add(g, f"RESET ATTACK (reset {rs:.0f}s): E4 sf=1", strategy="bank", fee_mode="E4", reset_every=rs, **b)
        add(g, "reset attack, loose bank (slow within 0.2 tick)", strategy="bank", fee_mode="E4",
            reset_every=rs, tol_gap=2e-3, **b)
        add(g, "reset attack tuned (bank 0.16 tick, reset gap 2e-5, 120s)", strategy="bank", fee_mode="E4",
            reset_every=120.0, tol_gap=1.6e-3, reset_gap=2e-5, **b)
        add(g, "reset attack tuned, contract slow price (exp)", strategy="bank", fee_mode="E4",
            reset_every=120.0, tol_gap=1.6e-3, reset_gap=2e-5, slow_mode="exp", **b)
        add(g, "reset attack tuned (bank 0.3 tick, reset gap 1e-4, 60s)", strategy="bank", fee_mode="E4",
            reset_every=60.0, tol_gap=3e-3, reset_gap=1e-4, **b)
        add(g, "reset attack tuned vs FIX one-tick entry charge", strategy="bank", fee_mode="E4",
            reset_every=120.0, tol_gap=1.6e-3, reset_gap=2e-5, entry_ticks=1.0, **b)
        add(g, "reset attack tuned vs FIX side-level carry", strategy="bank", fee_mode="E4",
            reset_every=120.0, tol_gap=1.6e-3, reset_gap=2e-5, carry=True, **b)
        add(g, "1x benchmark (no leverage)", strategy="one", fee_mode="E4", **b)
        add(g, "reset attack vs FIX one-tick entry charge", strategy="bank", fee_mode="E4", reset_every=rs,
            entry_ticks=1.0, **b)

    # ---- G3: true uncertainty window shorter than the contract ---------------------------------
    for p0 in [0.5, 0.9]:
        for Tt_d, dt in [(10, 300.0), (3, 120.0)]:
            b = dict(T=30 * DAY, T_true=Tt_d * DAY, p0=p0, H=0.6 * Tt_d * DAY, dt=dt, phase_random=True)
            g = f"G3 contract 30d, true window {Tt_d}d, p0={p0}"
            add(g, "cap: no crowding fee", strategy="cap", fee_mode="none", **b)
            add(g, "cap: E4 skewFrac=1 (fee fully collected)", strategy="cap", fee_mode="E4", **b)
            add(g, "reset attack: E4 sf=1", strategy="bank", fee_mode="E4", reset_every=1800.0, **b)
            add(g, "cap, L<=5 vs FIX one-tick entry charge", strategy="cap", fee_mode="E4", entry_ticks=1.0,
                Lcap=5.0, **b)
            add(g, "cap vs FIX side-level carry", strategy="cap", fee_mode="E4", carry=True, **b)
            add(g, "cap vs FIX fee horizon = true window", strategy="cap", fee_mode="E4", T_fee=Tt_d * DAY, **b)
            add(g, "cap vs FIX price-space fee", strategy="cap", fee_mode="E4", price_fee=1.0, **b)
            add(g, "reset attack vs FIX price-space fee", strategy="bank", fee_mode="E4", price_fee=1.0,
                reset_every=1800.0, **b)

    # ---- G4: front-loaded hazard through learning (two hidden states, no diffusion) -------------
    T30 = 30 * DAY
    for nm, pi0, xH, xL, p0lab, Hd in [("p0=0.90: 20% chance the event is 'live' (hazard ln2/30d), else never",
                                         0.2, math.log(2), 0.0, 0.9, 10),
                                        ("p0=0.50: 60% chance 'live' (hazard 1.79/30d), else never",
                                         0.6, math.log(6), 0.0, 0.5, 5)]:
        b = dict(T=T30, pi0=pi0, lamH=xH / T30, lamL=xL / T30, H=Hd * DAY, dt=300.0 if p0lab == 0.5 else 600.0)
        g = f"G4 learning model, {nm}"
        add(g, "1x benchmark (no leverage)", strategy="one", fee_mode="E4", **b)
        add(g, "cap: no crowding fee", strategy="cap", fee_mode="none", **b)
        add(g, "cap: E4 skewFrac=1 (fee fully collected)", strategy="cap", fee_mode="E4", **b)
        add(g, "reset attack: E4 sf=1", strategy="bank", fee_mode="E4", **b)
        add(g, "cap vs FIX price-space fee", strategy="cap", fee_mode="E4", price_fee=1.0, **b)

    # ---- G5: diffusion + one-sided jump (two states + Brownian news about the state) ------------
    # Path-wise simulation (prices differ path by path).  p0 = 0.5 with pi0 = 0.5.
    xH, xL = 1.2279, 0.34657
    rk = dict(strategy="bank", fee_mode="E4", hold_ticks=2, tol_gap=2e-3, reset_gap=2e-5, reset_every=3600.0)

    def noisy(tpd, **kw):
        kappa = tpd * 0.01 / (abs(math.exp(-xH) - math.exp(-xL)) * 0.25 * math.sqrt(DAY))
        return dict(T=T30, pi0=0.5, lamH=xH / T30, lamL=xL / T30, kappa=kappa, H=5 * DAY, dt=600.0, **kw)

    g = "G5 noisy, p0=0.5, tau0=30d, diffusion 2 tick/sqrt(day)"
    add(g, "1x benchmark (no leverage)", **noisy(2.0, strategy="one", fee_mode="E4"))
    for Lc in [5.0, 10.0, 25.0]:
        add(g, f"L<={Lc:.0f} cap: no crowding fee", **noisy(2.0, strategy="cap", fee_mode="none", Lcap=Lc))
        add(g, f"L<={Lc:.0f} cap: E4 sf=1", **noisy(2.0, strategy="cap", fee_mode="E4", Lcap=Lc))
    for Lc in [10.0, 15.0]:
        add(g, f"L<={Lc:.0f} RESET ATTACK (bank>=2 ticks, reset when under water): E4 sf=1", **noisy(2.0, Lcap=Lc, **rk))
        add(g, f"L<={Lc:.0f} reset attack vs FIX side-level carry", **noisy(2.0, Lcap=Lc, carry=True, **rk))
    add(g, "L<=10 reset attack vs FIX price-space fee", **noisy(2.0, Lcap=10.0, price_fee=1.0, **rk))
    add(g, "L<=10 reset attack vs FIX one-tick entry charge", **noisy(2.0, Lcap=10.0, entry_ticks=1.0, **rk))
    add(g, "L<=10 cap vs FIX price-space fee", **noisy(2.0, strategy="cap", fee_mode="E4", Lcap=10.0, price_fee=1.0))
    for tpd, Lc in [(1.0, 15.0), (4.0, 7.0)]:
        g = f"G5 noisy, p0=0.5, tau0=30d, diffusion {tpd:.0f} tick/sqrt(day)"
        add(g, f"L<={Lc:.0f} cap: no crowding fee", **noisy(tpd, strategy="cap", fee_mode="none", Lcap=Lc))
        add(g, f"L<={Lc:.0f} cap: E4 sf=1", **noisy(tpd, strategy="cap", fee_mode="E4", Lcap=Lc))
        add(g, f"L<={Lc:.0f} RESET ATTACK: E4 sf=1", **noisy(tpd, Lcap=Lc, **rk))

    # ---- G6: last hour (fee tau floored at 1 h) --------------------------------------------------
    for tau0 in [3600.0, 2400.0]:
        b = dict(T=tau0, p0=0.5, H=tau0 - 300.0, dt=5.0, phase_random=True, Lmin=1.01)
        g = f"G6 last hour, tau0={tau0:.0f}s, p0=0.5, constant hazard"
        add(g, "cap: no crowding fee", strategy="cap", fee_mode="none", **b)
        add(g, "cap: E4 skewFrac=1", strategy="cap", fee_mode="E4", **b)
        add(g, "bank: E4 skewFrac=1", strategy="bank", fee_mode="E4", reset_every=60.0, tol_gap=2e-3, **b)
        add(g, "one shot at the Ltime limit (no planning): no fee", strategy="cap", fee_mode="none",
            plan=False, max_opens=1, **b)
        add(g, "one shot at the Ltime limit (no planning): E4 sf=1", strategy="cap", fee_mode="E4",
            plan=False, max_opens=1, **b)
        add(g, "one shot at half the Ltime excess: E4 sf=1", strategy="cap", fee_mode="E4",
            plan=False, max_opens=1, Lcap=1.0 + 0.5 * (math.sqrt(tau0 / 120.0) / 3.0 - 1.0), **b)

    # ---- G7: favourite late in a game -----------------------------------------------------------
    for p0, mins in [(0.8, 30), (0.7, 30), (0.7, 60)]:
        b = dict(T=mins * 60.0, p0=p0, H=mins * 60.0 - 300.0, dt=5.0, phase_random=True)
        g = f"G7 favourite p={p0}, {mins} min left (one-sided crash)"
        add(g, "rules as written (expiry at event end): cap E4", strategy="cap", fee_mode="E4", **b)
        add(g, "HYPOTHETICAL no Ltime: cap, no fee", strategy="cap", fee_mode="none", e3_time=False, **b)
        add(g, "HYPOTHETICAL no Ltime: cap, E4 sf=1", strategy="cap", fee_mode="E4", e3_time=False, **b)
        add(g, "HYPOTHETICAL no Ltime: bank+reset, E4 sf=1", strategy="bank", fee_mode="E4", e3_time=False,
            reset_every=30.0, tol_gap=2e-3, **b)
    return T


def run(task):
    group, label, kw = task
    t0 = time.time()
    seed = (zlib.crc32((group + '|' + label).encode()) % 100_000) + 17
    if kw.get("kappa", 0.0) > 0:
        r = simulate(N=N, seed=seed, **kw)          # path-wise: every path has its own price path
        r["method"] = "pathwise"
    else:
        # Deterministic price between crashes: record the no-crash trajectory for K tick-phase
        # classes with the full rule engine, then Monte Carlo over (phase, hidden state, crash time).
        kw2 = {k: v for k, v in kw.items() if k != "phase_random"}
        two = "pi0" in kw2
        rec = simulate(N=(1 if two else 200), seed=seed, record=True, phase_random=not two, **kw2)
        r = evaluate(rec, N=N, seed=seed)
        r["method"] = "trajectory"
    r.update(group=group, label=label, secs=time.time() - t0)
    r["kw"] = {k: (v if not isinstance(v, float) or math.isfinite(v) else str(v)) for k, v in kw.items()}
    return r


def show(results):
    groups = {}
    for r in results:
        groups.setdefault(r["group"], []).append(r)
    for g in sorted(groups):
        print(f"\n### {g}   (N = {groups[g][0]['N']:,} paths; per $1 of margin kept deployed)")
        print(f"{'strategy / rule set':66s} {'EV per $-day':>13s} {'(se)':>9s} {'exact':>10s} {'EV/window':>10s} {'(se)':>8s} "
              f"{'m-days':>7s} {'fee paid':>8s} {'accrued':>8s} {'gap cost':>8s} {'house':>8s} {'opens':>6s} "
              f"{'liq':>5s} {'P(crash)':>8s}")
        for r in groups[g]:
            ex = f"{r['exact_rate']:+10.5f}" if "exact_rate" in r else "   (MC only)"[:10]
            print(f"{r['label']:66s} {r['ev_per_dollar_day']:+13.5f} {r['ev_per_dollar_day_se']:9.5f} {ex:>10s} "
                  f"{r['ev']:+10.4f} {r['ev_se']:8.4f} {r['mdays']:7.3f} {r['fee_paid']:8.4f} "
                  f"{r['fee_accrued']:8.4f} {r['gap_cost']:8.4f} {r['house_pnl']:+8.4f} {r['opens']:6.1f} "
                  f"{r['liqs']:5.2f} {r['p_crash_loss']:8.4f}")


if __name__ == "__main__":
    want = sys.argv[1:]
    ts = [t for t in tasks() if not want or any(t[0].startswith(w) for w in want)]
    print(f"{len(ts)} configurations x {N:,} paths", flush=True)
    t0 = time.time()
    res = []
    with Pool(int(os.environ.get("WORKERS", 6))) as pool:
        for r in pool.imap(run, ts, chunksize=1):
            res.append(r)
            print(f"  done [{len(res)}/{len(ts)}] {r['group']} | {r['label']} ({r['secs']:.0f}s)", flush=True)
    print(f"total {time.time()-t0:.0f}s")
    out = os.path.join(HERE, "results.json")
    old = []
    if os.path.exists(out):
        old = [r for r in json.load(open(out)) if not any(r["group"] == x["group"] and r["label"] == x["label"] for x in res)]
    json.dump(old + res, open(out, "w"), indent=1, default=float)
    show(res)
