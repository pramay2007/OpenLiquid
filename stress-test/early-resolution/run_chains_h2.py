"""
Repeated strategies on the one-touch (C simulator, 200,000 independent market paths per row).
Each trade stakes $1 of margin at the maximum allowed leverage; a new trade opens as soon as the
previous one ends and the fill is penalty-free (worse-of fill within 0.05 tick of the mid).

H  "theta harvest on NO": always buy NO (re-open after every collect / liquidation).
   H-GBM   pure GBM, start YES = 0.10 or 0.30, 320 days before the contract end
   H-gap   GBM + earnings gaps (sd 7%), window that contains the first release:
           (a) holds through the release, (b) flat from 24 h before to 1 h after it
S  "sub-tick information": the trader knows the fair value f (computable from the underlying) and
   opens YES when f - mid >= theta, NO when f - mid <= -theta (theta in ticks), otherwise waits.
   Compared with an uninformed trader who always opens YES.  Pure GBM, start YES = 0.50 / 0.30.
   Fix variants: 5-tick minimum distance; fills at the touch (half-spread 0.5 tick = mid on a 1-tick book).
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
    rng = np.random.default_rng(cfg["seed"])
    n = cfg.get("n", N)
    m = get_model(cfg["gaps"])
    t0 = cfg["t0_days"] / 365.0
    y0 = m.y_from_yes(cfg["p0"] + rng.uniform(-0.005, 0.005, n), m.row(t0))
    dt = cfg["dt"]
    ts = time.time()
    extra = dict(cfg.get("extra", {}))
    if cfg["tag"].startswith("H"):
        extra.setdefault("max_gap", 0.0005)
    out = csim.run(y0, cfg["seed"] * 104729 + 7, model=m, t0=t0, dt_sec=dt, max_steps=int(round(cfg["days"] * 86400 / dt)),
                   mode=1, policy=cfg["policy"], entry_eps=cfg.get("entry_eps", 0.0005), skew=cfg.get("skew", 0.0),
                   min_lev=cfg.get("min_lev", 2.0), **extra)
    tot, house, ntr, nwin = out[:, 0], out[:, 1], out[:, 2], out[:, 3]
    se = lambda x: x.std(ddof=1) / np.sqrt(len(x))
    T = ntr.sum()
    per_trade = tot.sum() / max(T, 1)
    # cluster-robust s.e. of the per-trade mean (ratio estimator, paths are the clusters)
    per_trade_se = np.sqrt(((tot - per_trade * ntr) ** 2).sum()) / max(T, 1)
    return dict(cfg=cfg, tot=tot.mean(), tot_se=se(tot), house=house.mean(), house_se=se(house), trades=ntr.mean(),
                win=nwin.sum() / max(T, 1), per_trade=per_trade, per_trade_se=per_trade_se, p_pos=(tot > 0).mean(),
                p_neg=(tot < 0).mean(), q05=np.percentile(tot, 5), q50=np.percentile(tot, 50), q95=np.percentile(tot, 95),
                liq=out[:, 4].mean(), crowd=out[:, 5].mean(), hold_frac=out[:, 6].mean() / (cfg["days"] * 86400.0),
                ended=out[:, 7].mean(), secs=time.time() - ts, n_trades=T)


if __name__ == "__main__":
    import csim  # compile in the parent
    quick = "--quick" in sys.argv
    cfgs = []
    seed = 7000
    seed += 1
    cfgs.append(dict(tag="H-GBM", gaps=False, t0_days=45.0, p0=0.10, dt=600.0, days=30.0, policy=0, skew=0.0, seed=seed,
                     label="pure GBM, YES0=0.10, 30d, skew 0"))
    seed += 1
    cfgs.append(dict(tag="H-gap", gaps=True, t0_days=30.0, p0=0.10, dt=600.0, days=30.0, policy=0, skew=0.0, seed=seed,
                     label="gaps, YES0=0.10, 30d, holds through the release"))
    for label, extra in (("informed 0.40, 5-tick min distance", dict(theta=0.0040, min_dist=0.05)),
                         ("informed 0.40, 10-tick min distance", dict(theta=0.0040, min_dist=0.10)),
                         ("informed 0.45, 2-tick (current)", dict(theta=0.0045))):
        seed += 1
        cfgs.append(dict(tag="S", gaps=False, t0_days=45.0, p0=0.50, dt=30.0, days=2.0, skew=0.0, seed=seed, extra=extra,
                         label="YES0=0.50 " + label, min_lev=2.0, policy=3))
    if quick:
        for c in cfgs:
            c["n"] = 10_000
    only = [a.split("=")[1] for a in sys.argv if a.startswith("--only=")]
    if only:
        cfgs = [c for c in cfgs if c["tag"].startswith(only[0])]
    with Pool(4) as pool:
        res = pool.map(run, cfgs, chunksize=1)
    hdr = "%-52s | %8s %7s | %7s %6s | %9s %7s | %6s %6s | %7s %7s %7s | %6s" % (
        "strategy", "P&L/path", "s.e.", "trades", "win%", "EV/trade", "s.e.", "P(>0)", "P(<0)", "q05", "median", "q95", "inPos")
    for tag, title in (("H-GBM", "NO theta harvest, pure GBM, patient entry (slow = mid) (P&L per path = sum over cycles of $1-margin results)"),
                       ("H-gap", "NO theta harvest, GBM + earnings gaps, patient entry (slow = mid)"),
                       ("S", "Sub-tick information, pure GBM, 2 days per path")):
        rr = [r for r in res if r["cfg"]["tag"] == tag]
        if not rr:
            continue
        print("\n=== %s ===" % title)
        print(hdr)
        for r in rr:
            print("%-52s | %+8.4f %7.4f | %7.2f %6.1f | %+9.4f %7.4f | %6.3f %6.3f | %+7.2f %+7.2f %+7.2f | %6.2f" % (
                r["cfg"]["label"], r["tot"], r["tot_se"], r["trades"], 100 * r["win"], r["per_trade"], r["per_trade_se"],
                r["p_pos"], r["p_neg"], r["q05"], r["q50"], r["q95"], r["hold_frac"]))
    print("\nrun times (s):", " ".join("%.0f" % r["secs"] for r in res))
