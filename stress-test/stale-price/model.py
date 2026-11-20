"""
Shared model for the stale-price / price-choice stress test of OpenLiquid event markets.

Units
-----
* Everything is per 1 USDC of margin (M = 1).
* Prices are measured in 1-cent ticks RELATIVE TO THE ENTRY FILL p0, in the position's own side
  price (YES price for a long, NO price for a short), so a "long" below covers both sides.
* x = on-chain mid - p0 (ticks, on the 1c lattice),  s = on-chain slow price - p0 (ticks, real).

Rules modelled exactly as written (R1, R4, R7, E1, E2):
* P&L at fill y:  clamp(k*y, -1, C),  k = L*0.01/p0 (margin per tick),  C = (1-p0)/p0 (free mode).
* A close is a sell: it fills at min(mid, slow)   -> y = min(x, s).
* collect(): allowed when the P&L at the CLOSE price has reached C  (min(x, s) >= W = C/k).
* Liquidation: equity AT THE MID <= 20% of margin (k*x <= -0.8); settled at the mid; the liquidator
  takes 5% of margin out of what is left; the rest returns to the trader.
* Profit share 10% of net profit at close. Crowding fee is taken from profit only (MC only).

The slow price is the exact exponential average (what PriceOracle.sol does, and the adversarial
limit of the written "dt/(tau+dt)" step when a trader pushes every one-second signed price).
"""
import math
import numpy as np

TICK = 0.01
PROFIT_SHARE = 0.10
MAINT = 0.20
LIQ_FEE = 0.05


class Corridor:
    """A free-mode (or boosted) event position opened at own-side price p0 with leverage L."""

    def __init__(self, p0, L, boost=False):
        self.p0, self.L, self.boost = p0, L, boost
        self.k = L * TICK / p0                       # margin lost/won per tick
        self.C = min(10.0, L * (1 - p0) / p0) if boost else (1 - p0) / p0
        self.W = self.C / self.k                     # win line, ticks above entry
        self.S = 1.0 / self.k                        # stop line, ticks below entry
        self.trig = -(1 - MAINT) / self.k            # liquidation trigger (ticks)
        self.xL = int(math.floor(self.trig + 1e-9))  # first lattice point at/below the trigger

    def gross(self, y):
        return np.clip(self.k * np.asarray(y, dtype=float), -1.0, self.C)

    def close_net(self, y, fee=0.0):
        """Trader's net P&L when closing at fill offset y (ticks). fee = accrued crowding fee."""
        r = self.gross(y)
        prof = np.maximum(r - fee, 0.0)
        return np.where(r > 0, (1 - PROFIT_SHARE) * prof, r)

    def liq_net(self, x):
        """Trader's net P&L when liquidated with the on-chain mid at offset x (ticks)."""
        e = 1.0 + self.gross(x)
        return np.maximum(e - LIQ_FEE, 0.0) - 1.0

    def __repr__(self):
        return (f"Corridor(p0={self.p0}, L={self.L}, boost={self.boost}: k={self.k:.4f}/tick, C={self.C:.3f}, "
                f"win +{self.W:.2f}t, stop -{self.S:.2f}t, liq trigger {self.trig:.2f}t -> lattice {self.xL})")


