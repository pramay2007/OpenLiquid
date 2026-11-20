"""In-play engines shared by scripts b, c and d.

sim_multi  : positions opened pre-game and carried into play (a 1x holder, or a leveraged
             position the keeper failed to force-close).  Several configurations are evaluated
             on the SAME simulated matches in one pass.  Optional R6 'last look': when the
             reference price drops against the holder, with probability phi the holder's close
             lands at the pre-goal signed price before the keeper's relay.
sim_harvest: hypothetical in-play free-mode leverage with re-opening (drift harvesting).

Order of events inside one step of dt seconds:
  1. the score may change; the slow price advances toward the mid that prevailed
  2. crowding fee accrues on open positions (profit only, charged at settlement)
  3. the new mid is published; then, in order: last-look close (stale feed), liquidation at
     the mid, collect at the close price, keeper force-close
"""
import numpy as np
from ol import (Pos, ltime, net_close, net_liq, MAINT, TAU_SLOW, TAU_FLOOR, MAX_GAP, LCAP)


def cfg(side_yes, L, skew=0.0, pre_fee=0.0, keeper_at=None, liq_before="keeper", phi=0.0,
        min_drop=0.05, liq_1x=True, label=""):
    """keeper_at: seconds after kick-off at which the keeper force-closes L>1 positions
    (None = never).  liq_before: who liquidates before keeper_at ('keeper', 'third', 'none');
    from keeper_at on the keeper liquidates.  'third' = outside liquidators, who act only
    when the reward min(5% M, equity) is positive."""
    return dict(side_yes=side_yes, L=float(L), skew=skew, pre_fee=pre_fee, keeper_at=keeper_at,
                liq_before=liq_before, phi=phi, min_drop=min_drop, liq_1x=liq_1x, label=label)


def sim_multi(match, configs, N, seed, fee_tau=TAU_FLOOR):
    rng = np.random.default_rng(seed)
    rng2 = np.random.default_rng(seed + 10_007)
    K, dt = match.K, match.dt
    decay = np.exp(-dt / TAU_SLOW)
    d = np.zeros(N, np.int64)
    mid_prev = np.full(N, match.mid0)
    slow = mid_prev.copy()
    st = []
    for c in configs:
        s0 = match.mid0 if c["side_yes"] else 1 - match.mid0
        st.append(dict(c=c, pos=Pos(s0, c["L"]), s0=s0, alive=np.ones(N, bool),
                       fee=np.full(N, float(c["pre_fee"])), pnl=np.zeros(N), liqpaid=np.zeros(N),
                       kind=np.zeros(N, np.int8), n_alive=N))
    for k in range(K):
        d, _ = match.evolve(d, rng)
        t = (k + 1) * dt
        slow = mid_prev + (slow - mid_prev) * decay
        last = k + 1 == K
        if last:
            out = match.outcome(d, rng)
        else:
            mid = match.mid(k + 1, d)
        for s in st:
            if s["n_alive"] == 0:
                continue
            c, pos, s0, alive = s["c"], s["pos"], s["s0"], s["alive"]
            yes = c["side_yes"]
            s_prev = mid_prev if yes else 1 - mid_prev
            if c["skew"] > 0 and pos.borrowed > 0:
                s["fee"] += alive * (pos.borrowed * c["skew"] * dt / fee_tau) * (1 - s_prev)
            if last:
                win = (out == 1) if yes else (out == 0)
                net = net_close(np.where(win, pos.C, -1.0), s["fee"])
                s["pnl"][alive] = net[alive]
                s["kind"][alive] = 5
                s["n_alive"] = 0
                continue
            s_mid = mid if yes else 1 - mid
            s_slow = slow if yes else 1 - slow
            if c["phi"] > 0:
                ll = alive & (s_prev - s_mid >= c["min_drop"])
                if ll.any():
                    idx = np.flatnonzero(ll)
                    idx = idx[rng2.random(idx.size) < c["phi"]]
                    if idx.size:
                        cp_stale = np.minimum(s_prev[idx], s_slow[idx])   # stale mid; slow advanced toward it
                        net = net_close(np.clip(pos.n * (cp_stale - s0), -1.0, pos.C), s["fee"][idx])
                        s["pnl"][idx] = net
                        s["kind"][idx] = 1
                        alive[idx] = False
            keeper_on = c["keeper_at"] is not None and t >= c["keeper_at"]
            mode = "keeper" if keeper_on else c["liq_before"]
            if mode != "none" and not (c["L"] == 1 and not c["liq_1x"]):
                res_mid = np.clip(pos.n * (s_mid - s0), -1.0, pos.C)
                lq = alive & (res_mid <= MAINT - 1.0)
                if mode == "third":
                    lq &= res_mid > -1.0
                if lq.any():
                    net, lf = net_liq(res_mid[lq])
                    s["pnl"][lq] = net
                    s["liqpaid"][lq] = lf
                    s["kind"][lq] = 2
                    alive &= ~lq
            if c["L"] > 1:
                cp = np.minimum(s_mid, s_slow)
                co = alive & (pos.n * (cp - s0) >= pos.C - 1e-12)
                if co.any():
                    s["pnl"][co] = net_close(np.full(int(co.sum()), pos.C), s["fee"][co])
                    s["kind"][co] = 3
                    alive &= ~co
                if keeper_on and alive.any():
                    net = net_close(np.clip(pos.n * (cp[alive] - s0), -1.0, pos.C), s["fee"][alive])
                    s["pnl"][alive] = net
                    s["kind"][alive] = 4
                    alive[:] = False
            s["n_alive"] = int(alive.sum())
        if not last:
            mid_prev = mid
    return [dict(label=s["c"]["label"], pnl=s["pnl"], house=-s["pnl"] - s["liqpaid"], kind=s["kind"],
                 cfg=s["c"]) for s in st]


