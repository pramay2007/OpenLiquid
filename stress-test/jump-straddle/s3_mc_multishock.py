"""
S3 - Repeated scheduled jumps in a "news-driven" market (400,000 paths).

Model (an exact martingale): the outcome is YES iff a latent score S ends above 0.  The score moves in
m equal, independent N(0,1) shocks at scheduled times (debates, data releases, earnings, court dates).
Before shock k the price is p = Phi(S / sqrt(m - k + 1)); after it, Phi(S' / sqrt(m - k)).  The last
shock resolves the market.  Shocks are `gap_days` apart, the last one at expiry.

Before every shock the trader opens in a calm market (fill = mid), the shock arrives, the keeper
liquidates losers at the mid, collects winners at the cap once the slow price has converged, and
force-closes any position above Ltime(new mid) at the lagging slow price (modelled as zero profit for
a winner; the microstructure of all three was validated in S2).  Leverage obeys E3 at each open:
L <= min(50, floor(min(p,1-p)/0.02), floor(Ltime(p, tau))).

Output: house P&L per $1 of margin posted, per shock and per market, for several trader policies.
"""
import json
import numpy as np
from scipy.stats import norm
from rules import lev_time, max_lev, TICK, MAINT, LIQ_FEE, PROFIT_SHARE, BOOST_MULT

DAY = 86400.0
P = 400_000
OUT = {}


def leg_vec(side, boost, M, L, p0, p1, tau_after, resolved, force_close=True):
    """Vector version of rules.leg with per-path arrays; returns (trader, house, liqfee, forced)."""
    e = np.where(side > 0, p0, 1 - p0)
    x = np.where(side > 0, p1, 1 - p1)
    n = M * L / e
    cap = np.where(boost, np.minimum(BOOST_MULT * M, n * (1 - e)), M * (1 - e) / e)
    res = np.maximum(np.minimum(n * (x - e), cap), -M)
    liq = (M + res <= MAINT * M) & ~resolved
    lf = np.where(liq, np.minimum(LIQ_FEE * M, M + res), 0.0)
    win = res > 0
    forced = np.zeros_like(win)
    if force_close:
        lt = np.maximum(1.0, np.minimum(50.0, np.floor(lev_time(np.clip(p1, 1e-6, 1 - 1e-6), np.maximum(tau_after, 1.0)) + 1e-9)))
        forced = win & ~resolved & (L > lt + 1e-9)
        res = np.where(forced, 0.0, res)          # closed at the slow price ~ entry
        win = res > 0
    profit = np.where(win, res, 0.0)
    fee = PROFIT_SHARE * profit
    trader = np.where(win, profit - fee, res - lf)
    house = -trader - lf
    active = M > 0
    return np.where(active, trader, 0.0), np.where(active, house, 0.0), np.where(active, lf, 0.0), forced & active


