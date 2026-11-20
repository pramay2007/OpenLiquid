"""Is a 1x position held through the match safe for the house?

Section: sports in play, 1x only (the only thing the current rules allow after kick-off).
Question: (i) house EV of a frozen 1x bet; (ii) effect of R4 liquidation on a 1x bet;
(iii) effect of R2 'closes are always allowed' + R6 (any signed price newer than the one
on-chain, valid 20 s): on a goal against him the holder closes at the pre-goal price with
probability phi (the chance his close lands before the keeper's relay of the new mid).
Output: EV per $1 of margin with standard errors, 300,000 matches per model; every
configuration is evaluated on the same simulated matches.
"""
import numpy as np
from ol import soccer, nfl, mean_se
from inplay import sim_multi, cfg

N = 300_000
PHIS = (0.25, 0.5, 0.75, 1.0)


def line(label, x):
    m, s = mean_se(x)
    return f"{label} {m:+.4f} (se {s:.4f})"


def run(match, name, seed):
    p0 = match.mid0
    print("=" * 118, flush=True)
    print(f"{name}: kick-off YES price {p0:.2f} (fair {match.fair0:.4f}), dt={match.dt:.0f}s, {N} matches")
    configs = []
    for side_yes in (True, False):
        configs.append(cfg(side_yes, 1, liq_1x=False, label="frozen"))
        configs.append(cfg(side_yes, 1, liq_1x=True, label="liq"))
        for phi in PHIS:
            configs.append(cfg(side_yes, 1, liq_1x=False, phi=phi, label=f"phi{phi}"))
    res = sim_multi(match, configs, N, seed)
    by = {(r["cfg"]["side_yes"], r["label"]): r for r in res}
    for side_yes, lab in ((True, "YES 1x"), (False, "NO  1x")):
        s0 = p0 if side_yes else 1 - p0
        r = by[(side_yes, "frozen")]
        print(f"  {lab} frozen to the whistle        {line('trader', r['pnl'])}   {line('house', r['house'])}"
              f"   theory house = 0.10*(1-s0) = {0.1 * (1 - s0):+.4f}")
        r = by[(side_yes, "liq")]
        print(f"  {lab} with R4 liquidation at 20%   {line('trader', r['pnl'])}   {line('house', r['house'])}"
              f"   liquidated {np.mean(r['kind'] == 2):.3f} of bets")
    print("  R6 last look on closes (phi = share of adverse scores dodged at the pre-score price):")
    for phi in PHIS:
        for side_yes, lab in ((True, "YES"), (False, "NO ")):
            r = by[(side_yes, f"phi{phi}")]
            print(f"    phi={phi:.2f}  {lab} 1x   {line('trader', r['pnl'])}   {line('house', r['house'])}"
                  f"   exits by last look {np.mean(r['kind'] == 1):.3f}, losing bets {np.mean(r['pnl'] < -1e-9):.3f}")
        box = p0 * by[(True, f"phi{phi}")]["pnl"] + (1 - p0) * by[(False, f"phi{phi}")]["pnl"]
        boxh = p0 * by[(True, f"phi{phi}")]["house"] + (1 - p0) * by[(False, f"phi{phi}")]["house"]
        print(f"    phi={phi:.2f}  BOX (YES+NO, equal shares, $1 total)  {line('trader', box)}   {line('house', boxh)}"
              f"   matches with a loss {np.mean(box < -1e-9):.3f}", flush=True)


if __name__ == "__main__":
    m, la = soccer(0.45, 1.20, dt=15.0)
    run(m, f"SOCCER, YES = 'A wins in 90 min' (lambda_A={la:.2f}, lambda_B=1.20)", 31)
    m2, la2 = soccer(0.70, 0.90, dt=15.0)
    run(m2, f"SOCCER strong favourite (lambda_A={la2:.2f}, lambda_B=0.90)", 32)
    n, k = nfl(0.65, dt=30.0)
    run(n, f"NFL-like two-way moneyline (favourite scale k={k:.3f})", 33)
