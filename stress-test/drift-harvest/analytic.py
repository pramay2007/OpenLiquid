"""
Closed-form / quadrature results for drift harvesting in the continuous-price constant-hazard model
p_s(t) = exp(-lambda * (T_true - t)), crash to 0 at rate lambda (so p_s is a martingale).

Strategy "cap": open free mode at the maximum leverage E3 allows, hold to the win line, collect C,
re-open at the new price.  Per round from price p with leverage L:
   win line        p_w = p + (1-p)/L
   time to it      D   = ln(p_w/p)/lambda
   P(no crash)     p/p_w
   cap             C   = M(1-p)/p            (M = 1)
   E4 fee          F   = sf * b * int_0^D (1 - p e^{lambda s}) / max(T_fee - t - s, 3600) ds,  b = (L-1)/p
   EV              = (p/p_w) * 0.9 * max(C - F, 0) - (1 - p/p_w)
"""
import math
import numpy as np
from scipy.integrate import quad

DAY = 86400.0
H_REACT = 120.0


def ltime(p, tau):
    if tau <= 0:
        return 0.0
    return min(p, 1 - p) / (3.0 * math.sqrt(p * (1 - p) * H_REACT / tau))


def lmax(p, tau, cap=50.0):
    return min(cap, min(p, 1 - p) / 0.02, ltime(p, tau))


def rho(p):
    """E4 rate (1-p)/tau divided by the constant-hazard drift per share  -p ln p / tau."""
    return (1 - p) / (-p * math.log(p))


def chain(p0, T, H, T_true=None, sf=1.0, fee=True, share=0.10, Lmin=1.05, Lcap=1e9, T_fee=None,
          floor=3600.0, first_only=False, entry_ticks=0.0):
    """Expected P&L and expected margin-time of the hold-to-cap harvester over the window [0, H]."""
    T_true = T if T_true is None else T_true
    T_fee = T if T_fee is None else T_fee
    lam = -math.log(p0) / T_true
    t, S, ev, mt = 0.0, 1.0, 0.0, 0.0
    rounds = []
    while t < min(H, T_true) - 1e-9:
        p = math.exp(-lam * (T_true - t))
        L = min(lmax(p, T - t), Lcap)
        if L < Lmin or p > 0.99:
            break
        pw = p + (1 - p) / L
        D = math.log(pw / p) / lam
        b = (L - 1) / p
        C = (1 - p) / p
        full = True
        if t + D > H:  # window ends first: close at H at the then price
            D = H - t
            full = False
        pend = p * math.exp(lam * D)
        gross = (L / p) * (pend - p) if not full else C
        F = 0.0
        if fee:
            F = sf * b * quad(lambda s: (1 - p * math.exp(lam * s)) / max(T_fee - t - s, floor), 0, D)[0]
            F += sf * b * 0.01 * entry_ticks
        pwin = math.exp(-lam * D)
        net = max(gross - F, 0.0) * (1 - share)
        ev_round = pwin * net - (1 - pwin)
        ev += S * ev_round
        mt += S * (1 - pwin) / lam
        rounds.append(dict(t=t, p=p, L=L, pw=pw, D=D, C=C, F=F, pwin=pwin, ev=ev_round,
                           ev_gross_nofee=pwin * gross - (1 - pwin)))
        S *= pwin
        t += D
        if first_only:
            break
    return dict(ev=ev, mdays=mt / DAY, rate=ev / (mt / DAY) if mt > 0 else float("nan"), rounds=rounds)


def breakeven_sf(p0, T, share=0.10):
    """skewFrac at which the first hold-to-cap round has zero EV (fee fully collected)."""
    r1 = chain(p0, T, 1e12, sf=1.0, first_only=True)["rounds"][0]
    F1, C, pw = r1["F"], r1["C"], r1["pwin"]
    return (C - (1 - pw) / ((1 - share) * pw)) / F1


