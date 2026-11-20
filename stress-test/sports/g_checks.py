"""Small confirmations.

 G1 (exact)  A leveraged YES plus a leveraged NO with the same number of shares and the same
             leverage is flat through a jump of ANY size, before fees (E2 is self-consistent:
             the 'collect on one side, lose only margin on the other' attack is closed).
 G2 (exact)  Value of leaving a losing leveraged position open into a frozen match instead of
             closing it at its mark (why a kick-off snapshot is needed if the match is frozen).
 G3 (MC)     Last look with leverage: a 2x position that survives into play, liquidations on
             time, holder dodges adverse scores at the pre-score price (phi = 1), skew 0.
 G4 (exact)  House edge on a frozen 1x bet when the reference mid is off by eps.
"""
import os
import numpy as np
from ol import Pos, soccer, mean_se
from inplay import sim_multi, cfg

N = int(os.environ.get("N", 200_000))

print("G1. Leveraged box (equal shares, equal leverage): worst |P&L| over jumps, before fees")
worst = 0.0
for p in np.arange(0.05, 0.96, 0.05):
    for L in (2, 3, 5, 10, 20, 50):
        if L > min(p, 1 - p) / 0.02 + 1e-9:
            continue
        y, n_ = Pos(p, float(L)), Pos(1 - p, float(L))
        my, mn = p, 1 - p                      # margins for one share-pair per unit leverage
        for target in np.arange(0.0, 1.0001, 0.01):
            py = np.clip(y.n * (target - p), -1.0, y.C) * my
            pn = np.clip(n_.n * ((1 - target) - (1 - p)), -1.0, n_.C) * mn
            worst = max(worst, abs(py + pn))
print(f"    max |YES leg + NO leg| over all p, L and jump targets = {worst:.2e}  (winner then pays the 10% share, so the box loses)")

print()
print("G2. A losing leveraged position left open into a FROZEN match is worth its outright value, not its mark:")
print("    p0    L   kick-off price   mark (if closed)   value if frozen to the whistle   gain from not closing")
for p0, L, pk in ((0.40, 5, 0.37), (0.40, 5, 0.34), (0.50, 5, 0.45), (0.30, 3, 0.25), (0.40, 5, 0.43)):
    pos = Pos(p0, float(L))
    mark = float(np.clip(pos.n * (pk - p0), -1.0, pos.C))
    frozen = pk * pos.C * 0.9 - (1 - pk) * 1.0
    print(f"    {p0:.2f}  {L}   {pk:.2f}             {mark:+.3f}             {frozen:+.3f}                           {frozen - mark:+.3f}")

print()
print("G4. Frozen 1x bet, reference mid off by eps (true probability = p0 + eps): house EV per $1 staked")
print("    house = 0.10 (1 - p0) - eps (1 + 0.9 (1 - p0) / p0);  break-even eps:")
for p0 in (0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9):
    be = 0.1 * (1 - p0) / (1 + 0.9 * (1 - p0) / p0)
    print(f"    p0={p0:.2f}: house edge at eps=0 {0.1 * (1 - p0):+.3f};  loses once the buyer's edge exceeds {100 * be:.1f} pts")

print()
m, la = soccer(0.45, 1.20, dt=15.0)
print(f"G3. Soccer (YES {m.mid0:.2f}), {N} matches: survivors with last look, liquidations on time, no force-close, skew 0")
configs = []
for side_yes in (True, False):
    for L in (1, 2):
        for phi in (0.0, 1.0):
            configs.append(cfg(side_yes, L, phi=phi, keeper_at=None, liq_before="keeper", liq_1x=False,
                               label=f"{'YES' if side_yes else 'NO '} L={L} phi={phi:.0f}"))
for r in sim_multi(m, configs, N, 91):
    mm, s = mean_se(r["pnl"]); hm_, hs = mean_se(r["house"])
    print(f"    {r['label']:<16s} trader {mm:+.4f} (se {s:.4f})   house {hm_:+.4f} (se {hs:.4f})")
