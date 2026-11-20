"""
S6 - exact side computations.

 1. Is the implied-hazard rate (1-p_s)/tau enough?  Same total variance p(1-p) spread over the time
    left, delivered as jumps of a given size: closed-form ratio of what a position earns from the
    jumps to what it is charged (crowding fee at skewFrac = 1, or Boost premium).
 2. Fix test: free-mode cap = min(M, M(1-p0)/p0) (never more than 1:1 on a leveraged position).
    Best-response trader EV over two-point mean-zero jumps and over the latent-normal shock.
 3. Value of a position that jumped through its stop and was NOT liquidated (liquidators are paid out
    of remaining equity, which is zero), per $1 of its margin.
 4. A transient spike with no noise: straddle P&L (deterministic).
"""
import json
import numpy as np
from scipy.stats import norm
from rules import leg, max_lev, two_point, lev_time, TAU_SLOW, MAINT, LIQ_FEE, PROFIT_SHARE

DAY = 86400.0
OUT = {}

# ---------------------------------------------------------------------------------------------
print("=" * 110)
print("1. Jump-size sensitivity of the implied-hazard charge (per borrowed share, variance budget p(1-p)/tau).")
print("   'earn/charge' > 1 means the position earns more from jumps than the rule charges.")
print("=" * 110)
print("   (a) drift harvesting, free mode: side price e drifts up, crashes by A points; charge = crowding fee at skewFrac = 1")
print(f"   {'e':>5s} {'L':>4s} {'crash A (pts)':>14s} {'earn/charge':>12s}   formula e(A - e/L)/(A^2 (1-1/L))")
OUT["hazard_harvest"] = []
for e, L in [(0.8, 10), (0.9, 5), (0.7, 15), (0.6, 20)]:
    for A in [e, 0.40, 0.30, 0.20, 0.10]:
        if A > e or A <= e / L:
            continue
        ratio = e * (A - e / L) / (A * A * (1 - 1 / L))
        print(f"   {e:5.2f} {L:4d} {A*100:14.0f} {ratio:12.2f}")
        OUT["hazard_harvest"].append(dict(e=e, L=L, A=A, ratio=ratio))
print("   (b) Boost, own-side price e, favourable jump F w.p. A/(A+F), adverse A; charge = Boost premium")
print(f"   {'e':>5s} {'L':>4s} {'+F/-A (pts)':>14s} {'earn/charge':>12s}   earn = n F (A - e/L)/(A+F) per jump (uncapped), jumps at rate e(1-e)/(tau A F)")
OUT["hazard_boost"] = []
for e, L in [(0.5, 25), (0.5, 16), (0.3, 15)]:
    for F, A in [(1 - e, e), (0.40, 0.40), (0.20, 0.20), (0.10, 0.10), (0.05, 0.05)]:
        if A > e or F > 1 - e or A <= e / L:
            continue
        n = L / e
        gain = min(10.0, n * F)                      # per $1 margin, capped at 10x
        ev_jump = (A / (A + F)) * gain * (1 - PROFIT_SHARE) - (F / (A + F)) * 1.0
        rate = e * (1 - e) / (A * F)                 # jumps per tau
        prem = n * (1 - 1 / L) * (1 - e)             # per tau
        print(f"   {e:5.2f} {L:4d} {F*100:6.0f}/{A*100:<6.0f} {ev_jump*rate/prem:12.2f}")
        OUT["hazard_boost"].append(dict(e=e, L=L, F=F, A=A, ratio=ev_jump * rate / prem))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("2. FIX TEST: free-mode profit cap = min(M, M(1-p0)/p0).  Best single free position (any side, any L)")
print("   against each mean-zero two-point jump; trader EV per $1 after the 10% profit share.")
print("=" * 110)


def leg_fix(side, M, L, p0, p1, profit_share=PROFIT_SHARE):
    e = p0 if side > 0 else 1 - p0
    x = p1 if side > 0 else 1 - p1
    n = M * L / e
    cap = min(M, M * (1 - e) / e) if L > 1 else M * (1 - e) / e
    res = np.maximum(np.minimum(n * (x - e), cap), -M)
    liq = M + res <= MAINT * M
    lf = np.where(liq, np.minimum(LIQ_FEE * M, M + res), 0.0)
    win = res > 0
    return np.where(win, res * (1 - profit_share), res - lf)


