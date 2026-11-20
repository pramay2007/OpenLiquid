"""
Scheduled-gap attack on a one-touch ("Will the underlying trade >= B before T").

Strategy: a few minutes before a scheduled earnings release, open a FREE-MODE position at the maximum
leverage the rules allow, hold through the gap, exit after it (liquidated at the mid if equity <= 20%
of margin, otherwise collected at the cap or closed at the worse-of price 30 minutes later).

Part A: exact expectation by quadrature over the gap (unrounded prices, exit at the post-gap mid).
Part B: Monte Carlo with 1-cent rounding of the mid, the slow price, liquidation, collect(), the 5%
        liquidator cut, the 10% profit share and the crowding fee (skewFrac = 1) - 400,000 paths/state.
Part C: the same expectation under candidate fixes.
"""
import sys
import numpy as np
from model import OneTouch
import rules as R

rng = np.random.default_rng(7)


def gap_states(m, k, p0_list):
    pre, post = m.row_pre(k), m.row_post(k)
    y0 = m.y_from_yes(np.array(p0_list), pre)
    return pre, post, y0


def post_price(m, post, y0, J):
    """YES fair value right after the gap; touched -> exactly 1 (resolved)."""
    y1 = y0 - J
    touched = y1 <= 0
    p1 = 1.0 - np.interp(np.maximum(y1, 0.0), m.y, post)
    return np.where(touched, 1.0, p1), touched, y1


def exact_ev(m, k, p0, L_yes, L_no, fee=R.PROFIT_FEE, haircut=False, nz=40001):
    """Quadrature over the gap. Returns dict for YES and NO longs per $1 margin."""
    pre, post, y0 = gap_states(m, k, [p0])
    z = np.linspace(-9, 9, nz)
    w = np.exp(-0.5 * z * z)
    w /= w.sum()
    J = -0.5 * m.gap_sd**2 + m.gap_sd * z
    p1, touched, _ = post_price(m, post, y0[0], J)
    out = {}
    for side, ps0, ps1, L in (("YES", p0, p1, L_yes), ("NO", 1 - p0, 1 - p1, L_no)):
        r = R.result(ps0, ps1, L)
        if haircut:
            # candidate fix: a favourable single-update jump is paid on M/p0 shares (1x), not on n shares
            r1 = np.minimum((1.0 / ps0) * (ps1 - ps0), R.reserve(ps0, L))
            r = np.where(ps1 > ps0, r1, r)
        liq = (1.0 + r <= R.MAINT) & ~touched
        trader, house, liqfee = R.settle(r, 0.0, liq, fee)
        out[side] = dict(
            ev=float((w * trader).sum()), house=float((w * house).sum()), liq=float((w * liqfee).sum()),
            p_win=float(w[r > 0].sum()), p_cap=float(w[r >= R.reserve(ps0, L) - 1e-12].sum()),
            p_wipe=float(w[r <= -1 + 1e-12].sum()), L=L,
            mean_gain=float((w * np.maximum(r, 0)).sum()), mean_loss=float((w * np.maximum(-r, 0)).sum()),
        )
    out["p_touch"] = float(w[touched].sum())
    out["p1_q"] = [float(np.interp(q, np.cumsum(w), p1[::1])) for q in (0.1, 0.5, 0.9)]
    return out


