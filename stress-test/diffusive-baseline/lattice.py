"""
Exact (no simulation) value of ONE free-mode event position when the reference mid moves on a
price lattice in i.i.d. symmetric steps (a martingale).  All amounts are per $1 of margin.

Rules modelled (own-side price, so a NO position is the same object with p -> 1-p):
  n = L / p0 shares per $1 margin, cap C = (1-p0)/p0, P&L = clamp(n*(p-p0), -1, +C)
  liquidation when equity at the MID <= maint (20%) of margin; settled at the mid;
      liquidator takes min(5% of margin, remaining equity); rest returns to the trader
  profit share `fee` (10%) on positive P&L at close
  the position is opened at the mid with slow == mid (zero entry cost)

Idealisation used ONLY here (the Monte Carlo engine removes it): a voluntary close fills at the
mid, i.e. the slow price has caught up.  For a losing close that is exact (worse-of of a fallen
price IS the mid); for a winning close it is an upper bound.
"""
import numpy as np


def _frac_lev_ok(p0, L):
    return L <= min(50.0, min(p0, 1 - p0) / 0.02 + 1e-12)


def max_int_leverage(p0, tau=None, h_react=120.0, cap=50):
    """E3 leverage limit, integer leverage as in the contract (floor)."""
    lev = min(cap, int(np.floor(min(p0, 1 - p0) / 0.02 + 1e-9)))
    if tau is not None:
        lt = min(p0, 1 - p0) / (3.0 * np.sqrt(p0 * (1 - p0) * h_react / tau))
        lev = min(lev, int(np.floor(lt + 1e-9)))
    return max(lev, 1)


