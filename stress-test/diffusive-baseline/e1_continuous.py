"""
E1.  Continuous-martingale baseline.

Claim to check: for a continuous martingale started at p0, P(win line before stop line) = p0.
Model: the price of a digital "BTC >= K at T" under Black-Scholes, p_t = Phi(x_t / sqrt(T - t)),
x a standard Brownian motion (an exact continuous martingale, with volatility that depends on
both the price level and the time left).  Euler time step small relative to the corridor.

Then the frictions that do not depend on ticks:
  80% liquidation trigger  -> P(win before liquidation) = 0.8 p0 / (1 - 0.2 p0)
  5% liquidator cut, 10% profit share -> EV per $1 margin = -0.13 (1-p0) / (1 - 0.2 p0)
"""
import numpy as np
from scipy.stats import norm

rng = np.random.default_rng(7)
T = 30 * 86400.0


def sim(p0, L, npaths=200_000, steps_per_sd=40.0, trigger=1.0):
    """returns (P(win), se, mean exit time/T, P(unfinished)); trigger=0.8 uses the liquidation line."""
    win_line = p0 + (1 - p0) / L
    stop_line = p0 - trigger * p0 / L
    width = min(win_line - p0, p0 - stop_line)
    # choose dt so one step moves the price by width/steps_per_sd (local vol phi(z)/sqrt(T))
    vol0 = norm.pdf(norm.ppf(p0))
    dt = (width / steps_per_sd / vol0) ** 2 * T
    x = np.full(npaths, norm.ppf(p0) * np.sqrt(T))
    t = 0.0
    alive = np.ones(npaths, dtype=bool)
    win = np.zeros(npaths, dtype=bool)
    texit = np.zeros(npaths)
    it = 0
    while alive.any() and t < T - 2 * dt:
        idx = np.where(alive)[0]
        x[idx] += rng.standard_normal(len(idx)) * np.sqrt(dt)
        t += dt
        p = norm.cdf(x[idx] / np.sqrt(T - t))
        up = p >= win_line
        dn = p <= stop_line
        win[idx[up]] = True
        done = up | dn
        texit[idx[done]] = t
        alive[idx[done]] = False
        it += 1
    pw = win.mean()
    return pw, np.sqrt(pw * (1 - pw) / npaths), texit[~alive].mean() / T, alive.mean(), dt


print("A. P(win line before STOP line) for a continuous martingale (claim: = p0)")
print(f"{'p0':>5} {'L':>4} {'P(win) MC':>11} {'s.e.':>7} {'claim p0':>9} {'z':>6} {'E[T]/T':>8} {'dt (s)':>7} {'unfinished':>10}")
for p0, L in [(0.5, 25), (0.5, 10), (0.3, 15), (0.3, 5), (0.7, 15), (0.2, 10), (0.8, 10)]:
    pw, se, et, unf, dt = sim(p0, L)
    print(f"{p0:5.2f} {L:4d} {pw:11.4f} {se:7.4f} {p0:9.4f} {(pw - p0) / se:6.2f} {et:8.4f} {dt:7.2f} {unf:10.5f}")

print()
print("B. With the 80% liquidation trigger: P(win before liquidation) (theory 0.8p0/(1-0.2p0))")
print(f"{'p0':>5} {'L':>4} {'P(win) MC':>11} {'s.e.':>7} {'theory':>8} {'z':>6}")
rows = []
for p0, L in [(0.5, 25), (0.5, 10), (0.3, 15), (0.2, 10), (0.8, 10)]:
    pw, se, et, unf, dt = sim(p0, L, trigger=0.8)
    th = 0.8 * p0 / (1 - 0.2 * p0)
    rows.append((p0, L, pw, se))
    print(f"{p0:5.2f} {L:4d} {pw:11.4f} {se:7.4f} {th:8.4f} {(pw - th) / se:6.2f}")

print()
print("C. EV per $1 margin, single corridor bet held to collect or liquidation (continuous limit)")
print("   EV = P(win)*0.9*C - P(liq)*(0.80 + 0.05);   C = (1-p0)/p0")
print(f"{'p0':>5} {'L':>4} {'EV from MC P(win)':>18} {'s.e.':>7} {'closed form':>12} | {'no liq cut':>10} {'no fee':>8} {'neither':>8}")
for p0, L, pw, se in rows:
    C = (1 - p0) / p0
    ev = pw * 0.9 * C - (1 - pw) * 0.85
    ev_se = se * (0.9 * C + 0.85)
    cf = -0.13 * (1 - p0) / (1 - 0.2 * p0)
    th = 0.8 * p0 / (1 - 0.2 * p0)
    nocut = th * 0.9 * C - (1 - th) * 0.80
    nofee = th * C - (1 - th) * 0.85
    neither = th * C - (1 - th) * 0.80
    print(f"{p0:5.2f} {L:4d} {ev:18.4f} {ev_se:7.4f} {cf:12.4f} | {nocut:10.4f} {nofee:8.4f} {neither:8.4f}")

print()
print("D. Closed form by entry price (leverage does not enter in the continuous limit)")
print(f"{'p0':>5} {'P(win)=p0':>10} {'P(win|80% trig)':>16} {'EV hold':>9} {'EV self-liq':>12} {'profit share':>13} {'liq cut':>8}")
for p0 in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
    th = 0.8 * p0 / (1 - 0.2 * p0)
    C = (1 - p0) / p0
    print(f"{p0:5.2f} {p0:10.3f} {th:16.4f} {-0.13 * (1 - p0) / (1 - 0.2 * p0):9.4f} "
          f"{-0.08 * (1 - p0) / (1 - 0.2 * p0):12.4f} {-0.1 * th * C:13.4f} {-0.05 * (1 - th):8.4f}")
