"""
Free-mode positions on the one-touch under the written rules (C simulator, 200,000 paths per row).

Block A  pure GBM (no gaps), 320 days before the contract end: each side at the maximum allowed
         leverage, uninformed entry (fair value uniformly within half a tick of the mid), held until
         liquidated / collected (closed once the worse-of close price yields 95% of the cap) / resolved.
Block B  GBM + earnings gaps (sd 7%): the same positions opened 1 hour or 1 day before the first release
         (whatever is still open 12 hours after the release is closed at the worse-of price).
Block C  the same gap-timed positions under two candidate fixes:
           calendar clock - Ltime uses the seconds to the next scheduled release
           jump pays 1x   - a favourable single-update move of more than 2 ticks is paid on M/p0 shares
Block D  the last day before the contract end near the barrier (closed form, 4-second steps):
         does the allowed leverage survive a liquidation that lands 12 s or 60 s late?
"""
import sys
import time
import numpy as np
from multiprocessing import Pool

N = 200_000
_models = {}


def get_model(gaps):
    from model import OneTouch
    if gaps not in _models:
        _models[gaps] = OneTouch(gap_days=(45.0, 136.0, 227.0, 318.0) if gaps else (), gap_sd=0.07)
    return _models[gaps]


def run(cfg):
    import csim
    import rules as R
    rng = np.random.default_rng(cfg["seed"])
    n = cfg.get("n", N)
    p0 = cfg["p0"]
    delta = rng.uniform(-0.005, 0.005, n)
    t_start = time.time()
    if cfg["block"] == "D":
        sigma, T = 0.40, 1.0
        t0 = T - cfg["days_left"] / 365.0
        y0 = csim.y_from_yes_closed(p0 + delta, T - t0, sigma)
        tau = cfg["days_left"] * 86400.0
        kw = dict(closed=(sigma, T))
    else:
        m = get_model(cfg["gaps"])
        t0 = cfg["t0_days"] / 365.0
        y0 = m.y_from_yes(p0 + delta, m.row(t0))
        tau = (m.T - t0) * 365 * 86400.0
        kw = dict(model=m)
    extra = dict(cfg.get("extra", {}))
    dt = cfg["dt"]
    out = csim.run(y0, cfg["seed"] * 7919 + 13, t0=t0, dt_sec=dt, max_steps=int(cfg.get("max_days", 120) * 86400 / dt),
                   mode=0, side=1 if cfg["side"] == "YES" else 0, lev=cfg.get("lev", 0.0), skew=cfg.get("skew", 0.0),
                   **kw, **extra)
    s = csim.stats0(out)
    # the same paths with the crowding fee at skewFrac = 1
    r, crowd, kind = out[:, 0], out[:, 3], out[:, 1]
    tr1, ho1, _ = R.settle(r, crowd, kind == 0)
    s["ev_fee1"] = tr1.mean()
    s["crowd1"] = np.minimum(crowd, np.maximum(r, 0)).mean()
    sp = out[:, 4] > 0.5
    s["ev_span"] = out[sp, 5].mean() if sp.any() else float("nan")
    s["ev_span_se"] = out[sp, 5].std(ddof=1) / np.sqrt(sp.sum()) if sp.sum() > 1 else float("nan")
    s["ev_nospan"] = out[~sp, 5].mean() if (~sp).any() else float("nan")
    # leverage actually used (the simulator picks the maximum when lev = 0)
    ps0 = p0 if cfg["side"] == "YES" else 1 - p0
    s["L"] = cfg.get("lev", 0.0) or float(cfg.get("L_show", 0.0))
    s["secs"] = time.time() - t_start
    s["cfg"] = cfg
    return s


