"""
Independent re-derivation of the claim
  "Profit cap makes the crowding fee under-collect even with no gaming when tick times are random".

Rules implemented exactly as written in the brief:
  R1  worse-of fill; slow += (previousMid - slow)*dt/(tau_slow+dt) on each update, tau_slow = 300 s (events)
  R7  nothing to open/close; 10% profit share on NET profit at close (events)
  E1  n = M*L/p0
  E2  free mode: P&L = clamp(n*(p-p0), -M, C), C = M*(1-p0)/p0
  E4  crowding fee accrues per second = scale * borrowedShares * skewFrac * (1-p_s)/tau (tau floored 1h),
      borrowedShares = n*(1-1/L); deducted ONLY from profit at close; loser pays nothing.
      skewFrac = 1 here (attacker alone on the side: the MOST fee the rule can charge).

Market model (the fee's own model, discretised on the 1c tick grid):
  crash-to-zero hazard      lam(p,tau) = (1-p)/tau
  up-tick (+1c) intensity   nu(p,tau)  = p*(1-p)/(tick*tau)       -> E[dp] = 0, the quoted price is a martingale
  Both scale as 1/tau, so within a level  P(no event by s) = ((tau0-s)/tau0)^c,  c = (1-p)*(1+p/tick),
  and the event is a crash with probability (1-p)/c = 1/(1+p/tick), independent of its time.

Two independent implementations:
  (A) event-driven, vectorised (exact sampling of event times, exact fee integral)
  (B) brute-force fixed time step (dt seconds), no closed forms at all
plus (C) a closed form for the zero-wait/zero-lag case.
"""
import math
import sys
import numpy as np

TICK = 0.01
FLOOR = 3600.0


def fee_integral(tau_a, tau_b):
    """integral of dt / max(tau, 1h) while tau runs down from tau_a to tau_b (tau_a >= tau_b >= 0)."""
    a = np.maximum(tau_a, FLOOR)
    b = np.maximum(tau_b, FLOOR)
    part_log = np.log(a / b)                       # region tau >= floor
    part_lin = (np.minimum(tau_a, FLOOR) - np.minimum(tau_b, FLOOR)) / FLOOR  # region tau < floor
    return part_log + part_lin


def simulate(p0, L, tau0, scale=1.0, hold_ticks=1, wait=900.0, tau_slow=300.0, poke=4.0,
             share=0.10, n_paths=2_000_000, seed=1, M=1.0, lag=True, max_events=12):
    """Strategy: open free-mode long at p0 with leverage L, hold until `hold_ticks` up-ticks have printed,
    wait `wait` seconds (so the slow price catches up), close, pay min(accrued fee, profit), pay profit share.
    Returns dict of statistics per $1 margin."""
    rng = np.random.default_rng(seed)
    n_sh = M * L / p0
    B = n_sh * (1.0 - 1.0 / L)
    C = M * (1.0 - p0) / p0
    q = tau_slow / (tau_slow + poke) if poke > 0 else None   # per-poke decay of the mid-slow gap

    N = n_paths
    mid = np.full(N, p0)
    slow = np.full(N, p0)
    tau = np.full(N, float(tau0))
    fee = np.zeros(N)
    fee_at_tick = np.full(N, np.nan)
    ticks = np.zeros(N, dtype=np.int64)
    wait_left = np.full(N, np.inf)        # inf while still waiting for the up-ticks
    pnl = np.full(N, np.nan)
    gross_out = np.full(N, np.nan)
    feepaid = np.zeros(N)
    share_paid = np.zeros(N)
    alive = np.ones(N, dtype=bool)
    crashed = np.zeros(N, dtype=bool)
    dur = np.zeros(N)

    def relax(sl, md, dt):
        if not lag:
            return md.copy()
        if poke > 0:
            return md - (md - sl) * np.power(q, dt / poke)
        # lazy: a single on-chain update after dt
        return sl + (md - sl) * dt / (tau_slow + dt)

    for _ in range(max_events):
        idx = np.nonzero(alive)[0]
        if idx.size == 0:
            break
        p = mid[idx]
        c = (1.0 - p) * (1.0 + p / TICK)
        u = rng.random(idx.size)
        s = tau[idx] * (1.0 - np.power(u, 1.0 / c))        # time to next market event
        wl = wait_left[idx]
        closes = s >= wl                                    # the close happens before the next event
        step = np.where(closes, wl, s)
        tau_new = tau[idx] - step
        fee[idx] += scale * B * (1.0 - p) * fee_integral(tau[idx], tau_new)
        slow[idx] = relax(slow[idx], mid[idx], step)
        tau[idx] = tau_new
        dur[idx] += step

        # --- paths that close now
        ci = idx[closes]
        if ci.size:
            fill = np.minimum(mid[ci], slow[ci])
            gross = np.clip(n_sh * (fill - p0), -M, C)
            f = np.minimum(fee[ci], np.maximum(gross, 0.0))
            net = gross - f
            sp = np.where(net > 0, share * net, 0.0)
            pnl[ci] = net - sp
            gross_out[ci] = gross
            feepaid[ci] = f
            share_paid[ci] = sp
            alive[ci] = False

        # --- paths with a market event
        ei = idx[~closes]
        if ei.size:
            pe = mid[ei]
            is_crash = rng.random(ei.size) < 1.0 / (1.0 + pe / TICK)
            cr = ei[is_crash]
            pnl[cr] = -M
            crashed[cr] = True
            alive[cr] = False
            up = ei[~is_crash]
            mid[up] = np.round(mid[up] + TICK, 2)
            ticks[up] += 1
            wait_left[up] = np.where(np.isinf(wait_left[up]), np.inf, wait_left[up] - s[~closes][~is_crash])
            newly = up[(ticks[up] == hold_ticks) & np.isinf(wait_left[up])]
            wait_left[newly] = wait
            fee_at_tick[newly] = fee[newly]
            if wait == 0.0:
                pass  # closes on next loop iteration with step 0
            # a price that reaches 1.00 means the side has won; nothing further can happen
            done1 = up[mid[up] >= 0.995]
            if done1.size:
                # settle at the cap / full payoff (free mode): the clamp applies
                gross = np.clip(n_sh * (1.0 - p0), -M, C)
                f = np.minimum(fee[done1], gross)
                net = gross - f
                sp = share * net
                pnl[done1] = net - sp
                gross_out[done1] = gross
                feepaid[done1] = f
                share_paid[done1] = sp
                alive[done1] = False

    assert not alive.any(), f"{alive.sum()} paths still alive; raise max_events"
    ev = pnl.mean()
    se = pnl.std(ddof=1) / math.sqrt(N)
    won = ~crashed
    return dict(ev=ev, se=se, p_crash=crashed.mean(),
                fee_accrued_at_tick=np.nanmean(fee_at_tick),
                fee_accrued_at_close=fee[won].mean(),
                fee_paid_per_round=feepaid.mean(), fee_paid_given_close=feepaid[won].mean(),
                gross_given_close=gross_out[won].mean(), share_per_round=share_paid.mean(),
                mean_dur_h=dur.mean() / 3600.0, n_sh=n_sh, B=B, C=C)