def solve_dp(cor, lam, tau=300.0, q=1.0, la_nonliq=True, la_liq=True, mode="opt", tp_frac=0.9,
             haircut=0.0, collect_at_mid=False, ds=0.002, dt=None, pad_top=8, s_floor=-5.0,
             tol=1e-11, max_iter=3_000_000, x_shift=0.0):
    """
    Value of an open position as a function of (x, s), for a +/-1 tick symmetric Poisson walk of the
    reference mid with intensity lam (ticks per second).

    Look-ahead: when a tick arrives, with probability q the trader sees it before it is on-chain and
    may close first at the pre-tick on-chain state (this is the relay-lag race).
      la_liq    : the look-ahead may be used when the tick would trigger liquidation (iii)
      la_nonliq : ... on any other adverse tick (ii)
    mode = "opt"     : optimal stopping (voluntary close any time + look-ahead closes)
    mode = "passive" : hold; take profit when the close P&L reaches tp_frac*C; dodge if la_liq.
    haircut : ticks taken off every close fill (candidate fix); entry haircut is applied by the caller
              through the starting x.
    collect_at_mid : variant in which the cap is tested (and paid) at the mid instead of the close price.
    x_shift : lattice offset (the mid lattice sits at integers + x_shift relative to entry).
    Returns dict with V[x_index, s_index], grids and the stop masks.
    """
    k, C, W = cor.k, cor.C, cor.W
    if dt is None:
        dt = min(3.0, 0.02 / lam)
    a = math.exp(-dt / tau) if tau > 0 else 0.0
    # lattice rows: all x = integer + x_shift strictly above the trigger
    x_lo = int(math.floor(cor.trig - x_shift + 1e-9)) + 1
    x_hi = int(math.ceil(W)) + pad_top
    xi = np.arange(x_lo, x_hi + 1)
    xs = xi + x_shift
    s_lo = min(xs[0], s_floor) - 0.5
    s_hi = float(xs[-1])
    ns = int(round((s_hi - s_lo) / ds)) + 1
    sg = s_lo + ds * np.arange(ns)
    nx = len(xs)
    X = xs[:, None] * np.ones((1, ns))
    S = np.ones((nx, 1)) * sg[None, :]
    fill = np.minimum(X, S) - haircut
    r = cor.gross(fill)
    cnow = np.where(r > 0, (1 - PROFIT_SHARE) * r, r)
    if collect_at_mid:
        forced = (X - haircut) >= W - 1e-9
        cnow = np.where(forced, (1 - PROFIT_SHARE) * C, cnow)
    else:
        forced = fill >= W - 1e-9
    Sdec = X + (S - X) * a
    f = (Sdec - s_lo) / ds
    j0 = np.clip(np.floor(f).astype(np.int64), 0, ns - 2)
    w = f - j0
    rows = np.arange(nx)[:, None]
    liq = float(cor.liq_net(xs[0] - 1.0))
    lamdt = lam * dt
    la_allowed = np.zeros((nx, 1), dtype=bool)
    la_allowed[0, 0] = la_liq
    la_allowed[1:, 0] = la_nonliq
    if mode == "passive":
        stop = forced | (r >= tp_frac * C - 1e-12)
    V = cnow.copy()
    it = 0
    while True:
        Vdec = (1 - w) * V[rows, j0] + w * V[rows, j0 + 1]
        Vup = np.concatenate([V[1:], V[-1:]], axis=0)
        Vdn = np.concatenate([np.full((1, ns), liq), V[:-1]], axis=0)
        if mode == "opt":
            dn = np.where(la_allowed, q * np.maximum(cnow, Vdn) + (1 - q) * Vdn, Vdn)
            cont = (1 - lamdt) * Vdec + lamdt * 0.5 * (Vup + dn)
            Vn = np.maximum(cnow, cont)
            Vn[forced] = cnow[forced]
        else:
            dn = Vdn.copy()
            if la_liq:
                dn[0] = q * cnow[0] + (1 - q) * liq
            cont = (1 - lamdt) * Vdec + lamdt * 0.5 * (Vup + dn)
            Vn = np.where(stop, cnow, cont)
        diff = float(np.max(np.abs(Vn - V)))
        V = Vn
        it += 1
        if diff < tol or it >= max_iter:
            break
    Vdn = np.concatenate([np.full((1, ns), liq), V[:-1]], axis=0)
    if mode == "opt":
        Vdec = (1 - w) * V[rows, j0] + w * V[rows, j0 + 1]
        Vup = np.concatenate([V[1:], V[-1:]], axis=0)
        dn = np.where(la_allowed, q * np.maximum(cnow, Vdn) + (1 - q) * Vdn, Vdn)
        cont = (1 - lamdt) * Vdec + lamdt * 0.5 * (Vup + dn)
        A = forced | (cnow >= cont - 1e-10)
    else:
        A = stop
    return dict(V=V, A=A, cnow=cnow, xs=xs, xi=xi, sg=sg, s_lo=s_lo, ds=ds, x_lo=x_lo, liq=liq,
                iters=it, diff=diff, dt=dt, cor=cor, la_allowed=la_allowed[:, 0], mode=mode, q=q)


def value_at(sol, x, s):
    """V at lattice x (same lattice as the solution) and slow offset s; liquidation value below."""
    cor = sol["cor"]
    xs = sol["xs"]
    ix = int(round(x - xs[0]))
    if ix < 0:
        return float(cor.liq_net(x))
    ix = min(ix, len(xs) - 1)
    f = (s - sol["s_lo"]) / sol["ds"]
    j = int(np.clip(math.floor(f), 0, len(sol["sg"]) - 2))
    w = f - j
    return float((1 - w) * sol["V"][ix, j] + w * sol["V"][ix, j + 1])
