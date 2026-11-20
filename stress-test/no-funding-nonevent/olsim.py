"""
Shared engine for the "no funding on non-event markets" stress scenario.

Rules modelled (non-event markets, crypto parameters from the brief):
  R1  mid + slow; on each update  slow += (previousMid - slow) * dt/(tau+dt), tau = 60 s.
      buy fills at max(mid, slow), sell fills at min(mid, slow).
  R2  opens refused while |mid - slow| > 20 bps (measured against slow, as in the contract).
  R4  isolated margin, loss <= M; liquidatable when equity at MID <= 20% of M; settled at the mid;
      liquidator gets 5% of M out of whatever equity is left; the rest returns to the trader.
  R5  reserve / profit cap = min(10*M, N).  A position whose P&L at the close fill has reached the
      cap can be closed by anyone (collect).
  R7  no fee to open or close; profit share 5% of net profit at close.
  E4  crowding fee (non-events): accrues N * skew * 0.05%/day; taken only from profit at close,
      before the profit share; never from margin; a losing position pays nothing.

All money amounts are in units of one leg's margin M unless stated (so N = L, cap = min(10, L)).
Prices evolve on a 1-second grid (the keeper signs every second) with arithmetic returns
r = sigma_1s * z, so the mid is an exact martingale.  z is standard normal or a unit-variance
Student-t.
"""
import math
import numpy as np

SEC_DAY = 86400.0
SEC_YEAR = 365.0 * SEC_DAY

TAU = 60.0
MAX_GAP = 20e-4
MAINT = 0.20
LIQ_FEE = 0.05
CAP_MULT = 10.0
PROFIT_SHARE = 0.05
CROWD_PER_DAY = 0.0005
ENTRY_GUARD = 0.30  # deployed contract only (MAX_ENTRY_LOSS_BPS); not in the brief's rule list


def sig1(sigma_ann):
    return sigma_ann / math.sqrt(SEC_YEAR)


def mean_se(x):
    x = np.asarray(x, dtype=float)
    return float(x.mean()), float(x.std(ddof=1) / math.sqrt(len(x)))


def fmt(x, unit="", d=4):
    m, s = mean_se(x)
    return f"{m:.{d}f} +/- {s:.{d}f}{unit}"


class Draw:
    """Unit-variance innovations: normal, or Student-t(df) rescaled to variance 1."""

    def __init__(self, rng, dist="normal"):
        self.rng = rng
        self.dist = dist
        if dist != "normal":
            self.df = float(dist)
            self.scale = 1.0 / math.sqrt(self.df / (self.df - 2.0))

    def __call__(self, n):
        if self.dist == "normal":
            return self.rng.standard_normal(n)
        return self.rng.standard_t(self.df, n) * self.scale


def burn_in(draw, n, s1, burn=600):
    """Run the two prices long enough that (mid, slow) is in its stationary relation."""
    mid = np.ones(n)
    slow = np.ones(n)
    w = 1.0 / (TAU + 1.0)
    for _ in range(burn):
        prev = mid
        mid = prev * (1.0 + s1 * draw(n))
        slow = slow + (prev - slow) * w
    return mid, slow