def sim_harvest(match, N, seed, Lcap=5.0, use_ltime=False, skew=1.0, min_L=2.0, entry_tol=0.005,
                start=0.0, tau_floor=TAU_FLOOR, policy=None):
    """Hypothetical: free-mode leverage may be opened in play.  Strategy: whenever flat, open
    the side whose price rises while nobody scores, at the maximum allowed leverage; never close
    voluntarily (collect at the cap, liquidation by the keeper, settlement at the whistle).
    Leverage: floor(min(Lcap, min(p,1-p)/0.02 [, Ltime with tau = time to the final whistle])).
    Crowding fee: borrowed * skew * (1 - s) / max(time to final whistle, tau_floor) per second."""
    rng = np.random.default_rng(seed)
    K, dt, T = match.K, match.dt, match.T
    decay = np.exp(-dt / TAU_SLOW)
    d = np.zeros(N, np.int64)
    mid_prev = np.full(N, match.mid0)
    slow = mid_prev.copy()
    has = np.zeros(N, bool)
    yes = np.zeros(N, bool)
    s0 = np.full(N, 0.5); L = np.ones(N); nsh = np.ones(N); C = np.ones(N); borrowed = np.zeros(N)
    fee = np.zeros(N)
    cum = np.zeros(N); liqpaid = np.zeros(N)
    n_open = np.zeros(N); n_collect = np.zeros(N); n_liq = np.zeros(N)
    fee_paid = np.zeros(N)
    for k in range(K):
        d, _ = match.evolve(d, rng)
        t = (k + 1) * dt
        slow = mid_prev + (slow - mid_prev) * decay
        s_prev = np.where(yes, mid_prev, 1 - mid_prev)
        tau_fee = max(T - k * dt, tau_floor)
        if skew > 0:
            fee += has * (borrowed * skew * (1 - s_prev) * dt / tau_fee)
        if k + 1 == K:
            out = match.outcome(d, rng)
            win = (out == 1) == yes
            res = np.where(win, C, -1.0)
            cum += has * net_close(res, fee)
            fee_paid += has * np.minimum(fee, np.maximum(res, 0))
            break
        mid = match.mid(k + 1, d)
        s_mid = np.where(yes, mid, 1 - mid)
        s_slow = np.where(yes, slow, 1 - slow)
        res_mid = np.clip(nsh * (s_mid - s0), -1.0, C)
        lq = has & (1 + res_mid <= MAINT)
        if lq.any():
            net, lf = net_liq(res_mid)
            cum += lq * net; liqpaid += lq * lf; n_liq += lq
            has &= ~lq
        cp = np.minimum(s_mid, s_slow)
        co = has & (nsh * (cp - s0) >= C - 1e-12)
        if co.any():
            cum += co * net_close(C, fee); n_collect += co
            fee_paid += co * np.minimum(fee, C)
            has &= ~co
        if use_ltime:
            lim = np.maximum(1.0, np.floor(np.minimum(LCAP, ltime(mid, T - t)) + 1e-9))
            fc = has & (L > lim)
            if fc.any():
                res = np.clip(nsh * (cp - s0), -1.0, C)
                cum += fc * net_close(res, fee)
                fee_paid += fc * np.minimum(fee, np.maximum(res, 0))
                has &= ~fc
        if t >= start and k + 2 <= K:
            drift_yes = match.fair(k + 2, d) - match.fair(k + 1, d)
            want_yes = drift_yes > 0
            if policy is not None:      # state-selective harvester: 0 = stay flat, 1 = YES, 2 = NO
                choice = policy[k + 1, d + match.dmax]
                want_yes = choice == 1
                drift_yes = np.where(choice == 0, 0.0, 1.0)
            sm = np.where(want_yes, mid, 1 - mid)
            ss = np.where(want_yes, slow, 1 - slow)
            entry = np.maximum(sm, ss)
            m = np.minimum(mid, 1 - mid)
            Lnew = np.minimum(Lcap, m / 0.02)
            if use_ltime:
                Lnew = np.minimum(Lnew, ltime(mid, T - t))
            Lnew = np.floor(Lnew + 1e-9)
            ok = (~has) & (np.abs(mid - slow) <= MAX_GAP) & (Lnew >= min_L) & (entry - sm <= entry_tol) \
                & (drift_yes != 0) & (mid > 0.011) & (mid < 0.989)
            if ok.any():
                s0 = np.where(ok, entry, s0); L = np.where(ok, Lnew, L); yes = np.where(ok, want_yes, yes)
                nsh = np.where(ok, L / s0, nsh); C = np.where(ok, (1 - s0) / s0, C)
                borrowed = np.where(ok, nsh * (1 - 1 / L), borrowed)
                fee = np.where(ok, 0.0, fee)
                has |= ok; n_open += ok
        mid_prev = mid
    return dict(pnl=cum, house=-cum - liqpaid, n_open=n_open, n_collect=n_collect, n_liq=n_liq,
                fee_paid=fee_paid)