OUT["fix_cap"] = {}
for p0 in [0.50, 0.30, 0.20]:
    Lm = int(max_lev(p0, 30 * DAY))
    print(f"  p0 = {p0:.2f}")
    print(f"   {'jump +U/-D':>12s} {'now: best EV':>13s} {'with fix: best EV':>18s}   (side, L)")
    for (U, D) in [(0.10, 0.10), (0.20, 0.20), (0.10, 0.20), (0.20, 0.10), (0.05, 0.20), (0.20, 0.05), (0.40, 0.10), (0.10, 0.40)]:
        if p0 + U > 0.99 or p0 - D < 0.01:
            continue
        J, pr = two_point(U, D)
        best_now, best_fix = (-9, None), (-9, None)
        for side in (+1, -1):
            for L in range(1, Lm + 1):
                o = leg(side, "free", 1.0, float(L), p0, p0 + J)
                ev = float(pr @ o["trader"])
                if ev > best_now[0] + 1e-12:
                    best_now = (ev, (side, L))
                ev2 = float(pr @ leg_fix(side, 1.0, float(L), p0, p0 + J))
                if ev2 > best_fix[0] + 1e-12:
                    best_fix = (ev2, (side, L))
        sn = {1: "YES", -1: "NO"}
        print(f"   +{U*100:>3.0f}/-{D*100:<3.0f}     {best_now[0]:+13.3f} {best_fix[0]:+18.3f}   now {sn[best_now[1][0]]} {best_now[1][1]}x; fix {sn[best_fix[1][0]]} {best_fix[1][1]}x")
        OUT["fix_cap"][f"p{p0}_U{U}_D{D}"] = dict(now=best_now[0], fix=best_fix[0])

print("\n   Latent-normal shock (1 of 4 equal shocks), cheap side, by price and leverage: trader EV per $1")
print(f"   {'p0':>5s} {'L':>4s} {'now':>8s} {'with fix':>9s}")
z = np.linspace(-8, 8, 160001)
w = norm.pdf(z) * (z[1] - z[0])
OUT["fix_latent"] = []
for p0 in [0.40, 0.30, 0.20, 0.10]:
    S = 2 * norm.ppf(p0)
    p1 = np.clip(np.round(norm.cdf((S + z) / np.sqrt(3)) / 0.01) * 0.01, 0.01, 0.99)
    for L in [2, 4, 8, int(max_lev(p0, 30 * DAY))]:
        now = float(w @ leg(+1, "free", 1.0, float(L), p0, p1)["trader"])
        fix = float(w @ leg_fix(+1, 1.0, float(L), p0, p1))
        print(f"   {p0:5.2f} {L:4d} {now:+8.3f} {fix:+9.3f}")
        OUT["fix_latent"].append(dict(p0=p0, L=L, now=now, fix=fix))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("3. A position that jumped through its stop and is NOT liquidated keeps its settlement value.")
print("   Expected value left with the trader = x/e per $1 of margin (x = own-side price after the jump),")
print("   i.e. what the house fails to collect.  Liquidator reward available for removing it: 0.")
print("=" * 110)
OUT["unliquidated"] = []
for e, x in [(0.50, 0.30), (0.50, 0.10), (0.30, 0.10), (0.70, 0.50), (0.46, 0.20)]:
    v = x / e
    print(f"   entry {e:.2f}, after an adverse jump to {x:.2f}: value kept if not liquidated = {v:.3f} per $1 margin (liquidated: 0.000)")
    OUT["unliquidated"].append(dict(e=e, x=x, value=v))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("4. Transient spike of S ticks for one 4 s poll, no other movement.  25x free straddle at 0.50, $1 per leg.")
print("   The leg against the spike is liquidated at the mid; the other leg can only close at the slow price.")
print("=" * 110)
OUT["spike"] = []
for S in [1, 2, 3, 6, 10]:
    e, L, M = 0.5, 25.0, 1.0
    n = M * L / e
    x = e - S * 0.01
    eq = M + max(n * (x - e), -M)
    liq = eq <= MAINT * M + 1e-12
    lose = (M - eq) if liq else 0.0
    lf = min(LIQ_FEE * M, eq) if liq else 0.0
    slow_move = S * 0.01 * 4.0 / (TAU_SLOW + 4.0)
    win_now = n * slow_move * (1 - PROFIT_SHARE)           # what the other leg could close for during the spike
    print(f"   spike {S:2d} ticks: losing leg liquidated = {liq}, house takes {lose:.2f}, liquidator {lf:.2f};"
          f" winning leg closable for only {win_now:+.3f} (slow moved {slow_move*100:.3f} pts) -> house {lose/2:+.3f} per $1 of straddle margin")
    OUT["spike"].append(dict(S=S, liq=bool(liq), house_per_dollar=lose / 2))

with open(__file__.replace(".py", ".json"), "w") as f:
    json.dump(OUT, f, indent=1, default=float)
