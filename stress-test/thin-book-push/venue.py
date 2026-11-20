"""
OpenLiquid venue rules, exactly as written in the review brief (R1-R7, E1-E6), as plain
vectorised numpy helpers.  Everything about a position is expressed in its OWN side price q
(q = p for YES, q = 1-p for NO).

Simplifications (stated once, used everywhere):
  * prices are floats, not 1e18 fixed point (rounding dust ignored);
  * leverage is an integer, as in the contract (uint32);
  * the free-mode cap is C = M*(1-q0)/q0 as written in E2 (the contract additionally
    truncates at 10*M, which only binds for q0 < 1/11 and is never reached in these tests);
  * profit share 10% on (profit - crowding fee); staker split ignored (house = vault + stakers).
"""
import numpy as np

TICK = 0.01
TAU_SLOW_EVENT = 300.0          # R1
MAX_GAP_EVENT = 0.05            # R2, probability points
KAPPA = 0.5                     # R3
DEPTH_TICKS = 5                 # R3, Gemini
MAINT = 0.20                    # R4
LIQ_FEE = 0.05                  # R4
PRICE_VALID_S = 20              # R6
POLL_S = 4                      # R6
PROFIT_SHARE_EVENT = 0.10       # R7
L_CAP = 50                      # E3
MIN_DIST = 0.02                 # E3 (two ticks)
REACTION_H = 120.0              # E3
TIME_Z = 3.0                    # E3
TAU_FLOOR = 3600.0              # E4/E5

# Gemini Predictions fee schedule (gemini.com/fees/predictions, schedule dated 2026-03-12):
#   taker fee = 0.07 * C * P * (1-P); maker fee = 0.0175 * C * P * (1-P), waived 2026-09-02..12-31.
GEMINI_TAKER = 0.07
GEMINI_MAKER = 0.0


def taker_fee_per_contract(px, rate=GEMINI_TAKER):
    return rate * px * (1.0 - px)


# ---------------------------------------------------------------- R1: slow price
def slow_step_written(slow, prev_mid, dt, tau=TAU_SLOW_EVENT):
    """R1 as written: slow += (previousMid - slow) * dt / (tau + dt)."""
    return slow + (prev_mid - slow) * dt / (tau + dt)


def slow_step_exact(slow, prev_mid, dt, tau=TAU_SLOW_EVENT):
    """What the deployed PriceOracle.sol does: exact exponential average."""
    return prev_mid + (slow - prev_mid) * np.exp(-dt / tau)


def catchup_written(T, tau=TAU_SLOW_EVENT, dt=POLL_S):
    """Share of a held gap that `slow` has covered after T seconds, updates every dt (R1 as written)."""
    n = np.floor(np.asarray(T, float) / dt)
    rem = np.asarray(T, float) - n * dt
    return 1.0 - (tau / (tau + dt)) ** n * (tau / (tau + rem))


def catchup_exact(T, tau=TAU_SLOW_EVENT):
    return 1.0 - np.exp(-np.asarray(T, float) / tau)


# ---------------------------------------------------------------- E3: leverage limit
def l_time(p, tau_exp, h=REACTION_H, z=TIME_Z):
    p = np.asarray(p, float)
    d = np.minimum(p, 1 - p)
    return d / (z * np.sqrt(p * (1 - p) * h / np.maximum(tau_exp, 1e-9)))


def l_max(p, tau_exp):
    """Largest integer leverage that may be opened at mid p with tau_exp seconds to expiry."""
    p = np.asarray(p, float)
    d = np.minimum(p, 1 - p)
    lim = np.minimum(np.minimum(L_CAP, np.floor(d / MIN_DIST + 1e-9)), np.floor(l_time(p, tau_exp)))
    return np.maximum(lim, 1.0)


# ---------------------------------------------------------------- E1/E2: position maths (own-side price q)
def shares(N, q0):
    return N / q0


def cap_free(M, q0):
    return M * (1.0 - q0) / q0


def win_line(q0, L):
    return q0 + (1.0 - q0) / L


def stop_line(q0, L):
    return q0 - q0 / L


