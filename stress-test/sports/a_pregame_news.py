"""Pre-game news jump (lineup / injury) against a free-mode position.

Section: sports pre-game.  Question: is a leveraged free-mode position exploitable around a
news jump (a) without any information (convexity from the stop line) and (b) with the
R6 stale-price window (open at the pre-news price after seeing the jump)?
Input: rules in ol.py.  Output: EV per $1 margin, with standard errors.

Timeline per path (all prices on the 1c grid):
  t = -60 s   open at mid = slow = p (quiet book), leverage = E3 maximum (integer)
  t = 0       mid jumps by J (martingale).  slow still at p.
  t = 30 s .. 40 min: slow converges (tau = 300 s); the mid takes +-1 tick noise steps.
     keeper alive: liquidates at mid when equity <= 20%, force-closes when L > time limit
     trader: collect when the close price reaches the win line; otherwise closes a winner
             once the slow price is within 1/20 tick of the mid; closes everything at 40 min.
Crowding fee at the stated skew (profit only), then the 10% profit share.
"""
import sys
import numpy as np
from ol import (ltime, lmax, net_close, net_liq, mean_se, MAINT, TAU_SLOW, TAU_FLOOR, LCAP)

import os
N = int(os.environ.get("N", 300_000))
EXIT_GAP = 0.0005   # winner closes once slow is within 1/20 tick of the mid


def two_point(a, b=None, q=0.5):
    """+a with prob q, -b with prob 1-q; b defaults to the martingale value."""
    if b is None:
        b = a * q / (1 - q)

    def draw(rng, n):
        return np.where(rng.random(n) < q, a, -b)

    return draw


def laplace(scale):
    def draw(rng, n):
        return np.rint(rng.laplace(0.0, scale, n) * 100) / 100

    return draw


def sim_news(p_yes, side_yes, tau, L, draw, n=N, seed=1, skew=1.0, q_noise=0.002,
             steps=80, dt=30.0, informed=False, lead=60.0, phi=1.0, dodge_fc=True):
    rng = np.random.default_rng(seed)
    J = draw(rng, n)
    if informed:  # R6: sees the jump, opens in its direction at the pre-jump signed price
        side = J > 0
        traded = (J != 0) & (rng.random(n) < phi)
        lead = 0.0
    else:
        side = np.full(n, bool(side_yes))
        traded = np.ones(n, bool)
    s0 = np.where(side, p_yes, 1 - p_yes)
    if informed and dodge_fc:   # the bot knows the post-jump mid: stay at or under the time limit there
        post = np.clip(np.rint((p_yes + J) * 100) / 100, 0.01, 0.99)
        L = np.minimum(L, np.maximum(1.0, np.floor(np.minimum(LCAP, ltime(post, tau)) + 1e-9)))
    nsh = L / s0
    C = (1 - s0) / s0
    pw = s0 + (1 - s0) / L
    borrowed = nsh * (1 - 1 / L)
    tau_fee = max(tau, TAU_FLOOR)

    mid = np.clip(np.rint((p_yes + J) * 100) / 100, 0.01, 0.99)
    slow = np.full(n, p_yes)
    alive = traded.copy()
    fee = borrowed * skew * (1 - s0) * lead / tau_fee
    pnl = np.zeros(n)
    liqpaid = np.zeros(n)
    kind = np.zeros(n, np.int8)
    decay = np.exp(-dt / TAU_SLOW)

    def checks(mid, slow, last):
        nonlocal alive
        s_mid = np.where(side, mid, 1 - mid)
        s_slow = np.where(side, slow, 1 - slow)
        res_mid = np.clip(nsh * (s_mid - s0), -1.0, C)
        lq = alive & (1 + res_mid <= MAINT)
        if lq.any():
            net, lf = net_liq(res_mid)
            pnl[lq] = net[lq]; liqpaid[lq] = lf[lq]; kind[lq] = 2
            alive &= ~lq
        cp = np.minimum(s_mid, s_slow)
        res_cp = np.clip(nsh * (cp - s0), -1.0, C)
        co = alive & (nsh * (cp - s0) >= C - 1e-12)
        fc_lim = np.maximum(1.0, np.floor(np.minimum(LCAP, ltime(mid, tau)) + 1e-9))
        fc = alive & ~co & (L > fc_lim)                         # keeper force-close, no penalty
        vol = alive & ~co & ~fc & (res_cp > 0) & (s_mid - s_slow <= EXIT_GAP)
        done = co | fc | vol | (alive & last)
        if done.any():
            net = net_close(res_cp, fee)
            pnl[done] = net[done]
            kind[co] = 3; kind[fc] = 4; kind[vol] = 5
            kind[alive & last & ~(co | fc | vol)] = 6
            alive &= ~done

    checks(mid, slow, False)
    for j in range(1, steps + 1):
        slow = mid + (slow - mid) * decay
        s_prev = np.where(side, mid, 1 - mid)
        fee = fee + alive * borrowed * skew * (1 - s_prev) * dt / tau_fee
        u = rng.random(n)
        mid = np.clip(mid + 0.01 * (u < q_noise) - 0.01 * (u > 1 - q_noise), 0.01, 0.99)
        checks(mid, slow, j == steps)
    return pnl, -pnl - liqpaid, kind


