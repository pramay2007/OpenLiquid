"""Would free-mode leverage be safe in play?  (Hypothetical: the current rules forbid it.)

Section: sports in play.  Three questions, each answered with numbers:
 D1  One harvest cycle (exact expectation along the fair-value table): a position opened on the
     side that drifts up, collected at the cap or killed by a score.  Shows what the slow price
     and the crowding fee do to it, by match state.
 D2  Monte Carlo of the harvesting loop over a whole match (200,000 matches per cell):
       NAIVE     : always hold the drifting side at maximum leverage, re-open after every collect
       SELECTIVE : open only in states whose one-cycle value exceeds +0.02 (policy from D1)
     In-play leverage rule: E3-EXT = E3 with tau = time to the final whistle;
     FIX5 / FIX10 = flat ceiling with the tick rule (min(p,1-p)/0.02) and no time rule.
     Crowding fee E4 with tau = time to the final whistle floored at 1 hour, at skew 0 or 1.
 D3  The score itself: R6 lets an open land at the pre-score signed price.  Profit per $1.
"""
import os
import time
import numpy as np
from ol import soccer, nfl, mean_se, Pos, PROFIT_SHARE
from inplay import sim_harvest, cycle_ev, build_policy

N = int(os.environ.get("N", 200_000))


def line(x):
    m, s = mean_se(x)
    return f"{m:+.4f} (se {s:.4f})"


def d1(m):
    print("D1. One-cycle expected value per $1 margin, 5x ceiling (soccer, YES = 'A wins'):")
    print("    state                 YES mid   skew 0: YES     NO     skew 1: YES     NO")
    for minute, d in [(0, 0), (30, 0), (60, 0), (80, 0), (45, 1), (60, 1), (70, 1), (80, 1), (85, 1)]:
        k = int(minute * 60 / m.dt)
        row = []
        for skew in (0.0, 1.0):
            for sy in (True, False):
                e = cycle_ev(m, k, d, sy, 5.0, skew)
                row.append("   n/a" if e is None else f"{e:+.3f}")
        score = "0-0" if d == 0 else ("1-0" if d == 1 else f"{d:+d}")
        print(f"    {minute:>2d}' {score:<6s}            {m.mid(k, np.array([d]))[0]:.2f}        {row[0]}  {row[1]}         {row[2]}  {row[3]}")
    print("    Best one-cycle value over all states (minute 0-89, score difference -3..+3):")
    pols = {}
    for Lcap, skew, floor in [(5.0, 0.0, 3600.0), (5.0, 1.0, 3600.0), (10.0, 0.0, 3600.0), (10.0, 1.0, 3600.0),
                              (25.0, 1.0, 3600.0)]:
        t0 = time.time()
        pol, best = build_policy(m, Lcap, skew, floor, thr=0.02)
        pols[(Lcap, skew)] = pol
        k, di = np.unravel_index(np.nanargmax(best), best.shape)
        print(f"      ceiling {Lcap:>4.0f}x, skew {skew:.0f}: max {np.nanmax(best):+.4f} at {k * m.dt / 60:.0f}' score diff {di - m.dmax:+d};"
              f" states with value > +0.02: {int((pol > 0).sum())} of {int(np.isfinite(best).sum())}"
              f"   [{time.time() - t0:.0f}s]", flush=True)
    return pols


def d2(match, name, seed0, pols=None):
    print(f"D2. Harvest loop, {name}: kick-off YES {match.mid0:.2f}, dt={match.dt:.0f}s, {N} matches per cell")
    cells = [
        ("NAIVE     E3-EXT            skew 0", dict(Lcap=50.0, use_ltime=True, skew=0.0)),
        ("NAIVE     FIX5              skew 0", dict(Lcap=5.0, skew=0.0)),
        ("NAIVE     FIX5              skew 1", dict(Lcap=5.0, skew=1.0)),
    ]
    if pols is not None:
        cells += [
            ("SELECTIVE FIX5              skew 0", dict(Lcap=5.0, skew=0.0, policy=pols[(5.0, 0.0)])),
            ("SELECTIVE FIX10             skew 0", dict(Lcap=10.0, skew=0.0, policy=pols[(10.0, 0.0)])),
            ("SELECTIVE FIX5 (skew-0 policy) at skew 1", dict(Lcap=5.0, skew=1.0, policy=pols[(5.0, 0.0)])),
            ("SELECTIVE FIX5 (skew-0 policy) at skew 0.5", dict(Lcap=5.0, skew=0.5, policy=pols[(5.0, 0.0)])),
        ]
    for i, (lab, kw) in enumerate(cells):
        r = sim_harvest(match, N, seed0 + i, **kw)
        print(f"  {lab:<44s} trader {line(r['pnl'])}  house {line(r['house'])}  | positions/match {r['n_open'].mean():.2f}"
              f"  collects {r['n_collect'].mean():.2f}  liquidations {r['n_liq'].mean():.2f}  fee paid {r['fee_paid'].mean():.3f}",
              flush=True)


def d3(m):
    print("D3. A score traded at the pre-score signed price (R6), profit per $1 of margin after the 10% share:")
    print("    (position opened on the scoring side at the stale mid; collected at the cap, or closed once the slow price has caught up)")
    dmax = m.dmax
    for minute in (10, 30, 60, 80):
        k = int(minute * 60 / m.dt)
        p = float(m.mid(k, np.array([0]))[0])
        for who, dd, side_yes in (("A scores, long YES", 1, True), ("B scores, long NO ", -1, False)):
            s0 = p if side_yes else 1 - p
            after = float(m.mid(k, np.array([dd]))[0])
            s1 = after if side_yes else 1 - after
            out = []
            for L in (1.0, 5.0):
                Lr = max(1.0, np.floor(min(L, min(p, 1 - p) / 0.02) + 1e-9))
                pos = Pos(s0, Lr)
                gain = min(pos.n * (s1 - s0), pos.C) * (1 - PROFIT_SHARE)
                out.append(f"{Lr:.0f}x: {gain:+.2f}")
            print(f"    0-0 at {minute:>2d}'  {who}: own-side price {s0:.2f} -> {s1:.2f}   " + "   ".join(out))


if __name__ == "__main__":
    m, la = soccer(0.45, 1.20, dt=15.0)
    print(f"Soccer model: lambda_A={la:.2f}, lambda_B=1.20, YES = 'A wins in 90 min'")
    pols = d1(m)
    d3(m)
    d2(m, "SOCCER", 51, pols)
    n, k = nfl(0.65, dt=30.0)
    d2(n, f"NFL-like two-way moneyline (k={k:.3f})", 61, None)
