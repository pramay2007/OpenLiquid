"""
Exact (dynamic-programming) values of the price-choice edges on event markets.
Appends one JSON line per solve to dp_results.jsonl (so progress is visible).

V(0,0) = value of a position opened at the true mid at a quiet moment (slow = mid).
V(1,0) = value of a position opened at the pre-tick price when the mid has just ticked one cent in
         its favour (entry snipe, (i)).  V(J,0): same for a J-tick move.
All numbers are the trader's expected net P&L per 1 USDC of margin (so the house's expected loss,
before the liquidator's cut and the stakers' share of the profit fee).

Usage: python3 dp_tables.py [workers]
"""
import json, sys, time
from concurrent.futures import ProcessPoolExecutor, as_completed
from model import Corridor, solve_dp, value_at

CORR = {
    "A_50c_25x": (0.50, 25, False),
    "B_50c_10x": (0.50, 10, False),
    "C_50c_5x": (0.50, 5, False),
    "D_20c_10x": (0.20, 10, False),
    "E_80c_10x": (0.80, 10, False),
}

POL = {
    # name: (mode, la_nonliq, la_liq, uses_q)
    "passive": ("passive", False, False, False),
    "passive+dodge": ("passive", False, True, True),
    "opt_honest": ("opt", False, False, False),
    "opt+iii": ("opt", False, True, True),
    "opt+ii": ("opt", True, False, True),
    "opt+ii+iii": ("opt", True, True, True),
}


def job(spec):
    name, corr, lam, tau, q, pol, extra = spec
    p0, L, boost = CORR[corr]
    cor = Corridor(p0, L, boost)
    mode, la_nl, la_l, _ = POL[pol]
    wide = cor.W + cor.S > 12
    kw = dict(ds=0.02 if wide else 0.005, dt=(0.05 if wide else 0.03) / lam)
    kw.update(extra)
    t0 = time.time()
    sol = solve_dp(cor, lam, tau=tau, q=q, la_nonliq=la_nl, la_liq=la_l, mode=mode, **kw)
    out = dict(name=name, corr=corr, lam_inv=round(1 / lam), tau=tau, q=q, pol=pol, extra=extra,
               iters=sol["iters"], secs=round(time.time() - t0, 1))
    xmax = int(sol["xs"][-1])
    out["V"] = {str(j): value_at(sol, j, 0.0) for j in range(0, min(xmax, 12) + 1)}
    out["V_lag"] = {str(j): value_at(sol, j, -1.0) for j in (0, 1)}     # slow one tick below entry
    return out


def main():
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    jobs = []
    lams = [1 / 270, 1 / 1000, 1 / 100, 1 / 30]
    # Table 1: headline corridor
    for lam in lams:
        for pol in POL:
            qs = [1.0, 0.75] if POL[pol][3] else [0.0]
            for q in qs:
                jobs.append(("T1", "A_50c_25x", lam, 300.0, q, pol, {}))
    # Table 6: sensitivity to the race-win probability q
    for q in (0.05, 0.1, 0.25, 0.5):
        for lam in (1 / 270, 1 / 1000):
            jobs.append(("T6", "A_50c_25x", lam, 300.0, q, "opt+ii+iii", {}))
    # Table 5: candidate fixes / variants
    for pol, q in (("passive", 0.0), ("opt_honest", 0.0), ("opt+ii+iii", 1.0), ("opt+ii+iii", 0.75)):
        jobs.append(("T5_collect_at_mid", "A_50c_25x", 1 / 270, 300.0, q, pol, dict(collect_at_mid=True)))
        jobs.append(("T5_haircut1", "A_50c_25x", 1 / 270, 300.0, q, pol, dict(haircut=1.0, pad_top=12)))
    # Table 2: how much the slow price blunts (tau = 0, 60, 900) at the design tick rate
    for tau in (1e-9, 60.0, 900.0):
        for pol in POL:
            qs = [1.0, 0.75] if POL[pol][3] else [0.0]
            for q in qs:
                jobs.append(("T2", "A_50c_25x", 1 / 270, tau, q, pol, {}))
    # Table 3: other corridors at the design tick rate
    for corr in ("B_50c_10x", "D_20c_10x", "E_80c_10x", "C_50c_5x"):
        for pol in ("passive", "opt_honest", "opt+iii", "opt+ii+iii"):
            qs = [1.0, 0.75] if POL[pol][3] else [0.0]
            if corr == "C_50c_5x":
                qs = [1.0] if POL[pol][3] else [0.0]
            for q in qs:
                jobs.append(("T3", corr, 1 / 270, 300.0, q, pol, {}))
    t0 = time.time()
    done = 0
    with ProcessPoolExecutor(max_workers=workers) as ex, open("dp_results.jsonl", "a") as fh:
        futs = [ex.submit(job, j) for j in jobs]
        for f in as_completed(futs):
            r = f.result()
            fh.write(json.dumps(r) + "\n")
            fh.flush()
            done += 1
            print(f"[{done}/{len(jobs)} {time.time()-t0:.0f}s] {r['name']} {r['corr']} 1/lam={r['lam_inv']} tau={r['tau']} "
                  f"q={r['q']} {r['pol']} {r['extra']}: V00={r['V']['0']:+.4f} V10={r['V']['1']:+.4f} "
                  f"({r['iters']} it, {r['secs']}s)", flush=True)


if __name__ == "__main__":
    main()
