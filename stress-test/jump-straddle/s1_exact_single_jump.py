"""
S1 - exact (no simulation) house P&L per dollar of trader margin through ONE jump.

Assumptions (stated simplifications):
  * calm market before the jump (mid = slow = p0), so every fill is at p0;
  * the jump persists, losers are liquidated at the post-jump mid (or settled if resolved),
    winners close once the slow price has converged (close price = post-jump mid);
  * integer leverage (as in the contract); time-to-expiry 30 days unless stated, so the
    time limit Ltime does not bind and L = min(50, floor(min(p,1-p)/0.02));
  * crowding fee / Boost premium for a short hold are shown separately (they are ~0 over minutes).
House P&L includes the 10% profit share it keeps.  Liquidator reward comes out of the trader's
remaining equity, so it never changes the house number.
"""
import itertools
import json
import numpy as np
from rules import leg, max_lev, two_point, lev_time, TAU_SLOW

DAY = 86400.0
np.set_printoptions(linewidth=200, suppress=True)
OUT = {}


def straddle(p0, legs, p1, **kw):
    """legs: list of (side, mode, M, L). Returns house and trader P&L arrays and total margin."""
    house = 0.0
    trader = 0.0
    margin = 0.0
    for (side, mode, M, L) in legs:
        if M <= 0:
            continue
        o = leg(side, mode, M, L, p0, p1, **kw)
        house = house + o["house"]
        trader = trader + o["trader"]
        margin += M
    return house, trader, margin


def std_straddles(p0, tau=30 * DAY):
    Lm = float(max_lev(p0, tau))
    out = {}
    out["free/free same L, equal margin"] = [(+1, "free", 1.0, Lm), (-1, "free", 1.0, Lm)]
    out["free/free same L, balanced (M_Y:M_N = p:1-p)"] = [(+1, "free", p0, Lm), (-1, "free", 1 - p0, Lm)]
    # leverage mismatch with matched BORROWED shares: YES at max L, NO at 2x
    BY = (1.0 * Lm / p0) * (1 - 1 / Lm)
    L2 = 2.0
    MN = BY * (1 - p0) / (L2 - 1)          # B_N = M_N (L-1)/(1-p0)
    out["free/free mismatch: YES maxL, NO 2x, borrowed shares matched"] = [(+1, "free", 1.0, Lm), (-1, "free", MN, L2)]
    out["free YES only (max L)"] = [(+1, "free", 1.0, Lm)]
    out["free NO only (max L)"] = [(-1, "free", 1.0, Lm)]
    out["boost/boost same L, equal margin"] = [(+1, "boost", 1.0, Lm), (-1, "boost", 1.0, Lm)]
    out["boost YES + free NO, equal margin"] = [(+1, "boost", 1.0, Lm), (-1, "free", 1.0, Lm)]
    return Lm, out


# ---------------------------------------------------------------------------------------------
print("=" * 110)
print("A. ONE JUMP STRAIGHT TO RESOLUTION (YES w.p. p0, NO w.p. 1-p0).  House P&L per $1 of trader margin")
print("=" * 110)
OUT["A"] = {}
for p0 in [0.10, 0.30, 0.50, 0.70, 0.90]:
    Lm, S = std_straddles(p0)
    print(f"\np0 = {p0:.2f}   max leverage = {Lm:.0f}x")
    print(f"  {'structure':62s} {'YES wins':>9s} {'NO wins':>9s} {'E[house]':>9s} {'= x*E[profit]':>13s}")
    OUT["A"][p0] = {}
    for name, legs in S.items():
        h, t, m = straddle(p0, legs, np.array([1.0, 0.0]), resolved=True)
        ev = (p0 * h[0] + (1 - p0) * h[1]) / m
        # expected gross profit of winners (before profit share), to show E[house] = 10% of it for free mode
        gross = 0.0
        for (side, mode, M, L) in legs:
            o = leg(side, mode, M, L, p0, np.array([1.0, 0.0]), resolved=True, profit_share=0.0)
            gross += p0 * max(o["trader"][0], 0) + (1 - p0) * max(o["trader"][1], 0)
        print(f"  {name:62s} {h[0]/m:9.3f} {h[1]/m:9.3f} {ev:9.4f} {ev/(gross/m) if gross>0 else float('nan'):13.3f}")
        OUT["A"][p0][name] = dict(yes=float(h[0] / m), no=float(h[1] / m), ev=float(ev))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("B. ONE PARTIAL JUMP of F points.  House P&L per $1 of trader margin, by direction, and the")
