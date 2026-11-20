"""
E6.  Repeated re-opening for one day (200,000 paths), whole-cent reference steps, slow price modelled.
The trader keeps $1 of margin at work: as soon as a position ends, the next one is opened.
Reference speed from the venue's own model, variance p(1-p)/tau per second:
   30 days out: 83 one-cent changes a day at 50c  (lam*tau_s = 0.29);   11 days out: 227 a day (0.79).
honest : YES at the maximum integer leverage for the current price, held to the cap or liquidation
tuned  : only at prices where an integer leverage puts the stop line 2.5-2.7 ticks away (the pocket)
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import lattice_value, regime, max_int_leverage

NP = 200_000
TAU_S = 300.0
h, st, pr = regime("full")
K = int(round(1 / h)) + 1


def lam_for(days, p=0.5):
    return p * (1 - p) / (days * 86400.0 * h * h)


def honest_tables(days):
    lev = np.zeros(K)
    for k in range(2, K - 2):
        lev[k] = max_int_leverage(k * h, days * 86400.0)
    return lev, np.full(K, np.inf)


def tuned_tables(days, min_ev=0.01):
    lev = np.zeros(K)
    tpk = np.full(K, np.inf)
    for k in range(5, 60):
        p0 = k * h
        best = (min_ev, 0, np.inf)
        for L in range(2, max_int_leverage(p0, days * 86400.0) + 1):
            r = lattice_value(p0, L, h, st, pr, policy="optimal")
            if r["ev"] > best[0]:
                pos = [s_ for s_ in r["stop_set"] if s_ > 0]
                best = (r["ev"], L, min(pos) if pos else np.inf)
        lev[k], tpk[k] = best[1], best[2]
    return lev, tpk


def report(label, r, days_h=1.0):
    tot = r["pnl"]
    mu, se = stat(tot)
    nb = r["nb"].mean()
    print(f"   {label:<40} P&L per day per $1 margin at work {mu:+.4f} +-{se:.4f} | bets/day {nb:6.2f} | per bet {mu / max(nb, 1e-9):+.4f} | "
          f"fee/day {r['fee'].mean():.4f} liqcut/day {r['liqcut'].mean():.4f} clamp gain/day {r['under'].mean():.4f} "
          f"entry cost/day {r['entry_cost'].mean():.4f} | P(day P&L > 0) {np.mean(tot > 0):.3f}")


for days in [30, 11]:
    lam = lam_for(days)
    print(f"\n=== {days} days to expiry: {lam * 86400:.0f} one-cent changes per day at 50c, lam*tau_s = {lam * TAU_S:.2f} ===")
    lev, tpk = honest_tables(days)
    for eps_in, lab in [(0.02, "honest, patient re-entry"), (np.inf, "honest, immediate re-entry")]:
        leg = Leg(+1, lev, tpk, tp_eps=0.1, eps_in=eps_in)
        r = run(NP, 50, h, st, pr, lam=lam, legs=[leg], tau_s=TAU_S, repeat=True, horizon_time=86400.0, seed=41, settle_at_end=True)[0]
        report(lab + " (start 50c)", r)
    legs = [Leg(+1, lev, tpk, tp_eps=0.1, eps_in=0.02), Leg(-1, lev, tpk, tp_eps=0.1, eps_in=0.02)]
    ry, rn = run(NP, 50, h, st, pr, lam=lam, legs=legs, tau_s=TAU_S, repeat=True, horizon_time=86400.0, seed=42, settle_at_end=True)
    tot = (ry["pnl"] + rn["pnl"]) / 2
    mu, se = stat(tot)
    print(f"   {'honest, both sides re-opened':<40} P&L per day per $1 margin at work {mu:+.4f} +-{se:.4f} | bets/day per side {ry['nb'].mean():.2f}/{rn['nb'].mean():.2f}")
    lev_t, tpk_t = tuned_tables(days)
    ks = [k for k in range(K) if lev_t[k] > 0]
    print(f"   pocket prices on the whole-cent grid: {len(ks)} of 55 between 5c and 59c, e.g. " + ", ".join(f"{k}c@{int(lev_t[k])}x" for k in ks[:12]))
    for k0 in [46, 26, 20]:
        leg = Leg(+1, lev_t, tpk_t, tp_eps=0.1, eps_in=0.02)
        r = run(NP, k0, h, st, pr, lam=lam, legs=[leg], tau_s=TAU_S, repeat=True, horizon_time=86400.0, seed=43 + k0, settle_at_end=True)[0]
        report(f"tuned pocket re-opener (start {k0}c)", r)
    sys.stdout.flush()
