"""
Vectorised rule engine for OpenLiquid event markets (Boost pricing stress test).

Models, per path, one position slot per "book" (a side + mode), in the position's own side price:
  R1  worse-of fills against mid/slow (slow += (prevMid - slow) * dt / (tau_s + dt), tau_s = 300 s)
  R2  opens refused while |mid - slow| > 5 points (closes always allowed)
  R4  liquidation when equity at the MID <= 20% of margin; liquidator gets min(5% M, remaining equity)
  R7  10% profit share on net profit at close
  E1  n = M * L / p0
  E2  free mode: cap C = M (1 - p0) / p0
  E3  L <= min(50, min(p,1-p)/0.02, Ltime); positions above the current Ltime are force-closable at the close fill
  E5  boost: cap = min(10 M, n (1 - p0)); premium accrues per second from equity:
        variant "brief": borrowedShares * (1 - p_s) / tau        (formula as written in the review brief)
        variant "code" : borrowedShares * p (1 - p) / tau        (PerpEngine.sol _deltas, whitepaper ch. 5)
      tau floored at 1 hour.
Simplifications (stated in the report): mid lives on the 1-cent grid in [0.01, 0.99]; the keeper acts
once per simulation step (liquidate, collect, force-close, in that order); capacity (R3/E6) and the
vault reserve (R5) are not binding for a single unit-margin position; premium accrues exactly on the
mid that prevailed over each step.
"""
import numpy as np
from scipy.special import ndtr, ndtri

TICK = 0.01
PMIN, PMAX = 0.01, 0.99
TAU_SLOW = 300.0
TAU_FLOOR = 3600.0
H_REACT = 120.0
TIME_Z = 3.0
MAINT = 0.20
LIQ_FEE = 0.05
PROFIT_SHARE = 0.10
MAX_PROFIT_MULT = 10.0
L_ABS = 50.0
MIN_DIST = 0.02
MAX_GAP = 0.05
MAX_ENTRY_LOSS = 0.30

K_CLOSE, K_LIQ, K_FORCE, K_COLLECT, K_SETTLE = 1, 2, 3, 4, 5
KIND_NAMES = {1: "close", 2: "liquidated", 3: "force-closed", 4: "collected", 5: "settled"}


def ltime(p, tau, h=H_REACT):
    """E3 time limit: min(p,1-p) / (3 sqrt(p(1-p) h / tau))."""
    p = np.clip(p, 1e-9, 1 - 1e-9)
    tau = np.maximum(tau, 1e-9)
    return np.minimum(p, 1 - p) / (TIME_Z * np.sqrt(p * (1 - p) * h / tau))


def ltime_int(p, tau):
    """As the contract evaluates it for force-close: integer floor, clipped to [1, 50]."""
    return np.clip(np.floor(ltime(p, tau) + 1e-9), 1.0, L_ABS)


def lmax_open(p, tau, integer=True):
    l = np.minimum(L_ABS, np.minimum(np.minimum(p, 1 - p) / MIN_DIST, ltime(p, tau)))
    if integer:
        l = np.floor(l + 1e-9)
    return np.maximum(l, 1.0)


def hazard(ps, variant):
    if variant == "brief":
        return 1.0 - ps
    if variant == "code":
        return ps * (1.0 - ps)
    raise ValueError(variant)


def to_tick(x):
    return np.clip(np.round(x / TICK) * TICK, PMIN, PMAX)


