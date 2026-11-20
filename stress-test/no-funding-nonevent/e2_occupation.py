"""
(i) Liquidity occupation: a hedged long + short held only to lock vault reserve and side capacity.

Part A (this file, coarse grid): leverage 1..50, one year, hourly GBM steps (martingale).
  Each leg has notional N (=1 here), margin N/L, reserve min(10M, N) = N*min(10/L, 1).
  Attacker policy 'run'      : a losing leg is closed by its owner at a loss of 75% of margin
                               (free; just inside the 80% liquidation trigger) and re-opened at the
                               same price; winners are left alone until the cap forces a collect.
                  'rebalance': at every stop both legs are closed (winner pays the 5% share) and
                               re-opened, so no extra cash is ever needed.
  Threshold crossings are executed at the threshold price (the keeper's 1-second grid is ~0.9 bp
  per step at 50% vol, negligible against stops that are >= 1.5% away).  Fills are taken at the mid:
  at these leverages the attacker can wait for a second in which mid == slow at no cost (see e2b).
  tmax_h > 0 adds the proposed rule "any position older than tmax may be closed by anyone at the
  normal close price": both legs are rolled every tmax hours (winner pays the share).
Outputs are per $1 of notional per leg unless stated; the pair locks 2*min(10/L,1) of reserve and
occupies $1 of capacity on each side.
"""
import sys, math, time
import numpy as np
from olsim import PROFIT_SHARE, CAP_MULT, SEC_YEAR, mean_se, fmt, run_parallel

HOURS_YEAR = 365 * 24


def occ_worker(args):
    (n, sigma_ann, L, days, seed, policy, tmax_h, snaps) = args
    rng = np.random.default_rng(seed)
    dt = 1.0 / HOURS_YEAR
    sd = sigma_ann * math.sqrt(dt)
    capf = min(CAP_MULT / L, 1.0)
    stopf = 0.75 / L
    S = np.ones(n)
    pL = np.ones(n); pS = np.ones(n)
    tax = np.zeros(n); gross = np.zeros(n); nstop = np.zeros(n); ncap = np.zeros(n)
    cash = np.zeros(n)           # cumulative realised cash flow to the attacker (after tax)
    peak = np.zeros(n)           # largest cumulative cash shortfall so far
    age = 0
    res = {}
    steps = days * 24
    for k in range(1, steps + 1):
        S = S * np.exp(sd * rng.standard_normal(n) - 0.5 * sd * sd)
        for _ in range(3):
            # long leg: stop below, cap above
            hitS = S <= pL * (1 - stopf)
            hitC = S >= pL * (1 + capf)
            # short leg: stop above, cap below (only if cap < 100% move)
            hitS2 = S >= pS * (1 + stopf)
            hitC2 = (S <= pS * (1 - capf)) if capf < 1 else np.zeros(n, bool)
            if not (hitS.any() or hitC.any() or hitS2.any() or hitC2.any()):
                break
            if policy == "rebalance":
                st = hitS | hitS2
                if st.any():
                    # the stop is executed at the threshold price x; both legs closed there
                    x = np.where(hitS, pL * (1 - stopf), pS * (1 + stopf))[st]
                    gl = x / pL[st] - 1.0
                    gs = 1.0 - x / pS[st]
                    g = np.minimum(gl, capf) + np.minimum(gs, capf)
                    t = PROFIT_SHARE * (np.maximum(np.minimum(gl, capf), 0) + np.maximum(np.minimum(gs, capf), 0))
                    gross[st] += g; tax[st] += t; cash[st] += g - t; nstop[st] += 1
                    pL[st] = x; pS[st] = x
                continue_mask = None
            else:
                if hitS.any():
                    gross[hitS] -= stopf; cash[hitS] -= stopf; nstop[hitS] += 1
                    pL[hitS] = pL[hitS] * (1 - stopf)
                if hitS2.any():
                    gross[hitS2] -= stopf; cash[hitS2] -= stopf; nstop[hitS2] += 1
                    pS[hitS2] = pS[hitS2] * (1 + stopf)
            if hitC.any():
                gross[hitC] += capf; tax[hitC] += PROFIT_SHARE * capf; cash[hitC] += capf * (1 - PROFIT_SHARE)
                ncap[hitC] += 1; pL[hitC] = pL[hitC] * (1 + capf)
            if hitC2.any():
                gross[hitC2] += capf; tax[hitC2] += PROFIT_SHARE * capf; cash[hitC2] += capf * (1 - PROFIT_SHARE)
                ncap[hitC2] += 1; pS[hitC2] = pS[hitC2] * (1 - capf)
        age += 1
        if tmax_h and age >= tmax_h:
            gl = np.minimum(S / pL - 1.0, capf); gs = np.minimum(1.0 - S / pS, capf)
            t = PROFIT_SHARE * (np.maximum(gl, 0) + np.maximum(gs, 0))
            gross += gl + gs; tax += t; cash += gl + gs - t
            pL = S.copy(); pS = S.copy(); age = 0
        peak = np.maximum(peak, -cash)
        if k in snaps:
            ul = np.minimum(S / pL - 1.0, capf); us = np.minimum(1.0 - S / pS, capf)
            exit_tax = PROFIT_SHARE * (np.maximum(ul, 0) + np.maximum(us, 0))
            d = k // 24
            res[f"tax_run_{d}"] = tax.copy()
            res[f"tax_exit_{d}"] = exit_tax
            res[f"pretax_{d}"] = gross + ul + us
            res[f"nstop_{d}"] = nstop.copy()
            res[f"ncap_{d}"] = ncap.copy()
            res[f"peak_{d}"] = peak.copy()
    return res