def analytic(p_side, L, a, b, q):
    """No-noise, full-convergence value of the same position (cross-check)."""
    nsh = L / p_side
    C = (1 - p_side) / p_side
    up = min(nsh * a, C)
    lo = max(-nsh * b, -1.0)
    eq = 1 + lo
    if eq <= MAINT:
        lo -= min(0.05, max(eq, 0))
    return q * up * 0.9 + (1 - q) * lo


def row(label, pnl, house):
    m, s = mean_se(pnl)
    hm, hs = mean_se(house)
    print(f"  {label:<58s} trader {m:+.4f} (se {s:.4f})   house {hm:+.4f} (se {hs:.4f})")


if __name__ == "__main__":
    np.set_printoptions(suppress=True)
    print(f"{N} paths per cell; crowding fee at skew 1 throughout (worst case for the trader)")
    print("=" * 110)
    print("A1. E3 stop distance vs time to kickoff (integer leverage; stop distance = own-side price / L)")
    print("    tau       p=0.50: L  stop(pts)   p=0.30: L  stop(pts)   p=0.20: L  stop(pts)")
    for lab, tau in [("7 d", 7 * 86400), ("5 d", 5 * 86400), ("3 d", 3 * 86400), ("48 h", 48 * 3600),
                     ("24 h", 86400), ("12 h", 43200), ("6 h", 21600), ("3 h", 10800), ("72 min", 4321),
                     ("60 min", 3600)]:
        out = f"    {lab:<8s}"
        for p in (0.5, 0.3, 0.2):
            L = float(lmax(p, tau))
            out += f"   {L:>8.0f}  {100 * p / L:>8.1f}"
        print(out)

    print()
    print("A2. UNINFORMED holder through a symmetric +-J news jump (opened 60 s before, E3 maximum leverage)")
    for p_yes, tau, lab in [(0.30, 7 * 86400, "7 d"), (0.30, 48 * 3600, "48 h"), (0.30, 86400, "24 h"),
                            (0.20, 5 * 86400, "5 d")]:
        L = float(lmax(p_yes, tau))
        print(f" p={p_yes:.2f}, tau={lab}, L={L:.0f}: stop {100 * p_yes / L:.1f} pts (cheap side), "
              f"win line +{100 * (1 - p_yes) / L:.1f} pts, C={(1 - p_yes) / p_yes:.2f}", flush=True)
        for a in (0.03, 0.05, 0.08, 0.10):
            pn, ho, _ = sim_news(p_yes, True, tau, L, two_point(a), seed=11)
            an = analytic(p_yes, L, a, a, 0.5)
            row(f"cheap side  YES  J=+-{100 * a:.0f} pts  (analytic no-noise {an:+.3f})", pn, ho)
        pn, ho, kd = sim_news(p_yes, False, tau, L, two_point(0.05), seed=12)
        row(f"favourite side NO  J=+-5 pts  [winners force-closed {np.mean(kd == 4):.2f}]", pn, ho)

    print()
    print("A2b. Even-money market: maximum leverage vs two notches lower (to stay under the time limit after a move)")
    for tau, lab in [(7 * 86400, "7 d"), (86400, "24 h")]:
        Lm = float(lmax(0.5, tau))
        for L in (Lm, Lm - 3 if Lm > 10 else Lm - 2):
            pn, ho, kd = sim_news(0.5, True, tau, L, two_point(0.05), seed=19)
            row(f"p=0.50 tau={lab} L={L:.0f}  J=+-5 pts  [force-closed {np.mean(kd == 4):.2f}, collected {np.mean(kd == 3):.2f}]", pn, ho)

    print()
    print("A3. UNINFORMED holder, skewed news (likely small move in favour, unlikely large move against)")
    for p_yes, tau, lab, a, q, dL in [(0.30, 7 * 86400, "7 d", 0.03, 0.7, 0), (0.30, 48 * 3600, "48 h", 0.03, 0.7, 0),
                                      (0.50, 7 * 86400, "7 d", 0.02, 0.7, 3), (0.50, 86400, "24 h", 0.03, 0.75, 2)]:
        L = float(lmax(p_yes, tau)) - dL
        b = a * q / (1 - q)
        pn, ho, _ = sim_news(p_yes, True, tau, L, two_point(a, q=q), seed=13)
        row(f"p={p_yes:.2f} tau={lab} L={L:.0f}: +{100 * a:.0f} pts w.p. {q:.2f} / -{100 * b:.1f} pts", pn, ho)

    print()
    print("A4. Laplace news jump (mean |J| = b), cheap side at the E3 maximum, uninformed")
    for p_yes, tau, lab in [(0.30, 7 * 86400, "7 d"), (0.30, 48 * 3600, "48 h"), (0.30, 86400, "24 h"),
                            (0.20, 5 * 86400, "5 d")]:
        L = float(lmax(p_yes, tau))
        for b in (0.02, 0.04):
            pn, ho, _ = sim_news(p_yes, True, tau, L, laplace(b), seed=14)
            row(f"p={p_yes:.2f} tau={lab} L={L:.0f}  Laplace b={100 * b:.0f} pts", pn, ho)

    print()
    print("A5. R6 STALE-PRICE OPEN: bot sees the jump, opens in its direction at the pre-jump signed price (phi = 1)")
    for p_yes, tau, lab in [(0.30, 7 * 86400, "7 d"), (0.30, 86400, "24 h"), (0.50, 86400, "24 h"),
                            (0.50, 21600, "6 h"), (0.50, 3600, "60 min"), (0.30, 3600, "60 min")]:
        L = float(lmax(p_yes, tau))
        for b in (0.02, 0.04):
            pn, ho, _ = sim_news(p_yes, True, tau, L, laplace(b), seed=15, informed=True)
            row(f"p={p_yes:.2f} tau={lab} L<={L:.0f}  Laplace b={100 * b:.0f} pts  [traded {np.mean(pn != 0):.2f} of jumps]", pn, ho)
        pn, ho, _ = sim_news(p_yes, True, tau, L, two_point(0.05), seed=16, informed=True)
        row(f"p={p_yes:.2f} tau={lab} L<={L:.0f}  J=+-5 pts", pn, ho)

    print()
    print("A6. Same tests under the proposed sports cap  L <= floor(min(p,1-p)/0.10)  (stop >= 10 pts)")
    for p_yes, tau, lab in [(0.30, 7 * 86400, "7 d"), (0.20, 5 * 86400, "5 d"), (0.50, 7 * 86400, "7 d")]:
        L = float(np.minimum(lmax(p_yes, tau), np.maximum(1.0, np.floor(min(p_yes, 1 - p_yes) / 0.10 + 1e-9))))
        for a in (0.05, 0.10, 0.15):
            if p_yes - a < 0.02:
                continue
            pn, ho, _ = sim_news(p_yes, True, tau, L, two_point(a), seed=17)
            row(f"p={p_yes:.2f} tau={lab} L={L:.0f}  cheap side J=+-{100 * a:.0f} pts", pn, ho)
        pn, ho, _ = sim_news(p_yes, True, tau, L, laplace(0.04), seed=18)
        row(f"p={p_yes:.2f} tau={lab} L={L:.0f}  cheap side Laplace b=4 pts", pn, ho)
