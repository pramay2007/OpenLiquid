"""Shared rule model for the OpenLiquid sports stress test.

Everything is per $1 of margin and in the position's OWN-SIDE price s
(s = p for YES, s = 1 - p for NO).  Rules implemented exactly as stated in the brief:

  E1  n = L / s0 shares
  E2  free mode: P&L = clamp(n (s - s0), -1, C),  C = (1 - s0) / s0
      win line  s0 + (1 - s0)/L,  stop line  s0 - s0/L
  R4  liquidation when equity at the MID <= 20% of margin; liquidator takes 5% of margin
      out of whatever equity is left; the rest returns to the trader
  R1  closes fill at min(mid_s, slow_s), opens at max(mid_s, slow_s)
  R7  10% of net profit;  E4 crowding fee is taken from profit only, before the share
  E3  L <= min(50, min(p,1-p)/0.02, Ltime),  Ltime = min(p,1-p) / (3 sqrt(p(1-p) h / tau))

Simplifications (stated in the report):
  * leverage is an integer (floor), never below 1 -- this is how the contract applies E3
  * the slow price is the exact exponential average (tau = 300 s); the brief's discrete
    update dt/(tau+dt) differs from 1-exp(-dt/tau) by <1% at the step sizes used
"""
import numpy as np

TICK = 0.01
H_REACT = 120.0
TAU_SLOW = 300.0
TAU_FLOOR = 3600.0
PROFIT_SHARE = 0.10
MAINT = 0.20
LIQ_FEE = 0.05
MAX_GAP = 0.05
LCAP = 50.0
MIN_DIST = 0.02


def ltime(p, tau):
    p = np.asarray(p, float)
    m = np.minimum(p, 1 - p)
    tau = np.maximum(np.asarray(tau, float), 1e-12)
    return m / (3.0 * np.sqrt(np.maximum(p * (1 - p), 1e-12) * H_REACT / tau))


def lmax(p, tau, integer=True, use_time=True, cap=LCAP, min_dist=MIN_DIST):
    """Maximum leverage for a new position at YES-mid p with tau seconds to expiry."""
    p = np.asarray(p, float)
    m = np.minimum(p, 1 - p)
    L = np.minimum(cap, m / min_dist)
    if use_time:
        L = np.minimum(L, ltime(p, tau))
    if integer:
        L = np.floor(L + 1e-9)
    return np.maximum(L, 1.0)


class Pos:
    """A free-mode position with $1 margin opened at own-side price s0 with leverage L."""

    def __init__(self, s0, L):
        self.s0 = s0
        self.L = L
        self.n = L / s0
        self.C = (1 - s0) / s0
        self.pw = s0 + (1 - s0) / L
        self.pstop = s0 - s0 / L
        self.pliq = s0 - (1 - MAINT) * s0 / L
        self.borrowed = self.n * (1 - 1 / L)


def net_close(result, fee):
    """Trader net P&L for a close / collect / settlement with price result `result`
    (already clamped to [-1, C]) and accrued crowding fee `fee`."""
    result = np.asarray(result, float)
    profit = np.maximum(result, 0.0)
    crowd = np.minimum(fee, profit)
    share = PROFIT_SHARE * (profit - crowd)
    return np.where(result > 0, profit - crowd - share, result)


def net_liq(result):
    """Liquidation at the mid: the liquidator takes min(5% of margin, remaining equity)."""
    result = np.asarray(result, float)
    equity = np.maximum(1.0 + result, 0.0)
    liqfee = np.minimum(LIQ_FEE, equity)
    return result - liqfee, liqfee


# ----------------------------------------------------------------------------------------
# In-play model: independent Poisson scoring, fair win probability by backward induction,
# reference mid = fair value rounded to the 1c tick.
# ----------------------------------------------------------------------------------------
class Match:
    def __init__(self, events, tie_value, T=5400.0, dt=5.0, dmax=12):
        """events: list of (expected count per match, score change for YES team's margin)."""
        self.events = events
        self.tie = tie_value
        self.T = T
        self.dt = dt
        self.K = int(round(T / dt))
        self.dmax = dmax
        self.probs = [(rate * dt / T, int(size)) for rate, size in events]
        D = 2 * dmax + 1
        dgrid = np.arange(-dmax, dmax + 1)
        V = np.zeros((self.K + 1, D))
        V[self.K] = np.where(dgrid > 0, 1.0, np.where(dgrid == 0, tie_value, 0.0))
        p_none = 1.0 - sum(p for p, _ in self.probs)
        idx = np.arange(D)
        shifts = [np.clip(idx + size, 0, D - 1) for _, size in self.probs]
        for k in range(self.K - 1, -1, -1):
            nxt = V[k + 1]
            acc = p_none * nxt
            for (p, _), sh in zip(self.probs, shifts):
                acc = acc + p * nxt[sh]
            V[k] = acc
        self.V = V
        self.fair0 = V[0, dmax]
        self.mid0 = float(np.clip(np.rint(self.fair0 * 100) / 100, 0.01, 0.99))

    def evolve(self, d, rng):
        u = rng.random(d.shape[0])
        add = np.zeros_like(d)
        c = 0.0
        for prob, size in self.probs:
            hit = (u >= c) & (u < c + prob)
            add[hit] = size
            c += prob
        return np.clip(d + add, -self.dmax, self.dmax), add

    def fair(self, k, d):
        return self.V[k, d + self.dmax]

    def mid(self, k, d):
        return np.clip(np.rint(self.V[k, d + self.dmax] * 100) / 100, 0.01, 0.99)

    def outcome(self, d, rng):
        """1 if YES wins, 0 otherwise (ties broken by a fair coin when tie_value = 0.5)."""
        out = (d > 0).astype(float)
        tie = d == 0
        if self.tie > 0:
            out[tie] = (rng.random(int(tie.sum())) < self.tie).astype(float)
        return out


def soccer(target_yes, lam_b, T=5400.0, dt=5.0):
    """Soccer match, YES = 'team A wins in regular time'. lam_A is solved so that the
    kick-off fair value equals target_yes."""
    from scipy.optimize import brentq

    f = lambda la: Match([(la, +1), (lam_b, -1)], 0.0, T, dt).fair0 - target_yes
    la = brentq(f, 0.05, 6.0, xtol=1e-10)
    return Match([(la, +1), (lam_b, -1)], 0.0, T, dt), la


def nfl(target_yes, T=11400.0, dt=10.0, td=2.4, fg=1.6):
    """NFL-like two-way market: touchdowns (7) and field goals (3) as Poisson events over the
    ~190 minutes of real time a game takes; a tie at the end is a coin flip (overtime).
    Team A's scoring rates are scaled by k and B's by 1/k to hit the target price."""
    from scipy.optimize import brentq

    def build(k):
        ev = [(td * k, +7), (fg * k, +3), (td / k, -7), (fg / k, -3)]
        return Match(ev, 0.5, T, dt, dmax=80)

    f = lambda k: build(k).fair0 - target_yes
    k = brentq(f, 0.5, 2.0, xtol=1e-8)
    return build(k), k


def mean_se(x):
    x = np.asarray(x, float)
    return float(x.mean()), float(x.std(ddof=1) / np.sqrt(x.size))


def fmt(x):
    m, s = mean_se(x)
    return f"{m:+.4f} (se {s:.4f})"