class Book:
    """One position slot per path for one side; re-openable. Accumulates trader / house P&L."""

    def __init__(self, npaths, side, boost=True, M=1.0, variant="brief", prem_mult=1.0):
        self.np_ = npaths
        self.side = side
        self.boost = boost
        self.M = M
        self.variant = variant
        self.prem_mult = prem_mult
        z = lambda: np.zeros(npaths)
        self.is_open = np.zeros(npaths, bool)
        self.n_open = 0
        self.entry, self.n, self.B, self.L, self.cap, self.prem = z(), z(), z(), z(), z(), z()
        self.open_step = np.zeros(npaths, np.int64)
        # cumulative accounting
        self.trader = z()      # sum of (payout - M) over closed positions
        self.house = z()       # sum of (M - payout - liquidator fee); includes the profit share
        self.liqfees = z()
        self.fees = z()        # profit share (part of house)
        self.prem_paid = z()   # premium actually absorbed
        self.n_opened = z()
        self.kinds = np.zeros((6, npaths))
        self.last_kind = np.zeros(npaths, np.int8)
        self.last_exit_step = np.full(npaths, -1, np.int64)

    def ps(self, yes_price):
        return yes_price if self.side > 0 else 1.0 - yes_price

    def open(self, mask, mid, slow, L, tau, step=0):
        idx = np.flatnonzero(mask & ~self.is_open)
        if idx.size == 0 or tau <= 0:
            return idx[:0]
        m, sl = mid[idx], slow[idx]
        ps, ss = self.ps(m), self.ps(sl)
        entry = np.maximum(ps, ss)
        Lreq = L[idx] if isinstance(L, np.ndarray) else L
        Leff = np.minimum(Lreq, lmax_open(m, tau))
        n = self.M * Leff / entry
        ok = (
            (np.abs(m - sl) <= MAX_GAP + 1e-12)
            & (ps >= PMIN - 1e-12)
            & (ps <= PMAX + 1e-12)
            & (n * (entry - ps) <= MAX_ENTRY_LOSS * self.M + 1e-12)
        )
        idx, entry, Leff, n = idx[ok], entry[ok], Leff[ok] if isinstance(Leff, np.ndarray) else Leff, n[ok]
        if idx.size == 0:
            return idx
        self.entry[idx] = entry
        self.n[idx] = n
        self.L[idx] = Leff
        self.B[idx] = n * (1.0 - 1.0 / Leff)
        self.cap[idx] = np.minimum(MAX_PROFIT_MULT * self.M, (n if self.boost else self.M / entry) * (1.0 - entry))
        self.prem[idx] = 0.0
        self.open_step[idx] = step
        self.is_open[idx] = True
        self.n_opened[idx] += 1
        self.n_open += idx.size
        return idx

    def accrue(self, mid_prev, dt, tau_eff, mult=1.0):
        if not self.boost or self.n_open == 0:
            return
        rate = self.B * hazard(self.ps(mid_prev), self.variant)
        rate *= self.is_open
        if isinstance(mult, np.ndarray):
            rate *= mult
        self.prem += rate * (self.prem_mult * (mult if not isinstance(mult, np.ndarray) else 1.0) * dt / tau_eff)

    def result(self, price_s):
        gross = np.minimum(self.n * (price_s - self.entry), self.cap)
        return np.maximum(gross - self.prem, -self.M)

    def settle(self, mask, price_s, kind, step):
        idx = np.flatnonzero(mask & self.is_open)
        if idx.size == 0:
            return idx
        px = price_s[idx] if isinstance(price_s, np.ndarray) else price_s
        gross = np.minimum(self.n[idx] * (px - self.entry[idx]), self.cap[idx])
        prem = self.prem[idx]
        res = np.maximum(gross - prem, -self.M)
        fee = np.where(res > 0, PROFIT_SHARE * res, 0.0)
        payout = self.M + res - fee
        if kind == K_LIQ:
            liqfee = np.minimum(LIQ_FEE * self.M, payout)
            payout = payout - liqfee
        else:
            liqfee = 0.0
        self.trader[idx] += payout - self.M
        self.house[idx] += self.M - payout - liqfee
        self.liqfees[idx] += liqfee
        self.fees[idx] += fee
        self.prem_paid[idx] += np.clip(np.minimum(prem, self.M + gross), 0.0, None)
        self.kinds[kind, idx] += 1
        self.last_kind[idx] = kind
        self.last_exit_step[idx] = step
        self.is_open[idx] = False
        self.n_open -= idx.size
        return idx

    def keeper(self, mid, slow, tau, step, force_close=True):
        if self.n_open == 0:
            return
        ps = self.ps(mid)
        eq = np.minimum(self.n * (ps - self.entry), self.cap) - self.prem  # result before the -M floor
        liq = self.is_open & (eq <= (MAINT - 1.0) * self.M + 1e-12)
        if liq.any():
            self.settle(liq, ps, K_LIQ, step)
            if self.n_open == 0:
                return
        fill = np.minimum(ps, self.ps(slow))
        col = self.is_open & (self.n * (fill - self.entry) >= self.cap - 1e-12)
        if col.any():
            self.settle(col, fill, K_COLLECT, step)
        if force_close and self.n_open:
            fc = self.is_open & (self.L > ltime_int(mid, tau) + 1e-9)
            if fc.any():
                self.settle(fc, fill, K_FORCE, step)

    def close(self, mask, mid, slow, step):
        if self.n_open == 0:
            return np.zeros(0, np.int64)
        fill = np.minimum(self.ps(mid), self.ps(slow))
        return self.settle(mask, fill, K_CLOSE, step)

    def settle_final(self, final_yes, step):
        return self.settle(self.is_open.copy(), self.ps(final_yes), K_SETTLE, step)