print("   expectation when the jump is symmetric (+F / -F with prob 1/2 each: a mean-zero jump).")
print("=" * 110)
OUT["B"] = {}
for p0 in [0.50, 0.30]:
    Lm, S = std_straddles(p0)
    print(f"\np0 = {p0:.2f}   max leverage = {Lm:.0f}x   (YES win line +{(1-p0)/Lm*100:.2f} pts, YES stop -{p0/Lm*100:.2f} pts)")
    OUT["B"][p0] = {}
    for F in [0.10, 0.20, 0.30, 0.40]:
        if p0 - F < 0.01 or p0 + F > 0.99:
            continue
        print(f"  jump size F = {F*100:.0f} points")
        print(f"    {'structure':62s} {'up':>9s} {'down':>9s} {'E sym':>9s}")
        OUT["B"][p0][F] = {}
        for name, legs in S.items():
            h, t, m = straddle(p0, legs, np.array([p0 + F, p0 - F]))
            print(f"    {name:62s} {h[0]/m:9.3f} {h[1]/m:9.3f} {(h[0]+h[1])/2/m:9.3f}")
            OUT["B"][p0][F][name] = dict(up=float(h[0] / m), down=float(h[1] / m), ev=float((h[0] + h[1]) / 2 / m))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("C. FLATNESS TEST.  Single free-mode position, max leverage, mean-zero two-point jump (+U w.p. D/(U+D), -D).")
print("   Trader EV per $1 margin BEFORE the profit share (so 0.000 = exactly fair), then house EV after its 10%.")
print("   Closed form when both lines are crossed:  EV = [D(1-p) - U p] / [p (U+D)]  = (pi_up - p)/p.")
print("=" * 110)
OUT["C"] = {}
sizes = [0.05, 0.10, 0.20, 0.30, 0.40]
for p0 in [0.50, 0.30, 0.70]:
    Lm = float(max_lev(p0, 30 * DAY))
    print(f"\np0 = {p0:.2f} (YES side), L = {Lm:.0f}x.  Rows: up-jump U; columns: down-jump D (points).  Cell = trader EV gross | house EV net")
    print("        " + "".join(f"   D={d*100:>3.0f}        " for d in sizes))
    OUT["C"][p0] = {}
    for U in sizes:
        row = f" U={U*100:>3.0f}  "
        for D in sizes:
            if p0 + U > 0.99 or p0 - D < 0.01:
                row += "        n/a       "
                continue
            J, pr = two_point(U, D)
            g = leg(+1, "free", 1.0, Lm, p0, p0 + J, profit_share=0.0)
            n_ = leg(+1, "free", 1.0, Lm, p0, p0 + J)
            evg = float(pr @ g["trader"])
            evh = float(pr @ n_["house"])
            row += f"  {evg:+6.3f} | {evh:+6.3f} "
            OUT["C"][p0][f"U{U}_D{D}"] = dict(trader_gross=evg, house_net=evh)
        print(row)
    print(f"   fair (0.000) only on the ray U/D = (1-p)/p = {(1-p0)/p0:.3f}  (the jump-to-resolution ratio).")

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("D. BEST RESPONSE.  For each p0 and each mean-zero two-point jump, the single free-mode position (side, L)")
print("   with the highest trader EV per $1 margin after all charges; and the best BOOST position.")
print("=" * 110)
OUT["D"] = {}


def best_single(p0, J, pr, modes=("free",), tau=30 * DAY, safe_force=True):
    best = None
    Lm = int(max_lev(p0, tau))
    for side in (+1, -1):
        for mode in modes:
            for L in range(1, Lm + 1):
                # the keeper force-closes at the lagging slow price anything above Ltime(new mid):
                # a winner that becomes force-closable after the jump is paid ~0, so skip those.
                if safe_force:
                    ok = True
                    for j in J:
                        x1 = p0 + j
                        won = (j > 0) if side > 0 else (j < 0)
                        if won and L > np.floor(lev_time(x1, tau) + 1e-9):
                            ok = False
                    if not ok:
                        continue
                o = leg(side, mode, 1.0, float(L), p0, p0 + J)
                ev = float(pr @ o["trader"])
                if best is None or ev > best[0] + 1e-12:
                    best = (ev, side, mode, L, float(pr @ o["house"]), o["trader"].tolist())
    return best


