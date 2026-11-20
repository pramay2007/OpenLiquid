"""
Life of one free-mode position on the one-touch, simulated path by path under the written rules.

Per step (dt seconds; every path in a run shares the calendar):
  1. the underlying diffuses; a touch inside the step (Brownian-bridge test) resolves the market YES
  2. a scheduled gap (if this step is a release) is applied; a gap through the barrier resolves YES
  3. the contract end resolves NO
  4. mid = fair value rounded to 1c; slow = exponential average (300 s) moved toward the mid held last step
  5. crowding fee accrues: borrowedShares * (1 - side price)/tau, tau = seconds to CONTRACT END (floor 1 h)
  6. liquidation: equity at the MID <= 20% of margin -> settled at the mid (optionally `lat_steps` later),
     liquidator takes 5% of margin out of what is left
  7. collect(): worse-of close price has reached the cap -> paid the cap
  8. forceClose: leverage above the current integer time-limit -> closed at the worse-of price
Entry: calm market (slow = mid), fill at the mid p0 (on the tick); the true fair value sits
uniformly within +/- half a tick of it unless `delta` is given.
"""
import numpy as np
import rules as R

SEC_Y = 365.0 * 86400.0
KIND = {0: "liquidated", 1: "collected", 2: "resolved", 3: "force-closed", 4: "timed out"}