if __name__ == "__main__":
    import csim  # compile once in the parent
    import rules as R
    quick = "--quick" in sys.argv
    cfgs = []
    seed = 1000
    tau320 = 320 * 86400.0
    dts = {0.10: 600.0, 0.30: 120.0, 0.50: 60.0, 0.70: 60.0, 0.90: 60.0}
    for p0 in (0.10, 0.30, 0.50, 0.70, 0.90):
        for side in ("YES", "NO"):
            seed += 1
            cfgs.append(dict(block="A", gaps=False, t0_days=45.0, p0=p0, side=side, dt=dts[p0], seed=seed,
                             L_show=float(R.max_leverage(p0, tau320))))
    for lead_days in (1.0 / 24.0, 1.0):
        for p0 in (0.20, 0.80):
            for side in ("YES", "NO"):
                seed += 1
                cfgs.append(dict(block="B", gaps=True, t0_days=45.0 - lead_days, p0=p0, side=side, dt=60.0, seed=seed,
                                 lead=lead_days, L_show=float(R.max_leverage(p0, tau320)), max_days=lead_days + 0.5))
    for name, extra in (("calendar clock", dict(clock_mode=1)), ("jump pays 1x", dict(jump_1x=1, jump_ticks=2.0))):
        for lead_days in ((1.0 / 24.0, 3.0) if name == "calendar clock" else (1.0 / 24.0,)):
            for p0, side in ((0.20, "YES"), (0.80, "NO")):
                seed += 1
                cfgs.append(dict(block="C", gaps=True, t0_days=45.0 - lead_days, p0=p0, side=side, dt=60.0, seed=seed,
                                 lead=lead_days, fix=name, extra=extra, max_days=lead_days + 0.5))
    for p0, side in ((0.20, "YES"), (0.80, "NO"), (0.20, "NO"), (0.80, "YES")):
        seed += 1
        cfgs.append(dict(block="E", gaps=True, t0_days=45.0 - 1.0 / 24.0, p0=p0, side=side, dt=60.0, seed=seed,
                         lead=1.0 / 24.0, fix="jumps at 1x both ways", extra=dict(jump_1x=2, jump_ticks=2.0),
                         max_days=1.0 / 24.0 + 0.5))
    for md, label, states in ((0.05, "5-tick minimum distance", ((0.10, "YES", 600.0), (0.50, "YES", 60.0), (0.90, "NO", 60.0))),
                              (0.10, "10-tick minimum distance", ((0.50, "YES", 60.0),))):
        for p0, side, dt in states:
            seed += 1
            cfgs.append(dict(block="F", gaps=False, t0_days=45.0, p0=p0, side=side, dt=dt, seed=seed, fix=label, max_days=60,
                             extra=dict(min_dist=md), L_show=float(R.max_leverage(p0, tau320, min_dist=md))))
    for p0 in (0.50, 0.70, 0.90):
        for lat_s in (0, 12, 60):
            seed += 1
            cfgs.append(dict(block="D", days_left=1.0, p0=p0, side="NO", dt=4.0, seed=seed, max_days=0.9,
                             extra=dict(lat_steps=lat_s // 4), lat=lat_s,
                             L_show=float(R.max_leverage(p0, 86400.0))))
    if quick:
        for c in cfgs:
            c["n"] = 20_000
    only = [a.split("=")[1] for a in sys.argv if a.startswith("--only=")]
    if only:
        cfgs = [c for c in cfgs if c["block"] in only[0]]
    with Pool(4) as pool:
        res = pool.map(run, cfgs, chunksize=1)

    def rows(b):
        return [r for r in res if r["cfg"]["block"] == b]

    if rows("A"):
        print("=== Block A: pure GBM, 320 days to the contract end, max leverage, uninformed entry ===")
        print("    EV and house per $1 margin with the crowding fee off (skewFrac 0); EV(fee1) with skewFrac 1.")
        print("%5s %4s %3s | %8s %7s | %8s %7s | %8s %7s | %6s %6s %6s | %6s %6s" % (
            "YES", "side", "L", "EV/M", "s.e.", "house/M", "s.e.", "EV(fee1)", "crowd", "P(win)", "P(liq)", "P(t/o)", "hold d", "liqfee"))
        for s in rows("A"):
            c = s["cfg"]
            print("%5.2f %4s %3d | %+8.4f %7.4f | %+8.4f %7.4f | %+8.4f %7.4f | %6.3f %6.3f %6.3f | %6.2f %6.4f" % (
                c["p0"], c["side"], c["L_show"], s["ev"], s["ev_se"], s["house"], s["house_se"], s["ev_fee1"], s["crowd1"],
                s["p_win"], s["p_liq"], s["p_to"], s["hold_days"], s["liq"]))
    if rows("B"):
        print("\n=== Block B: GBM + earnings gaps (sd 7%), entry before the first release, max leverage ===")
        print("%6s %5s %4s %3s | %8s %7s | %8s %7s | %7s | %9s %7s | %10s" % (
            "lead", "YES", "side", "L", "EV/M", "s.e.", "house/M", "s.e.", "spanned", "EV|span", "s.e.", "EV|no span"))
        for s in rows("B"):
            c = s["cfg"]
            print("%5.2fd %5.2f %4s %3d | %+8.4f %7.4f | %+8.4f %7.4f | %7.3f | %+9.4f %7.4f | %+10.4f" % (
                c["lead"], c["p0"], c["side"], c["L_show"], s["ev"], s["ev_se"], s["house"], s["house_se"],
                s["spanned"], s["ev_span"], s["ev_span_se"], s["ev_nospan"]))
    if rows("C"):
        print("\n=== Block C: the gap-timed positions under candidate fixes ===")
        print("%-15s %6s %5s %4s | %8s %7s | %8s %7s | %7s %7s" % (
            "fix", "lead", "YES", "side", "EV/M", "s.e.", "house/M", "s.e.", "spanned", "P(f/c)"))
        for s in rows("C"):
            c = s["cfg"]
            print("%-15s %5.2fd %5.2f %4s | %+8.4f %7.4f | %+8.4f %7.4f | %7.3f %7.3f" % (
                c["fix"], c["lead"], c["p0"], c["side"], s["ev"], s["ev_se"], s["house"], s["house_se"], s["spanned"], s["p_fc"]))
    if rows("E"):
        print("\n=== Block E: gap-timed positions if a single-update move of more than 2 ticks is settled at 1x in both directions ===")
        print("%-22s %6s %5s %4s | %8s %7s | %8s %7s | %7s" % ("fix", "lead", "YES", "side", "EV/M", "s.e.", "house/M", "s.e.", "spanned"))
        for s in rows("E"):
            c = s["cfg"]
            print("%-22s %5.2fd %5.2f %4s | %+8.4f %7.4f | %+8.4f %7.4f | %7.3f" % (
                c["fix"], c["lead"], c["p0"], c["side"], s["ev"], s["ev_se"], s["house"], s["house_se"], s["spanned"]))
    if rows("F"):
        print("\n=== Block F: Block A's uninformed positions with a wider minimum line distance (pure GBM) ===")
        print("%-26s %5s %4s %3s | %8s %7s | %8s %7s | %6s %6s" % ("rule", "YES", "side", "L", "EV/M", "s.e.", "house/M", "s.e.", "P(win)", "hold d"))
        for s in rows("F"):
            c = s["cfg"]
            print("%-26s %5.2f %4s %3d | %+8.4f %7.4f | %+8.4f %7.4f | %6.3f %6.2f" % (
                c["fix"], c["p0"], c["side"], c["L_show"], s["ev"], s["ev_se"], s["house"], s["house_se"], s["p_win"], s["hold_days"]))
    if rows("D"):
        print("\n=== Block D: last day before the contract end, buy NO (cheap side near the barrier), 4 s steps ===")
        print("    'gross' = result before fees: 0 would be a fair game; a positive number is what the stop overshoot gives away.")
        print("%5s %3s %6s | %8s %7s | %8s %7s | %6s %6s %6s %6s | %7s" % (
            "YES", "L", "late", "gross/M", "s.e.", "EV/M", "s.e.", "P(win)", "P(liq)", "P(f/c)", "wipe", "hold h"))
        for s in rows("D"):
            c = s["cfg"]
            print("%5.2f %3d %5ds | %+8.4f %7.4f | %+8.4f %7.4f | %6.3f %6.3f %6.3f %6.3f | %7.2f" % (
                c["p0"], c["L_show"], c["lat"], s["gross"], s["gross_se"], s["ev"], s["ev_se"], s["p_win"], s["p_liq"], s["p_fc"],
                s["wipe"], s["hold_days"] * 24))
    print("\nrun times (s):", " ".join("%.0f" % r["secs"] for r in res))
