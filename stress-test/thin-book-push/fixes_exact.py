"""
Exact evaluation of candidate fixes on the static book, rules otherwise as written.
Goal: the smallest change that drives attacker net <= 0 for every variant, including the
fee-free attacker and the spoofer and the extreme-price favourite.

Variants scored (worst case over m in 0..8, hold up to 30 min, two legs where that helps):
  base        kappa 0.5, ref depth = USD within 5 ticks, exit tau 300, Gemini taker fee on
  nofee       same, taker fee 0 (maker-rebate / fee holiday)
  spoof10x    attacker has rested 10x the natural depth for >tau so it counts
  extreme     uniform book at mid 0.895, NO side (the worst kappa* in table E)

Candidate fixes, applied one at a time and then stacked:
  F1 lower kappa
  F2 exit averaging: the close fills at the worse of (mid, slow_exit) with a LONG exit tau
  F3 corridor capacity: side notional <= kappa_c * USD resting between the mid and the win line
                        on the side a winning move must cross (spoofing outside the corridor adds nothing)
  F4 absolute per-side OI cap (independent of reported depth)  -> directly caps the spoof
  F5 minimum hold time H_min before close/collect pays, with the book refilling after the push
"""
import numpy as np
from book import Book, attack_static, n_levels_in_band
from venue import catchup_exact, cap_free, win_line, GEMINI_TAKER, l_max

D5 = 1000.0


def ubook(mid2tick, s=1, d5=D5):
    B0 = (mid2tick - s) // 2
    rho = d5 / n_levels_in_band(s)
    return Book.uniform(B0, s, rho)


def corridor_depth(book, L, direction=+1, kappa_c=0.5):
    """USD resting strictly between the current mid and the position's win line, on the crossing side."""
    q0 = book.mid if direction > 0 else 1 - book.mid
    wl = win_line(q0, L)                       # own-side win price
    if direction > 0:
        lo, hi = book.mid, wl                  # YES mid must rise to wl
        px, usd = book.ask_px(), book.usd_ask
    else:
        lo, hi = 1 - wl, book.mid              # YES mid must fall to (1-wl)
        px, usd = book.bid_px(), book.usd_bid
    inside = (px > lo + 1e-12) & (px < hi - 1e-12)
    return usd[inside].sum()


def best_net(book, kappa=0.5, taker=GEMINI_TAKER, spoof=0.0, two_leg=True, direction=+1,
             tau_exit=300.0, L=1, capacity="usd", kappa_c=None, abs_cap=None, Ts=(150, 300, 600, 900, 1800)):
    best = -1e18
    for m in range(0, 9):
        for T in Ts:
            if capacity == "corridor":
                cd = corridor_depth(book, L, direction, kappa_c)
                N = (kappa if kappa_c is None else kappa_c) * cd
                r = attack_static(book, m, T, kappa=1e9, taker=taker, spoof_usd=0.0, two_leg=two_leg, T2=900,
                                  direction=direction, tau=tau_exit, L=L, abs_cap=N)
            else:
                r = attack_static(book, m, T, kappa=kappa, taker=taker, spoof_usd=spoof, two_leg=two_leg, T2=900,
                                  direction=direction, tau=tau_exit, L=L, abs_cap=abs_cap)
            if r["delta"] <= 0:
                continue
            best = max(best, r["net"])
    return best


SCEN = {
    "base      ": dict(book=ubook(99), taker=GEMINI_TAKER, spoof=0.0, direction=+1, L=1),
    "nofee     ": dict(book=ubook(99), taker=0.0, spoof=0.0, direction=+1, L=1),
    "spoof10x  ": dict(book=ubook(99), taker=GEMINI_TAKER, spoof=9 * D5, direction=+1, L=1),
    "spoof100x ": dict(book=ubook(99), taker=GEMINI_TAKER, spoof=99 * D5, direction=+1, L=1),
    "extreme-NO": dict(book=ubook(179), taker=GEMINI_TAKER, spoof=0.0, direction=-1, L=1),
    "extreme-nf": dict(book=ubook(179), taker=0.0, spoof=0.0, direction=-1, L=1),
}
# per-scenario leverage ceilings from E3 (far-dated, 30 d): tick limit = floor(min(p,1-p)/0.02)
for k, v in SCEN.items():
    v["L"] = int(min(50, l_max(v["book"].mid if v["direction"] > 0 else 1 - v["book"].mid, 30 * 86400)))


