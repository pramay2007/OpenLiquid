"""
Theta harvest on NO in a NEWS-driven "Will X happen by date" market, and the crowding fee E4.

The NO price has no diffusion here: it drifts up while nothing happens and crashes to 0 when X happens.
NO fair price p(t) = S(T)/S(t), S = survival function of the event time.

Harvester: buy NO in free mode at the maximum allowed leverage, get paid the cap at the win line
(2 ticks up at the tick limit), re-open at the new price, repeat while leverage >= 2. $1 margin per cycle.
A crash while a cycle is open costs the $1.  Fee E4: borrowed shares * skewFrac * (1 - p)/tau per second,
tau = seconds to the CONTRACT END (floored at 1 h), taken from profit only; then the 10% profit share.

Hazard shapes (all with the same starting NO price):
  H1 uniform crash-time density over the contract life  (the assumption behind E4)
  H2 constant hazard
  H3 front-loaded: X can only happen in the first T1 days ("the decision comes early")
  H4 back-loaded: X can only happen in the last T1 days
Exact expectation over the event time, checked by Monte Carlo (1,000,000 event times).
Then H5: lumpy information - K scheduled decision points (e.g. meetings), each "X happens" with prob q.
"""
import numpy as np
import rules as R

DAY = 86400.0
rng = np.random.default_rng(11)


def survival(kind, t, T, q0, T1):
    t = np.asarray(t, dtype=float)
    if kind == "H1":
        return 1.0 - q0 * t / T
    if kind == "H2":
        lam = -np.log(1.0 - q0) / T
        return np.exp(-lam * t)
    if kind == "H3":
        return 1.0 - q0 * np.minimum(t, T1) / T1
    if kind == "H4":
        return 1.0 - q0 * np.clip((t - (T - T1)) / T1, 0.0, 1.0)
    raise ValueError


def draw_event_times(kind, n, T, q0, T1):
    u = rng.random(n)
    happens = u < q0
    v = rng.random(n)
    if kind == "H1":
        th = v * T
    elif kind == "H2":
        lam = -np.log(1.0 - q0) / T
        th = -np.log(1.0 - v * q0) / lam  # conditional on happening before T
    elif kind == "H3":
        th = v * T1
    elif kind == "H4":
        th = T - T1 + v * T1
    return np.where(happens, th, np.inf)


def schedule(kind, T, q0, T1, skew, lev_cap=None, min_dist=0.02, fee_clock_T=None):
    """Deterministic harvest cycles: list of (t_start, t_end, net profit if it completes)."""
    tg = np.linspace(0.0, T, 400001)
    S = survival(kind, tg, T, q0, T1)
    p = S[-1] / S  # NO price, non-decreasing
    cycles = []
    t = 0.0
    px = np.round(p[0], 2)
    Tfee = T if fee_clock_T is None else fee_clock_T
    while True:
        tau = T - t
        L = float(R.max_leverage(1.0 - px, tau, min_dist=min_dist))
        if lev_cap is not None:
            L = min(L, lev_cap)
        if L < 2 or px >= 0.99:
            break
        C = float(R.reserve(px, L))
        W = px + C * px / L
        if W > p[-1] + 1e-12 or W > 0.99 + 1e-12:
            break
        # first time the NO price reaches W
        k_end = int(np.searchsorted(p, W - 1e-12))
        if k_end >= len(tg):
            break
        t_end = tg[k_end]
        k0 = int(np.searchsorted(tg, t))
        seg = slice(k0, k_end + 1)
        tau_fee = np.maximum(np.maximum(Tfee - tg[seg], 0.0), R.TAU_FLOOR)
        fee = R.borrowed_shares(px, L) * skew * np.trapz((1.0 - p[seg]) / tau_fee, tg[seg])
        net = max(0.0, C - fee) * (1.0 - R.PROFIT_FEE)
        cycles.append((t, t_end, net, L, px, W, C, fee))
        t = t_end
        px = np.round(W, 2)
    return cycles