# ----------------------------------------------------------------------------------------------
# Worlds: produce the YES mid on the 1-cent grid, step by step.
# ----------------------------------------------------------------------------------------------
class FlatJumpToResolution:
    """Price sits at p0; at a uniform random time in [0, tau0] it jumps to hi (prob p0) or lo."""

    def __init__(self, p0, tau0, hi=PMAX, lo=PMIN):
        self.p0, self.tau0, self.hi, self.lo = p0, tau0, hi, lo

    def init(self, n, rng):
        self.U = rng.uniform(0.0, self.tau0, n)
        self.up = rng.random(n) < (self.p0 - self.lo) / (self.hi - self.lo)
        return np.full(n, self.p0)

    def step(self, k, t_prev, t, rng):
        return np.where(self.U <= t, np.where(self.up, self.hi, self.lo), self.p0)


class ScheduledJump:
    """Flat at p0, one jump at a known time t_jump to p1 ~ sampler (mean p0), flat afterwards."""

    def __init__(self, p0, t_jump, sampler):
        self.p0, self.t_jump, self.sampler = p0, t_jump, sampler

    def init(self, n, rng):
        self.p1 = to_tick(self.sampler(n, rng))
        return np.full(n, self.p0)

    def step(self, k, t_prev, t, rng):
        return self.p1 if t >= self.t_jump - 1e-9 else np.full(self.p1.shape, self.p0)


class PoissonJumps:
    """
    Latent martingale x with instantaneous variance rate x(1-x)/tau ("uniform budget", the same
    assumption E3 uses). A share f_jump of that variance arrives as jumps of size delta, the rest
    as diffusion. mode "two": +-delta with equal odds. mode "down": crashes of delta compensated by
    upward drift (one-sided).
    """

    def __init__(self, p0, tau0, delta, f_jump=1.0, mode="two"):
        self.p0, self.tau0, self.delta, self.f, self.mode = p0, tau0, delta, f_jump, mode

    def init(self, n, rng):
        self.x = np.full(n, float(self.p0))
        self.njumps = np.zeros(n)
        return to_tick(self.x)

    def step(self, k, t_prev, t, rng):
        n = self.x.shape[0]
        dt = t - t_prev
        tau = max(self.tau0 - t_prev, 1.0)
        x = self.x
        v = x * (1.0 - x) / tau
        if self.f < 1.0:
            x = x + np.sqrt((1.0 - self.f) * v * dt) * rng.standard_normal(n)
            x = np.clip(x, PMIN, PMAX)
        if self.f > 0.0:
            lam = self.f * v / self.delta**2
            jump = rng.random(n) < -np.expm1(-lam * dt)
            u = np.minimum(self.delta, PMAX - x)
            d = np.minimum(self.delta, x - PMIN)
            if self.mode == "two":
                pu = np.where(u + d > 0, d / np.maximum(u + d, 1e-12), 0.0)
                up = rng.random(n) < pu
                x = np.where(jump, np.where(up, x + u, x - d), x)
            else:
                x = np.where(jump, x - d, np.minimum(x + lam * d * dt, PMAX))
            self.njumps += jump
        self.x = np.clip(x, PMIN, PMAX)
        return to_tick(self.x)


