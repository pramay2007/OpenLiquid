"""
Exact (no simulation) expected outcome of ONE free-mode event position per $1 of margin,
by solving the absorbing Markov chain of the mid on the 1-cent grid.

Same model as nav_leak_mc.py (rules as written, martingale tick process, keeper acts at the
first mid past a line). Used to (1) cross-check the Monte Carlo and (2) scan every entry
price for the jump asymmetry of the free-mode corridor:

    E[trader, before fees] = E[D-] - E[D+]
      D- = loss the stop gap spares the trader  (linear loss beyond the margin)
      D+ = win the cap takes from the trader    (linear win beyond the outright payoff)

For a continuous path both are zero and the bet is fair. With jumps they are not equal
unless the corridor is symmetric (entry at 50c) or the jump goes all the way to 0/1.
"""
import sys
import numpy as np

REGIMES = {
    "calm": ([1], [1.0]),
    "normal": ([1, 2, 3, 5, 10], [0.85, 0.10, 0.03, 0.015, 0.005]),
    "newsy": ([1, 2, 3, 5, 10, 25], [0.70, 0.15, 0.07, 0.04, 0.03, 0.01]),
}


def solve(p0_tick, L, sizes, probs, hazard=0.0, profit_fee=0.10, maint=0.20, liq_fee=0.05, cap=None):
    p0 = p0_tick / 100.0
    n = L / p0
    C = (1 - p0) / p0
    if cap is not None:
        C = min(C, cap)  # candidate fix: cap the free-mode win at `cap` x margin as well

    def lin(t):
        return n * (t - p0_tick) / 100.0

    def is_exit(t):
        x = lin(t)
        return x >= C - 1e-12 or 1.0 + x <= maint + 1e-12

    trans = [t for t in range(1, 100) if not is_exit(t)]
    index = {t: i for i, t in enumerate(trans)}
    m = len(trans)
    Q = np.zeros((m, m))
    # payoff vectors accumulated on exit
    keys = ["win", "true", "d_plus", "d_minus", "fee", "liq_fee", "zero_liq", "liq", "res_exit"]
    R = {k: np.zeros(m) for k in keys}

    def exit_payoffs(t, prob, i, resolved):
        x = lin(t)
        win = x >= C - 1e-12
        true = min(max(x, -1.0), C)
        R["true"][i] += prob * true
        if resolved:
            R["res_exit"][i] += prob
        if win:
            R["win"][i] += prob
            R["d_plus"][i] += prob * (x - C)
            R["fee"][i] += prob * profit_fee * C
        else:
            eq = max(0.0, 1.0 + x)
            R["liq"][i] += prob
            R["d_minus"][i] += prob * max(0.0, -1.0 - x)
            R["liq_fee"][i] += prob * min(liq_fee, eq)
            if eq <= 1e-12:
                R["zero_liq"][i] += prob

    for t in trans:
        i = index[t]
        if hazard > 0:
            exit_payoffs(100, hazard * t / 100.0, i, True)
            exit_payoffs(0, hazard * (1 - t / 100.0), i, True)
        for k, pk in zip(sizes, probs):
            u = min(k, 100 - t)
            d = min(k, t)
            pu = d / (u + d)
            for newt, pr in ((t + u, pu), (t - d, 1 - pu)):
                pr *= pk * (1 - hazard)
                if newt in index:
                    Q[i, index[newt]] += pr
                else:
                    exit_payoffs(newt, pr, i, newt in (0, 100))
    A = np.eye(m) - Q
    out = {k: np.linalg.solve(A, R[k])[index[p0_tick]] for k in keys}
    out["C"] = C
    out["steps"] = np.linalg.solve(A, np.ones(m))[index[p0_tick]]
    return out


if __name__ == "__main__":
    print("EXACT values per $1 margin (absorbing-chain solve). trader = before profit share and liquidator fee;")
    print("net = trader - 10% profit share - liquidator fee; LP = -trader + 70% of profit share.")
    for hz in (0.0, 0.002):
        for name, (sizes, probs) in REGIMES.items():
            print(f"\n== {name}, early-resolution hazard {hz} ==")
            print("p0    L  | P(win)  trader    D+      D-      fee(10%)  trader net   LP(no JIT)  LP(JIT 50%)  LP(JIT 90%) | liq $0 reward | mean price changes")
            for p0t, L in [(10, 5), (20, 10), (30, 10), (30, 15), (40, 20), (50, 5), (50, 10), (50, 20), (50, 24),
                           (50, 25), (60, 20), (70, 15), (80, 5), (80, 10), (90, 5)]:
                r = solve(p0t, L, sizes, probs, hz)
                net = r["true"] - r["fee"] - r["liq_fee"]
                lp = -r["true"] + 0.7 * r["fee"]
                jump = r["d_plus"] + 0.7 * r["fee"]
                zl = r["zero_liq"] / r["liq"] if r["liq"] > 0 else 0
                print(f"{p0t/100:.2f} {L:3d} | {r['win']:.3f}  {r['true']:+.4f}  {r['d_plus']:.4f}  {r['d_minus']:.4f}  "
                      f"{r['fee']:.4f}   {net:+.4f}     {lp:+.4f}     {lp-0.5*jump:+.4f}      {lp-0.9*jump:+.4f}   |   {100*zl:3.0f}%   | {r['steps']:.1f}")

    # every entry price at the maximum leverage the tick rule allows, and at half of it
    print("\n== scan of entry prices at max tick leverage (L = floor(min(p,1-p)/0.02), <= 50), regime 'normal', no hazard ==")
    print("p0   Lmax | trader pre-fee | trader net of 10% share and liq fee | LP EV (no JIT)")
    sizes, probs = REGIMES["normal"]
    for p0t in (4, 6, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 92, 94, 96):
        L = max(1, min(50, int(round(min(p0t, 100 - p0t) / 2 - 1e-9))))
        L = min(50, min(p0t, 100 - p0t) // 2)
        if L < 2:
            continue
        r = solve(p0t, L, sizes, probs, 0.0)
        net = r["true"] - r["fee"] - r["liq_fee"]
        print(f"{p0t/100:.2f} {L:4d} | {r['true']:+.4f}        | {net:+.4f}                              | {-r['true'] + 0.7*r['fee']:+.4f}")
    print("\n== same scan, regime 'newsy' ==")
    sizes, probs = REGIMES["newsy"]
    for p0t in (4, 6, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 92, 94, 96):
        L = min(50, min(p0t, 100 - p0t) // 2)
        if L < 2:
            continue
        r = solve(p0t, L, sizes, probs, 0.0)
        net = r["true"] - r["fee"] - r["liq_fee"]
        print(f"{p0t/100:.2f} {L:4d} | {r['true']:+.4f}        | {net:+.4f}                              | {-r['true'] + 0.7*r['fee']:+.4f}")