def simulate(no_fn, y_from_yes, T, sigma, t0, p0, side, L, n, dt_sec, rng, gap_times=(), gap_sd=0.0,
             delta=None, lat_steps=0, max_days=120.0, force_close=True, tau_clock=None, min_dist=0.02,
             jump_1x=False, jump_ticks=2.0):
    """Returns dict of per-path arrays. tau_clock(t) -> seconds used in Ltime/fees (default: to contract end).
    jump_1x: candidate fix - a single-step favourable move of more than `jump_ticks` ticks is paid at 1x."""
    nu = 0.5 * sigma * sigma
    dt = dt_sec / SEC_Y
    sd = sigma * np.sqrt(dt)
    if delta is None:
        delta = rng.uniform(-0.5 * R.TICK, 0.5 * R.TICK, n)
    f0 = p0 + delta
    y = y_from_yes(f0, t0).astype(float)
    is_yes = side == "YES"
    ps0 = p0 if is_yes else 1.0 - p0
    reserve = float(R.reserve(ps0, L))
    borrowed = float(R.borrowed_shares(ps0, L))
    ps_res_yes = 1.0 if is_yes else 0.0   # side price if YES resolves
    ps_res_no = 0.0 if is_yes else 1.0

    idx = np.arange(n)
    slow = np.full(n, p0)
    mid_prev = np.full(n, p0)
    crowd = np.zeros(n)
    count = np.full(n, -1, dtype=np.int64)
    adj = np.zeros(n)  # jump_1x: cumulative favourable jump stripped from the borrowed shares (side price)

    r_out = np.full(n, np.nan)
    kind = np.full(n, -1, dtype=np.int8)
    hold = np.zeros(n)
    crowd_out = np.zeros(n)
    spanned = np.zeros(n, dtype=bool)
    gap_steps = {}
    for g in gap_times:
        if g > t0 + 1e-12:
            gap_steps[int(round((g - t0) / dt))] = g
    max_steps = int(max_days * 86400.0 / dt_sec)

    def finish(mask, r_vals, k, step):
        gi = idx[mask]
        r_out[gi] = r_vals
        kind[gi] = k
        hold[gi] = step * dt_sec
        crowd_out[gi] = crowd[mask] * borrowed

    step = 0
    while len(idx) > 0 and step < max_steps:
        step += 1
        t = t0 + step * dt
        m_act = len(idx)
        z = rng.standard_normal(m_act)
        ynew = y + nu * dt - sd * z
        hit = ynew <= 0
        near = (~hit) & (y < 8 * sd) & (ynew < 8 * sd)
        if near.any():
            u = rng.random(int(near.sum()))
            hit[near] = u < np.exp(-2.0 * y[near] * ynew[near] / (sd * sd))
        y = ynew
        if step in gap_steps:
            spanned[idx] = True
            J = rng.normal(-0.5 * gap_sd**2, gap_sd, m_act)
            y = y - J
            hit |= y <= 0
        resolved_no = t >= T - 1e-12
        if hit.any():
            finish(hit, np.full(int(hit.sum()), float(R.result(ps0, ps_res_yes, L))), 2, step)
        keep = ~hit
        if resolved_no:
            finish(keep, np.full(int(keep.sum()), float(R.result(ps0, ps_res_no, L))), 2, step)
            idx = idx[:0]
            break
        if not keep.all():
            idx, y, slow, mid_prev, crowd, count, adj = idx[keep], y[keep], slow[keep], mid_prev[keep], crowd[keep], count[keep], adj[keep]
        if len(idx) == 0:
            break
        f = 1.0 - no_fn(np.maximum(y, 0.0), t)
        mid = R.round_tick(f)
        slow = R.slow_update(slow, mid_prev, dt_sec)
        tau_end = (T - t) * SEC_Y
        tau = tau_end if tau_clock is None else tau_clock(t)
        ps_mid = mid if is_yes else 1.0 - mid
        ps_close = np.minimum(mid, slow) if is_yes else 1.0 - np.maximum(mid, slow)
        crowd += (1.0 - ps_mid) / max(tau, R.TAU_FLOOR) * dt_sec
        if jump_1x:
            ps_prev = mid_prev if is_yes else 1.0 - mid_prev
            d = ps_mid - ps_prev
            adj += np.where(d > jump_ticks * R.TICK + 1e-12, d, 0.0)
        # result at the mid and at the close price (borrowed shares do not earn `adj`)
        def res(ps):
            raw = (L / ps0) * (ps - ps0) - borrowed * adj
            return np.maximum(np.minimum(raw, reserve), -1.0), raw
        r_mid, _ = res(ps_mid)
        under = 1.0 + r_mid <= R.MAINT
        if lat_steps == 0:
            liq = under
        else:
            count = np.where(under & (count < 0), lat_steps, count)
            due = count == 0
            liq = due & under
            count = np.where(due & ~under, -1, count)
            count = np.where(count > 0, count - 1, count)
        done = liq.copy()
        if liq.any():
            finish(liq, r_mid[liq], 0, step)
        r_close, raw_close = res(ps_close)
        coll = (~done) & (raw_close >= reserve - 1e-12)
        if coll.any():
            finish(coll, np.full(int(coll.sum()), reserve), 1, step)
            done |= coll
        if force_close and L > 1:
            lim = R.max_leverage(mid, tau, min_dist=1e-9)  # only the time limit matters for forceClose
            lim = np.maximum(1.0, np.minimum(R.LEV_CEIL, np.floor(R.ltime(mid, tau) + 1e-9)))
            fc = (~done) & (L > lim)
            if fc.any():
                finish(fc, r_close[fc], 3, step)
                done |= fc
        mid_prev = mid
        if done.any():
            keep = ~done
            idx, y, slow, mid_prev, crowd, count, adj = idx[keep], y[keep], slow[keep], mid_prev[keep], crowd[keep], count[keep], adj[keep]
    if len(idx) > 0:  # timed out: close at the worse-of price
        f = 1.0 - no_fn(np.maximum(y, 0.0), t0 + step * dt)
        mid = R.round_tick(f)
        ps_close = np.minimum(mid, slow) if is_yes else 1.0 - np.maximum(mid, slow)
        raw = (L / ps0) * (ps_close - ps0) - borrowed * adj
        finish(np.ones(len(idx), dtype=bool), np.maximum(np.minimum(raw, reserve), -1.0), 4, step)
    return dict(r=r_out, kind=kind, hold=hold, crowd=crowd_out, spanned=spanned, ps0=ps0, L=L, reserve=reserve)


def summarize(out, skew=1.0):
    r = out["r"]
    n = len(r)
    trader, house, liq = R.settle(r, out["crowd"] * skew, out["kind"] == 0)
    se = lambda x: x.std(ddof=1) / np.sqrt(n)
    return dict(
        ev=trader.mean(), ev_se=se(trader), house=house.mean(), house_se=se(house), liq=liq.mean(),
        gross=r.mean(), gross_se=se(r), p_win=(r > 0).mean(), p_cap=(out["kind"] == 1).mean(),
        p_liq=(out["kind"] == 0).mean(), p_res=(out["kind"] == 2).mean(), p_fc=(out["kind"] == 3).mean(),
        p_to=(out["kind"] == 4).mean(), hold_days=out["hold"].mean() / 86400.0, spanned=out["spanned"].mean(),
        crowd=(np.minimum(out["crowd"] * skew, np.maximum(r, 0))).mean(),
    )
