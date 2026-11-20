"""
Monte Carlo of the push-and-hold attack (Attack 1), its second leg, and the spoofed-capacity variant
(Attack 2) against a noisy reference book, with the venue rules exactly as written.

Everything is simulated in the OWN-side price q of leg 1 (q = p for a YES-first attack, q = 1-p for a
NO-first attack).  `usd_side` says how the keeper's USD depth translates into contracts:
   "own"   (YES-first): a level holding rho USD at own price q holds rho / q contracts;
   "other" (NO-first):  the keeper measures USD at the YES price 1-q, so the level holds rho / (1-q) contracts.

Reference market model (assumptions, not rules):
  * fair value v is a martingale with variance v(1-v)/tau_exp per second (the scaling E3 itself assumes);
  * a market maker quotes a ladder of rho USD per tick on both sides, `s` ticks wide, centred on v with
    hysteresis (it re-centres by one tick when v has moved more than `hyst` ticks from its centre);
  * levels the attacker has consumed stay consumed until a refill event (Poisson, rate r) restores the
    whole ladder; the attacker then consumes them again;
  * the attacker keeps a 1-contract bid one tick under the best ask (maker, free) so the keeper's mid sits
    half a tick under the best ask; its fills are ignored (1 contract);
  * the attacker's inventory is marked at fair value v when the push is released (no further cost or gain
    in expectation); taker fees per Gemini's schedule are paid on everything consumed.
Venue model (rules as written): keeper sees the book every 4 s and the change reaches the chain at once;
slow price updated on every poll with R1's formula; worse-of fills; liquidation at the mid at 20% equity
with the 5% reward; collect() at the cap; crowding fee from profit only (attacker alone on his side, so
skewFrac = 1); 10% profit share.
"""
import numpy as np
from venue import (TICK, POLL_S, GEMINI_TAKER, MAINT, LIQ_FEE, PROFIT_SHARE_EVENT, TAU_FLOOR, MAX_GAP_EVENT,
                   slow_step_written, slow_step_exact, l_max, cap_free, win_line, liq_line)
from book import n_levels_in_band