def simulate(m=5, gap_days=2.0, p_start=0.5, seed=3, force=True):
    rng = np.random.default_rng(seed)
    S = np.full(P, np.sqrt(m) * norm.ppf(p_start))
    pol = {}

    def acc(name, house, margin, forced=None):
        d = pol.setdefault(name, dict(house=np.zeros(P), margin=np.zeros(P), forced=np.zeros(P), by_shock=[]))
        d["house"] += house
        d["margin"] += margin
        if forced is not None:
            d["forced"] += forced
        with np.errstate(invalid="ignore"):
            d["by_shock"].append((float(house.sum() / max(margin.sum(), 1e-12)), float(margin.mean())))

    price_log = []
    for k in range(1, m + 1):
        left = m - k + 1
        p0 = norm.cdf(S / np.sqrt(left))
        p0 = np.clip(np.round(p0 / TICK) * TICK, 0.01, 0.99)
        tau_before = (m - k) * gap_days * DAY + 60.0         # shock m is at expiry
        S = S + rng.standard_normal(P)
        resolved = np.full(P, k == m)
        if k == m:
            p1 = (S > 0).astype(float)
        else:
            p1 = np.clip(np.round(norm.cdf(S / np.sqrt(left - 1)) / TICK) * TICK, 0.01, 0.99)
        tau_after = np.full(P, max(tau_before - 60.0, 1.0))
        price_log.append((float(np.mean(np.abs(p1 - p0))), float(np.quantile(np.abs(p1 - p0), 0.5)), float(np.quantile(np.abs(p1 - p0), 0.9))))
        Lmax = max_lev(p0, tau_before)
        cheapY = p0 <= 0.5                                   # YES is the cheap side
        cheap = np.where(cheapY, 1.0, -1.0)
        dear = -cheap
        one = np.ones(P)
        tradable = (p0 >= 0.02) & (p0 <= 0.98)

        def add(name, legs):
            h = np.zeros(P)
            mg = np.zeros(P)
            fc = np.zeros(P)
            for (side, boost, M, L) in legs:
                M = np.where(tradable, M, 0.0)
                t_, h_, lf_, f_ = leg_vec(side, boost, M, np.maximum(L, 1.0), p0, p1, tau_after, resolved, force_close=force)
                h += h_
                mg += M
                fc += f_
            acc(name, h, mg, fc)

        F = np.zeros(P, dtype=bool)
        T = np.ones(P, dtype=bool)
        add("A1 free, cheap side only, L = min(Lmax, 4)", [(cheap, F, one, np.minimum(Lmax, 4.0))])
        add("A2 free, cheap side only, L = min(Lmax, 8)", [(cheap, F, one, np.minimum(Lmax, 8.0))])
        add("A3 free, cheap side only, L = Lmax", [(cheap, F, one, Lmax)])
        add("A4 free, dear side only, L = Lmax (favourite backers)", [(dear, F, one, Lmax)])
        add("A5 free, 1x cheap side (outright bettor)", [(cheap, F, one, one)])
        e_c = np.where(cheapY, p0, 1 - p0)
        add("B1 free straddle, same L = Lmax, balanced margin", [(cheap, F, e_c, Lmax), (dear, F, 1 - e_c, Lmax)])
        add("B2 free straddle, same L = Lmax, equal margin", [(cheap, F, one, Lmax), (dear, F, one, Lmax)])
        # hedged: cheap side at min(Lmax,4) with 15% of margin, dear side 1x with 85%
        add("B3 free hedged: 15% cheap side L=min(Lmax,4) + 85% dear side 1x", [(cheap, F, 0.15 * one, np.minimum(Lmax, 4.0)), (dear, F, 0.85 * one, one)])
        add("C1 boost straddle, same L = Lmax, equal margin", [(cheap, T, one, Lmax), (dear, T, one, Lmax)])
        add("C2 boost straddle, same L = min(Lmax, 8), equal margin", [(cheap, T, one, np.minimum(Lmax, 8.0)), (dear, T, one, np.minimum(Lmax, 8.0))])
        add("C3 boost cheap side only, L = min(Lmax, 8)", [(cheap, T, one, np.minimum(Lmax, 8.0))])
        add("C4 boost YES + free NO, L = min(Lmax, 8), equal margin", [(one, T, one, np.minimum(Lmax, 8.0)), (-one, F, one, np.minimum(Lmax, 8.0))])
    return pol, price_log


for (m, gap, lab, force) in [(5, 7.0, "5 shocks, 7 days apart (last at expiry)", True), (5, 7.0, "5 shocks, 7 days apart, NO force-close of winners (reference)", False), (5, 2.0, "5 shocks, 2 days apart (last at expiry)", True), (8, 1.0, "8 shocks, 1 day apart (last at expiry)", True)]:
    pol, plog = simulate(m, gap, force=force)
    print("=" * 118)
    print(f"{lab}; start p = 0.50; {P:,} paths")
    print("  |jump| per shock (mean / median / 90th pct, points): " + "; ".join(f"{a*100:.0f}/{b*100:.0f}/{c*100:.0f}" for a, b, c in plog))
    print("=" * 118)
    print(f"  {'policy':66s} {'house per $1 posted':>21s}   per shock: " + " ".join(f"k={k+1:<6d}" for k in range(m)))
    OUT[lab] = {}
    for name, d in pol.items():
        tot_m = d["margin"].sum()
        mean = d["house"].sum() / tot_m
        # s.e. of the ratio via per-path totals (delta method)
        x = d["house"] - mean * d["margin"]
        se = x.std(ddof=1) / np.sqrt(P) / d["margin"].mean()
        per_mkt = d["house"].mean()
        print(f"  {name:66s} {mean:+8.4f} (se {se:.4f})   " + " ".join(f"{h:+8.3f}" for h, _ in d["by_shock"]) + f"   | per market {per_mkt:+.3f}; forced {d['forced'].mean():.3f}")
        OUT[lab][name] = dict(house_per_dollar=float(mean), se=float(se), by_shock=[h for h, _ in d["by_shock"]], per_market=float(per_mkt), forced=float(d["forced"].mean()))

with open(__file__.replace(".py", ".json"), "w") as f:
    json.dump(OUT, f, indent=1)