def line(label, fn):
    cells = []
    for name, sc in SCEN.items():
        net = fn(sc)
        cells.append(f"{name.strip():>10}:{net:+8.2f}")
    print(f"  {label:46s} " + "  ".join(cells))


print("Worst-case attacker net per $1,000 natural depth (two legs allowed), by scenario and fix.")
print("Negative = the house is safe.  Scenarios differ in fee, spoofed depth, price/side.\n")
print("  " + " " * 46 + "  ".join(f"{n.strip():>10}        " for n in SCEN)[:0] + "columns: " + ", ".join(s.strip() for s in SCEN))
print()

line("as written (kappa 0.5, ref=5-tick depth, tau 300)",
     lambda sc: best_net(sc["book"], kappa=0.5, taker=sc["taker"], spoof=sc["spoof"], direction=sc["direction"], L=sc["L"]))

print("\nF1  lower kappa (ref depth = 5 ticks, tau 300, fee as per scenario):")
for kap in (0.25, 0.1, 0.05, 0.02, 0.01):
    line(f"kappa = {kap}", lambda sc, kap=kap: best_net(sc["book"], kappa=kap, taker=sc["taker"], spoof=sc["spoof"], direction=sc["direction"], L=sc["L"]))

print("\nF2  exit averaging only (kappa 0.5), exit tau:")
for te in (300, 600, 1200, 1800, 3600):
    line(f"tau_exit = {te}s", lambda sc, te=te: best_net(sc["book"], kappa=0.5, taker=sc["taker"], spoof=sc["spoof"], direction=sc["direction"], L=sc["L"], tau_exit=te, Ts=(300, 600, 1200, 1800, 3600, 7200)))

print("\nF3  corridor capacity: N_side <= kappa_c * USD between mid and the win line (fee as per scenario, tau 300).")
print("    Evaluated at a few leverages because the corridor width = (1-q0)/L depends on L.")
for L in (5, 10, 24):
    for kc in (0.5, 0.25, 0.1):
        def fn(sc, L=L, kc=kc):
            Lh = min(L, sc["L"])
            return best_net(sc["book"], taker=sc["taker"], spoof=sc["spoof"], direction=sc["direction"], L=Lh, capacity="corridor", kappa_c=kc)
        line(f"L<= {L:>2}, kappa_c = {kc}", fn)

print("\nF4  absolute per-side OI cap C_abs (independent of reported depth), kappa 0.5 otherwise, fee per scenario:")
for cabs in (500, 250, 100, 50):
    line(f"C_abs = ${cabs} per $1k natural depth", lambda sc, cabs=cabs: best_net(sc["book"], kappa=0.5, taker=sc["taker"], spoof=sc["spoof"], direction=sc["direction"], L=sc["L"], abs_cap=cabs))

print("\nSTACK  kappa 0.1  +  exit tau 1800  +  absolute side cap = 0.1*5-tick depth (= $100 / $1k):")
line("stacked fix", lambda sc: best_net(sc["book"], kappa=0.1, taker=sc["taker"], spoof=min(sc["spoof"], 0.0), direction=sc["direction"], L=sc["L"], tau_exit=1800, abs_cap=0.1 * D5, Ts=(300, 600, 1200, 1800, 3600, 7200)))
print("  (spoof neutralised by the absolute cap; shown with spoof forced to 0 since the cap makes reported depth irrelevant)")
line("stacked fix, spoofer still tries", lambda sc: best_net(sc["book"], kappa=0.1, taker=sc["taker"], spoof=sc["spoof"], direction=sc["direction"], L=sc["L"], tau_exit=1800, abs_cap=0.1 * D5, Ts=(300, 600, 1200, 1800, 3600, 7200)))
