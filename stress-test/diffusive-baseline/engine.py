"""
Event-driven Monte Carlo of OpenLiquid free-mode event positions with the slow price modelled.

Reference mid: lattice of spacing h; changes arrive as a Poisson process (rate lam per second);
each change is an i.i.d. symmetric step (martingale).  The keeper relays every change at once
(R6), so the on-chain mid is the lattice mid.  Between changes the slow price moves toward the
mid:  exact exponential (the contract: gap *= exp(-dt/tau)) or the rule as written in the brief
for a single sparse update (gap *= tau/(tau+dt)).

Rules implemented exactly, per $1 of margin, in the position's own-side price:
  open   : buy at max(mid, slow)  (own side);  leverage limit judged at the mid; refused if
           |mid-slow| > maxGap (5 points) or if the fill starts > 30% of margin under water
  P&L    : clamp(n*(p - entry), -1, C),  C = (1-entry)/entry,  n = L/entry
  close  : sell at min(mid, slow)  (own side); trader closes when that price reaches `target`
  collect: target is never above the win line, so a capped position is closed at the cap
  liquidate: at a mid change, if equity at the MID <= 20%: settle at the mid, liquidator takes
           min(5%, equity), remainder to the trader
  profit share 10% of positive P&L after the crowding fee; crowding fee taken from profit only

A leg is described by tables indexed by the lattice index of the mid at entry:
  lev[k]  : leverage to use (0 = do not trade at this price)
  tpk[k]  : take-profit, in lattice steps above the own-side mid at entry (np.inf = the cap)
"""
import numpy as np


class Leg:
    def __init__(self, side, lev, tpk, tp_eps=0.02, eps_in=0.02, sl_k=None, crowd_rate=0.0,
                 crowd_reset=False, reset_eps=0.02, first_bias=None, follow=False, tp_converge=False,
                 lastlook=0.0):
        self.side = side              # +1 YES, -1 NO
        self.lev = np.asarray(lev, dtype=float)
        self.tpk = np.asarray(tpk, dtype=float)
        self.tp_eps = tp_eps          # close this many TICKS (0.01) below the lattice target / cap
        self.eps_in = eps_in          # largest adverse entry gap accepted, in ticks (np.inf = naive)
        self.sl_k = sl_k              # optional voluntary stop, lattice steps below entry mid
        self.crowd_rate = crowd_rate  # skewFrac / tau_expiry  (per second, per borrowed share * (1-p_s))
        self.crowd_reset = crowd_reset
        self.reset_eps = reset_eps
        self.follow = follow          # enter only right after a first half-step in this leg's favour (paired model)
        self.lastlook = lastlook      # probability of closing at the pre-change worse-of price when the next mid change is adverse
        self.tp_converge = tp_converge  # close at ANY own-side mid >= entry mid + tpk steps once the slow price is within tp_eps of the mid (or the cap is reached)