if __name__ == "__main__":
    NP = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
    W = 8
    per = NP // W
    days = 365
    snaps = {7 * 24, 30 * 24, 365 * 24}
    t0 = time.time()
    print("Hedged pair held to lock reserve/capacity.  Units: $ per $1 of notional per leg.")
    print("pair capital = 2/L, pair reserve locked = 2*min(10/L,1), capacity occupied = 1 per side\n")
    for sigma in (0.5, 0.15):
        for L in (1, 2, 5, 10, 20, 50):
            for policy, tmax in (("run", 0), ("rebalance", 0), ("run", 24)):
                if policy == "rebalance" and L not in (10, 50):
                    continue
                if tmax and L != 10:
                    continue
                args = [(per, sigma, L, days, 7000 + 31 * i + L + int(1000 * sigma) + tmax, policy, tmax, snaps) for i in range(W)]
                o = run_parallel(occ_worker, args, W)
                capf = min(CAP_MULT / L, 1.0)
                R = 2 * capf; C = 2.0 / L
                tag = f"vol={int(100*sigma)}% L={L:<3d} policy={policy}{'+Tmax24h' if tmax else ''}"
                print(f"--- {tag}:  capital {C:.3f}, reserve locked {R:.2f} (ratio {R/C:.0f}:1)")
                for d in (7, 30, 365):
                    run = o[f"tax_run_{d}"]; ex = o[f"tax_exit_{d}"]; tot = run + ex
                    m, s = mean_se(tot)
                    pk = o[f"peak_{d}"]
                    yrs = d / 365.0
                    print(f"   {d:>3d}d: stops/pair {o[f'nstop_{d}'].mean():6.2f}  caps {o[f'ncap_{d}'].mean():5.3f}  "
                          f"profit share paid {100*m:7.4f}% +/- {100*s:.4f}% of notional (running {100*run.mean():.4f}%, on exit {100*ex.mean():.4f}%)"
                          f"  = {100*m/R/yrs:6.3f}%/yr of reserve locked, {100*m/C/yrs:7.2f}%/yr of margin posted;"
                          f"  extra cash to re-margin: mean {pk.mean():.3f}, p95 {np.quantile(pk,0.95):.3f};"
                          f"  pre-tax P&L {fmt(o[f'pretax_{d}'],'',5)}")
                print(f"   [elapsed {time.time()-t0:.0f}s]", flush=True)
