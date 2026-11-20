"""
OpenLiquid event-market rule simulator for the drift-harvest stress test.

Everything is expressed in the position's own side price p_s (the drifting side: the NO side of a
"will X happen before T" market).  The harvester keeps one free-mode position of margin M = 1 open
on that side at (up to) the maximum leverage the rules allow, and re-opens after every close.

Rules modelled exactly as written in the brief:
  R1  worse-of fills: open (buy side shares) at max(mid, slow); close (sell) at min(mid, slow).
      slow += (prevMid - slow) * dt/(tau+dt) on each update (tau = 300 s).  One on-chain update per
      simulation step is assumed (the keeper relays every mid change; a trader may submit any newer
      signed price).  slow_mode='exp' uses the deployed contract's exact exponential instead.
  R2  opens refused while |mid - slow| > 0.05.
  R4  isolated margin; liquidation when equity at the MID <= 20% of M; liquidator takes 5% of M out
      of the remaining equity; rest returns to the trader.
  R7  no open/close fee; 10% profit share on net profit at close (after the crowding fee).
  E1  n = M*L/p0.
  E2  free mode: P&L = clamp(n*(p-p0), -M, C), C = M*(1-p0)/p0; collect() by anyone once the close
      price P&L reaches C.
  E3  L <= min(50, min(p,1-p)/0.02, Ltime), Ltime = min(p,1-p)/(3*sqrt(p(1-p)*120/tau)); positions
      with L > current Ltime are force-closed at the normal close price (keeper assumed live).
  E4  crowding fee accrues per second = borrowedShares * skewFrac * (1-p_s)/max(tau, 3600), taken
      only from the position's profit at close; a position closed at <= 0 pays nothing.
The reference mid is the fair probability rounded to the 1-cent tick.

Market model (exact martingale): two hidden states for the hazard (H with prob pi0, L otherwise),
hazard active only on [0, T_true] (T_true <= contract horizon T), optional Brownian signal about the
state (kappa) that makes the price diffuse.  pi0 = 1 gives the constant-hazard model
p_s = exp(-lambda * tau).
"""
import math
import numpy as np

DAY = 86400.0


def lev_limit(mid, tau, h=120.0, lmax=50.0):
    """E3 leverage limit and Ltime, evaluated at the mid."""
    mid = np.asarray(mid, dtype=float)
    mm = np.minimum(mid, 1.0 - mid)
    if tau <= 0:
        z = np.zeros_like(mid)
        return z, z
    var = np.maximum(mid * (1.0 - mid) * h / tau, 1e-300)
    ltime = mm / (3.0 * np.sqrt(var))
    L = np.minimum(np.minimum(lmax, mm / 0.02), ltime)
    return L, ltime