def run(npaths, k0, h, steps, probs, lam, legs, tau_s=300.0, repeat=False, horizon_events=None,
        horizon_time=None, seed=0, fee=0.10, maint=0.20, liqfee=0.05, max_entry_loss=0.30,
        max_gap=0.05, slow_rule="exp", burn_time=0.0, g0_ticks=0.0, first_up_prob=None,
        first_wait=None, tick=0.01, liq_buffer_ticks=None, max_iter=2_000_000, paired=None,
        settle_at_end=False):
    """
    k0: lattice index of the starting mid (price = k0*h).  g0_ticks: initial (mid - slow) in ticks.
    first_up_prob: if set, the FIRST mid change is +1 lattice step (YES-favourable) with this
                   probability (models knowing the next change); first_wait = its delay in seconds.
    Returns list of per-leg result dicts with per-path arrays.
    """
    rng = np.random.default_rng(seed)
    steps = np.asarray(steps, dtype=int)
    probs = np.asarray(probs, dtype=float)
    cum = np.cumsum(probs)
    kmin, kmax = int(round(0.01 / h)), int(round(0.99 / h))
    P = npaths
    kmid = np.full(P, k0, dtype=np.int64)
    g = np.full(P, g0_ticks * tick)          # YES-terms gap: mid - slow
    t = np.zeros(P)
    nev = np.zeros(P, dtype=np.int64)
    # paired half-step model: a quote shift arrives at rate lam and is seen as two half-cent steps,
    # the second after an Exp(delay) wait, in the same direction with probability rho (else the
    # first half-step is undone).  pend = direction of a pending second half-step (0 = none).
    pend = np.zeros(P, dtype=np.int64)

    if slow_rule == "exp":
        decay = lambda dt: np.exp(-dt / tau_s)
        t_reach = lambda ratio: tau_s * np.log(1.0 / ratio)      # time until gap shrinks to ratio*gap
    else:  # one sparse update after dt, as written: slow += (mid - slow) * dt/(tau+dt)
        decay = lambda dt: tau_s / (tau_s + dt)
        t_reach = lambda ratio: tau_s * (1.0 / ratio - 1.0)

    S = []
    for lg in legs:
        S.append(dict(
            ph=np.zeros(P, dtype=np.int8), entry=np.zeros(P), n=np.zeros(P), C=np.zeros(P),
            L=np.zeros(P), target=np.zeros(P), liqp=np.zeros(P), slp=np.full(P, -np.inf),
            capp=np.zeros(P), level=np.zeros(P),
            acc=np.zeros(P), topen=np.zeros(P), entry_mid=np.zeros(P),
            pnl=np.zeros(P), nb=np.zeros(P), nwin=np.zeros(P), nliq=np.zeros(P), nsl=np.zeros(P),
            fee=np.zeros(P), crowd=np.zeros(P), under=np.zeros(P), liqcut=np.zeros(P),
            dur=np.zeros(P), entry_cost=np.zeros(P), lagcost=np.zeros(P), gross_win=np.zeros(P),
            mart=np.zeros(P), forfeit=np.zeros(P),
            nreset=np.zeros(P)))

    def settle(st, lg, ii, own_price, kind, when, own_mid=None):
        """close paths ii of a leg at own-side price own_price (array)."""
        lin = st["n"][ii] * (own_price - st["entry"][ii])
        res = np.clip(lin, -1.0, st["C"][ii])
        if own_mid is not None:   # diagnostics: martingale part and profit forfeited above the cap
            st["mart"][ii] += st["n"][ii] * (own_mid - st["entry_mid"][ii])
        st["forfeit"][ii] += np.maximum(lin - st["C"][ii], 0.0)
        pos = res > 0
        cf = np.where(pos, np.minimum(st["acc"][ii], np.maximum(res, 0)), 0.0)
        net = np.where(pos, (res - cf) * (1 - fee), res)
        pf = np.where(pos, (res - cf) * fee, 0.0)
        if kind == "liq":
            eq = 1.0 + res
            cut = np.minimum(liqfee, np.maximum(eq, 0.0))
            net = net - cut
            st["liqcut"][ii] += cut
            st["nliq"][ii] += 1
            st["under"][ii] += np.maximum(-(1.0 + lin), 0.0)
        elif kind == "sl":
            st["nsl"][ii] += 1
        else:
            st["nwin"][ii] += pos
            st["gross_win"][ii] += np.where(pos, res, 0.0)
        st["pnl"][ii] += net
        st["fee"][ii] += pf
        st["crowd"][ii] += cf
        st["nb"][ii] += 1
        st["dur"][ii] += when - st["topen"][ii]
        st["ph"][ii] = 0 if repeat else 2
        st["acc"][ii] = 0.0

    it = 0
    while True:
        it += 1
        alive = np.zeros(P, dtype=bool)
        for st in S:
            alive |= st["ph"] != 2
        if horizon_events is not None:
            alive &= nev < horizon_events
        if horizon_time is not None:
            alive &= t < horizon_time
        A = np.where(alive)[0]
        if len(A) == 0 or it > max_iter:
            break
        m = kmid[A] * h
        gA = g[A]
        if first_wait is not None and it == 1:
            w = np.full(len(A), float(first_wait))
        else:
            w = rng.exponential(1.0 / lam, size=len(A))
            if paired is not None:
                pa = pend[A] != 0
                w = np.where(pa, rng.exponential(paired["delay"], size=len(A)), w)
        pendA = pend[A].copy()
        # stop exactly AT the horizon (not just after the next mid change, when the slow price
        # is a full step behind): truncate the last interval and skip its step
        over = np.zeros(len(A), dtype=bool)
        if horizon_time is not None:
            over = t[A] + w > horizon_time
            w = np.where(over, horizon_time - t[A], w)

        for lg, st in zip(legs, S):
            sd = lg.side
            own_m = m if sd > 0 else 1.0 - m
            own_g = gA * sd                                   # own mid - own slow
            ph = st["ph"][A]
            t_used = np.zeros(len(A))                          # time within the interval already used
            # ---------- open positions: take profit while the slow price catches up ----------
            op = ph == 1
            if op.any():
                J = np.where(op)[0]
                ii = A[J]
                lag = np.maximum(own_g[J], 0.0)                # own realizable = own_m - lag*decay(t)
                tgt_now = st["target"][ii]
                if lg.tp_converge:
                    dyn = np.minimum(st["capp"][ii], own_m[J] - lg.tp_eps * tick)
                    tgt_now = np.where(own_m[J] >= st["level"][ii] - 1e-12, dyn, np.inf)
                need = own_m[J] - tgt_now                      # exit when lag*decay(t) <= need
                now = lag <= need + 1e-15
                later = (~now) & (need > 1e-15)
                ts = np.full(len(J), np.inf)
                ts[later] = t_reach(need[later] / lag[later])
                ex = now | (ts <= w[J])
                if ex.any():
                    Je = J[ex]
                    ie = A[Je]
                    te = np.where(now[ex], 0.0, ts[ex])
                    price = np.where(now[ex], own_m[Je] - lag[ex], tgt_now[ex])
                    # crowding accrual up to the exit time
                    if lg.crowd_rate > 0:
                        B = st["n"][ie] * (1 - 1 / st["L"][ie])
                        st["acc"][ie] += B * lg.crowd_rate * (1 - own_m[Je]) * te
                    st["lagcost"][ie] += st["n"][ie] * (own_m[Je] - price)
                    settle(st, lg, ie, price, "tp", t[ie] + te, own_mid=own_m[Je])
                    t_used[Je] = te
                # crowding accrual / free reset for those still open through the interval
                if lg.crowd_rate > 0:
                    Jk = J[~ex]
                    ik = A[Jk]
                    if len(ik):
                        B = st["n"][ik] * (1 - 1 / st["L"][ik])
                        st["acc"][ik] += B * lg.crowd_rate * (1 - own_m[Jk]) * w[Jk]
                        if lg.crowd_reset:
                            gend = np.abs(own_g[Jk]) * decay(w[Jk])
                            at_entry = np.abs(own_m[Jk] - st["entry"][ik]) < 1e-12
                            rs = at_entry & (gend <= lg.reset_eps * tick)
                            ir = ik[rs]
                            st["acc"][ir] = 0.0                # close at ~0 P&L and re-open: accrual gone
                            st["pnl"][ir] -= st["n"][ir] * gend[rs]
                            st["nreset"][ir] += 1
            # ---------- flat: enter when the adverse gap is small enough ----------
            fl = (st["ph"][A] == 0) & (t[A] + w >= burn_time)
            if fl.any():
                J = np.where(fl)[0]
                ii = A[J]
                Lv = lg.lev[kmid[ii]]
                tpk = lg.tpk[kmid[ii]]
                ok = Lv > 0
                if lg.follow:
                    ok &= pendA[J] * sd > 0
                adverse = np.maximum(-own_g[J], 0.0)           # own slow - own mid (entry cost)
                eps = lg.eps_in * tick
                tstart = np.maximum(t_used[J], np.maximum(burn_time - t[ii], 0.0))
                adv_s = adverse * decay(tstart)
                te = np.where(adv_s <= eps, tstart,
                              tstart + (t_reach(eps / np.maximum(adv_s, 1e-300)) if np.isfinite(eps) else 0.0))
                adv_e = adverse * decay(te)
                gap_e = np.abs(own_g[J]) * decay(te)
                ok &= te <= w[J]
                entry = own_m[J] + adv_e
                nn = np.where(Lv > 0, Lv / np.where(entry > 0, entry, 1.0), 0.0)
                ok &= gap_e <= max_gap + 1e-12
                ok &= nn * adv_e <= max_entry_loss + 1e-12
                if ok.any():
                    Jo = J[ok]
                    io = A[Jo]
                    e = entry[ok]
                    L = Lv[ok]
                    n_ = L / e
                    C_ = (1 - e) / e
                    st["entry"][io] = e
                    st["entry_mid"][io] = own_m[Jo]
                    st["n"][io] = n_
                    st["C"][io] = C_
                    st["L"][io] = L
                    cap_price = e + (1 - e) / L
                    tgt = np.where(np.isfinite(tpk[ok]), own_m[Jo] + tpk[ok] * h, cap_price) - lg.tp_eps * tick
                    st["target"][io] = np.minimum(tgt, cap_price)
                    st["capp"][io] = cap_price
                    st["level"][io] = np.where(np.isfinite(tpk[ok]), own_m[Jo] + tpk[ok] * h, cap_price)
                    m_eff = maint if liq_buffer_ticks is None else np.maximum(maint, n_ * liq_buffer_ticks * tick)
                    st["liqp"][io] = e - (1 - m_eff) / n_
                    st["slp"][io] = -np.inf if lg.sl_k is None else own_m[Jo] - lg.sl_k * h
                    st["topen"][io] = t[io] + te[ok]
                    st["acc"][io] = 0.0
                    st["entry_cost"][io] += n_ * adv_e[ok]
                    st["ph"][io] = 1
                    if lg.crowd_rate > 0:
                        B = n_ * (1 - 1 / L)
                        st["acc"][io] += B * lg.crowd_rate * (1 - own_m[Jo]) * (w[Jo] - te[ok])

        # ---------- the mid changes ----------
        u = rng.random(len(A))
        s = steps[np.searchsorted(cum, u, side="right").clip(0, len(steps) - 1)]
        if first_up_prob is not None and it == 1:
            s = np.where(rng.random(len(A)) < first_up_prob, 1, -1)
        if paired is not None:
            fresh = pendA == 0
            first = np.where(rng.random(len(A)) < 0.5, 1, -1)
            second = np.where(rng.random(len(A)) < paired["rho"], pendA, -pendA)
            s = np.where(fresh, first, second)
            pend[A] = np.where(fresh, first, 0)
        s = np.where(over, 0, s)
        if paired is not None:
            pend[A] = np.where(over, pendA, pend[A])
        knew = kmid[A] + s
        bad = (knew < kmin) | (knew > kmax)
        s = np.where(bad, 0, s)
        knew = kmid[A] + s
        # stale-price "last look": close at the worse-of price from BEFORE an adverse change
        for lg, st in zip(legs, S):
            if lg.lastlook <= 0:
                continue
            op = (st["ph"][A] == 1) & (s * lg.side < 0) & (rng.random(len(A)) < lg.lastlook)
            if op.any():
                J = np.where(op)[0]
                ii = A[J]
                m_old = kmid[ii] * h
                own_m_old = m_old if lg.side > 0 else 1.0 - m_old
                lag_old = np.maximum(gA[J] * decay(w[J]) * lg.side, 0.0)
                price = own_m_old - lag_old
                if lg.crowd_rate > 0:
                    pass
                st["lagcost"][ii] += st["n"][ii] * lag_old
                settle(st, lg, ii, price, "tp", t[ii] + w[J], own_mid=own_m_old)
        gA = gA * decay(w) + s * h
        t[A] += w
        if horizon_time is not None:
            t[A] = np.where(over, horizon_time, t[A])
        nev[A] += (~over).astype(np.int64)
        kmid[A] = knew
        g[A] = gA
        m = knew * h
        for lg, st in zip(legs, S):
            sd = lg.side
            own_m = m if sd > 0 else 1.0 - m
            own_g = gA * sd
            op = st["ph"][A] == 1
            if not op.any():
                continue
            J = np.where(op)[0]
            ii = A[J]
            lq = own_m[J] <= st["liqp"][ii] + 1e-12
            if lq.any():
                settle(st, lg, ii[lq], own_m[J][lq], "liq", t[ii[lq]], own_mid=own_m[J][lq])
            rest = ~lq
            sl = rest & (own_m[J] <= st["slp"][ii] + 1e-12)
            if sl.any():
                price = own_m[J][sl] - np.maximum(own_g[J][sl], 0.0)
                settle(st, lg, ii[sl], price, "sl", t[ii[sl]], own_mid=own_m[J][sl])

    out = []
    for lg, st in zip(legs, S):
        if settle_at_end:                      # close whatever is still open at the worse-of price
            ii = np.where(st["ph"] == 1)[0]
            if len(ii):
                m_ = kmid[ii] * h
                own_m_ = m_ if lg.side > 0 else 1.0 - m_
                own_g_ = g[ii] * lg.side
                st["open_end_n"] = len(ii)
                st["lagcost"][ii] += st["n"][ii] * np.maximum(own_g_, 0.0)
                settle(st, lg, ii, own_m_ - np.maximum(own_g_, 0.0), "tp", t[ii], own_mid=own_m_)
        st["t_end"] = t.copy()
        st["nev"] = nev.copy()
        st["open_at_end"] = st["ph"] == 1
        out.append(st)
    return out