# ---------------------------------------------------------------------------------------------
# Hedged pair (one long leg + one short leg, same notional), 1-second grid, exact fills.
# ---------------------------------------------------------------------------------------------
def pair_worker(args):
    """
    Attacker keeps a long and a short of equal notional open as much of the time as possible.
      - a leg is (re)opened when its worse-of fill costs at most `entry_tol` of price
        (long: slow - mid <= tol ; short: mid - slow <= tol) and R2 allows opens;
      - losing legs are left to the liquidation rule (keeper checks every `liq_every` seconds;
        settled at the mid; loss clipped at M).  self_liq=True means the attacker is his own
        liquidator, so the 5% reward comes back to him;
      - winning legs run until collectable at the cap (P&L at the close fill >= min(10M, N));
      - at the horizon every open leg is marked at the mid, gains taxed at the profit share.
    Returns per-path arrays (units of one leg's margin M).
    """
    (n, sigma_ann, L, horizon_s, seed, liq_every, self_liq, entry_tol, dist, burn) = args
    rng = np.random.default_rng(seed)
    draw = Draw(rng, dist)
    s1 = sig1(sigma_ann)
    cap = min(CAP_MULT, float(L))
    w = 1.0 / (TAU + 1.0)
    mid, slow = burn_in(draw, n, s1, burn)

    eL = np.ones(n); oL = np.zeros(n, bool)
    eS = np.ones(n); oS = np.zeros(n, bool)
    net = np.zeros(n)      # attacker P&L after profit share and third-party liquidation fees
    gross = np.zeros(n)    # sum of position results before profit share
    tax = np.zeros(n)      # profit share paid
    liqfee = np.zeros(n)   # liquidation reward paid to a third party (0 when self_liq)
    clip = np.zeros(n)     # loss beyond margin that the vault never collects (N|x| - M)+
    nstop = np.zeros(n); ncap = np.zeros(n)
    occL = np.zeros(n); occS = np.zeros(n)
    thr = -(1.0 - MAINT)

    for k in range(1, horizon_s + 1):
        prev = mid
        mid = prev * (1.0 + s1 * draw(n))
        slow = slow + (prev - slow) * w

        pmL = L * (mid / eL - 1.0)
        pmS = L * (1.0 - mid / eS)
        if k % liq_every == 0:
            lq = oL & (pmL <= thr)
            if lq.any():
                res = np.maximum(pmL[lq], -1.0)
                fee = 0.0 if self_liq else np.minimum(LIQ_FEE, 1.0 + res)
                gross[lq] += res; net[lq] += res - fee; liqfee[lq] += fee
                clip[lq] += np.maximum(-pmL[lq] - 1.0, 0.0)
                nstop[lq] += 1; oL[lq] = False
            lq = oS & (pmS <= thr)
            if lq.any():
                res = np.maximum(pmS[lq], -1.0)
                fee = 0.0 if self_liq else np.minimum(LIQ_FEE, 1.0 + res)
                gross[lq] += res; net[lq] += res - fee; liqfee[lq] += fee
                clip[lq] += np.maximum(-pmS[lq] - 1.0, 0.0)
                nstop[lq] += 1; oS[lq] = False
        # collect at the cap (close fill: long sells at min, short buys at max)
        lo = np.minimum(mid, slow); hi = np.maximum(mid, slow)
        col = oL & (L * (lo / eL - 1.0) >= cap)
        if col.any():
            gross[col] += cap; tax[col] += PROFIT_SHARE * cap; net[col] += cap * (1 - PROFIT_SHARE)
            ncap[col] += 1; oL[col] = False
        col = oS & (L * (1.0 - hi / eS) >= cap)
        if col.any():
            gross[col] += cap; tax[col] += PROFIT_SHARE * cap; net[col] += cap * (1 - PROFIT_SHARE)
            ncap[col] += 1; oS[col] = False
        # (re)open
        gap_ok = np.abs(mid - slow) <= MAX_GAP * slow
        can = (~oL) & gap_ok & ((slow - mid) <= entry_tol * mid)
        if can.any():
            eL[can] = hi[can]; oL[can] = True
        can = (~oS) & gap_ok & ((mid - slow) <= entry_tol * mid)
        if can.any():
            eS[can] = lo[can]; oS[can] = True
        occL += oL; occS += oS

    # mark what is still open at the mid
    for (o, pm) in ((oL, L * (mid / eL - 1.0)), (oS, L * (1.0 - mid / eS))):
        res = np.clip(pm[o], -1.0, cap)
        t = PROFIT_SHARE * np.maximum(res, 0.0)
        gross[o] += res; tax[o] += t; net[o] += res - t
        clip[o] += np.maximum(-pm[o] - 1.0, 0.0)
    return dict(net=net, gross=gross, tax=tax, liqfee=liqfee, clip=clip, nstop=nstop, ncap=ncap,
                occL=occL / horizon_s, occS=occS / horizon_s)


def run_parallel(worker, arglist, workers=8):
    from concurrent.futures import ProcessPoolExecutor
    with ProcessPoolExecutor(max_workers=workers) as ex:
        outs = list(ex.map(worker, arglist))
    keys = outs[0].keys()
    return {k: np.concatenate([o[k] for o in outs]) for k in keys}