if __name__ == "__main__":
    print("=== A. Is (1-p)/tau conservative?  ratio to the true drift per share ===")
    print(" p_s   const-hazard drift*tau   E4 rate*tau   rho=E4/const   uniform-crash drift*tau   E4/uniform")
    for p in [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 0.99]:
        print(f" {p:4.2f}   {-p*math.log(p):10.4f}            {1-p:6.3f}       {rho(p):6.3f}          "
              f"{p*(1-p):8.4f}             {1/p:6.3f}")

    print("\n=== B. Hold-to-cap harvest, constant hazard, continuous price: first round ===")
    print(" tau0   p0    L      win line  days/round  P(win)   C      EV no fee  EV no fee,10%share  "
          "E4 fee F  F/(b*dp)  EV with E4 sf=1  breakeven sf")
    for Td in [1, 3, 7, 30, 90]:
        for p0 in [0.2, 0.5, 0.7, 0.9, 0.95]:
            T = Td * DAY
            if lmax(p0, T) < 1.05:
                continue
            nf = chain(p0, T, 1e12, fee=False, first_only=True)["rounds"][0]
            wf = chain(p0, T, 1e12, fee=True, first_only=True)["rounds"][0]
            b = (nf["L"] - 1) / p0
            fair = b * (nf["pw"] - p0)
            print(f" {Td:3d}d  {p0:4.2f}  {nf['L']:5.2f}  {nf['pw']:6.4f}   {nf['D']/DAY:8.4f}   {nf['pwin']:6.4f}  "
                  f"{nf['C']:6.3f}  {nf['ev_gross_nofee']:+8.4f}    {nf['ev']:+8.4f}          {wf['F']:7.4f}   "
                  f"{wf['F']/fair:6.3f}    {wf['ev']:+8.4f}       {breakeven_sf(p0, T):6.3f}")

    print("\n=== C. EV per dollar-day over a window (re-opening at max leverage each round) ===")
    print(" tau0   p0    window   no fee      E4 sf=1     sf=0.9     sf=0.75    sf=0.5     sf=0.25    "
          "instantaneous lam*(0.9L-1)")
    for Td, Hd in [(1, 0.25), (3, 1), (7, 2), (30, 5), (90, 10)]:
        for p0 in [0.2, 0.5, 0.7, 0.9]:
            T, H = Td * DAY, Hd * DAY
            if lmax(p0, T) < 1.05:
                continue
            row = [chain(p0, T, H, fee=False)["rate"]]
            for sf in [1.0, 0.9, 0.75, 0.5, 0.25]:
                row.append(chain(p0, T, H, sf=sf)["rate"])
            lam = -math.log(p0) / Td
            inst = lam * (0.9 * lmax(p0, T) - 1)
            print(f" {Td:3d}d  {p0:4.2f}  {Hd:5.2f}d  " + "  ".join(f"{x:+9.5f}" for x in row) + f"   {inst:+9.5f}")

    print("\n=== D. True uncertainty window shorter than the contract (fee uses the contract tau) ===")
    print(" contract  true    p0    L      no fee/day   E4 sf=1 /day   fee collected / fair (first round)")
    for Td, p0 in [(30, 0.5), (30, 0.9), (30, 0.2), (90, 0.5), (90, 0.9)]:
        for k in [1, 1.5, 2, 3, 5, 10, 30]:
            T = Td * DAY
            Tt = T / k
            Hh = 0.6 * Tt
            nf = chain(p0, T, Hh, T_true=Tt, fee=False)
            wf = chain(p0, T, Hh, T_true=Tt, fee=True)
            r1 = chain(p0, T, 1e12, T_true=Tt, fee=True, first_only=True)["rounds"][0]
            fair = (r1["L"] - 1) / p0 * (r1["pw"] - p0)
            print(f" {Td:3d}d     {Td/k:6.2f}d  {p0:4.2f}  {r1['L']:5.2f}  {nf['rate']:+10.4f}   {wf['rate']:+10.4f}     "
                  f"{r1['F']/fair:6.3f}")

    print("\n=== E. tau floor (1 h): can a harvest be opened where the floor under-charges? ===")
    print(" (constant hazard, fee fully collected, sf=1; best first-round EV per $ over p in [0.03,0.97])")
    for tau in [900, 1080, 1500, 1800, 2400, 3000, 3600, 5400, 7200, 14400]:
        best = (-9, None)
        for p in np.arange(0.03, 0.975, 0.01):
            L = lmax(p, tau)
            if L < 1.0 + 1e-9:
                continue
            for Lc in [L, 0.5 * (1 + L)]:
                if Lc <= 1.0 + 1e-9:
                    continue
                r = chain(float(p), tau, tau * 0.999, fee=True, first_only=True, Lcap=Lc, Lmin=1.0)["rounds"]
                if r and r[0]["ev"] > best[0]:
                    best = (r[0]["ev"], (float(p), Lc))
        print(f" tau = {tau:6d} s  best EV/round = {best[0]:+.4f}  at (p, L) = {best[1]}")

    print("\n=== F. E3 in play: Ltime for a favourite with tau seconds of the event left ===")
    print(" p_fav   " + "  ".join(f"{m:>6d}m" for m in [5, 15, 30, 45, 60, 90, 120, 180, 360]))
    for p in [0.55, 0.65, 0.75, 0.8, 0.9]:
        print(f" {p:4.2f}    " + "  ".join(f"{ltime(p, m*60):7.2f}" for m in [5, 15, 30, 45, 60, 90, 120, 180, 360]))
    print(" minimum time left for Ltime >= 1:  " + ", ".join(
        f"p={p}: {9*H_REACT*p*(1-p)/min(p,1-p)**2/60:.0f} min" for p in [0.5, 0.6, 0.7, 0.8, 0.9]))

    print("\n=== G. What E3 is blocking: hypothetical in-play harvest if opens were allowed after kickoff ===")
    print(" (favourite leading, one-sided crash at constant hazard over the minutes left; leverage min(50, (1-p)/0.02);")
    print("  E4 fee uses tau floored at 1 h, so fee/fair = rho * minutes_left/60)")
    print(" p_fav  min left   L     harvest EV per $-minute (no fee)   E4 fee / fair")
    for p in [0.6, 0.7, 0.8, 0.9]:
        for m in [45, 30, 15]:
            lam = -math.log(p) / m
            L = min(50.0, (1 - p) / 0.02)
            print(f" {p:4.2f}   {m:4d}    {L:5.1f}    {lam*(0.9*L-1):+8.4f}                           {rho(p)*m/60:5.2f}")