def simulate(N=200_000, seed=1, T=30 * DAY, T_true=None, p0=0.5, lamH=None, lamL=0.0, pi0=1.0,
             kappa=0.0, tick=0.01, tau_slow=300.0, slow_mode="rule", dt=300.0, H=5 * DAY,
             strategy="cap", fee_mode="E4", sf=1.0, entry_ticks=0.0, carry=False, T_fee=None,
             Lcap=np.inf, Lmin=1.05, int_lev=False, share=0.10, reset_every=3600.0,
             tol_gap=1e-4, reset_gap=1e-7, reset_tol=1.0, liq_thr=0.2, liq_fee=0.05, max_gap=0.05,
             max_opens=None, fee_tick=0.01, tau_floor=3600.0, self_liq=False, lev1_drift=False,
             price_fee=0.0, return_paths=False, stratified=False, phase_random=False,
             e3_time=True, hold_ticks=1, plan=True, plan_buffer=None, record=False):
    """
    strategy: 'cap'  = open max leverage, hold until collect()/liquidation/force-close, re-open.
              'bank' = same position, but (a) close and re-open as soon as it shows a profit and the
                       slow price has caught up (bank every tick), and (b) while it shows no profit,
                       close and re-open every `reset_every` seconds (sheds the accrued crowding fee
                       because a position closed at <= 0 pays nothing).
              'one'  = unleveraged benchmark (L = 1), held for the window.
              'snipe'= stay flat; when the reference mid ticks up, open at the PREVIOUS mid (a signed
                       price still inside the 20 s validity window, submitted before the keeper's
                       relay lands), bank once the slow price has caught up, go flat again.
    phase_random: start the fair value uniformly inside the starting tick (no tick-phase luck).
    e3_time: False switches off the Ltime part of E3 (used only to show what E3 is worth).
    fee_mode: 'none' | 'E4'.
    entry_ticks: proposed fix - extra crowding charge of entry_ticks * 1 tick per borrowed share
                 * skewFrac at open, still payable from profit only.
    carry: proposed fix - unpaid accrued crowding fee is carried to the same account's next position.
    price_fee: proposed fix - fraction of the profit on BORROWED shares taken (times sf), i.e. a
               charge in price space rather than time space.
    T_fee: horizon the fee formula uses (default: contract horizon T).
    Returns a dict of summary statistics (and per-path arrays if return_paths).
    """
    rng = np.random.default_rng(seed)
    if T_true is None:
        T_true = T
    if T_fee is None:
        T_fee = T
    two = pi0 < 1.0
    lam_arr = None
    if lamH is None:  # constant hazard calibrated to the starting price
        two = False
        if phase_random and tick > 0:
            v0 = p0 + (rng.random(N) - 0.5) * tick
            if stratified:
                v0 = p0 + (((np.arange(N) * 0.6180339887498949) % 1.0) - 0.5) * tick
            if record:  # N phase classes, evenly spread across the starting tick
                v0 = p0 + ((np.arange(N) + 0.5) / N - 0.5) * tick
            lam_arr = -np.log(v0) / T_true
            lamH = float(lam_arr.mean())
        else:
            lamH = -math.log(p0) / T_true
        lamL = lamH
    theta = (rng.random(N) < pi0) if two else np.ones(N, dtype=bool)
    lam_path = np.where(theta, lamH, lamL) if lam_arr is None else lam_arr
    e = rng.exponential(1.0, N)
    if stratified:  # quasi-exact expectation over the crash time (midpoint quantiles)
        e = -np.log(1.0 - (np.arange(N) + 0.5) / N)
    tc = np.full(N, np.inf)
    okl = lam_path > 0
    tc[okl] = e[okl] / lam_path[okl]
    tc[tc > T_true] = np.inf
    if record:  # no crashes: the no-crash trajectory of each phase class is recorded step by step
        tc[:] = np.inf
    snaps = []

    l0 = math.log(pi0 / (1.0 - pi0)) if two else None
    Y = np.zeros(N) if (two and kappa > 0) else None

    def fair(t):
        rem = max(T_true - t, 0.0)
        a = math.exp(-lamH * rem)
        c = math.exp(-lamL * rem)
        if not two:
            if lam_arr is not None:
                return np.exp(-lam_arr * rem), (lam_arr if t < T_true else np.zeros(N))
            return np.full(N, a), (lamH if t < T_true else 0.0) * np.ones(1)
        l = l0 - (lamH - lamL) * min(t, T_true)
        if Y is not None:
            l = l + kappa * Y - 0.5 * kappa * kappa * t
            pi = 1.0 / (1.0 + np.exp(-l))
        else:
            pi = np.full(N, 1.0 / (1.0 + math.exp(-l)))
        v = pi * a + (1.0 - pi) * c
        # crash intensity conditional on public information (the drift of v on survival is hz*v)
        hz = (pi * lamH + (1.0 - pi) * lamL) if t < T_true else np.zeros(N)
        return v, hz

    def to_mid(v):
        if tick > 0:
            return np.clip(np.rint(v / tick) * tick, tick, 1.0 - tick)
        return np.clip(v, 1e-9, 1.0 - 1e-9)

    w_slow = dt / (tau_slow + dt) if slow_mode == "rule" else 1.0 - math.exp(-dt / tau_slow)

    alive = np.ones(N, dtype=bool)
    pos = np.zeros(N, dtype=bool)
    P0 = np.zeros(N); Lv = np.ones(N); nsh = np.zeros(N); bsh = np.zeros(N); Cap = np.zeros(N)
    F = np.zeros(N); efee = np.zeros(N); debt = np.zeros(N); topen = np.zeros(N)
    pnl = np.zeros(N); mtime = np.zeros(N); feepaid = np.zeros(N); pshare = np.zeros(N)
    liqcut = np.zeros(N); gapcost = np.zeros(N); feeacc = np.zeros(N)
    nopen = np.zeros(N); nreset = np.zeros(N); nliq = np.zeros(N); ncrash = np.zeros(N)
    nwin = np.zeros(N); grosswin = np.zeros(N)

    t = 0.0
    v, hz = fair(t)
    mid = to_mid(v)
    slow = mid.copy()

    def settle(mask, r):
        idx = np.flatnonzero(mask)
        if idx.size == 0:
            return
        rr = r[idx]
        win = rr > 1e-12
        owed = F[idx] + efee[idx] + debt[idx]
        if price_fee > 0:
            # price-space charge: share of the profit earned on borrowed shares
            owed = owed + price_fee * sf * (1.0 - 1.0 / np.maximum(Lv[idx], 1.0)) * np.maximum(rr, 0.0)
        fee = np.where(win, np.minimum(owed, rr), 0.0)
        net = np.where(win, rr - fee, 0.0)
        ps = share * net
        pnl[idx] += np.where(win, net - ps, np.minimum(rr, 0.0))
        feepaid[idx] += fee
        pshare[idx] += ps
        nwin[idx] += win
        grosswin[idx] += np.where(win, rr, 0.0)
        if carry:
            debt[idx] = owed - fee
        pos[idx] = False

    def do_open(mask, ref_mid=None):
        nonlocal nopen
        tau_now = T - t
        if tau_now <= 0:
            return
        idx = np.flatnonzero(mask & alive & ~pos)
        if max_opens is not None and idx.size:
            idx = idx[nopen[idx] < max_opens]
        if idx.size == 0:
            return
        om = (mid if ref_mid is None else ref_mid)[idx]  # on-chain mid the open is priced against
        sl = slow[idx]
        Lr, _ = lev_limit(om, tau_now)
        if not e3_time:
            Lr = np.minimum(50.0, np.minimum(om, 1.0 - om) / 0.02)
        L_ = np.minimum(Lr, Lcap)
        if plan and e3_time and strategy in ("cap", "bank", "snipe"):
            # A position above the current Ltime is force-closed at the worse-of close price, so the
            # harvester sizes leverage to stay inside Ltime until its planned exit (Ltime shrinks
            # with sqrt(tau) and with the price moving away from 0.5).
            hzv = np.maximum(hz[idx] if hz.size > 1 else hz[0], 1e-12)
            buf = (4.0 * tau_slow + 2.0 * dt) if plan_buffer is None else plan_buffer
            tk = tick if tick > 0 else 0.01
            for _ in range(12):
                Ls = np.maximum(L_, 1.0)
                if strategy == "cap":
                    target = om + (1.0 - om) / Ls
                else:
                    target = np.minimum(om + hold_ticks * tk, om + (1.0 - om) / Ls)
                target = np.minimum(target, 0.995)
                if strategy == "snipe":
                    Dh = buf
                else:
                    Dh = (np.log(target / om) + 0.5 * tk / om) / hzv + buf
                tau_end = tau_now - Dh
                mm = np.minimum(target, 1.0 - target)
                lt_end = np.where(tau_end > 0, mm / (3.0 * np.sqrt(target * (1.0 - target) * 120.0
                                                                   / np.maximum(tau_end, 1e-9))), 0.0)
                L_new = np.minimum(L_, lt_end)
                done = np.allclose(L_new, L_, rtol=1e-6, atol=1e-9)
                L_ = L_new
                if done:
                    break
        if strategy == "one":
            L_ = np.ones(idx.size)
        if int_lev:
            L_ = np.floor(L_ + 1e-9)
        if lev1_drift:
            L_ = np.minimum(L_, 1.0)
        ok = (np.abs(om - sl) <= max_gap + 1e-12) & (om >= 0.01 - 1e-12) & (om <= 0.99 + 1e-12)
        ok &= (L_ >= (1.0 if strategy == "one" else Lmin))
        if not ok.any():
            return
        j = idx[ok]
        Lj = L_[ok]
        fill = np.maximum(om, sl)[ok]
        bnew = (Lj - 1.0) / fill
        P0[j] = fill
        Lv[j] = Lj
        nsh[j] = Lj / fill
        bsh[j] = bnew
        Cap[j] = (1.0 - fill) / fill
        F[j] = 0.0
        efee[j] = (bnew * sf * fee_tick * entry_ticks) if fee_mode == "E4" else 0.0
        topen[j] = t
        nopen[j] += 1
        pos[j] = True

    if strategy != "snipe":
        do_open(alive.copy())
    nsteps = int(round(H / dt))
    def snap():
        hzv = hz if hz.size > 1 else np.full(N, hz[0])
        return np.stack([pnl, mtime, feepaid, feeacc, gapcost, pshare, liqcut, nopen, nreset, nliq, nwin,
                         grosswin, pos.astype(float), np.where(pos, bsh * mid * hzv, 0.0)])

    for _ in range(nsteps):
        if record:
            snaps.append(snap())
        t1 = t + dt
        # 1. crash inside (t, t1]: price jumps to ~0, the position loses exactly its margin
        cr = alive & (tc <= t1)
        if cr.any():
            lose = cr & pos
            pnl[lose] -= 1.0
            mtime[lose] += tc[lose] - t
            gapcost[lose] += bsh[lose] * mid[lose] * hz[lose if hz.size > 1 else 0] * (tc[lose] - t)
            ncrash += lose
            pos = pos & ~cr
            alive = alive & ~cr
        # 2. accrual over the step for surviving positions
        tau_mid = max(T_fee - (t + 0.5 * dt), 0.0)
        tau_eff = max(tau_mid, tau_floor)
        acc = np.where(pos, bsh * sf * (1.0 - mid) / tau_eff * dt, 0.0)
        feeacc += acc
        if fee_mode == "E4":
            F += acc
        mtime += np.where(pos, dt, 0.0)
        gapcost += np.where(pos, bsh * mid * (hz if hz.size > 1 else hz[0]) * dt, 0.0)
        # 3. new reference price; slow price update (prev mid held over the step)
        if Y is not None:
            Y += kappa * theta * dt + math.sqrt(dt) * rng.standard_normal(N)
        t = t1
        v, hz = fair(t)
        new_mid = to_mid(v)
        slow = slow + (mid - slow) * w_slow
        mid_prev = mid
        mid = new_mid
        # 4. position management
        tau_now = T - t
        cp = np.minimum(mid, slow)
        raw = nsh * (cp - P0)
        eq_mid = 1.0 + np.clip(nsh * (mid - P0), -1.0, Cap)
        # (i) liquidation at the mid
        lqi = np.flatnonzero(pos & (eq_mid <= liq_thr + 1e-12))
        if lqi.size:
            equity = np.maximum(eq_mid[lqi], 0.0)
            lf = np.zeros(lqi.size) if self_liq else np.minimum(liq_fee, equity)
            pnl[lqi] += equity - lf - 1.0
            liqcut[lqi] += lf
            nliq[lqi] += 1
            pos[lqi] = False
        # (ii) force-close when leverage exceeds Ltime (normal close price, no penalty)
        if tau_now > 0:
            _, ltime_now = lev_limit(mid, tau_now)
        else:
            ltime_now = np.zeros(N)
        fc = pos & (Lv > ltime_now * (1.0 + 1e-9)) & (Lv > 1.0 + 1e-9)
        if not e3_time:
            fc = np.zeros(N, dtype=bool)
        if fc.any():
            settle(fc, np.clip(raw, -1.0, Cap))
        # (iii) collect at the cap
        col = pos & (raw >= Cap - 1e-7)
        if col.any():
            settle(col, Cap)
        # (iv) strategy
        if strategy == "snipe":
            bank = pos & (raw > 1e-12) & ((mid - slow) <= tol_gap)
            if bank.any():
                settle(bank, np.clip(raw, -1.0, Cap))
        if strategy == "bank":
            bank = pos & (raw > (hold_ticks - 0.5) * tick * nsh) & ((mid - slow) <= tol_gap)
            if bank.any():
                settle(bank, np.clip(raw, -1.0, Cap))
            rs = pos & (raw <= 1e-12) & (raw >= -reset_tol) & ((t - topen) >= reset_every - 1e-9)
            rs &= (np.abs(mid - slow) <= reset_gap) & ((F + efee + debt) > 0)
            if rs.any():
                nreset += rs
                settle(rs, np.clip(raw, -1.0, Cap))
        # 5. re-open
        if t < H - 1e-9:
            if strategy == "snipe":
                up = alive & ~pos & (mid > mid_prev + 1e-12)
                if up.any():
                    do_open(up, ref_mid=mid_prev)
            else:
                do_open(alive & ~pos)
    # close whatever is still open at the end of the window (normal close)
    cp = np.minimum(mid, slow)
    raw = nsh * (cp - P0)
    settle(pos.copy(), np.clip(raw, -1.0, Cap))

    if record:
        snaps.append(snap())
        return dict(S=np.stack(snaps), K=N, dt=dt, nsteps=nsteps, H=nsteps * dt, T_true=T_true,
                    lam=(lam_arr if lam_arr is not None else None), two=two, pi0=pi0, lamH=lamH, lamL=lamL)
    mdays = mtime / DAY
    out = summarize(pnl, mdays)
    out.update(dict(
        fee_paid=feepaid.mean(), fee_accrued=feeacc.mean(), gap_cost=gapcost.mean(),
        profit_share=pshare.mean(), liq_cut=liqcut.mean(), house_pnl=(-pnl - liqcut).mean(),
        house_pnl_se=(-pnl - liqcut).std(ddof=1) / math.sqrt(N),
        opens=nopen.mean(), resets=nreset.mean(), liqs=nliq.mean(), p_crash_loss=ncrash.mean(),
        wins=nwin.mean(), gross_win=grosswin.mean(), lam=lamH, N=N,
    ))
    if return_paths:
        out["paths"] = dict(pnl=pnl, mdays=mdays, tc=tc)
    return out


