"""
(1) Boost, if it were enabled on the one-touch: the scheduled-gap trade with a boosted position
    (cap raised to min(10 M, n (1 - p0)); premium = borrowed shares * (1 - ps)/tau per second, tau to the
    contract end, here paid for one hour).  Exact quadrature over the gap, per $1 margin.
(2) Overnight-gap sensitivity: if the reference contract gaps at every US open (underlying gap sd 1.3%,
    intraday diffusion 34% so that total volatility stays 40%), the cheap-side trade can be repeated nightly.
    Exact quadrature for one night, free mode, max leverage, for a 320-day and a 42-day remaining life.
(3) After the touch, before the venue settles: buying YES at a mid below 1.00.
"""
import numpy as np
from model import OneTouch
import rules as R


def gap_ev(m, k, p0, boost, hold_sec=3600.0, nz=40001):
    pre, post = m.row_pre(k), m.row_post(k)
    y0 = float(m.y_from_yes(np.array([p0]), pre)[0])
    z = np.linspace(-9, 9, nz)
    w = np.exp(-0.5 * z * z)
    w /= w.sum()
    J = -0.5 * m.gap_sd**2 + m.gap_sd * z
    y1 = y0 - J
    touched = y1 <= 0
    p1 = np.where(touched, 1.0, 1.0 - np.interp(np.maximum(y1, 0), m.y, post))
    tau = (m.T - m.gap_t[k]) * 365 * 86400.0
    L = float(R.max_leverage(p0, tau))
    out = {}
    for side, ps0, ps1 in (("YES", p0, p1), ("NO", 1 - p0, 1 - p1)):
        prem = R.borrowed_shares(ps0, L) * (1 - ps0) / max(tau, R.TAU_FLOOR) * hold_sec if boost else 0.0
        r = R.result(ps0, ps1, L, boost=boost, premium=prem)
        liq = (1.0 + r <= R.MAINT) & ~touched
        tr, ho, lf = R.settle(r, 0.0, liq)
        out[side] = (float((w * tr).sum()), float((w * ho).sum()), prem, float(R.reserve(ps0, L, boost)))
    return L, out


if __name__ == "__main__":
    m = OneTouch(gap_sd=0.07)
    k = 0
    print("=== (1) Boost on the one-touch at an earnings release (gap sd 7%, 320 days before the end) ===")
    print("%5s %3s | %10s %10s | %10s %10s | %9s %9s" % ("YES", "L", "free YES", "boost YES", "free NO", "boost NO", "premium/h", "boost cap"))
    for p0 in (0.10, 0.20, 0.30, 0.50, 0.70, 0.80, 0.90):
        L, f = gap_ev(m, k, p0, False)
        _, b = gap_ev(m, k, p0, True)
        print("%5.2f %3d | %+10.3f %+10.3f | %+10.3f %+10.3f | %9.4f %9.2f" % (
            p0, L, f["YES"][0], b["YES"][0], f["NO"][0], b["NO"][0], max(b["YES"][2], b["NO"][2]), max(b["YES"][3], b["NO"][3])))

    print("\n=== (2) Overnight-gap sensitivity (daily gap sd 1.3%, intraday vol 34%), free mode, one night ===")
    for T_days, eval_day in ((365.0, 45.0), (42.0, 14.0)):
        gaps = tuple(float(d) for d in range(1, int(T_days)))
        mo = OneTouch(sigma=0.34, T_days=T_days, gap_days=gaps, gap_sd=0.013)
        k = gaps.index(eval_day)
        tau = (mo.T - mo.gap_t[k]) * 365 * 86400.0
        print("  contract with %.0f days left at the gap (highest YES attainable before the open: %.3f)" % (T_days - eval_day, mo.max_yes_pre(k)))
        print("  %5s %3s | %9s %9s | %9s" % ("YES", "L", "EV YES/M", "EV NO/M", "best/N"))
        for p0 in (0.10, 0.20, 0.30, 0.50, 0.70, 0.80, 0.90):
            if p0 > mo.max_yes_pre(k) - 0.005:
                continue
            L, f = gap_ev(mo, k, p0, False)
            best = max(f["YES"][0], f["NO"][0])
            print("  %5.2f %3d | %+9.3f %+9.3f | %+9.4f" % (p0, L, f["YES"][0], f["NO"][0], best / L))

    print("\n=== (3) After the touch, before settlement: open YES at 1x at a mid below 1.00 ===")
    for mid in (0.95, 0.97, 0.98, 0.985, 0.99):
        L = float(R.max_leverage(mid, 300 * 86400.0))
        gain = (1 - mid) / mid
        print("  mid %.3f: allowed L = %d, cap = %.4f per $1 margin, after the 10%% share = %+.4f (risk-free once the touch is known)" % (
            mid, L, gain, gain * 0.9))