for p0 in [0.50, 0.40, 0.30, 0.20]:
    print(f"\np0 = {p0:.2f}")
    print(f"  {'jump (+U/-D pts)':18s} {'P(up)':>6s} | {'best FREE: side L':>18s} {'trader EV':>10s} {'house EV':>9s} | {'best BOOST: side L':>19s} {'trader EV':>10s} {'house EV':>9s}")
    OUT["D"][p0] = {}
    for (U, D) in [(0.10, 0.10), (0.20, 0.20), (0.30, 0.30), (0.40, 0.40), (0.10, 0.20), (0.20, 0.10), (0.10, 0.40), (0.40, 0.10), (0.05, 0.30), (0.30, 0.05)]:
        if p0 + U > 0.99 or p0 - D < 0.01:
            continue
        J, pr = two_point(U, D)
        bf = best_single(p0, J, pr, modes=("free",))
        bb = best_single(p0, J, pr, modes=("boost",))
        sn = {1: "YES", -1: "NO"}
        print(f"  +{U*100:>3.0f}/-{D*100:<3.0f}          {pr[0]:6.3f} | {sn[bf[1]]:>12s} {bf[3]:>4d}x {bf[0]:10.3f} {bf[4]:9.3f} | {sn[bb[1]]:>13s} {bb[3]:>4d}x {bb[0]:10.3f} {bb[4]:9.3f}")
        OUT["D"][p0][f"U{U}_D{D}"] = dict(free=dict(side=sn[bf[1]], L=bf[3], trader_ev=bf[0], house_ev=bf[4]),
                                          boost=dict(side=sn[bb[1]], L=bb[3], trader_ev=bb[0], house_ev=bb[4]))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("E. NEAR-RISKLESS TWO-LEG COMBINATIONS (max-min over both jump outcomes), per $1 of TOTAL margin, after all charges.")
print("   Leg A and leg B may be any side / mode / leverage; weights searched on a 1% grid.")
print("=" * 110)
OUT["E"] = {}


def best_pair(p0, J, tau=30 * DAY, modes=("free",)):
    Lm = int(max_lev(p0, tau))
    cands = []
    for side in (+1, -1):
        for mode in modes:
            for L in range(1, Lm + 1):
                ok = True
                for j in J:
                    won = (j > 0) if side > 0 else (j < 0)
                    if won and L > np.floor(lev_time(p0 + j, tau) + 1e-9):
                        ok = False
                if ok:
                    o = leg(side, mode, 1.0, float(L), p0, p0 + J)
                    cands.append(((side, mode, L), o["trader"], o["B"]))
    best = (-9, None)
    ws = np.linspace(0, 1, 101)
    for a, b in itertools.combinations(range(len(cands)), 2):
        ta, tb = cands[a][1], cands[b][1]
        tot = np.outer(ws, ta) + np.outer(1 - ws, tb)        # per $1 total margin
        worst = tot.min(axis=1)
        k = int(np.argmax(worst))
        if worst[k] > best[0] + 1e-12:
            best = (float(worst[k]), (cands[a][0], cands[b][0], float(ws[k]), tot[k].tolist(), cands[a][2] * ws[k], cands[b][2] * (1 - ws[k])))
    return best