class InfoClockDiffusion:
    """
    p_t = Phi((z0 + W_c) / sqrt(1 - c)), c = clock(t) in [0, 1): the share of information revealed.
    clock(t) = t / tau0 is the standard "uniform information" binary diffusion; a clock that ramps
    inside a window concentrates the variance there (a scheduled night) with continuous paths.
    """

    def __init__(self, p0, clock):
        self.p0, self.clock = p0, clock

    def init(self, n, rng):
        self.z0 = float(ndtri(self.p0))
        self.W = np.zeros(n)
        return np.full(n, to_tick(np.array([self.p0]))[0])

    def step(self, k, t_prev, t, rng):
        c0, c1 = self.clock(t_prev), self.clock(t)
        if c1 > c0:
            self.W += np.sqrt(c1 - c0) * rng.standard_normal(self.W.shape[0])
        return to_tick(ndtr((self.z0 + self.W) / np.sqrt(max(1.0 - c1, 1e-12))))


# ----------------------------------------------------------------------------------------------
# Driver
# ----------------------------------------------------------------------------------------------
def run(world, books, policy, npaths, dt, nsteps, tau0, seed=1, force_close=True, tau_of=None, rv_scale=None):
    """
    tau_of(t): the time-to-expiry the CONTRACT uses at time t (default tau0 - t).
    policy.act(k, t, tau, mid, slow, books) is called after the keeper each step; k = 0 is the start.
    """
    rng = np.random.default_rng(seed)
    if tau_of is None:
        tau_of = lambda t: tau0 - t
    mid = world.init(npaths, rng)
    slow = mid.copy()
    # optional realised-volatility scaling of the premium: rv_scale = (averaging seconds, max multiple).
    # The multiple applied over a step uses only moves observed before that step (no look-ahead).
    rv = None if rv_scale is None else mid * (1 - mid) / max(tau_of(0.0), TAU_FLOOR)
    policy.act(0, 0.0, tau_of(0.0), mid, slow, books)
    for k in range(1, nsteps + 1):
        t_prev, t = (k - 1) * dt, k * dt
        new_mid = world.step(k, t_prev, t, rng)
        slow += (mid - slow) * (dt / (TAU_SLOW + dt))
        tau_eff = max(tau_of(t_prev) - dt / 2.0, TAU_FLOOR)
        mult = 1.0
        if rv_scale is not None:
            model = np.maximum(mid * (1 - mid), 1e-6) / tau_eff
            mult = np.clip(rv / model, 1.0, rv_scale[1])
        for b in books:
            b.accrue(mid, dt, tau_eff, mult)
        if rv_scale is not None:
            rv = rv + ((new_mid - mid) ** 2 / dt - rv) * dt / (rv_scale[0] + dt)
        mid = new_mid
        tau_now = tau_of(t)
        for b in books:
            b.keeper(mid, slow, tau_now, k, force_close)
        policy.act(k, t, tau_now, mid, slow, books)
        if k % 25 == 0 and all(b.n_open == 0 for b in books) and policy.finished(k):
            break
    for b in books:
        b.close(b.is_open.copy(), mid, slow, nsteps)
    return mid, slow