def mc_ev(m, k, p0, side, L, n=400_000, minutes=30, skew=1.0, entry_lead_min=10.0):
    """Monte Carlo with ticks, slow price, liquidation, collect, fees. Per $1 margin."""
    pre, post, y0 = gap_states(m, k, [p0])
    y0 = y0[0]
    t_gap = m.gap_t[k]
    tau_end = (m.T - t_gap) * 365 * 86400.0
    ps0 = p0 if side == "YES" else 1 - p0
    J = rng.normal(-0.5 * m.gap_sd**2, m.gap_sd, n)
    y = y0 - J
    touched = y <= 0
    alive = ~touched
    dt_sec = 60.0
    dt = dt_sec / (365 * 86400.0)
    sd = m.sigma * np.sqrt(dt)
    slow = np.full(n, p0)        # YES slow price: calm before the release, so slow = mid = p0
    mid_prev = np.full(n, p0)
    r_final = np.full(n, np.nan)
    liq_flag = np.zeros(n, dtype=bool)
    # resolved by the gap: settlement at 1.00 for YES
    ps_res = 1.0 if side == "YES" else 0.0
    r_final[touched] = R.result(ps0, ps_res, L)
    reserve = R.reserve(ps0, L)
    hold_sec = entry_lead_min * 60.0
    for step in range(minutes + 1):
        t = t_gap + step * dt
        row = m.row(t) if step > 0 else post
        f = 1.0 - np.interp(np.maximum(y, 0.0), m.y, row)
        mid = R.round_tick(f)
        if step > 0:
            slow = R.slow_update(slow, mid_prev, dt_sec)
        hold_sec += dt_sec if step > 0 else 0.0
        open_ = alive & np.isnan(r_final)
        ps_mid = mid if side == "YES" else 1 - mid
        # close price for a long on this side = worse-of: sell YES at min(mid, slow); buy YES back at max(mid, slow)
        ps_close = np.minimum(mid, slow) if side == "YES" else 1 - np.maximum(mid, slow)
        r_mid = R.result(ps0, ps_mid, L)
        liq = open_ & (1.0 + r_mid <= R.MAINT)
        r_final[liq] = r_mid[liq]
        liq_flag[liq] = True
        open_ &= ~liq
        raw_close = (L / ps0) * (ps_close - ps0)
        coll = open_ & (raw_close >= reserve - 1e-12)
        r_final[coll] = reserve
        open_ &= ~coll
        if step == minutes:
            r_final[open_] = R.result(ps0, ps_close, L)[open_]
            break
        # diffuse one minute; touch within the minute resolves YES
        zz = rng.standard_normal(n)
        ynew = y + m.nu * dt - sd * zz
        u = rng.random(n)
        hit = alive & ((ynew <= 0) | (u < np.exp(-2.0 * np.maximum(y, 0) * np.maximum(ynew, 0) / (sd * sd))))
        newly = hit & np.isnan(r_final)
        r_final[newly] = R.result(ps0, ps_res, L)
        alive &= ~hit
        y = ynew
        mid_prev = mid
    # crowding fee: borrowed shares * skew * (1 - ps)/tau for the ~40 minutes held (taken from profit only)
    crowd = R.borrowed_shares(ps0, L) * skew * (1 - ps0) / max(tau_end, R.TAU_FLOOR) * hold_sec
    trader, house, liqfee = R.settle(r_final, crowd, liq_flag)
    se = lambda x: x.std(ddof=1) / np.sqrt(n)
    return dict(ev=trader.mean(), se=se(trader), house=house.mean(), house_se=se(house),
                p_win=(r_final > 0).mean(), p_wipe=(r_final <= -1 + 1e-9).mean(), liq=liqfee.mean(), crowd=crowd)