def stat(x):
    x = np.asarray(x, dtype=float)
    return x.mean(), x.std(ddof=1) / np.sqrt(len(x))


def table_const(h, value):
    """a table over lattice indices 0..1/h filled with `value`."""
    return np.full(int(round(1.0 / h)) + 1, float(value))


if __name__ == "__main__":
    # self-check against the exact lattice value in the limit of a very slow market
    from lattice import lattice_value, regime
    h, st_, pr = regime("full")
    for p0, L, tp in [(0.5, 25, np.inf), (0.5, 10, np.inf), (0.2, 10, np.inf), (0.26, 10, 7), (0.18, 7, 11)]:
        leg = Leg(+1, table_const(h, L), table_const(h, tp), tp_eps=0.001)
        r = run(200_000, int(round(p0 / h)), h, st_, pr, lam=1e-6, legs=[leg], seed=1)[0]
        mu, se = stat(r["pnl"])
        ex = lattice_value(p0, L, h, st_, pr, policy="hold" if not np.isfinite(tp) else "tp",
                           tp_k=None if not np.isfinite(tp) else tp)
        print(f"p0={p0} L={L} tp={tp}: MC EV {mu:+.4f} +- {se:.4f} | exact {ex['ev']:+.4f} | "
              f"P(win) {r['nwin'].mean():.4f} vs {ex['p_win']:.4f}")