def summarize(books, label="", per="position"):
    """EV per dollar of margin posted (sum over books), with standard errors."""
    tr = sum(b.trader for b in books)
    ho = sum(b.house for b in books)
    lf = sum(b.liqfees for b in books)
    pp = sum(b.prem_paid for b in books)
    fe = sum(b.fees for b in books)
    m = sum(b.n_opened * b.M for b in books)
    mm = m.mean()
    n = tr.shape[0]
    se = lambda x: x.std(ddof=1) / np.sqrt(n)
    out = {
        "label": label,
        "paths": n,
        "margin_per_path": mm,
        "trader_ev": tr.mean() / mm,
        "trader_se": se(tr) / mm,
        "house_ev": ho.mean() / mm,
        "house_se": se(ho) / mm,
        "liqfee": lf.mean() / mm,
        "premium": pp.mean() / mm,
        "profit_share": fe.mean() / mm,
        "kinds": {KIND_NAMES[i]: float(sum(b.kinds[i] for b in books).mean()) for i in range(1, 6)},
        "p_trader_wins": float((tr > 1e-12).mean()),
        "worst_house": float(ho.min() / (m.max() if m.max() > 0 else 1.0)),
    }
    return out


def fmt(s):
    k = ", ".join(f"{a}={b:.3f}" for a, b in s["kinds"].items() if b > 0)
    return (
        f"{s['label']:<58s} trader {s['trader_ev']:+.4f} (se {s['trader_se']:.4f})  "
        f"HOUSE {s['house_ev']:+.4f} (se {s['house_se']:.4f})  prem {s['premium']:.3f} "
        f"share {s['profit_share']:.3f} liqfee {s['liqfee']:.3f}  P(win) {s['p_trader_wins']:.3f}  [{k}]"
    )


# ----------------------------------------------------------------------------------------------
# Policies
# ----------------------------------------------------------------------------------------------
class OpenHoldClose:
    """Open every book at open_step with leverage L (clipped to the limit), close at close_step."""

    def __init__(self, open_step, L, close_step):
        self.open_step, self.L, self.close_step = open_step, L, close_step

    def act(self, k, t, tau, mid, slow, books):
        if k == self.open_step:
            all_ = np.ones(mid.shape[0], bool)
            for b in books:
                b.open(all_, mid, slow, self.L, tau, k)
        if k == self.close_step:
            for b in books:
                b.close(b.is_open.copy(), mid, slow, k)

    def finished(self, k):
        return k > self.open_step


class OpenThenTakeProfit:
    """
    Open at open_step. Close a position once its result at the close fill is >= tp (in units of
    margin) and the slow price has caught up to within eps of the mid; give up at horizon_step.
    No look-ahead: uses only the current mid/slow.
    """

    def __init__(self, open_step, L, tp, eps=0.0051, horizon_step=None, reopen=False, reopen_until=None):
        self.open_step, self.L, self.tp, self.eps = open_step, L, tp, eps
        self.horizon_step, self.reopen, self.reopen_until = horizon_step, reopen, reopen_until

    def act(self, k, t, tau, mid, slow, books):
        for b in books:
            if k == self.open_step:
                b.open(np.ones(mid.shape[0], bool), mid, slow, self.L, tau, k)
            elif self.reopen and (self.reopen_until is None or k <= self.reopen_until):
                b.open(~b.is_open & (b.last_exit_step < k), mid, slow, self.L, tau, k)
            if b.n_open:
                ps = b.ps(mid)
                fill = np.minimum(ps, b.ps(slow))
                hit = b.is_open & (b.result(fill) >= self.tp * b.M) & (ps - fill <= self.eps) & (b.open_step < k)
                b.close(hit, mid, slow, k)
            if self.horizon_step is not None and k == self.horizon_step:
                b.close(b.is_open.copy(), mid, slow, k)

    def finished(self, k):
        if self.reopen:
            return self.reopen_until is not None and k > self.reopen_until
        return k > self.open_step


