"""What if the keeper is late force-closing and leveraged positions survive into play?

Section: sports, kick-off hand-over.  Question: trader / house EV of a free-mode position
opened pre-game at leverage L that is still open when the match starts.
Cases (all with the trader collecting at the win line himself, never closing otherwise):
  K5 / K15 / K45 : upkeep is down for 5 / 15 / 45 minutes of play, then liquidates or
                   force-closes at the normal close price
  LIQ-ONLY       : liquidations run on time all match but force-close never happens
  THIRD          : upkeep dead all match, outside liquidators act only when paid
                   (reward = min(5% M, equity) > 0)
  NONE           : upkeep dead all match, nobody liquidates
Crowding fee: skew 0 (the other side holds at least as many borrowed shares) or skew 1
(nobody on the other side).  'in-play only' starts the fee at kick-off; 'with pre-game'
adds what accrued between the last moment the leverage was allowed and kick-off.
200,000 matches per model, every configuration on the same matches.
"""
import numpy as np
from ol import soccer, nfl, mean_se, Pos
from inplay import sim_multi, cfg

import os
N = int(os.environ.get("N", 200_000))


def line(x):
    m, s = mean_se(x)
    return f"{m:+.4f} (se {s:.4f})"


def run(match, name, seed, levs=(2, 5)):
    p0 = match.mid0
    print("=" * 124, flush=True)
    print(f"{name}: kick-off YES price {p0:.2f}, dt={match.dt:.0f}s, {N} matches")
    configs = []
    for side_yes in (True, False):
        s0 = p0 if side_yes else 1 - p0
        for L in levs:
            pos = Pos(s0, float(L))
            tau_star = 1080.0 * L * L * max(p0, 1 - p0) / min(p0, 1 - p0)   # last moment L was allowed
            pre = pos.borrowed * (1 - s0) * (np.log(max(tau_star, 3600.0) / 3600.0) + min(tau_star, 3600.0) / 3600.0)
            tag = ("YES" if side_yes else "NO ") + f" L={L}"
            configs += [
                cfg(side_yes, L, keeper_at=300, liq_before="none", label=f"{tag} | K5       | skew 0"),
                cfg(side_yes, L, keeper_at=900, liq_before="none", label=f"{tag} | K15      | skew 0"),
                cfg(side_yes, L, keeper_at=2700, liq_before="none", label=f"{tag} | K45      | skew 0"),
                cfg(side_yes, L, keeper_at=None, liq_before="keeper", label=f"{tag} | LIQ-ONLY | skew 0"),
                cfg(side_yes, L, keeper_at=None, liq_before="third", label=f"{tag} | THIRD    | skew 0"),
                cfg(side_yes, L, keeper_at=None, liq_before="none", label=f"{tag} | NONE     | skew 0"),
                cfg(side_yes, L, skew=1.0, keeper_at=None, liq_before="keeper",
                    label=f"{tag} | LIQ-ONLY | skew 1 in-play only"),
                cfg(side_yes, L, skew=1.0, keeper_at=None, liq_before="none",
                    label=f"{tag} | NONE     | skew 1 in-play only"),
                cfg(side_yes, L, skew=1.0, pre_fee=pre, keeper_at=None, liq_before="keeper",
                    label=f"{tag} | LIQ-ONLY | skew 1 with pre-game ({pre / pos.C:.2f} C accrued)"),
            ]
    res = sim_multi(match, configs, N, seed)
    by = {r["label"]: r for r in res}
    for r in res:
        k = r["kind"]
        print(f"  {r['label']:<58s} trader {line(r['pnl'])}  house {line(r['house'])}  "
              f"win {np.mean(r['pnl'] > 1e-9):.3f} | collect {np.mean(k == 3):.3f} liq {np.mean(k == 2):.3f} "
              f"fclose {np.mean(k == 4):.3f} settle {np.mean(k == 5):.3f}")
    print("  Two-sided book with equal borrowed shares on YES and NO (skew 0 for both), house P&L per $1 of total margin:")
    for L in levs:
        for case in ("K15     ", "LIQ-ONLY", "THIRD   ", "NONE    "):
            a = by[f"YES L={L} | {case} | skew 0"]["house"]
            b = by[f"NO  L={L} | {case} | skew 0"]["house"]
            print(f"    L={L} {case}: house {line(p0 * a + (1 - p0) * b)}")
    print(flush=True)


if __name__ == "__main__":
    m, la = soccer(0.45, 1.20, dt=15.0)
    run(m, f"SOCCER, YES = 'A wins in 90 min' (lambda_A={la:.2f}, lambda_B=1.20)", 41)
    n, k = nfl(0.65, dt=30.0)
    run(n, f"NFL-like two-way moneyline (favourite scale k={k:.3f})", 42)
