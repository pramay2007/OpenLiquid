"""
Shared rule constants and closed-form single-position outcomes for OpenLiquid event markets.

Everything is in the position's OWN side price (p for YES, 1-p for NO), as in rules E1-E6.

Conventions
-----------
side  : +1 = YES (long), -1 = NO (the "short")
mode  : "free" or "boost"
M, L  : margin and leverage; notional N = M*L; shares n = N/e, e = entry fill (own side)
cap   : free  -> M*(1-e)/e                       (E2)
        boost -> min(10*M, n*(1-e))              (E5)
P&L   : clamp(n*(x-e), -M, cap), boost premium subtracted before the -M floor     (E2/E5)
liquidation : equity at the MID <= 20% of M; liquidator gets 5% of M OUT OF THE REMAINING
              EQUITY (capped by it), remainder to the trader                         (R4)
profit share: 10% of profit net of the crowding fee                                 (R7/E4)
crowding fee: taken from profit only, capped at profit                              (E4)
"""
import math
import numpy as np

TICK = 0.01
MAINT = 0.20          # liquidation when equity <= 20% of margin
LIQ_FEE = 0.05        # liquidator reward, share of margin, out of remaining equity
PROFIT_SHARE = 0.10   # events
TAU_SLOW = 300.0      # s, events
MAX_GAP = 0.05        # 5 probability points
H_REACT = 120.0       # s, E3
Z_TIME = 3.0          # E3
TAU_FLOOR = 3600.0    # s, E4/E5
BOOST_MULT = 10.0     # E5 cap multiple
MAX_LEV = 50.0
MIN_DIST = 0.02       # min(p,1-p)/0.02


def lev_time(p, tau, h=H_REACT, z=Z_TIME):
    """E3 time leverage limit (real-valued)."""
    p = np.asarray(p, dtype=float)
    tau = np.maximum(np.asarray(tau, dtype=float), 1e-9)
    return np.minimum(p, 1 - p) / (z * np.sqrt(p * (1 - p) * h / tau))


def max_lev(p, tau, integer=True):
    """E3 opening limit: min(50, min(p,1-p)/0.02, Ltime). Integer leverage as in the contract."""
    p = np.asarray(p, dtype=float)
    lv = np.minimum(MAX_LEV, np.minimum(np.minimum(p, 1 - p) / MIN_DIST + 1e-9, lev_time(p, tau)))
    if integer:
        lv = np.maximum(1.0, np.floor(lv + 1e-9))
    return lv


def leg(side, mode, M, L, p0, p1, *, fee_per_B=0.0, prem_per_B=0.0, resolved=False,
        profit_share=PROFIT_SHARE, entry=None):
    """
    Outcome of one position opened at YES-price p0 (fill = p0 unless `entry` given, own side) and
    closed/liquidated/settled at YES-price p1 (array ok).  Assumes the close happens once the slow
    price has converged (close price = mid) or at settlement.

    fee_per_B  : crowding fee accrued per borrowed share over the holding period (free mode)
    prem_per_B : Boost premium accrued per borrowed share over the holding period (boost mode)
    Returns dict of arrays: trader (P&L), house (vault P&L incl. fees it keeps), liqfee, fee,
    crowd, prem, plus scalars cap, n, B, stop, win (own-side lines).
    """
    p1 = np.asarray(p1, dtype=float)
    e = (p0 if side > 0 else 1 - p0) if entry is None else entry
    x = p1 if side > 0 else 1 - p1
    n = M * L / e
    B = n * (1 - 1 / L)
    if mode == "free":
        cap = M * (1 - e) / e
        prem = 0.0
        crowd_acc = B * fee_per_B
    else:
        cap = min(BOOST_MULT * M, n * (1 - e))
        prem = B * prem_per_B
        crowd_acc = 0.0
    res = np.maximum(np.minimum(n * (x - e), cap) - prem, -M)
    liq = (M + res <= MAINT * M) & (not resolved)
    liqfee = np.where(liq, np.minimum(LIQ_FEE * M, M + res), 0.0)
    win = res > 0
    crowd = np.where(win, np.minimum(crowd_acc, res), 0.0)
    profit = np.where(win, res - crowd, 0.0)
    fee = profit_share * profit
    trader = np.where(win, profit - fee, res - liqfee)
    house = -trader - liqfee
    return dict(trader=trader, house=house, liqfee=liqfee, fee=fee, crowd=crowd,
                prem=np.minimum(prem, M + np.minimum(n * (x - e), cap)) if mode == "boost" else 0.0,
                cap=cap, n=n, B=B, stop=e - e / L, win=e + cap / n, e=e, liq=liq)


def two_point(up, down):
    """Mean-zero two-point jump: +up w.p. pi, -down w.p. 1-pi.  Returns (jumps, probs)."""
    pi = down / (up + down)
    return np.array([up, -down]), np.array([pi, 1 - pi])


def fmt(x, w=8, d=3):
    return f"{x:{w}.{d}f}"