def summarize(pnl, mdays):
    N = len(pnl)
    m_p, m_m = pnl.mean(), mdays.mean()
    se_p = pnl.std(ddof=1) / math.sqrt(N)
    R = m_p / m_m if m_m > 0 else float("nan")
    if m_m > 0:
        cov = np.cov(pnl, mdays, ddof=1)
        varR = (cov[0, 0] - 2 * R * cov[0, 1] + R * R * cov[1, 1]) / (m_m * m_m) / N
        seR = math.sqrt(max(varR, 0.0))
    else:
        seR = float("nan")
    return dict(ev=m_p, ev_se=se_p, mdays=m_m, ev_per_dollar_day=R, ev_per_dollar_day_se=seR)


def fmt(r):
    return (f"EV/window {r['ev']:+.4f} (se {r['ev_se']:.4f})  margin-days {r['mdays']:.3f}  "
            f"EV per $-day {r['ev_per_dollar_day']:+.5f} (se {r['ev_per_dollar_day_se']:.5f})  "
            f"fee paid {r['fee_paid']:.4f} / accrued {r['fee_accrued']:.4f} / gap cost {r['gap_cost']:.4f}  "
            f"share {r['profit_share']:.4f}  opens {r['opens']:.1f} resets {r['resets']:.1f} "
            f"liq {r['liqs']:.3f} crashloss {r['p_crash_loss']:.4f}")


