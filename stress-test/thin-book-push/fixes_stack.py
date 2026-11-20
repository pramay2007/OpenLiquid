"""Share-based capacity, minimum hold time, and the full stacked fix, across all scenarios."""
import numpy as np
from book import Book, attack_static, n_levels_in_band
from venue import GEMINI_TAKER, l_max, win_line, cap_free, catchup_exact

D5 = 1000.0


def ubook(mid2tick, s=1, d5=D5):
    B0 = (mid2tick - s) // 2
    return Book.uniform(B0, s, d5 / n_levels_in_band(s))


SCEN = {
    "base": dict(mid2=99, taker=GEMINI_TAKER, spoof=0.0, direction=+1),
    "nofee": dict(mid2=99, taker=0.0, spoof=0.0, direction=+1),
    "spoof100x": dict(mid2=99, taker=GEMINI_TAKER, spoof=99 * D5, direction=+1),
    "extreme-NO": dict(mid2=179, taker=GEMINI_TAKER, spoof=0.0, direction=-1),
    "extreme-nf": dict(mid2=179, taker=0.0, spoof=0.0, direction=-1),
    "extreme-spoof": dict(mid2=179, taker=GEMINI_TAKER, spoof=99 * D5, direction=-1),
}
for v in SCEN.values():
    v["book"] = ubook(v["mid2"])
    q0 = v["book"].mid if v["direction"] > 0 else 1 - v["book"].mid
    v["L"] = int(min(50, l_max(q0, 30 * 86400)))


def net_share_cap(sc, kappa_sh, taker=None, abs_shares=None, tau_exit=300.0, Ts=(150, 300, 600, 900, 1800)):
    """Worst-case net with capacity on CONTRACTS: n_side <= kappa_sh * contracts within 5 ticks (+ optional absolute share cap)."""
    book, direction, L = sc["book"], sc["direction"], sc["L"]
    taker = sc["taker"] if taker is None else taker
    best = -1e18
    ctr_band = book.contracts5()
    for m in range(0, 9):
        for T in Ts:
            # contracts allowed; convert to the notional the attack function expects via own-price q0
            q0 = book.mid if direction > 0 else 1 - book.mid
            n_allow = kappa_sh * ctr_band
            if abs_shares is not None:
                n_allow = min(n_allow, abs_shares)
            N = n_allow * q0
            r = attack_static(book, m, T, kappa=1e9, taker=taker, spoof_usd=0.0, two_leg=True, T2=900,
                              direction=direction, tau=tau_exit, L=L, abs_cap=N)
            if r["delta"] <= 0:
                continue
            best = max(best, r["net"])
    return best


def net_minhold(sc, kappa, H_min, refill_rate):
    """kappa on 5-tick USD depth, but the position cannot close for H_min seconds; the attacker must hold the
       push that whole time against refills (cost multiplier 1 + refill_rate*H_min). Two legs."""
    book, direction, L, taker, spoof = sc["book"], sc["direction"], sc["L"], sc["taker"], sc["spoof"]
    best = -1e18
    for m in range(0, 9):
        # hold time is forced to at least H_min; extra holding only helps the slow price so use exactly H_min..+
        for T in (H_min, H_min + 300, H_min + 900):
            r = attack_static(book, m, T, kappa=kappa, taker=taker, spoof_usd=spoof, two_leg=True, T2=900,
                              direction=direction, tau=300.0, L=L, refill_rate=refill_rate)
            if r["delta"] <= 0:
                continue
            best = max(best, r["net"])
    return best


def line(label, fn):
    cells = [f"{n:>12}:{fn(sc):+9.2f}" for n, sc in SCEN.items()]
    print(f"  {label:40s} " + "  ".join(cells))


print("Columns:", ", ".join(SCEN))
print("Worst-case attacker net per $1,000 natural depth. Negative = safe.\n")

print("S1  SHARE-based capacity: n_side <= kappa_sh * contracts within 5 ticks (removes the 1/q0 blow-up).")
for ks in (0.5, 0.25, 0.1, 0.05):
    line(f"kappa_sh = {ks}", lambda sc, ks=ks: net_share_cap(sc, ks))

print("\nS2  share capacity + exit tau 1800:")
for ks in (0.25, 0.1, 0.05):
    line(f"kappa_sh = {ks}, tau_exit 1800", lambda sc, ks=ks: net_share_cap(sc, ks, tau_exit=1800, Ts=(300, 600, 1200, 1800, 3600, 7200)))

print("\nS3  share capacity + absolute share cap (independent of reported depth; = spoof defence):")
for absn in (1000, 500, 250):
    line(f"kappa_sh 0.25, abs_shares = {absn}", lambda sc, absn=absn: net_share_cap(sc, 0.25, abs_shares=absn))

print("\nS4  FULL STACK: kappa_sh 0.1  +  exit tau 1800  +  absolute share cap 500  (fee per scenario, incl. nofee):")
line("full stack", lambda sc: net_share_cap(sc, 0.1, abs_shares=500, tau_exit=1800, Ts=(300, 600, 1200, 1800, 3600, 7200)))

print("\nF5  Minimum hold time (kappa 0.5 USD-depth otherwise) with the book refilling. 1/refill = mean seconds to replace a level.")
for H in (300, 900):
    for mean_refill in (1e9, 600, 120, 30):
        rr = 0.0 if mean_refill > 1e8 else 1.0 / mean_refill
        tag = "stale book" if rr == 0 else f"refill ~{mean_refill:.0f}s"
        line(f"H_min {H}s, {tag}", lambda sc, H=H, rr=rr: net_minhold(sc, 0.5, H, rr))

print("\nF5b Minimum hold time WITH share-cap kappa_sh 0.1 + abs 500, refill ~120 s:")
def net_minhold_share(sc, H, rr):
    book, direction, L, taker = sc["book"], sc["direction"], sc["L"], sc["taker"]
    ctr_band = book.contracts5(); best = -1e18
    for m in range(0, 9):
        for T in (H, H + 600):
            q0 = book.mid if direction > 0 else 1 - book.mid
            N = min(0.1 * ctr_band, 500) * q0
            r = attack_static(book, m, T, kappa=1e9, taker=taker, spoof_usd=0.0, two_leg=True, T2=900,
                              direction=direction, tau=1800.0, L=L, abs_cap=N, refill_rate=rr)
            if r["delta"] <= 0: continue
            best = max(best, r["net"])
    return best
line("H_min 300s, refill ~120s", lambda sc: net_minhold_share(sc, 300, 1/120))