def closed_form(p0, L, scale=1.0, share=0.10, M=1.0):
    """zero wait, zero lag. EV = pi*(1-share)*G*(1 - m(1-e^{-1/m})) - (1-pi)*M,  m = scale*(1-1/L)/(p0+tick)"""
    G = M * L / p0 * TICK
    pi = (p0 / TICK) / (1.0 + p0 / TICK)
    m = scale * (1.0 - 1.0 / L) / (p0 + TICK)
    coll = m * (1.0 - math.exp(-1.0 / m))          # E[min(X,1)], X ~ Exp(mean m)
    ev = pi * (1 - share) * G * (1.0 - coll) - (1 - pi) * M
    return dict(ev=ev, G=G, pi=pi, m=m, collected_frac=coll, fee_accrued=m * G, fee_collected=pi * coll * G)


def brute_force(p0, L, tau0, scale=1.0, wait=900.0, tau_slow=300.0, dt=30.0, share=0.10,
                n_paths=300_000, seed=7, M=1.0):
    """(B) fixed-step simulation of the one-tick strategy; the on-chain price is poked every dt seconds
    with the R1 recursion  slow += (previousMid - slow)*dt/(tau_slow+dt)."""
    rng = np.random.default_rng(seed)
    n_sh = M * L / p0
    B = n_sh * (1.0 - 1.0 / L)
    C = M * (1.0 - p0) / p0
    N = n_paths
    mid = np.full(N, p0)
    slow = np.full(N, p0)
    fee = np.zeros(N)
    state = np.zeros(N, dtype=np.int8)       # 0 waiting for tick, 1 in the wait, 2 done
    wl = np.zeros(N)
    pnl = np.zeros(N)
    feepaid = np.zeros(N)
    tau = float(tau0)
    k = 0
    while (state < 2).any() and tau > dt:
        act = state < 2
        prev_mid = mid.copy()
        # market events during this step (probabilities exact for the step: hazards integrate to c*ln(tau/(tau-dt)))
        p = mid
        lr = math.log(tau / (tau - dt))
        pc = 1.0 - np.exp(-(1.0 - p) * lr)
        pu = 1.0 - np.exp(-(p * (1.0 - p) / TICK) * lr)
        r1 = rng.random(N)
        r2 = rng.random(N)
        crash = act & (r1 < pc)
        up = act & ~crash & (r2 < pu)
        # fee accrues on the price that prevailed during the step
        fee[act] += scale * B * (1.0 - p[act]) * dt / max(tau, FLOOR)
        # R1 slow update uses the mid that prevailed over the elapsed interval
        slow = slow + (prev_mid - slow) * dt / (tau_slow + dt)
        pnl[crash] = -M
        state[crash] = 2
        mid = np.where(up, np.round(mid + TICK, 2), mid)
        start = up & (state == 0)
        # paths already in the wait: count down, close when it expires
        inw = (state == 1)
        wl[inw] -= dt
        close = inw & (wl <= 0)
        if close.any():
            fill = np.minimum(mid[close], slow[close])
            gross = np.clip(n_sh * (fill - p0), -M, C)
            f = np.minimum(fee[close], np.maximum(gross, 0.0))
            net = gross - f
            pnl[close] = np.where(net > 0, (1 - share) * net, net)
            feepaid[close] = f
            state[close] = 2
        state[start] = 1
        wl[start] = wait
        tau -= dt
        k += 1
    return dict(ev=pnl.mean(), se=pnl.std(ddof=1) / math.sqrt(N), fee_paid=feepaid.mean(),
                unfinished=float((state < 2).mean()))


