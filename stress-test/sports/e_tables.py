"""Exact (no simulation) tables for the pre-game mechanics of a sports market.

 E1  When each leverage stops being allowed / becomes force-closable before kick-off (E3).
 E2  Crowding fee and Boost premium when tau = time to KICK-OFF: what an honest holder pays.
 E3  Force-close at the normal close price right after a favourable jump (slow still lagging).
 E4  Upkeep queue: how long N positions that fall due together keep a sequential keeper busy.
"""
import numpy as np
from ol import ltime, lmax, Pos, LCAP, TAU_SLOW

HOUR = 3600.0


def tau_star(L, p):
    """Seconds before kick-off at which floor(Ltime) drops below L (position becomes force-closable)."""
    return 1080.0 * L * L * max(p, 1 - p) / min(p, 1 - p)


def hm(sec):
    if sec >= 2 * 86400:
        return f"{sec / 86400:.1f} d"
    if sec >= 2 * HOUR:
        return f"{sec / HOUR:.1f} h"
    return f"{sec / 60:.0f} min"


print("E1. Time before kick-off at which a position of leverage L becomes force-closable (Ltime < L)")
print("    L      p=0.50      p=0.40      p=0.30      p=0.20      p=0.10")
for L in (2, 3, 5, 8, 10, 15, 20):
    print(f"    {L:<4d}" + "".join(f"{hm(tau_star(L, p)):>12s}" for p in (0.5, 0.4, 0.3, 0.2, 0.1)))
print("    => nothing above 1x can be OPENED inside the last 72 min (p=0.5) / 2.8 h (p=0.3) / 4.8 h (p=0.2) / 10.8 h (p=0.1).")
print("       Soccer line-ups (~60 min before), NFL inactives (90 min), NBA line-ups (30 min) all land when only 1x exists.")

print()
print("E2. Crowding fee at full skew, tau = time to kick-off (floored at 1 h).  Fee as a multiple of the")
print("    position's maximum profit C, for a hold from tau1 to tau2 with the price unchanged:")
print("    fee / C = (L - 1) * [ln(tau1 / max(tau2, 1h)) + (time spent inside the last hour) / 1h]")
for L in (2, 3, 5, 10):
    row = []
    for t1, t2, lab in ((48 * HOUR, 24 * HOUR, "48h->24h"), (24 * HOUR, 12 * HOUR, "24h->12h"),
                        (24 * HOUR, 23 * HOUR, "24h->23h"), (6 * HOUR, 3 * HOUR, "6h->3h"),
                        (2 * HOUR, 1 * HOUR, "2h->1h")):
        row.append(f"{lab}: {(L - 1) * np.log(t1 / t2):.2f} C")
    print(f"    L={L:<3d} " + "   ".join(row))
print("    Share of the remaining time after which the fee equals the whole possible profit:  "
      + ", ".join(f"L={L}: {100 * (1 - np.exp(-1 / (L - 1))):.0f}%" for L in (2, 3, 5, 10, 20)))
print("    Boost premium is the same amount but taken from margin.  Minutes until a boosted position that has not")
print("    moved in price is liquidated (premium = 80% of margin), for p0 = 0.50:")
for L in (2, 3, 5):
    pos = Pos(0.5, float(L))
    rate_last_hour = pos.borrowed * 0.5 / HOUR           # per second per $1 margin inside the last hour
    out = [f"inside the last hour: {0.8 / rate_last_hour / 60:.0f} min"]
    for tau in (6 * HOUR, 24 * HOUR):
        # 0.8 = borrowed*(1-p)*ln(tau/tau_end)  ->  tau_end
        x = 0.8 / (pos.borrowed * 0.5)
        tau_end = tau * np.exp(-x)
        out.append(f"opened {tau / HOUR:.0f} h out: dead {hm(tau - tau_end)} later" if tau_end > HOUR
                   else f"opened {tau / HOUR:.0f} h out: survives to the last hour")
    print(f"    L={L}: " + ";  ".join(out))
print("    Churn: the fee is capped at profit and wiped when a position closes at zero profit.  With no")
print("    open/close fee and mid = slow, closing and re-opening an unmoved position resets the accrual at the")
print("    cost of gas only, so a trader who churns pays only what accrues between his last re-open and the move.")

print()
print("E3. Smallest favourable jump after which a position opened at the E3 maximum is force-closable")
print("    (Ltime is evaluated at the NEW mid), while its close price is still the pre-jump slow price:")
print("    own side   tau      L_max   jump that makes it force-closable   profit at the mid   profit paid if force-closed at once")
for s0, tau, lab in ((0.50, 86400.0, "24 h"), (0.60, 86400.0, "24 h"), (0.70, 86400.0, "24 h"),
                     (0.70, 7 * 86400.0, "7 d"), (0.50, 7 * 86400.0, "7 d")):
    p = s0                      # holder is long YES at p >= 0.5 (favourite side)
    L = float(lmax(p, tau))
    pos = Pos(s0, L)
    found = None
    for ticks in range(1, 40):
        q = p + 0.01 * ticks
        if q >= 0.99:
            break
        lim = max(1.0, np.floor(min(LCAP, float(ltime(q, tau))) + 1e-9))
        if L > lim:
            found = ticks
            break
    if found is None:
        print(f"    {s0:.2f}       {lab:<6s}   {L:>4.0f}    none below 0.99")
        continue
    gain = min(pos.n * 0.01 * found, pos.C)
    print(f"    {s0:.2f}       {lab:<6s}   {L:>4.0f}    +{found} tick(s)                          {gain:+.3f} M"
          f"             0 (close price = slow = entry)")
print("    Time for the close price to give the winner his gain back: slow covers 1 - exp(-t/300 s);"
      f" 90% after {-TAU_SLOW * np.log(0.1) / 60:.1f} min.  A keeper that sweeps every 3 s closes him first.")

print()
print("E4. Upkeep queue (keeper sends one transaction per position and waits for it):")
for per_tx in (1.0, 2.0):
    print(f"    {per_tx:.0f} s per position: " + ", ".join(f"{n} positions -> {n * per_tx / 60:.0f} min" for n in (100, 500, 1500, 3000)))
print("    All positions with the same L and price fall due in the same second (table E1), and a force-close")
print("    costs the trader nothing, so $1 positions are a free way to fill that queue: the margin comes back.")
print("    Liquidations share the same queue.  Reward for outside liquidators = min(5% of margin, equity left),")
print("    which is 0 after a jump through the stop, so in a jump market the keeper is the only liquidator.")
