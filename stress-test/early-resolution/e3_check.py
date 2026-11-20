"""
E3 check: is Ltime = min(p,1-p) / (3*sqrt(p(1-p) h/tau)), tau = time to CONTRACT END, the right
limit for a one-touch?  Compare the variance it assumes over h = 120 s with the true local variance
of the one-touch probability (pure GBM, sigma = 40%; exact closed form, numerical delta).

Printed per state: YES price p, S/B, assumed sd over 120 s, true sd over 120 s, ratio, the three
leverage limits (integer floors as in the contract) and the stop distance of the cheap side at the
allowed leverage expressed in true standard deviations of the price move over 120 s and over 12 s.
"""
import numpy as np
from scipy.optimize import brentq
from model import no_closed, SEC_PER_YEAR

SIGMA = 0.40
H = 120.0


def y_for_yes(p, theta):
    return brentq(lambda y: (1.0 - no_closed(np.array([y]), theta, SIGMA)[0]) - p, 1e-9, 6.0, xtol=1e-12)


def true_sd(y, theta, h_sec):
    eps = 1e-5
    d = (no_closed(np.array([y + eps]), theta, SIGMA)[0] - no_closed(np.array([max(y - eps, 1e-12)]), theta, SIGMA)[0]) / (
        y + eps - max(y - eps, 1e-12)
    )
    return abs(d) * SIGMA * np.sqrt(h_sec / SEC_PER_YEAR)


def limits(p, tau_sec):
    dist = min(p, 1 - p)
    assumed = np.sqrt(p * (1 - p) * H / tau_sec)
    ltime = dist / (3 * assumed)
    ltick = dist / 0.02
    lev = max(1, int(min(50, np.floor(ltick + 1e-9), np.floor(ltime + 1e-9))))
    return assumed, ltime, ltick, lev


print("sigma = %.0f%%, h = %d s.  'stop' = cheap side's stop distance at the allowed leverage." % (SIGMA * 100, H))
hdr = "%7s %6s %6s | %9s %9s %6s | %7s %6s %4s | %8s %9s %9s | %7s" % (
    "T_left", "YES", "S/B", "sd_assum", "sd_true", "ratio", "Ltime", "Ltick", "L", "stop(c)", "stop/sd120", "stop/sd12", "L_true3s")
print(hdr)
for days in (365, 180, 42, 7, 1):
    theta = days / 365.0
    tau = days * 86400.0
    for p in (0.02, 0.05, 0.10, 0.30, 0.50, 0.70, 0.90, 0.95, 0.98):
        y = y_for_yes(p, theta)
        sd_t = true_sd(y, theta, H)
        sd_12 = true_sd(y, theta, 12.0)
        assumed, ltime, ltick, lev = limits(p, tau)
        cheap = min(p, 1 - p)
        stop = cheap / lev
        l_true = max(1, int(min(50, np.floor(cheap / 0.02 + 1e-9), np.floor(cheap / (3 * sd_t)))))
        print("%6dd %6.2f %6.3f | %9.5f %9.5f %6.2f | %7.1f %6.1f %4d | %8.4f %9.1f %9.1f | %7d" % (
            days, p, np.exp(-y), assumed, sd_t, sd_t / assumed, ltime, ltick, lev, stop, stop / sd_t, stop / sd_12, l_true))
    print()

# How fast does the far-dated one-touch move near the barrier, per day?
print("Daily sd of the YES price (cents), pure GBM:")
for days in (365, 180, 42):
    theta = days / 365.0
    row = []
    for p in (0.10, 0.30, 0.50, 0.70, 0.90, 0.95):
        y = y_for_yes(p, theta)
        row.append("p=%.2f: %.1fc" % (p, 100 * true_sd(y, theta, 86400.0)))
    print("  T_left %3dd  " % days + "  ".join(row))