def evaluate(kind, T, q0, T1, skew, n_mc=1_000_000, **kw):
    cyc = schedule(kind, T, q0, T1, skew, **kw)
    if not cyc:
        return dict(ev=0.0, mc=0.0, se=0.0, n=0, gross=0.0, fees=0.0, days=0.0)
    ts = np.array([c[0] for c in cyc])
    te = np.array([c[1] for c in cyc])
    net = np.array([c[2] for c in cyc])
    S0 = survival(kind, ts, T, q0, T1)
    S1 = survival(kind, te, T, q0, T1)
    ev = float((S1 * net - (S0 - S1) * 1.0).sum())  # S(0) = 1
    th = draw_event_times(kind, n_mc, T, q0, T1)
    pnl = np.zeros(n_mc)
    for a, b, g in zip(ts, te, net):
        pnl += np.where(th > b, g, 0.0) - np.where((th > a) & (th <= b), 1.0, 0.0)
    return dict(ev=ev, mc=pnl.mean(), se=pnl.std(ddof=1) / np.sqrt(n_mc), n=len(cyc),
                gross=float(sum(c[6] for c in cyc)), fees=float(sum(min(c[7], c[6]) for c in cyc)),
                days=te[-1] / DAY, cyc=cyc, p_any_loss=float(1 - S1[-1]))


