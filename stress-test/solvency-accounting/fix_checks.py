"""
(1) Exact enumeration on the tick grid: at the first tick where R4 lets a liquidation happen,
    how much equity is left and what does the liquidator get? All entry prices, all leverages
    E3 allows (tick rule only).
(2) Candidate fixes for the jump asymmetry of the free-mode corridor, checked with the exact
    chain solver: (A) cap the free-mode win at min(outright payoff, 1x margin) so the corridor is
    never wider on the win side than on the stop side; (B) a minimum stop distance in ticks.
"""
import math
from exact_chain import solve, REGIMES


def first_liq(p0t, L, step):
    s_t = p0t / L                       # stop distance in ticks
    k = math.ceil(0.8 * s_t / step - 1e-9) * step   # first grid point at/after the 80% line
    loss = k / s_t
    eq = max(0.0, 1.0 - loss)
    return k, eq, min(0.05, eq), max(0.0, loss - 1.0)


print("== (1) liquidation on the grid: share of (entry price, leverage) pairs, leverage 2..Lmax(p), entry 0.02..0.98 ==")
for step, name in ((1.0, "whole-tick mids (task text)"), (0.5, "half-tick mids (a bid/ask midpoint)")):
    tot = zero = partial = over = 0
    mx = mxz = 0
    worst = (0, None)
    for p0t in range(2, 99):
        Lmax = min(50, min(p0t, 100 - p0t) // 2)
        for L in range(2, Lmax + 1):
            k, eq, fee, ov = first_liq(p0t, L, step)
            tot += 1
            zero += eq <= 1e-12
            partial += 1e-12 < eq < 0.05 - 1e-12
            over += ov > 1e-12
            if ov > worst[0]:
                worst = (ov, (p0t, L, k))
            if L == Lmax:
                mx += 1
                mxz += eq <= 1e-12
    print(f"{name}: pairs={tot}; liquidator reward 0 (equity already 0) in {zero} ({100*zero/tot:.1f}%), "
          f"reward below 5% in {partial} ({100*partial/tot:.1f}%); first liquidatable tick is already past the stop line in "
          f"{over} ({100*over/tot:.1f}%), worst overshoot {100*worst[0]:.0f}% of margin at (p0,L,ticks)={worst[1]}; "
          f"at max leverage: zero reward in {mxz}/{mx}")

print("\n== (2A) cap the free-mode win at min(outright, 1x margin): trader EV before fees, max tick leverage ==")
print("p0   L  | normal: as written  with cap 1x | newsy: as written  with cap 1x")
for p0t in (4, 6, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90):
    L = min(50, min(p0t, 100 - p0t) // 2)
    row = []
    for reg in ("normal", "newsy"):
        sizes, probs = REGIMES[reg]
        a = solve(p0t, L, sizes, probs)["true"]
        b = solve(p0t, L, sizes, probs, cap=1.0)["true"]
        row += [a, b]
    print(f"{p0t/100:.2f} {L:3d} |   {row[0]:+.4f}        {row[1]:+.4f}    |   {row[2]:+.4f}       {row[3]:+.4f}")

print("\n== (2B) cheap side: trader EV net of the 10% share and liquidator fee, by leverage (stop distance in ticks) ==")
for p0t in (10, 20, 30):
    Lmax = min(50, p0t // 2)
    for reg in ("normal", "newsy"):
        sizes, probs = REGIMES[reg]
        cells = []
        for L in range(2, Lmax + 1):
            r = solve(p0t, L, sizes, probs)
            net = r["true"] - r["fee"] - r["liq_fee"]
            cells.append(f"L={L}(stop {p0t/L:.1f}t): {net:+.3f}")
        print(f"p0={p0t/100:.2f} {reg:6s}: " + "; ".join(cells))