for p0, U, D in [(0.30, 0.20, 0.20), (0.30, 0.10, 0.10), (0.40, 0.20, 0.20), (0.20, 0.15, 0.15), (0.50, 0.10, 0.40), (0.50, 0.20, 0.20)]:
    J, pr = two_point(U, D)
    for modes, lab in ((("free",), "free only"), (("free", "boost"), "free+boost")):
        w, info = best_pair(p0, J, modes=modes)
        if info is None:
            continue
        (a, b, wa, outc, Ba, Bb) = info
        sn = {1: "YES", -1: "NO"}
        print(f"p0={p0:.2f} jump +{U*100:.0f}/-{D*100:.0f} [{lab:10s}]: {wa*100:3.0f}% in {sn[a[0]]} {a[1]} {a[2]}x + {100-wa*100:3.0f}% in {sn[b[0]]} {b[1]} {b[2]}x"
              f"  -> trader P&L per $1: up {outc[0]:+.3f}, down {outc[1]:+.3f}  (locked-in {w:+.3f});"
              f" borrowed shares {sn[a[0]]} {Ba:.2f} vs {sn[b[0]]} {Bb:.2f}")
        OUT["E"][f"p{p0}_U{U}_D{D}_{lab}"] = dict(legA=[sn[a[0]], a[1], a[2]], legB=[sn[b[0]], b[1], b[2]], wA=wa, up=outc[0], down=outc[1], locked=w, B_A=float(Ba), B_B=float(Bb))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("F. LEVERAGE AVAILABLE vs TIME TO EXPIRY (E3) and what it does to the two headline numbers")
print("   (symmetric +-20 jump; free NO at p0=0.30; boost straddle at p0=0.50).  Leverage is also kept at or below")
print("   Ltime at the post-jump price so the winner cannot be force-closed at the lagging slow price.")
print("=" * 110)
OUT["F"] = {}
for tau_d in [30, 14, 7, 3, 1, 0.5, 0.25, 2 / 24, 1 / 24]:
    tau = tau_d * DAY
    J, pr = two_point(0.20, 0.20)
    bf = best_single(0.30, J, pr, modes=("free",), tau=tau)
    # boost straddle at 0.5: both legs same L, safe against force close at 0.7/0.3
    Ls = int(min(max_lev(0.5, tau), np.floor(lev_time(0.70, tau) + 1e-9)))
    Ls = max(Ls, 1)
    h, t, m = straddle(0.5, [(+1, "boost", 1.0, float(Ls)), (-1, "boost", 1.0, float(Ls))], 0.5 + J)
    print(f"  tau = {tau_d:6.3f} d: Lmax(0.30) = {int(max_lev(0.30, tau)):2d}x, Lmax(0.50) = {int(max_lev(0.50, tau)):2d}x |"
          f" free underdog best L = {bf[3]:2d}x: house EV {bf[4]:+.3f} per $1 |"
          f" boost straddle L = {Ls:2d}x: house {h[0]/m:+.3f} per $1 (either direction)")
    OUT["F"][tau_d] = dict(free_L=bf[3], free_house=bf[4], boost_L=Ls, boost_house=float(h[0] / m))

# ---------------------------------------------------------------------------------------------
print("\n" + "=" * 110)
print("G. COST OF CARRY over a scheduled jump: crowding fee (skewFrac = 1) and Boost premium, per $1 margin,")
print("   for a hold of 60 s before the jump plus the time the slow price needs to reach the win line.")
print("=" * 110)
OUT["G"] = {}
for (p0, side, L, F, lab) in [(0.30, +1, 15.0, 0.20, "free YES @0.30 15x, +20"), (0.50, +1, 25.0, 0.20, "boost YES @0.50 25x, +20"), (0.50, +1, 16.0, 0.20, "boost YES @0.50 16x, +20")]:
    e = p0
    n = L / e
    B = n * (1 - 1 / L)
    dwin = (1 - e) / L
    tconv = -TAU_SLOW * np.log(1 - min(dwin / F, 0.999999)) if "free" in lab else TAU_SLOW * np.log(10)   # boost: wait for 90% convergence
    for tau_d in [30, 7, 1]:
        tau = max(tau_d * DAY, 3600)
        hold = 60 + tconv
        # rate (1-p_s)/tau before the jump for 60 s, then at the post-jump price
        fee = B * ((1 - e) * 60 + (1 - e - F) * tconv) / tau
        print(f"  {lab:28s} tau={tau_d:>2d} d: hold {hold:5.0f} s, borrowed {B:5.1f} sh/$ -> carry {fee:.4f} per $1 margin")
        OUT["G"][f"{lab}|{tau_d}"] = dict(hold=float(hold), carry=float(fee))

with open(__file__.replace(".py", ".json"), "w") as f:
    json.dump(OUT, f, indent=1, default=float)
print("\nsaved", __file__.replace(".py", ".json"))
