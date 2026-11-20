"""
Closed forms used to cross-check the simulator. Margin M = 1 throughout; side price p0.
"""
import numpy as np
from engine import (LIQ_FEE, MAINT, MAX_PROFIT_MULT, PROFIT_SHARE, TAU_SLOW, hazard)


def pos(p0, L, boost=True):
    n = L / p0
    B = n * (1 - 1 / L)
    cap = min(MAX_PROFIT_MULT, (n if boost else 1 / p0) * (1 - p0))
    return n, B, cap


def calibration_hold_to_liq(p0, L, variant, hi=0.99, wait=1800.0):
    """
    World: price flat at p0, one jump to hi (prob ~p0) / 0.01 at a uniform time over the remaining
    life. Boosted position opened at t=0 and held until the jump or until the premium liquidates it
    (premium reaches 0.8 M). Returns (trader EV, house EV, P(jump before premium liquidation)).
    Premium by life-fraction x: c * -ln(1-x), c = B * hazard(p0).
    """
    n, B, cap = pos(p0, L)
    c = B * hazard(p0, variant)
    lo = 0.01
    pu = (p0 - lo) / (hi - lo)
    q = 1 - np.exp(-(1 - MAINT) / c)  # life fraction at which the premium alone liquidates
    fill = hi - (hi - p0) * np.exp(-wait / TAU_SLOW)
    G = min(cap, n * (fill - p0))
    int_prem = c * ((1 - q) * np.log(1 - q) + q)  # integral of premium over x in [0, q]
    win = pu * (1 - PROFIT_SHARE) * (G * q - int_prem)
    lose = (1 - pu) * q * 1.0
    prem_liq = (1 - q) * (1 - MAINT + LIQ_FEE)
    trader = win - lose - prem_liq
    liqfee = (1 - q) * LIQ_FEE  # a gapped position has no equity left to pay a liquidator
    house = -trader - liqfee
    return trader, house, q


def calibration_rate(p0, L, variant):
    """House EV per dollar of margin per unit of (holding time / remaining life), small holds."""
    n, B, cap = pos(p0, L)
    c = B * hazard(p0, variant)
    trader = p0 * (1 - PROFIT_SHARE) * cap - (1 - p0) * 1.0 - c * (1 - p0 * PROFIT_SHARE)
    return -trader


def sched_tight_leg(p0, L, p1, wait=900.0, boost=True):
    """One leg through a scheduled jump p0 -> p1, opened just before, closed `wait` s after. Premium ~ 0."""
    n, B, cap = pos(p0, L, boost)
    gross_mid = min(n * (p1 - p0), cap)
    if 1 + max(gross_mid, -1.0) <= MAINT:  # liquidated at the mid
        payout = 1 + max(gross_mid, -1.0)
        payout -= min(LIQ_FEE, payout)
        return payout - 1
    fill = min(p1, p1 - (p1 - p0) * np.exp(-wait / TAU_SLOW))
    res = max(min(n * (fill - p0), cap), -1.0)
    return res - (PROFIT_SHARE * res if res > 0 else 0.0)


def poisson_cycle(p0, L, delta, variant, f_jump=1.0, two_sided=True):
    """
    Uniform variance budget p(1-p)/tau; a share f_jump arrives as jumps of size delta. Position is
    opened fresh and held to its first jump (or premium liquidation); slow-price lag and diffusion
    ignored. In log-time s = ln(tau0/tau): jump rate kappa, premium rate c. Returns trader EV.
    """
    n, B, cap = pos(p0, L)
    c = B * hazard(p0, variant)
    kappa = f_jump * p0 * (1 - p0) / delta**2
    S = (1 - MAINT) / c
    # integrate over the first-jump log-time s in [0, S]
    s = np.linspace(0, S, 20001)
    w = kappa * np.exp(-kappa * s)
    prem = c * s
    up_gain = np.minimum(n * delta, cap) - prem
    up = (1 - PROFIT_SHARE) * np.maximum(up_gain, 0) + np.minimum(up_gain, 0)
    eq_dn = 1 - n * delta - prem
    dn = np.where(eq_dn <= MAINT, np.maximum(eq_dn, 0) - np.minimum(LIQ_FEE, np.maximum(eq_dn, 0)) - 1, eq_dn - 1)
    if two_sided:
        integrand = w * (0.5 * up + 0.5 * dn)
    else:
        # crash-only: every jump is down; the compensating drift earns n*kappa*delta per unit log-time
        drift_gain = n * kappa * delta * s
        integrand = w * (np.where(1 + drift_gain - n * delta - prem <= MAINT,
                                  np.maximum(1 + drift_gain - n * delta - prem, 0) * (1 - 0.0) - 1, drift_gain - n * delta - prem))
    ev = np.trapezoid(integrand, s)
    ev += np.exp(-kappa * S) * (MAINT - LIQ_FEE - 1) if two_sided else 0.0
    return ev


def gap_ratio_two_sided(L):
    """premium / worst-case expected gap loss, symmetric jumps of the worst size (2x stop distance), brief variant."""
    return 8 * (L - 1) / L**2


def gap_ratio_one_sided(L):
    return 4 * (L - 1) / L**2
