"""
OpenLiquid event-market rules, as written in the review brief (and as PerpEngine.sol implements them).
Everything is per position, in the position's OWN side price ps (YES price for YES, 1 - YES for NO).
Vectorised over numpy arrays.
"""
import numpy as np

TICK = 0.01
MAINT = 0.20        # liquidatable when equity at the mid <= 20% of margin
LIQ_FEE = 0.05      # liquidator gets 5% of margin, out of the remaining equity
PROFIT_FEE = 0.10   # share of net profit on events
CAP_MULT = 10.0     # contract ceiling on profit as a multiple of margin (maxProfitMult)
H_REACT = 120.0     # reaction seconds in Ltime
Z_TIME = 3.0
TAU_FLOOR = 3600.0
TAU_SLOW = 300.0
LEV_CEIL = 50


def round_tick(p):
    return np.round(np.asarray(p) / TICK) * TICK


def ltime(p_yes, tau_sec):
    p = np.asarray(p_yes, dtype=float)
    dist = np.minimum(p, 1 - p)
    sd = np.sqrt(np.maximum(p * (1 - p), 1e-18) * H_REACT / np.maximum(tau_sec, 1e-9))
    return dist / (Z_TIME * sd)


def max_leverage(p_yes, tau_sec, ceil=LEV_CEIL, min_dist=0.02, use_time=True):
    """Integer leverage limit E3 (floors as in the contract, never below 1)."""
    p = np.asarray(p_yes, dtype=float)
    dist = np.minimum(p, 1 - p)
    lev = np.minimum(ceil, np.floor(dist / min_dist + 1e-9))
    if use_time:
        lev = np.minimum(lev, np.floor(ltime(p, tau_sec) + 1e-9))
    return np.maximum(1.0, lev)


def reserve(ps0, L, boost=False):
    """Maximum profit per $1 of margin."""
    stake = L if boost else 1.0
    return np.minimum(CAP_MULT, stake * (1 - ps0) / ps0)


def result(ps0, ps1, L, boost=False, premium=0.0):
    """Capped/floored price result per $1 margin (contract _result)."""
    raw = (L / ps0) * (ps1 - ps0)
    r = np.minimum(raw, reserve(ps0, L, boost)) - premium
    return np.maximum(r, -1.0)


def settle(r, crowding=0.0, liquidated=False, fee=PROFIT_FEE):
    """Given the result r per $1 margin: returns (trader net P&L, house P&L, liquidator fee)."""
    r = np.asarray(r, dtype=float)
    c = np.where(r > 0, np.minimum(crowding, np.maximum(r, 0)), 0.0)
    profit = np.maximum(r, 0) - c
    share = profit * fee
    trader = np.where(r > 0, profit - share, r)
    house = np.where(r > 0, -(profit - share), -r)
    liq = np.where(liquidated, np.minimum(LIQ_FEE, 1.0 + trader), 0.0)
    liq = np.maximum(liq, 0.0)
    return trader - liq, house, liq


def win_line(ps0, L, boost=False):
    return ps0 + reserve(ps0, L, boost) * ps0 / L


def stop_line(ps0, L):
    return ps0 - ps0 / L


def liq_line(ps0, L):
    return ps0 - (1 - MAINT) * ps0 / L


def borrowed_shares(ps0, L):
    return (L - 1.0) / ps0


def slow_update(slow, held_mid, dt):
    """Oracle rule: the average moves toward the mid that was held for dt seconds."""
    return held_mid + (slow - held_mid) * np.exp(-dt / TAU_SLOW)