if __name__ == "__main__":
    quick = "--quick" in sys.argv
    P0 = [0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.80, 0.90, 0.95]
    for gap_sd in (0.07, 0.04, 0.10):
        m = OneTouch(gap_sd=gap_sd)
        for k in ((0, 3) if gap_sd == 0.07 else (0,)):
            t_gap = m.gap_t[k]
            tau = (m.T - t_gap) * 365 * 86400.0
            print("\n=== PART A (exact). gap sd %.0f%%, earnings on day %.0f, %.0f days before the contract end ===" % (
                gap_sd * 100, t_gap * 365, (m.T - t_gap) * 365))
            print("%5s %6s | %4s %9s %7s %7s %7s | %4s %9s %7s %7s %7s | %8s %8s %8s" % (
                "YES", "P(tch)", "Lyes", "EV_yes/M", "P(win)", "P(cap)", "P(wipe)", "Lno", "EV_no/M", "P(win)", "P(cap)", "P(wipe)",
                "best/M", "best/N", "p1 10-90"))
            print("  (highest YES price attainable just before this release: %.3f)" % m.max_yes_pre(k))
            for p0 in P0:
                if p0 > m.max_yes_pre(k) - 0.005:
                    print("%5.2f  not attainable just before the release" % p0)
                    continue
                Lmax = float(R.max_leverage(p0, tau))
                e = exact_ev(m, k, p0, Lmax, Lmax)
                best_side = "YES" if e["YES"]["ev"] > e["NO"]["ev"] else "NO"
                b = e[best_side]
                print("%5.2f %6.3f | %4d %+9.3f %7.3f %7.3f %7.3f | %4d %+9.3f %7.3f %7.3f %7.3f | %+8.3f %+8.3f  %.2f-%.2f %s" % (
                    p0, e["p_touch"], Lmax, e["YES"]["ev"], e["YES"]["p_win"], e["YES"]["p_cap"], e["YES"]["p_wipe"],
                    Lmax, e["NO"]["ev"], e["NO"]["p_win"], e["NO"]["p_cap"], e["NO"]["p_wipe"],
                    b["ev"], b["ev"] / Lmax, e["p1_q"][0], e["p1_q"][2], best_side))

    m = OneTouch(gap_sd=0.07)
    k = 0
    tau = (m.T - m.gap_t[k]) * 365 * 86400.0

    print("\n=== EV per $1 margin vs leverage (exact), gap sd 7%, first earnings ===")
    for p0, side in ((0.10, "YES"), (0.20, "YES"), (0.90, "NO"), (0.50, "YES"), (0.50, "NO")):
        Lmax = int(R.max_leverage(p0, tau))
        row = []
        for L in sorted(set([1, 2, 3, 5, 10, 15, 25, Lmax])):
            if L > Lmax:
                continue
            e = exact_ev(m, k, p0, float(L), float(L))[side]
            row.append("L=%d: %+.3f" % (L, e["ev"]))
        print("  YES=%.2f buy %-3s  " % (p0, side) + "  ".join(row))

    print("\n=== PART B (Monte Carlo, ticks + slow price + liquidation + collect + fees), gap sd 7%, first earnings ===")
    n = 100_000 if quick else 400_000
    print("%5s %4s %4s | %9s %8s | %9s %8s | %7s %7s | exact EV" % ("YES", "side", "L", "trader EV", "s.e.", "house", "s.e.", "P(win)", "P(wipe)"))
    for p0 in (0.10, 0.20, 0.30, 0.50, 0.70, 0.80, 0.90):
        Lmax = float(R.max_leverage(p0, tau))
        for side in ("YES", "NO"):
            r = mc_ev(m, k, p0, side, Lmax, n=n)
            ex = exact_ev(m, k, p0, Lmax, Lmax)[side]["ev"]
            print("%5.2f %4s %4d | %+9.4f %8.4f | %+9.4f %8.4f | %7.3f %7.3f | %+.4f" % (
                p0, side, Lmax, r["ev"], r["se"], r["house"], r["house_se"], r["p_win"], r["p_wipe"], ex))

    print("\n=== PART C: fixes (exact, gap sd 7%, first earnings). EV per $1 margin of the better side ===")
    print("%5s | %9s | %12s %12s %12s %12s | %12s | %12s" % (
        "YES", "current", "cap L<=5", "cap L<=3", "cap L<=2", "5-tick dist", "L=1 (calendar)", "jump pays 1x"))
    for p0 in P0:
        if p0 > m.max_yes_pre(k) - 0.005:
            continue
        Lmax = float(R.max_leverage(p0, tau))
        def best(L, **kw):
            e = exact_ev(m, k, p0, L, L, **kw)
            return max(e["YES"]["ev"], e["NO"]["ev"])
        L5t = float(R.max_leverage(p0, tau, min_dist=0.05))
        # calendar fix: tau := seconds to the release. Ten minutes before, floor(Ltime) = 0 -> 1x only.
        Lcal = float(R.max_leverage(p0, 600.0))
        print("%5.2f | %+9.3f | %+12.3f %+12.3f %+12.3f %+12.3f | %+12.3f (L=%d) | %+12.3f" % (
            p0, best(Lmax), best(min(Lmax, 5.0)), best(min(Lmax, 3.0)), best(min(Lmax, 2.0)), best(L5t),
            best(Lcal), Lcal, best(Lmax, haircut=True)))

    print("\nCalendar fix detail: Ltime with tau = seconds to the release, YES = 0.10 / 0.50:")
    for hrs in (72, 24, 6, 3, 1, 1 / 6):
        print("  %5.1f h before: floor(Ltime) = %d / %d  -> allowed L = %d / %d" % (
            hrs, np.floor(R.ltime(0.10, hrs * 3600)), np.floor(R.ltime(0.50, hrs * 3600)),
            R.max_leverage(0.10, hrs * 3600), R.max_leverage(0.50, hrs * 3600)))