def liq_line(q0, L):
    """Own-side mid at which equity = 20% of margin (80% of the stop distance)."""
    return q0 - (1.0 - MAINT) * q0 / L


def pnl_free(M, L, q0, q):
    n = M * L / q0
    return np.clip(n * (q - q0), -M, cap_free(M, q0))


def close_payout_net(pnl, crowd_fee, share=PROFIT_SHARE_EVENT):
    """Trader's net result of a close: profit pays the crowding fee then the profit share; a loss pays nothing extra."""
    pnl = np.asarray(pnl, float)
    fee = np.minimum(np.maximum(crowd_fee, 0.0), np.maximum(pnl, 0.0))
    return np.where(pnl > 0, (pnl - fee) * (1.0 - share), pnl)


def liquidation_net(M, pnl_at_mid):
    """Trader's net result if liquidated at the mid: equity returns less the 5%-of-margin reward."""
    eq = M + np.maximum(pnl_at_mid, -M)
    reward = np.minimum(LIQ_FEE * M, eq)
    return (eq - reward) - M, reward


# ---------------------------------------------------------------- E4: crowding fee rate (events)
def crowd_rate_written(borrowed_shares, skew_frac, q_mid, tau_exp):
    """USDC per second, E4 as written: borrowedShares * skewFrac * (1 - p_s) / tau."""
    return borrowed_shares * skew_frac * (1.0 - q_mid) / np.maximum(tau_exp, TAU_FLOOR)


def crowd_rate_contract(borrowed_shares, skew_frac, q_mid, tau_exp):
    """What PerpEngine.sol charges: borrowedShares * skewFrac * p(1-p) / tau."""
    return borrowed_shares * skew_frac * q_mid * (1.0 - q_mid) / np.maximum(tau_exp, TAU_FLOOR)


# ---------------------------------------------------------------- reference depth as the keeper measures it
def depth_near_mid(bid_px, bid_sz, ask_px, ask_sz, ticks=DEPTH_TICKS):
    """keeper/src/sources/gemini.js depthNearMid: mid = (best bid + best ask)/2; USD = px*sz within the band; thinner side."""
    bid_px = np.asarray(bid_px, float); ask_px = np.asarray(ask_px, float)
    bid_sz = np.asarray(bid_sz, float); ask_sz = np.asarray(ask_sz, float)
    ok_b = bid_sz > 0; ok_a = ask_sz > 0
    bid = bid_px[ok_b].max(); ask = ask_px[ok_a].min()
    mid = (bid + ask) / 2
    band = ticks * TICK + 1e-9
    db = (bid_px * bid_sz)[ok_b & (np.abs(bid_px - mid) <= band)].sum()
    da = (ask_px * ask_sz)[ok_a & (np.abs(ask_px - mid) <= band)].sum()
    return mid, bid, ask, min(db, da)


if __name__ == "__main__":
    # sanity checks against the whitepaper table (entry 54c, $100): 10x -> win 58.6c, stop 48.6c
    assert abs(win_line(0.54, 10) - 0.586) < 1e-9 and abs(stop_line(0.54, 10) - 0.486) < 1e-9
    assert abs(cap_free(100, 0.54) - 85.185185) < 1e-5
    # leverage table at 50c: 30d -> 25 (tick limit), 5d -> 20, 1d -> 8, 6h -> 4, 1h -> 1
    for days, want in [(30, 25), (5, 20), (1, 8), (0.25, 4), (1 / 24, 1)]:
        assert l_max(0.5, days * 86400) == want, (days, l_max(0.5, days * 86400))
    # slow price: written rule with 4 s updates vs exact
    for T in (4, 60, 150, 300, 600, 900):
        print(f"T={T:4d}s  catch-up written(4s)={catchup_written(T):.4f}  written(single update)={T/(300+T):.4f}  exact={catchup_exact(T):.4f}")
    print("l_max(0.495, 30d) =", l_max(0.495, 30 * 86400), " liq line L=24:", liq_line(0.495, 24), " win:", win_line(0.495, 24))
    print("ok")
