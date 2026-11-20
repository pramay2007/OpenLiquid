"""
Independent check of the gap-attack number, with no price grid: ONE earnings gap, pure GBM after it.
Post-gap YES price = closed form; pre-gap YES price = Gauss-Hermite integral of it over the gap.
Then the free-mode payoff of 'buy NO at 10x when YES = 0.80' is integrated over the gap directly and by
Monte Carlo (1,000,000 gaps).  Compared with the grid model built with the same single gap.
"""
import numpy as np
from scipy.optimize import brentq
from model import no_closed, OneTouch
import rules as R

sigma, s = 0.40, 0.07
theta_after = 320.0 / 365.0
z = np.linspace(-9, 9, 200001)
w = np.exp(-0.5 * z * z); w /= w.sum()
J = -0.5 * s * s + s * z


def yes_post(y):
    return np.where(y <= 0, 1.0, 1.0 - no_closed(np.maximum(y, 1e-12), theta_after, sigma))


def yes_pre(y0):
    return float((w * yes_post(y0 - J)).sum())


for p0, side, L in ((0.80, "NO", 10.0), (0.20, "YES", 10.0), (0.90, "NO", 5.0)):
    y0 = brentq(lambda y: yes_pre(y) - p0, 1e-6, 3.0, xtol=1e-12)
    p1 = yes_post(y0 - J)
    ps0 = p0 if side == "YES" else 1 - p0
    ps1 = p1 if side == "YES" else 1 - p1
    r = R.result(ps0, ps1, L)
    touched = (y0 - J) <= 0
    tr, ho, lf = R.settle(r, 0.0, (1 + r <= R.MAINT) & ~touched)
    ev_quad = float((w * tr).sum())
    rng = np.random.default_rng(3)
    n = 1_000_000
    Jm = rng.normal(-0.5 * s * s, s, n)
    p1m = yes_post(y0 - Jm)
    ps1m = p1m if side == "YES" else 1 - p1m
    rm = R.result(ps0, ps1m, L)
    trm, _, _ = R.settle(rm, 0.0, (1 + rm <= R.MAINT) & ~((y0 - Jm) <= 0))
    m = OneTouch(gap_days=(45.0,), gap_sd=s)
    y0g = float(m.y_from_yes(np.array([p0]), m.row_pre(0))[0])
    y1 = y0g - J
    p1g = np.where(y1 <= 0, 1.0, 1.0 - np.interp(np.maximum(y1, 0), m.y, m.row_post(0)))
    ps1g = p1g if side == "YES" else 1 - p1g
    rg = R.result(ps0, ps1g, L)
    trg, _, _ = R.settle(rg, 0.0, (1 + rg <= R.MAINT) & ~(y1 <= 0))
    print("YES=%.2f buy %s %dx | S/B before = %.4f (grid %.4f) | EV closed-form quadrature %+.4f | Monte Carlo %+.4f +/- %.4f | grid model %+.4f | E[YES after] = %.4f" % (
        p0, side, L, np.exp(-y0), np.exp(-y0g), ev_quad, trm.mean(), trm.std(ddof=1) / np.sqrt(n), float((w * trg).sum()), float((w * p1).sum())))
