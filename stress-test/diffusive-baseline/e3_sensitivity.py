"""
E3b / E8 / E9 (exact lattice computations).

(1) How often must the reference mid move in WHOLE-cent steps for the stop-line pocket to pay?
(2) Jump sensitivity: share of mid changes that are +-J cents at which honest max-leverage bets
    turn positive, and the trader's EV per bet on a symmetric jump ("intent (a)" check).
(3) Next-tick information: hit rate needed for positive EV; value of a one-tick head start.
"""
import numpy as np
from lattice import lattice_value, regime, max_int_leverage

TAU = 30 * 86400.0


def best_over_grid(h, st, pr, policy="optimal", lo=0.02, hi=0.98, fix=None):
    best = (-9, None)
    for p0 in np.round(np.arange(lo, hi + 1e-9, 0.005), 3):
        lmax = max_int_leverage(p0, TAU)
        for L in range(2, lmax + 1):
            r = lattice_value(p0, L, h, st, pr, policy=policy, liq_buffer_ticks=fix)
            if r["ev"] > best[0]:
                best = (r["ev"], (float(p0), L, round(r["ds_ticks"], 3)))
    return best


print("(1) half-cent lattice, share q of mid changes are whole-cent steps: best EV over all (price, integer L)")
print(f"{'q':>6} {'best EV (optimal stop)':>24} {'at (p0, L, stop ticks)':>28} {'best EV (plain hold)':>22}")
for q in [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98, 1.0]:
    h, st, pr = regime("mix", q=q)
    b = best_over_grid(h, st, pr, lo=0.10, hi=0.60)
    bh = best_over_grid(h, st, pr, policy="hold", lo=0.10, hi=0.60)
    print(f"{q:6.2f} {b[0]:+24.4f} {str(b[1]):>28} {bh[0]:+22.4f}")

print()
print("(2a) intent (a) check: ONE symmetric jump of +-J cents hits a fresh max-leverage position (no other moves).")
print("     Unleveraged bookmaker: EV 0 to the bettor.  Free mode, per $1 margin, after the 10% share:")
print(f"{'p0':>5} {'L':>3} {'J':>3} {'win if up':>10} {'loss if down':>13} {'EV per jump':>12} {'1x outright EV':>15}")
for p0, J in [(0.2, 4), (0.2, 8), (0.2, 15), (0.35, 5), (0.5, 5), (0.5, 20), (0.65, 5), (0.8, 8)]:
    L = max_int_leverage(p0, TAU)
    n, C = L / p0, (1 - p0) / p0
    up = min(n * J * 0.01, C) * 0.9
    dn = max(-n * J * 0.01, -1.0)
    ev1x = 0.5 * (J * 0.01 / p0) * 0.9 - 0.5 * (J * 0.01 / p0)
    print(f"{p0:5.2f} {L:3d} {J:3d} {up:+10.3f} {dn:+13.3f} {0.5 * up + 0.5 * dn:+12.3f} {ev1x:+15.3f}")

print()
print("(2b) mostly-diffusive market: whole-cent walk, a share mu of mid changes are +-J cent jumps.")
print("     EV per $1 margin of the plain max-leverage hold bet; mu* = share at which it turns positive.")
print(f"{'p0':>5} {'L':>3} {'J':>3} | " + " ".join(f"mu={m:<6}" for m in [0, 0.005, 0.01, 0.02, 0.05, 0.1]) + " | mu* (hold)  mu* (optimal stop)")
for p0 in [0.2, 0.3, 0.5]:
    L = max_int_leverage(p0, TAU)
    for J in [3, 5, 10]:
        evs = []
        for mu in [0, 0.005, 0.01, 0.02, 0.05, 0.1]:
            h, st, pr = regime("jump", mu=max(mu, 1e-12), J=J)
            evs.append(lattice_value(p0, L, h, st, pr, policy="hold")["ev"])

        def root(policy):
            lo_, hi_ = 1e-9, 0.6
            f = lambda mu: lattice_value(p0, L, *regime("jump", mu=mu, J=J), policy=policy)["ev"]
            if f(hi_) <= 0:
                return float("nan")
            if f(lo_) > 0:
                return 0.0
            for _ in range(50):
                mid = 0.5 * (lo_ + hi_)
                if f(mid) > 0:
                    hi_ = mid
                else:
                    lo_ = mid
            return hi_
        print(f"{p0:5.2f} {L:3d} {J:3d} | " + " ".join(f"{e:+9.4f}" for e in evs) + f" | {root('hold'):10.4f} {root('optimal'):10.4f}")

print()
print("(2c) same with the minimum stop distance raised to 5 ticks (L <= min(p,1-p)/0.05)")
for p0 in [0.2, 0.3, 0.5]:
    L = int(np.floor(min(p0, 1 - p0) / 0.05 + 1e-9))
    for J in [3, 5, 10]:
        def f(mu, policy="hold"):
            return lattice_value(p0, L, *regime("jump", mu=mu, J=J), policy=policy)["ev"]
        lo_, hi_ = 1e-9, 0.9
        if f(hi_) <= 0:
            r = float("nan")
        else:
            for _ in range(50):
                mid = 0.5 * (lo_ + hi_)
                if f(mid) > 0:
                    hi_ = mid
                else:
                    lo_ = mid
            r = hi_
        print(f"   p0={p0} L={L} J={J}: EV(mu=0.02) {f(0.02):+.4f}, mu* {r:.4f}")

print()
print("(3) next-tick information on the whole-cent walk.  V(k) = value of a position k ticks in profit")
print("    (optimal stopping, close-at-mid bound).  pi* = P(next change is favourable) needed for EV > 0.")
print(f"{'p0':>5} {'L':>3} {'stop':>5} {'win':>5} | {'V(+1)':>8} {'V(-1)':>8} {'pi*':>7} | {'hold: V(+1)':>11} {'V(-1)':>8} {'pi*':>7}")
h, st, pr = regime("full")
for p0, L in [(0.5, 25), (0.5, 10), (0.5, 5), (0.665, 16), (0.665, 8), (0.35, 17), (0.2, 10), (0.8, 10)]:
    ro = lattice_value(p0, L, h, st, pr, policy="optimal", return_all=True)
    rh = lattice_value(p0, L, h, st, pr, policy="hold", return_all=True)
    vo1, vom1 = ro["V"][1], ro["V"][-1]
    vh1, vhm1 = rh["V"][1], rh["V"][-1]
    pio = -vom1 / (vo1 - vom1)
    pih = -vhm1 / (vh1 - vhm1)
    print(f"{p0:5.3f} {L:3d} {rh['ds_ticks']:5.2f} {rh['dw_ticks']:5.2f} | {vo1:+8.4f} {vom1:+8.4f} {pio:7.4f} | {vh1:+11.4f} {vhm1:+8.4f} {pih:7.4f}")