def lattice_value(p0, L, h, steps, probs, fee=0.10, maint=0.20, liqfee=0.05,
                  policy="hold", tp_k=None, self_liq=False, liq_buffer_ticks=None,
                  tick=0.01, return_all=False):
    """
    policy: 'hold'    never close voluntarily: ends by liquidation or at the cap (collect)
            'tp'      close at the first lattice point k >= tp_k (else as 'hold')
            'optimal' optimal stopping over lattice points (close-at-mid idealisation)
    liq_buffer_ticks: if set, the PROPOSED FIX: liquidatable when equity <= max(maint, n*buffer*tick)
    Returns dict with ev (expected P&L per $1 margin), p_win, p_liq, e_under (expected loss
    forgiven by the -margin clamp), e_fee (profit share paid), e_liqcut, e_steps.
    """
    steps = np.asarray(steps, dtype=int)
    probs = np.asarray(probs, dtype=float)
    assert abs(probs.sum() - 1) < 1e-12 and abs((steps * probs).sum()) < 1e-12, "steps must be a martingale"
    n = L / p0
    C = (1 - p0) / p0
    S = int(np.abs(steps).max())
    maint_eff = maint if liq_buffer_ticks is None else max(maint, n * liq_buffer_ticks * tick)
    # lattice offsets k: mid = p0 + k*h
    k_liq = int(np.floor((maint_eff - 1) / (n * h) + 1e-9))      # largest k with equity <= maint_eff
    k_cap = int(np.ceil(C / (n * h) - 1e-9))                    # smallest k with n*k*h >= C
    if policy == "tp" and tp_k is not None:
        k_top = min(k_cap, int(tp_k))
    else:
        k_top = k_cap
    lo, hi = k_liq - S + 1, k_top + S - 1
    ks = np.arange(lo, hi + 1)
    idx = {k: i for i, k in enumerate(ks)}
    N = len(ks)
    lin = n * ks * h                                             # linear P&L at mid
    eq = 1 + lin
    is_liq = ks <= k_liq
    is_top = ks >= k_top
    interior = ~(is_liq | is_top)

    pay = np.zeros(N)
    under = np.zeros(N)
    feepaid = np.zeros(N)
    liqcut = np.zeros(N)
    eqc = np.maximum(eq, 0.0)
    cut = np.zeros(N) if self_liq else np.minimum(liqfee, eqc)
    pay[is_liq] = (eqc - cut - 1)[is_liq]
    under[is_liq] = np.maximum(-eq, 0.0)[is_liq]
    liqcut[is_liq] = cut[is_liq]
    gross_top = np.minimum(lin, C)
    pay[is_top] = (gross_top * (1 - fee))[is_top]
    feepaid[is_top] = (gross_top * fee)[is_top]
    close_now = np.where(lin > 0, lin * (1 - fee), lin)          # voluntary close at mid

    # transition matrix restricted to interior rows
    P = np.zeros((N, N))
    for k in ks[interior]:
        i = idx[k]
        for s, pr in zip(steps, probs):
            P[i, idx[k + s]] += pr
    I = np.where(interior)[0]
    T = np.where(~interior)[0]
    A = np.eye(len(I)) - P[np.ix_(I, I)]

    def solve(term_vec, run_vec=None):
        rhs = P[np.ix_(I, T)] @ term_vec[T]
        if run_vec is not None:
            rhs = rhs + run_vec[I]
        v = np.zeros(N)
        v[T] = term_vec[T]
        v[I] = np.linalg.solve(A, rhs)
        return v

    out = {"n": n, "C": C, "k_liq": k_liq, "k_cap": k_cap, "ds_ticks": (p0 / L) / tick,
           "dw_ticks": ((1 - p0) / L) / tick}
    if policy in ("hold", "tp"):
        V = solve(pay)
        k0 = idx[0]
        out.update(ev=V[k0],
                   p_win=solve(is_top.astype(float))[k0],
                   p_liq=solve(is_liq.astype(float))[k0],
                   e_under=solve(under)[k0],
                   e_fee=solve(feepaid)[k0],
                   e_liqcut=solve(liqcut)[k0],
                   e_steps=solve(np.zeros(N), np.ones(N))[k0])
        if return_all:
            out["V"] = dict(zip(ks.tolist(), V.tolist()))
        return out
    # optimal stopping by value iteration (V >= close_now on interior)
    V = np.where(interior, close_now, pay)
    for _ in range(200000):
        cont = P @ V
        Vn = np.where(interior, np.maximum(close_now, cont), pay)
        if np.max(np.abs(Vn - V)) < 1e-14:
            V = Vn
            break
        V = Vn
    cont = P @ V
    k0 = idx[0]
    out.update(ev=cont[k0],                       # value of opening and then stopping optimally
               stop_set=[int(k) for k in ks[interior & (close_now >= cont - 1e-13)]])
    if return_all:
        out["V"] = dict(zip(ks.tolist(), V.tolist()))
        out["cont"] = dict(zip(ks.tolist(), cont.tolist()))
    return out


# reference-step regimes ------------------------------------------------------------------------
def regime(name, **kw):
    """returns (h, steps, probs).  h is the lattice spacing in price units."""
    if name == "full":            # mid moves one whole cent at a time
        return 0.01, [-1, 1], [0.5, 0.5]
    if name == "half":            # mid = (bid+ask)/2 moves half a cent at a time
        return 0.005, [-1, 1], [0.5, 0.5]
    if name == "mix":             # half-cent lattice, a share q of changes are a whole cent
        q = kw["q"]
        return 0.005, [-2, -1, 1, 2], [q / 2, (1 - q) / 2, (1 - q) / 2, q / 2]
    if name == "jump":            # whole-cent lattice, a share mu of changes are +-J cents
        mu, J = kw["mu"], kw["J"]
        return 0.01, [-J, -1, 1, J], [mu / 2, (1 - mu) / 2, (1 - mu) / 2, mu / 2]
    raise ValueError(name)


if __name__ == "__main__":
    h, st, pr = regime("full")
    for p0, L in [(0.5, 25), (0.5, 10), (0.2, 10), (0.8, 10), (0.26, 10), (0.18, 7)]:
        r = lattice_value(p0, L, h, st, pr)
        print(p0, L, {k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})
