"""
Free-mode traders on each side of the one-touch, maximum allowed leverage, hold until the position
ends (liquidated / collected / resolved).  200,000 paths per row.

Block A: pure GBM (no gaps), 320 days before the contract end. Uninformed entry (fair value uniformly
         within half a tick of the mid).
Block B: GBM + earnings gaps (sd 7%), entry 1 hour / 1 day / 5 days before the first release.
"""
import sys
import time
import numpy as np
from multiprocessing import Pool
from model import OneTouch
import rules as R
from lifecycle import simulate, summarize

N = 200_000
_models = {}


def get_model(gaps):
    if gaps not in _models:
        _models[gaps] = OneTouch(gap_days=(45.0, 136.0, 227.0, 318.0) if gaps else (), gap_sd=0.07)
    return _models[gaps]


def run(cfg):
    name, gaps, t0_days, p0, side, dt_sec, seed = cfg
    m = get_model(gaps)
    rng = np.random.default_rng(seed)
    t0 = t0_days / 365.0
    tau = (m.T - t0) * 365 * 86400.0
    L = float(R.max_leverage(p0, tau))
    no_fn = lambda y, t: np.interp(y, m.y, m.row(t))
    y_from = lambda f, t: m.y_from_yes(f, m.row(t))
    t_start = time.time()
    out = simulate(no_fn, y_from, m.T, m.sigma, t0, p0, side, L, N, dt_sec, rng,
                   gap_times=m.gap_t if gaps else (), gap_sd=m.gap_sd)
    s1 = summarize(out, skew=1.0)
    s0 = summarize(out, skew=0.0)
    # split by whether the position was still open at a release
    sp = out["spanned"]
    tr, ho, _ = R.settle(out["r"], 0.0, out["kind"] == 0)
    ev_span = tr[sp].mean() if sp.any() else float("nan")
    ev_span_se = tr[sp].std(ddof=1) / np.sqrt(sp.sum()) if sp.sum() > 1 else float("nan")
    ev_nospan = tr[~sp].mean() if (~sp).any() else float("nan")
    return dict(name=name, gaps=gaps, t0=t0_days, p0=p0, side=side, L=L, s0=s0, s1=s1, secs=time.time() - t_start,
                ev_span=ev_span, ev_span_se=ev_span_se, ev_nospan=ev_nospan)


if __name__ == "__main__":
    cfgs = []
    seed = 100
    for p0 in (0.10, 0.30, 0.50, 0.70, 0.90):
        for side in ("YES", "NO"):
            seed += 1
            cfgs.append(("A", False, 45.0, p0, side, 120.0 if p0 <= 0.10 else 60.0, seed))
    for lead_days in (1.0 / 24.0, 1.0, 5.0):
        for p0 in (0.20, 0.80):
            for side in ("YES", "NO"):
                seed += 1
                cfgs.append(("B", True, 45.0 - lead_days, p0, side, 60.0, seed))
    if "--quick" in sys.argv:
        N = 20_000
    with Pool(6) as pool:
        res = pool.map(run, cfgs, chunksize=1)
    hdr = "%5s %4s %3s | %8s %7s | %8s %7s | %8s %7s | %6s %6s %6s %6s | %7s %6s" % (
        "YES", "side", "L", "EV/M", "s.e.", "house/M", "s.e.", "EV(fee1)", "crowd", "P(col)", "P(liq)", "P(res)", "P(t/o)", "hold d", "liqfee")
    print("=== Block A: pure GBM, 320 days to the contract end, max leverage, uninformed entry ===")
    print("    EV/M, house/M: crowding fee off (skewFrac = 0).  EV(fee1): trader EV with skewFrac = 1.")
    print(hdr)
    for r in res:
        if r["name"] != "A":
            continue
        s0, s1 = r["s0"], r["s1"]
        print("%5.2f %4s %3d | %+8.4f %7.4f | %+8.4f %7.4f | %+8.4f %7.4f | %6.3f %6.3f %6.3f %6.3f | %7.2f %6.4f" % (
            r["p0"], r["side"], r["L"], s0["ev"], s0["ev_se"], s0["house"], s0["house_se"], s1["ev"], s1["crowd"],
            s0["p_cap"], s0["p_liq"], s0["p_res"], s0["p_to"], s0["hold_days"], s0["liq"]))
    print("\n=== Block B: GBM + earnings gaps (sd 7%), entry before the first release, max leverage ===")
    print("%7s %5s %4s %3s | %8s %7s | %8s %7s | %7s | %9s %7s | %9s" % (
        "lead", "YES", "side", "L", "EV/M", "s.e.", "house/M", "s.e.", "spanned", "EV|span", "s.e.", "EV|no span"))
    for r in res:
        if r["name"] != "B":
            continue
        s0 = r["s0"]
        print("%6.2fd %5.2f %4s %3d | %+8.4f %7.4f | %+8.4f %7.4f | %7.3f | %+9.4f %7.4f | %+9.4f" % (
            45.0 - r["t0"], r["p0"], r["side"], r["L"], s0["ev"], s0["ev_se"], s0["house"], s0["house_se"],
            s0["spanned"], r["ev_span"], r["ev_span_se"], r["ev_nospan"]))
    print("\nrun times (s):", " ".join("%.0f" % r["secs"] for r in res))