def fmt(d, keys):
    return "  ".join(f"{k}={d[k]:+.5f}" if k in ("ev",) else f"{k}={d[k]:.5f}" for k in keys)


if __name__ == "__main__":
    DAY = 86400.0
    print("=== (C) closed form, zero wait / zero lag ===")
    for (p0, L) in [(0.90, 5), (0.80, 10), (0.50, 25)]:
        for sc in (1.0, 2.0):
            cf = closed_form(p0, L, sc)
            print(f"p0={p0:.2f} L={L:>2} scale={sc:.0f}  EV={cf['ev']:+.5f}  G={cf['G']:.5f}  m={cf['m']:.4f} "
                  f"E[min(X,1)]={cf['collected_frac']:.4f}  accrued={cf['fee_accrued']:.5f}  collected/round={cf['fee_collected']:.5f}")

    print("\n=== (A) event-driven MC vs (C): zero wait, zero lag, 0.90/5x, tau=3d ===")
    r = simulate(0.90, 5, 3 * DAY, wait=0.0, lag=False, n_paths=4_000_000, seed=11)
    print(fmt(r, ["ev", "se", "p_crash", "fee_accrued_at_tick", "fee_paid_per_round", "gross_given_close", "mean_dur_h"]))

    print("\n=== (A) the claim as stated: 0.90/5x, tau=3d, wait 15 min, slow lag (pokes every 4 s) ===")
    r = simulate(0.90, 5, 3 * DAY, wait=900.0, lag=True, poke=4.0, n_paths=4_000_000, seed=12)
    print(fmt(r, ["ev", "se", "p_crash", "fee_accrued_at_tick", "fee_accrued_at_close", "fee_paid_per_round",
                  "fee_paid_given_close", "gross_given_close", "share_per_round", "mean_dur_h"]))
    print("   same, ignoring the slow-price lag at the close (fill at mid):")
    r = simulate(0.90, 5, 3 * DAY, wait=900.0, lag=False, n_paths=4_000_000, seed=13)
    print("  ", fmt(r, ["ev", "se", "fee_paid_per_round", "gross_given_close"]))
    print("   same, lag with NO pokes (single on-chain update at the close, dt = 900 s):")
    r = simulate(0.90, 5, 3 * DAY, wait=900.0, lag=True, poke=0.0, n_paths=4_000_000, seed=14)
    print("  ", fmt(r, ["ev", "se", "fee_paid_per_round", "gross_given_close"]))

    print("\n=== (B) brute-force fixed-step check of the same thing (dt = 30 s pokes) ===")
    b = brute_force(0.90, 5, 3 * DAY, wait=900.0, dt=30.0, n_paths=400_000, seed=5)
    print(f"ev={b['ev']:+.5f} se={b['se']:.5f} fee_paid={b['fee_paid']:.5f} unfinished={b['unfinished']:.4f}")
    r = simulate(0.90, 5, 3 * DAY, wait=900.0, lag=True, poke=30.0, n_paths=4_000_000, seed=15)
    print("   event-driven with 30 s pokes for comparison:", fmt(r, ["ev", "se", "fee_paid_per_round"]))

    print("\n=== wait-time sweep (0.90/5x, tau=3d, 4 s pokes) ===")
    for w in (0, 300, 600, 900, 1200, 1500, 1800, 2700, 3600):
        r = simulate(0.90, 5, 3 * DAY, wait=float(w), lag=True, poke=4.0, n_paths=2_000_000, seed=20 + w)
        print(f"wait={w:>5}s  ev={r['ev']:+.5f} (se {r['se']:.5f})  fee_paid={r['fee_paid_per_round']:.5f}  gross|close={r['gross_given_close']:.5f}")