if __name__ == "__main__":
    T = 400 * DAY
    T1 = 30 * DAY
    print("NO harvest, 400-day contract. EV per $1 staked per cycle, summed over the harvest (exact | Monte Carlo +/- s.e.).")
    print("gross = sum of caps if nothing happens; fee = crowding fee E4 collected if nothing happens.")
    for p_no0 in (0.90, 0.80, 0.70):
        q0 = 1.0 - p_no0
        print("\nstart NO = %.2f" % p_no0)
        print("%-34s %5s | %7s %7s | %9s | %19s | %6s" % ("hazard shape", "skew", "gross", "fee", "EV exact", "EV Monte Carlo", "days"))
        for kind, label in (("H1", "H1 uniform crash time (E4's case)"), ("H2", "H2 constant hazard"),
                            ("H3", "H3 front-loaded (first 30 days)"), ("H4", "H4 back-loaded (last 30 days)")):
            for skew in (1.0, 0.5, 0.0):
                e = evaluate(kind, T, q0, T1, skew)
                print("%-34s %5.1f | %7.3f %7.3f | %+9.4f | %+9.4f +/- %.4f | %6.1f" % (
                    label, skew, e["gross"], e["fees"], e["ev"], e["mc"], e["se"], e["days"]))
    print("\nCycle detail, start NO = 0.90, H3 front-loaded, skewFrac = 1:")
    e = evaluate("H3", T, 0.10, T1, 1.0)
    for c in e["cyc"]:
        print("  day %5.1f -> %5.1f  NO %.2f -> %.2f  L=%d  cap %.3f  fee %.4f  net %.3f" % (
            c[0] / DAY, c[1] / DAY, c[4], c[5], c[3], c[6], c[7], c[2]))

    print("\nFixes for H3 (front-loaded), start NO = 0.90, skewFrac = 1: EV of the whole harvest per $1 per cycle")
    for label, kw in (("current rules", {}),
                      ("fee clock = 30-day decision window", dict(fee_clock_T=T1)),
                      ("leverage cap 3", dict(lev_cap=3.0)),
                      ("leverage cap 2", dict(lev_cap=2.0)),
                      ("5-tick minimum distance", dict(min_dist=0.05))):
        e = evaluate("H3", T, 0.10, T1, 1.0, **kw)
        print("  %-36s EV %+0.4f (MC %+0.4f +/- %.4f), %d cycles, fee collected %.3f of gross %.3f" % (
            label, e["ev"], e["mc"], e["se"], e["n"], e["fees"], e["gross"]))

    # ---- H5: lumpy information -------------------------------------------------------------
    print("\nH5 lumpy: K scheduled decision points left, each 'X happens' with probability q (NO -> 0), else NO jumps up.")
    print("Open NO at max leverage an hour before each decision, exit after it. Contract end 300 days away.")
    print("%3s %5s | %6s %6s %3s | %8s %8s | %12s | %21s | %12s" % (
        "K", "q", "NO", "NO'", "L", "raw win", "cap C", "EV exact", "EV Monte Carlo", "EV at L=1"))
    tau = 300 * DAY
    for K, q in ((6, 0.10), (4, 0.15), (3, 0.30), (2, 0.50), (8, 0.05), (1, 0.30)):
        p0 = (1 - q) ** K
        p1 = (1 - q) ** (K - 1)
        mid0 = float(R.round_tick(p0))
        mid1 = float(R.round_tick(p1))
        if mid0 > 0.99 or mid0 < 0.01:
            continue
        L = float(R.max_leverage(1 - mid0, tau))
        C = float(R.reserve(mid0, L))
        raw = L / mid0 * (min(mid1, 1.0) - mid0)
        hold = 2 * 3600.0
        fee = R.borrowed_shares(mid0, L) * (1 - mid0) / tau * hold
        win = max(0.0, min(raw, C) - fee) * 0.9
        ev = (1 - q) * win - q * 1.0
        n = 1_000_000
        x = rng.random(n) < q
        pnl = np.where(x, -1.0, win)
        raw1 = 1.0 / mid0 * (mid1 - mid0)
        ev1 = (1 - q) * 0.9 * min(raw1, C) - q
        print("%3d %5.2f | %6.2f %6.2f %3d | %8.3f %8.3f | %+12.4f | %+9.4f +/- %.4f | %+12.4f" % (
            K, q, mid0, mid1, L, raw, C, ev, pnl.mean(), pnl.std(ddof=1) / np.sqrt(n), ev1))

    # ---- H6: unscheduled partial news ------------------------------------------------------
    print("\nH6 unscheduled partial news: the YES price jumps from p0 to pu (prob (p0-pd)/(pu-pd)) or to pd, nothing in between.")
    print("Free mode, max leverage, contract end 300 days away. 'wait' = days the position sits before the news;")
    print("crowding fee at skewFrac 1 for that wait (from profit only). EV per $1 margin, exact.")
    print("%5s %5s %5s | %4s %3s | %10s %10s %10s | %10s" % ("p0", "pu", "pd", "side", "L", "wait 0d", "wait 5d", "wait 20d", "L=1"))
    for p0, pu, pd in ((0.10, 0.20, 0.05), (0.10, 0.30, 0.05), (0.30, 0.45, 0.20), (0.50, 0.60, 0.40),
                       (0.50, 0.70, 0.40), (0.80, 0.90, 0.60), (0.90, 0.95, 0.70), (0.90, 1.00, 0.00)):
        P_u = (p0 - pd) / (pu - pd)
        best = None
        for side in ("YES", "NO"):
            ps0 = p0 if side == "YES" else 1 - p0
            a = pu if side == "YES" else 1 - pu
            b = pd if side == "YES" else 1 - pd
            L = float(R.max_leverage(p0, tau))
            evs = []
            for wait in (0.0, 5.0, 20.0):
                fee = R.borrowed_shares(ps0, L) * (1 - ps0) / tau * wait * DAY
                ev = 0.0
                for prob, ps1 in ((P_u, a), (1 - P_u, b)):
                    r = float(R.result(ps0, ps1, L))
                    liq = (1 + r <= R.MAINT)
                    tr, _, _ = R.settle(np.array([r]), fee, np.array([liq]))
                    ev += prob * float(tr[0])
                evs.append(ev)
            ev1 = 0.0
            for prob, ps1 in ((P_u, a), (1 - P_u, b)):
                tr, _, _ = R.settle(np.array([float(R.result(ps0, ps1, 1.0))]), 0.0, np.array([False]))
                ev1 += prob * float(tr[0])
            if best is None or evs[0] > best[2][0]:
                best = (side, L, evs, ev1)
        print("%5.2f %5.2f %5.2f | %4s %3d | %+10.3f %+10.3f %+10.3f | %+10.3f" % (
            p0, pu, pd, best[0], best[1], best[2][0], best[2][1], best[2][2], best[3]))