def cycle_ev(match, k, d, side_yes, Lcap, skew, tau_floor=TAU_FLOOR):
    """Expected net P&L (per $1 margin) of ONE free-mode position opened at step k with score
    difference d on the given side at leverage floor(min(Lcap, min(p,1-p)/0.02)), held until
    it is collected, liquidated, hit by a score, or settled.  A score is valued at the
    post-score mid (capped at C; liquidation rule applied).  Used only to choose WHEN the
    harvester opens; the Monte Carlo then plays the rules exactly."""
    V, dmax, K, dt, T = match.V, match.dmax, match.K, match.dt, match.T

    def mid_at(j, dd):
        return float(min(max(round(V[j, dd + dmax] * 100) / 100, 0.01), 0.99))

    def side(x):
        return x if side_yes else 1 - x

    p = mid_at(k, d)
    if p <= 0.011 or p >= 0.989:
        return None
    L = np.floor(min(Lcap, min(p, 1 - p) / 0.02) + 1e-9)
    if L < 2:
        return None
    pos = Pos(side(p), float(L))
    s0 = pos.s0
    decay = np.exp(-dt / TAU_SLOW)
    p_none = 1.0 - sum(pr for pr, _ in match.probs)
    surv, ev, fee = 1.0, 0.0, 0.0
    slow, mid_prev = p, p
    for j in range(k + 1, K + 1):
        fee += pos.borrowed * skew * (1 - side(mid_prev)) * dt / max(T - (j - 1) * dt, tau_floor)
        slow = mid_prev + (slow - mid_prev) * decay
        for pr, size in match.probs:
            dd = int(min(max(d + size, -dmax), dmax))
            if j == K:
                v = V[K, dd]
                v = v if side_yes else 1 - v
                pay = v * float(net_close(pos.C, fee)) + (1 - v) * (-1.0)
            else:
                res = float(np.clip(pos.n * (side(mid_at(j, dd)) - s0), -1.0, pos.C))
                pay = float(net_liq(res)[0]) if 1 + res <= MAINT else float(net_close(res, fee))
            ev += surv * pr * pay
        surv *= p_none
        if j == K:
            v = V[K, d + dmax]
            v = v if side_yes else 1 - v
            ev += surv * (v * float(net_close(pos.C, fee)) + (1 - v) * (-1.0))
            break
        mid = mid_at(j, d)
        s_mid, s_slow = side(mid), side(slow)
        res_mid = float(np.clip(pos.n * (s_mid - s0), -1.0, pos.C))
        if 1 + res_mid <= MAINT:
            ev += surv * float(net_liq(res_mid)[0])
            break
        if pos.n * (min(s_mid, s_slow) - s0) >= pos.C - 1e-12:
            ev += surv * float(net_close(pos.C, fee))
            break
        mid_prev = mid
    return ev


def build_policy(match, Lcap, skew, tau_floor=TAU_FLOOR, thr=0.02, drange=3):
    """policy[k, d+dmax] in {0 flat, 1 open YES, 2 open NO}: open the better side when its
    one-cycle expected value exceeds thr."""
    pol = np.zeros((match.K + 1, 2 * match.dmax + 1), np.int8)
    best = np.full((match.K + 1, 2 * match.dmax + 1), np.nan)
    for k in range(1, match.K - 1):
        for d in range(-drange, drange + 1):
            ey = cycle_ev(match, k, d, True, Lcap, skew, tau_floor)
            en = cycle_ev(match, k, d, False, Lcap, skew, tau_floor)
            ey = -9.0 if ey is None else ey
            en = -9.0 if en is None else en
            e = max(ey, en)
            best[k, d + match.dmax] = e
            if e > thr:
                pol[k, d + match.dmax] = 1 if ey >= en else 2
    return pol, best