FIELDS = ["pnl", "mtime", "fee_paid", "fee_accrued", "gap_cost", "profit_share", "liq_cut", "opens",
          "resets", "liqs", "wins", "gross_win", "pos", "gaprate"]


def evaluate(rec, N=200_000, seed=1):
    """
    Monte Carlo over (tick-phase class, hidden state, crash time) on top of recorded no-crash
    trajectories, plus the exact expectation of the same quantity (sum over steps of the crash-time
    distribution).  Identical in distribution to running `simulate` path by path when the price is
    deterministic between crashes, because a crash inside step s ends the path with the state it
    had at the start of step s: realised P&L so far, minus the margin if a position was open.
    """
    S, K, dt, ns, T_true = rec["S"], rec["K"], rec["dt"], rec["nsteps"], rec["T_true"]
    rng = np.random.default_rng(seed)
    k = rng.integers(0, K, N)
    if rec["two"]:
        theta = rng.random(N) < rec["pi0"]
        lam = np.where(theta, rec["lamH"], rec["lamL"])
    elif rec["lam"] is not None:
        lam = rec["lam"][k]
    else:
        lam = np.full(N, rec["lamH"])
    e = rng.exponential(1.0, N)
    tc = np.full(N, np.inf)
    ok = lam > 0
    tc[ok] = e[ok] / lam[ok]
    tc[tc > T_true] = np.inf
    crashed = tc < ns * dt
    s = np.where(crashed, np.minimum(np.floor(np.where(crashed, tc, 0.0) / dt).astype(int), ns - 1), ns)
    g = lambda name: S[s, FIELDS.index(name), k]
    posf = np.where(crashed, g("pos"), 0.0)
    part = np.where(crashed, np.where(crashed, tc, 0.0) - s * dt, 0.0)
    pnl = g("pnl") - posf
    mdays = (g("mtime") + posf * part) / DAY
    out = summarize(pnl, mdays)
    liq = g("liq_cut")
    out.update(dict(
        fee_paid=g("fee_paid").mean(), fee_accrued=g("fee_accrued").mean(),
        gap_cost=(g("gap_cost") + np.where(crashed, g("gaprate") * part, 0.0)).mean(),
        profit_share=g("profit_share").mean(), liq_cut=liq.mean(), house_pnl=(-pnl - liq).mean(),
        house_pnl_se=(-pnl - liq).std(ddof=1) / math.sqrt(N), opens=g("opens").mean(),
        resets=g("resets").mean(), liqs=g("liqs").mean(), p_crash_loss=posf.mean(), wins=g("wins").mean(),
        gross_win=g("gross_win").mean(), N=N, K=K,
    ))
    # exact expectation over the crash time for each class (and hidden state)
    tgrid = np.arange(ns + 1) * dt

    def exact_for(lam_k, col):
        surv = np.exp(-lam_k * np.minimum(tgrid, T_true))          # S(t_s)
        pc = surv[:-1] - surv[1:]                                   # crash inside step s
        P, M, posv = S[:ns, 0, col], S[:ns, 1, col], S[:ns, 12, col]
        # expected time into the step at the crash, given the crash is in that step
        if lam_k > 0:
            a = lam_k * dt
            frac = np.where(pc > 0, (1.0 - np.exp(-a) * (1.0 + a)) / (lam_k * (1.0 - np.exp(-a))), 0.0)
        else:
            frac = 0.0
        ev = (pc * (P - posv)).sum() + surv[-1] * S[ns, 0, col]
        mt = (pc * (M + posv * frac)).sum() + surv[-1] * S[ns, 1, col]
        return ev, mt

    evs, mts = [], []
    if rec["two"]:
        for w, lk in [(rec["pi0"], rec["lamH"]), (1.0 - rec["pi0"], rec["lamL"])]:
            for col in range(K):
                a, b_ = exact_for(lk, col)
                evs.append(w * a / K)
                mts.append(w * b_ / K)
    else:
        for col in range(K):
            lk = rec["lam"][col] if rec["lam"] is not None else rec["lamH"]
            a, b_ = exact_for(lk, col)
            evs.append(a / K)
            mts.append(b_ / K)
    out["exact_ev"] = float(np.sum(evs))
    out["exact_mdays"] = float(np.sum(mts) / DAY)
    out["exact_rate"] = out["exact_ev"] / out["exact_mdays"] if out["exact_mdays"] > 0 else float("nan")
    return out