def simulate(n_paths=200_000, seed=1, B0=49, s=1, rho=200.0, kappa=0.5, L=24, usd_side="own",
             m_target=2, T_hold=600, r_refill=0.0, tau_exp=30 * 86400.0, tau_slow=300.0, poll=POLL_S,
             taker=GEMINI_TAKER, spoof_usd=0.0, two_leg=False, T2=900, wait=0, push=True,
             slow_rule="written", crowd="written", hyst=0.75, share=PROFIT_SHARE_EVENT, topup=True,
             kappa_mode="usd", abs_cap=None, sigma_mult=1.0, L2=None):
    rng = np.random.default_rng(seed)
    step = slow_step_written if slow_rule == "written" else slow_step_exact
    n = n_paths
    A0 = B0 + s
    mid0 = (B0 + A0) / 2 * TICK
    nlv = n_levels_in_band(s)
    d5 = nlv * rho                                           # keeper's USD depth, both sides equal
    usd_px = (lambda q: q) if usd_side == "own" else (lambda q: 1.0 - q)

    # ---- leg 1: opened calm at q0 = mid = slow
    q0 = mid0
    if kappa_mode == "usd":
        N1 = kappa * (d5 + spoof_usd)
    else:   # contracts-based capacity: kappa * contracts in band, valued at the position's own price
        ctr = sum(rho / usd_px((A0 + j) * TICK) for j in range(nlv))
        N1 = kappa * (ctr + spoof_usd / usd_px(mid0)) * q0
    if abs_cap is not None: N1 = min(N1, abs_cap)
    Lmax1 = float(l_max(q0, tau_exp))
    assert L <= Lmax1 + 1e-9, f"L={L} exceeds the E3 limit {Lmax1} at {q0}"
    M1 = N1 / L
    n1 = N1 / q0
    C1 = cap_free(M1, q0)
    win1, liq1 = win_line(q0, L), liq_line(q0, L)
    borrowed1 = n1 * (1 - 1.0 / L)

    v = np.full(n, mid0)
    Bc = np.full(n, B0, dtype=np.int64)
    e = np.zeros(n, dtype=np.int64)
    cash = np.zeros(n); sh = np.zeros(n)
    slow = np.full(n, mid0); mid_on = np.full(n, mid0)
    open1 = np.ones(n, dtype=bool)
    res1 = np.zeros(n)                 # trader's net result on leg 1
    crowd1 = np.zeros(n)
    liq_flag = np.zeros(n, dtype=bool); col_flag = np.zeros(n, dtype=bool)
    sig_c = sigma_mult / np.sqrt(tau_exp)
    p_refill = 1.0 - np.exp(-r_refill * poll)
    Astar = A0 + m_target
    t = 0.0

    def evolve():
        nonlocal v, Bc
        v = np.clip(v + sig_c * np.sqrt(v * (1 - v) * poll) * rng.standard_normal(n), 0.02, 0.98)
        for _ in range(2):                                   # at most two re-centres per poll
            x = v / TICK - (Bc + s / 2)
            Bc = Bc + (x > hyst).astype(np.int64) - (x < -hyst).astype(np.int64)

    def settle1(mask, exit_q, liquidation=False):
        nonlocal open1, res1
        if not mask.any(): return
        pnl = np.clip(n1 * (exit_q[mask] - q0), -M1, C1)
        if liquidation:
            eq = M1 + pnl
            res1[mask] = eq - np.minimum(LIQ_FEE * M1, eq) - M1
        else:
            fee = np.minimum(crowd1[mask], np.maximum(pnl, 0))
            res1[mask] = np.where(pnl > 0, (pnl - fee) * (1 - share), pnl)
        open1 = open1 & ~mask

    def venue_poll(mid_ref, pushing):
        """Deliver the polled mid on-chain, then run the keeper's checks on leg 1."""
        nonlocal slow, mid_on, crowd1, liq_flag, col_flag
        slow = step(slow, mid_on, poll, tau_slow)
        mid_on = mid_ref
        tau_left = max(tau_exp - t, TAU_FLOOR)
        rate = (1 - mid_on) if crowd == "written" else mid_on * (1 - mid_on)
        crowd1 = crowd1 + np.where(open1, borrowed1 * rate * poll / tau_left, 0.0)
        lq = open1 & (mid_on <= liq1 + 1e-12)
        liq_flag |= lq
        settle1(lq, mid_on, liquidation=True)
        ex = np.minimum(mid_on, slow)
        cl = open1 & (n1 * (ex - q0) >= C1 - 1e-12)
        col_flag |= cl
        settle1(cl, ex)

    # ---- optional wait before the push (minimum-hold-time experiments): honest market, position exposed
    for _ in range(int(wait // poll)):
        t += poll
        evolve()
        venue_poll((Bc + s / 2) * TICK, False)

    # ---- push and hold
    pushing = open1.copy() if push else np.zeros(n, dtype=bool)
    for _ in range(int(T_hold // poll)):
        t += poll
        evolve()
        if push:
            if p_refill > 0:
                e = np.where(rng.random(n) < p_refill, 0, e)
            need = np.where(pushing, np.maximum(Astar - (Bc + s + e), 0), 0)
            for _k in range(int(need.max()) if need.size else 0):
                todo = need > 0
                tick_px = (Bc + s + e) * TICK                # own-side price of the level being consumed
                c = np.where(todo, rho / usd_px(tick_px), 0.0)
                cash += c * tick_px + c * taker * tick_px * (1 - tick_px)
                sh += c
                e = e + todo; need = need - todo
            best_ask = np.maximum(Astar, Bc + s + e)
            mid_ref = np.where(pushing, (best_ask - 0.5) * TICK, (Bc + s / 2) * TICK)
        else:
            mid_ref = (Bc + s / 2) * TICK
        venue_poll(mid_ref, True)
        pushing = pushing & open1 if not two_leg else pushing      # once leg 1 is settled a one-leg attacker stops paying

    settle1(open1.copy(), np.minimum(mid_on, slow))
    ref_pnl = sh * v - cash                                   # inventory marked at fair value at release
    venue = res1.copy()
    margin = np.full(n, M1)
    res2 = np.zeros(n)

    # ---- leg 2: opposite side opened at the caught-up slow price, then the push is released
    if two_leg:
        gap_ok = np.abs(mid_on - slow) <= MAX_GAP_EVENT + 1e-12
        qb0 = 1.0 - np.minimum(mid_on, slow)                 # worse-of entry in the opposite side's own price
        if topup:
            dep2 = np.full(n, d5)
        else:
            cnt = np.floor(5.5 - (np.maximum(Astar, Bc + s + e) - Bc)) + 1
            dep2 = np.clip(cnt, 0, nlv) * rho
        if kappa_mode == "usd":
            N2 = kappa * (dep2 + spoof_usd)
        else:
            N2 = kappa * (dep2 / d5) * (sum(rho / usd_px((A0 + j) * TICK) for j in range(nlv)) + spoof_usd / usd_px(mid0)) * qb0
        if abs_cap is not None: N2 = np.minimum(N2, abs_cap)
        N2 = np.where(gap_ok & pushing, N2, 0.0)
        Lb = np.minimum(L if L2 is None else L2, l_max(mid_on, tau_exp - t))
        M2 = N2 / Lb; n2 = N2 / qb0
        C2 = cap_free(M2, qb0); win2 = win_line(qb0, Lb); liq2 = liq_line(qb0, Lb)
        borrowed2 = n2 * (1 - 1.0 / Lb)
        open2 = N2 > 0
        crowd2 = np.zeros(n)
        for _ in range(int(T2 // poll)):
            t += poll
            evolve()
            slow = step(slow, mid_on, poll, tau_slow)
            mid_on = (Bc + s / 2) * TICK                     # push released: natural mid
            qm = 1 - mid_on
            rate = (1 - qm) if crowd == "written" else qm * (1 - qm)
            crowd2 += np.where(open2, borrowed2 * rate * poll / max(tau_exp - t, TAU_FLOOR), 0.0)
            lq = open2 & (qm <= liq2 + 1e-12)
            if lq.any():
                pnl = np.clip(n2[lq] * (qm[lq] - qb0[lq]), -M2[lq], C2[lq]); eq = M2[lq] + pnl
                res2[lq] = eq - np.minimum(LIQ_FEE * M2[lq], eq) - M2[lq]; open2 = open2 & ~lq
            ex = np.minimum(1 - mid_on, 1 - slow)
            cl = open2 & (n2 * (ex - qb0) >= C2 - 1e-12)
            if cl.any():
                pnl = np.minimum(n2[cl] * (ex[cl] - qb0[cl]), C2[cl]); fee = np.minimum(crowd2[cl], pnl)
                res2[cl] = (pnl - fee) * (1 - share); open2 = open2 & ~cl
        if open2.any():
            ex = np.minimum(1 - mid_on, 1 - slow)
            pnl = np.clip(n2[open2] * (ex[open2] - qb0[open2]), -M2[open2], C2[open2])
            fee = np.minimum(crowd2[open2], np.maximum(pnl, 0))
            res2[open2] = np.where(pnl > 0, (pnl - fee) * (1 - share), pnl)
        venue = venue + res2
        margin = margin + M2

    total = venue + ref_pnl
    return dict(venue=venue, ref=ref_pnl, total=total, margin=margin, liq=liq_flag, collected=col_flag,
                N1=N1, M1=M1, d5=d5, leg1=res1, leg2=res2, ref_usd=cash)


def stats(x):
    x = np.asarray(x, float)
    return x.mean(), x.std(ddof=1) / np.sqrt(len(x))


def report(label, out, depth_scale=None):
    v, vse = stats(out["venue"]); r, rse = stats(out["ref"]); tt, tse = stats(out["total"])
    m = out["margin"].mean()
    em, emse = stats(out["total"] / out["margin"])
    d = out["d5"] if depth_scale is None else depth_scale
    return (f"{label:44s} house loss {v:9.2f} ±{vse:5.2f} | ref cost {-r:8.2f} ±{rse:5.2f} | attacker net {tt:+9.2f} ±{tse:5.2f}"
            f" | margin {m:8.2f} | EV per $ margin {em:+7.3f} ±{emse:5.3f} | liquidated {out['liq'].mean():6.2%} collected {out['collected'].mean():6.2%}")


if __name__ == "__main__":
    import sys, time
    NP = 200_000
    t0 = time.time()
    print("All figures per attack cycle on a book with $1,000 within 5 ticks ($200 per level), 1-tick spread, mid 49.5c,")
    print("30 days to expiry, kappa 0.5, Gemini taker fee on.  n =", NP, "paths per row; ± is one standard error.\n")

    print("0. Honest baseline (no push): a free-mode long held T seconds then closed.  House 'loss' should be <= 0.")
    for L in (1, 10, 24):
        for T in (600, 3600):
            o = simulate(NP, seed=10 + L + T, L=L, push=False, T_hold=T)
            print("  ", report(f"L={L:>2} hold {T:>4}s", o))

    print("\n1. Attack 1, stale book (no refill), one leg: leverage x push size x hold time")
    for L in (1, 10, 24):
        for m in (1, 2, 3, 5):
            for T in (150, 300, 600, 900):
                o = simulate(NP, seed=1000 + 37 * L + 11 * m + T, L=L, m_target=m, T_hold=T)
                print("  ", report(f"L={L:>2} push {m} ticks hold {T:>3}s", o))
    print(f"\n[{time.time()-t0:.0f}s]")