class Harvest:
    """
    Drift-harvest / re-entry policy with no look-ahead: open only when the slow price has converged
    to the mid (|mid - slow| <= eps_open), take profit once the result at the close fill is >= tp
    (units of margin), then re-open; stop opening after reopen_until.
    """

    def __init__(self, L, tp, eps_open=0.0011, reopen_until=None):
        self.L, self.tp, self.eps_open, self.reopen_until = L, tp, eps_open, reopen_until

    def act(self, k, t, tau, mid, slow, books):
        for b in books:
            if b.n_open:
                fill = np.minimum(b.ps(mid), b.ps(slow))
                hit = b.is_open & (b.result(fill) >= self.tp * b.M) & (b.open_step < k)
                if hit.any():
                    b.close(hit, mid, slow, k)
            if self.reopen_until is None or k <= self.reopen_until:
                can = ~b.is_open & (np.abs(mid - slow) <= self.eps_open) & (b.last_exit_step < k)
                if can.any():
                    b.open(can, mid, slow, self.L, tau, k)

    def finished(self, k):
        return self.reopen_until is not None and k > self.reopen_until


# ----------------------------------------------------------------------------------------------
# Lattice worlds: the MID ITSELF is a martingale on the 1-cent grid (no rounding of a latent price,
# which would bias every stop-out by about half a tick against the trader).
# ----------------------------------------------------------------------------------------------
def _skellam(rng, lam):
    """Symmetric integer step with variance 2*lam (per path)."""
    if np.max(lam) < 0.02:
        u = rng.random(lam.shape[0])
        return (u < lam).astype(np.int64) - (u > 1.0 - lam).astype(np.int64)
    return rng.poisson(lam) - rng.poisson(lam)


class LatticeProbit:
    """
    Driftless walk on ticks whose local variance equals that of the binary diffusion
    p = Phi((z0 + W_c)/sqrt(1-c)):  var(dp) = phi(Phi^-1(p))^2 * dc / (1 - c),  c = clock(t).
    """

    def __init__(self, p0, clock):
        self.p0, self.clock = p0, clock

    def init(self, n, rng):
        self.i = np.full(n, int(round(self.p0 / TICK)), np.int64)
        return self.i * TICK

    def step(self, k, t_prev, t, rng):
        c0, c1 = self.clock(t_prev), self.clock(t)
        if c1 > c0:
            p = self.i * TICK
            z = ndtri(p)
            var = np.exp(-z * z) / (2 * np.pi) * (c1 - c0) / max(1.0 - 0.5 * (c0 + c1), 1e-9)
            self.i = np.clip(self.i + _skellam(rng, var / (2 * TICK * TICK)), 1, 99)
        return self.i * TICK


class LatticeBudget:
    """
    Driftless walk on ticks with total variance rate p(1-p)/tau (the E3 "uniform budget").
    A share f_jump arrives as jumps of m ticks:
      mode "two":  +-m ticks, equal odds, rate f v / (m tick)^2
      mode "down": -m ticks at rate f v / (m tick)^2, compensated by single up-ticks arriving at
                   rate m times that (a martingale: the side that can only crash)
    The remaining (1 - f_jump) arrives as +-1-tick diffusion.
    """

    def __init__(self, p0, tau0, m_ticks, f_jump=1.0, mode="two"):
        self.p0, self.tau0, self.m, self.f, self.mode = p0, tau0, int(m_ticks), f_jump, mode

    def init(self, n, rng):
        self.i = np.full(n, int(round(self.p0 / TICK)), np.int64)
        self.njumps = np.zeros(n)
        return self.i * TICK

    def step(self, k, t_prev, t, rng):
        n = self.i.shape[0]
        dt = t - t_prev
        tau = max(self.tau0 - t_prev, 1.0)
        p = self.i * TICK
        v = p * (1.0 - p) / tau
        i = self.i
        if self.f < 1.0:
            i = i + _skellam(rng, (1.0 - self.f) * v * dt / (2 * TICK * TICK))
        if self.f > 0.0:
            lam = self.f * v / (self.m * TICK) ** 2
            jump = rng.random(n) < -np.expm1(-lam * dt)
            if self.mode == "two":
                sgn = np.where(rng.random(n) < 0.5, 1, -1)
                i = i + np.where(jump, sgn * self.m, 0)
            else:
                up = rng.random(n) < -np.expm1(-lam * self.m * dt)
                i = i + np.where(jump, -self.m, 0) + up
            self.njumps += jump
        self.i = np.clip(i, 1, 99)
        return self.i * TICK
