"""A week of pre-game trading with UNSCHEDULED news: does holding the cheap side at the E3
maximum pay once tick noise, the crowding fee, liquidation fees and the profit share are counted?

Section: sports pre-game, from 7 days out to 73 minutes before kick-off.
Assumed reference-price process (stated in the report; it is my assumption, not venue data):
  * tick noise: +1 or -1 tick, each at 0.5 per day
  * news: 0.25 per day, jump ~ Laplace(b) rounded to ticks (b = mean absolute jump)
  both zero-mean, so the mid is a martingale.  5-minute steps, 200,000 paths per cell.
Strategy (no information, no latency edge): whenever flat and mid = slow, open the cheap
side with $1 margin at the maximum allowed leverage; a winner is closed once the slow price
is within 1/20 tick of the mid (and re-opened at the new price); the keeper liquidates and force-closes on time.
'churn' = close and re-open at the entry price while the position is flat, which wipes the
accrued crowding fee (it is only ever taken from profit).
P&L is the total over the week per $1 of margin at work.
"""
import os
import numpy as np
from ol import ltime, lmax, net_close, net_liq, mean_se, MAINT, TAU_SLOW, TAU_FLOOR, LCAP

N = int(os.environ.get("N", 200_000))
DAY = 86400.0
EXIT_GAP = 0.0005   # a winner is closed once the slow price is within 1/20 tick of the mid


def sim_week(p_start, seed, skew, churn, b_jump, stop_floor=None, rate_jump=0.25 / DAY,
             rate_noise=0.5 / DAY, dt=300.0, tau_start=7 * DAY, tau_end=4380.0, n=None):
    n = n or N
    rng = np.random.default_rng(seed)
    K = int((tau_start - tau_end) / dt)
    decay = np.exp(-dt / TAU_SLOW)
    qn, qj = rate_noise * dt, rate_jump * dt
    mid = np.full(n, p_start)
    slow = mid.copy()
    has = np.zeros(n, bool); yes = np.zeros(n, bool)
    s0 = np.full(n, 0.5); L = np.ones(n); nsh = np.ones(n); C = np.ones(n); borrowed = np.zeros(n)
    fee = np.zeros(n); cum = np.zeros(n); liqpaid = np.zeros(n)
    n_open = np.zeros(n); n_liq = np.zeros(n); n_win = np.zeros(n); fee_paid = np.zeros(n)
    for k in range(K):
        tau0 = tau_start - k * dt
        tau = tau0 - dt
        slow = mid + (slow - mid) * decay
        s_prev = np.where(yes, mid, 1 - mid)
        if skew > 0:
            fee += has * (borrowed * skew * (1 - s_prev) * dt / max(tau0, TAU_FLOOR))
        u = rng.random(n)
        move = 0.01 * (u < qn) - 0.01 * ((u >= qn) & (u < 2 * qn))
        isj = (u >= 2 * qn) & (u < 2 * qn + qj)
        nj = int(isj.sum())
        if nj:
            move[isj] = np.rint(rng.laplace(0.0, b_jump, nj) * 100) / 100
        mid = np.clip(mid + move, 0.02, 0.98)
        s_mid = np.where(yes, mid, 1 - mid)
        s_slow = np.where(yes, slow, 1 - slow)
        res_mid = np.clip(nsh * (s_mid - s0), -1.0, C)
        lq = has & (1 + res_mid <= MAINT)
        if lq.any():
            net, lf = net_liq(res_mid)
            cum += lq * net; liqpaid += lq * lf; n_liq += lq
            has &= ~lq
        cp = np.minimum(s_mid, s_slow)
        res_cp = np.clip(nsh * (cp - s0), -1.0, C)
        lim = np.maximum(1.0, np.floor(np.minimum(LCAP, ltime(mid, tau)) + 1e-9))
        done = has & ((L > lim) | ((res_cp > 0) & ((s_mid - s_slow <= EXIT_GAP) | (nsh * (cp - s0) >= C - 1e-12))))
        if k == K - 1:
            done = has.copy()
        if done.any():
            cum += done * net_close(res_cp, fee)
            fee_paid += done * np.minimum(fee, np.maximum(res_cp, 0))
            n_win += done & (res_cp > 0)
            has &= ~done
        if churn:
            fee = np.where(has & (np.abs(cp - s0) < 1e-9), 0.0, fee)
        if k < K - 1:
            m = np.minimum(mid, 1 - mid)
            Lnew = lmax(mid, tau)
            if stop_floor is not None:
                Lnew = np.minimum(Lnew, np.maximum(1.0, np.floor(m / stop_floor + 1e-9)))
            ok = (~has) & (np.abs(mid - slow) <= 0.0025) & (Lnew >= 2)
            if ok.any():
                want_yes = mid <= 0.5
                sm = np.where(want_yes, mid, 1 - mid)
                ss = np.where(want_yes, slow, 1 - slow)
                entry = np.maximum(sm, ss)
                s0 = np.where(ok, entry, s0); L = np.where(ok, Lnew, L); yes = np.where(ok, want_yes, yes)
                nsh = np.where(ok, L / s0, nsh); C = np.where(ok, (1 - s0) / s0, C)
                borrowed = np.where(ok, nsh * (1 - 1 / L), borrowed)
                fee = np.where(ok, 0.0, fee)
                has |= ok; n_open += ok
    return dict(pnl=cum, house=-cum - liqpaid, n_open=n_open, n_liq=n_liq, n_win=n_win, fee_paid=fee_paid)


if __name__ == "__main__":
    cells = [
        ("p=0.30 b=2pts  skew 1, no churn            ", dict(p_start=0.30, skew=1.0, churn=False, b_jump=0.02)),
        ("p=0.30 b=2pts  skew 1, churn               ", dict(p_start=0.30, skew=1.0, churn=True, b_jump=0.02)),
        ("p=0.30 b=4pts  skew 1, churn               ", dict(p_start=0.30, skew=1.0, churn=True, b_jump=0.04)),
        ("p=0.30 b=4pts  skew 0                      ", dict(p_start=0.30, skew=0.0, churn=False, b_jump=0.04)),
        ("p=0.20 b=4pts  skew 1, churn               ", dict(p_start=0.20, skew=1.0, churn=True, b_jump=0.04)),
        ("p=0.50 b=4pts  skew 1, churn               ", dict(p_start=0.50, skew=1.0, churn=True, b_jump=0.04)),
        ("p=0.30 b=4pts  skew 0, stop >= 10 pts rule ", dict(p_start=0.30, skew=0.0, churn=False, b_jump=0.04, stop_floor=0.10)),
        ("p=0.20 b=4pts  skew 0, stop >= 10 pts rule ", dict(p_start=0.20, skew=0.0, churn=False, b_jump=0.04, stop_floor=0.10)),
    ]
    print(f"Week of pre-game trading, cheap side at maximum leverage, {N} paths per cell")
    only = os.environ.get("CELLS")
    only = None if only is None else {int(x) for x in only.split(",")}
    for i, (lab, kw) in enumerate(cells):
        if only is not None and i not in only:
            continue
        r = sim_week(seed=71 + i, **kw)
        m, s = mean_se(r["pnl"]); hm_, hs = mean_se(r["house"])
        print(f"  {lab} trader {m:+.4f} (se {s:.4f})  house {hm_:+.4f} (se {hs:.4f})  | positions {r['n_open'].mean():.2f}"
              f"  liquidated {r['n_liq'].mean():.2f}  closed in profit {r['n_win'].mean():.2f}  fee paid {r['fee_paid'].mean():.3f}",
              flush=True)
