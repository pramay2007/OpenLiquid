"""
E4.  Monte Carlo with the slow price and worse-of fills modelled (400,000 paths per cell).

lam*tau_s = expected number of reference mid changes per slow-price time constant (300 s).
Under the venue's own volatility model (variance p(1-p)/tau per second) and 1-cent steps this is
0.29 for a 50c market 30 days out, 0.79 at 11 days, 0.012 two years out.

A. honest single corridor bet, patient entry (slow == mid), close just under the cap
B. same bet entered at a random time at whatever the worse-of fill is (naive)
C. the stop-line pocket (whole-cent reference steps)
D. both sides at once
"""
import sys
import numpy as np
from engine import Leg, run, stat, table_const
from lattice import lattice_value, regime

NP = 400_000
TAU_S = 300.0
LTS = [0.01, 0.1, 0.3, 1.0]


def one(p0, L, tpk, lt, h, st, pr, tp_eps=0.02, eps_in=0.02, burn=0.0, seed=0, slow_rule="exp", fix=None, np_=NP):
    leg = Leg(+1, table_const(h, L), table_const(h, tpk), tp_eps=tp_eps, eps_in=eps_in)
    r = run(np_, int(round(p0 / h)), h, st, pr, lam=lt / TAU_S, legs=[leg], tau_s=TAU_S, seed=seed,
            burn_time=burn, slow_rule=slow_rule, liq_buffer_ticks=fix)[0]
    return r


def line(label, r):
    mu, se = stat(r["pnl"])
    nb = r["nb"].mean()
    return (f"{label:<34} EV {mu:+.4f} +-{se:.4f} | P(win) {r['nwin'].mean():.4f} P(liq) {r['nliq'].mean():.4f} | "
            f"fee {r['fee'].mean():.4f} liqcut {r['liqcut'].mean():.4f} clamp gain {r['under'].mean():.4f} "
            f"entry cost {r['entry_cost'].mean():.4f} exit lag {r['lagcost'].mean():.4f} | hold {r['dur'].mean() / 3600:.2f} h")


h, st, pr = regime("full")
which = sys.argv[1] if len(sys.argv) > 1 else "ABCD"

if "A" in which:
    print("A. honest single bet, patient entry, close when the worse-of price is within eps of the cap (whole-cent steps)")
    for p0, L in [(0.5, 25), (0.5, 10), (0.2, 10), (0.8, 10)]:
        ex = lattice_value(p0, L, h, st, pr, policy="hold")
        print(f"  p0={p0} L={L}: exact lattice (no slow lag) EV {ex['ev']:+.4f}, P(win) {ex['p_win']:.4f}; continuous-limit EV {-0.13 * (1 - p0) / (1 - 0.2 * p0):+.4f}")
        for lt in LTS:
            best = None
            for eps in [0.02, 0.1, 0.3]:
                r = one(p0, L, np.inf, lt, h, st, pr, tp_eps=eps, seed=11)
                mu, se = stat(r["pnl"])
                if best is None or mu > best[0]:
                    best = (mu, eps, r)
            print("   " + line(f"lam*tau={lt:<4} best eps={best[1]:<4}", best[2]))
        sys.stdout.flush()

if "B" in which:
    print("\nB. same bet, naive timing: opened at a random moment at the worse-of fill (30%-of-margin entry guard applies)")
    for p0, L in [(0.5, 25), (0.5, 10)]:
        for lt in [0.1, 0.3, 1.0]:
            r = one(p0, L, np.inf, lt, h, st, pr, tp_eps=0.1, eps_in=np.inf, burn=20 * TAU_S, seed=12)
            print("   " + line(f"p0={p0} L={L} lam*tau={lt}", r))
        sys.stdout.flush()

if "C" in which:
    print("\nC. the stop-line pocket: stop distance between 2.5 and 2.7 ticks, whole-cent reference steps")
    for p0, L, tpk in [(0.46, 18, np.inf), (0.205, 8, np.inf), (0.255, 10, 7), (0.18, 7, 11), (0.53, 21, 2)]:
        ex = lattice_value(p0, L, h, st, pr, policy="hold" if not np.isfinite(tpk) else "tp", tp_k=None if not np.isfinite(tpk) else tpk)
        print(f"  p0={p0} L={L} take-profit ticks={tpk}: exact lattice EV {ex['ev']:+.4f}, stop {ex['ds_ticks']:.3f} ticks, win {ex['dw_ticks']:.2f} ticks")
        for lt in LTS:
            best = None
            for eps in [0.02, 0.1, 0.3]:
                r = one(p0, L, tpk, lt, h, st, pr, tp_eps=eps, seed=13)
                mu, se = stat(r["pnl"])
                if best is None or mu > best[0]:
                    best = (mu, eps, r)
            print("   " + line(f"lam*tau={lt:<4} best eps={best[1]:<4}", best[2]))
        sys.stdout.flush()
    print("  with the brief's slow rule for one sparse update (slow += (mid-slow)*dt/(tau+dt)) instead of the exponential:")
    for lt in [0.1, 0.3]:
        r = one(0.46, 18, np.inf, lt, h, st, pr, tp_eps=0.1, seed=14, slow_rule="spec")
        print("   " + line(f"p0=0.46 L=18 lam*tau={lt} spec rule", r))
    print("  with the proposed fix (liquidatable when equity <= max(20% M, one tick of P&L)):")
    for p0, L, tpk in [(0.46, 18, np.inf), (0.205, 8, np.inf), (0.255, 10, 7)]:
        r = one(p0, L, tpk, 0.1, h, st, pr, tp_eps=0.02, seed=15, fix=1.0)
        print("   " + line(f"p0={p0} L={L} lam*tau=0.1 FIX", r))
    sys.stdout.flush()

if "D" in which:
    print("\nD. both sides at once (YES and NO, $1 margin each, same path): EV is per $1 of TOTAL margin")
    for p0, Ly, Ln in [(0.5, 25, 25), (0.5, 10, 10), (0.2, 10, 10), (0.46, 18, 18)]:
        for lt in [0.1, 0.3]:
            legs = [Leg(+1, table_const(h, Ly), table_const(h, np.inf), tp_eps=0.1),
                    Leg(-1, table_const(h, Ln), table_const(h, np.inf), tp_eps=0.1)]
            ry, rn = run(NP, int(round(p0 / h)), h, st, pr, lam=lt / TAU_S, legs=legs, tau_s=TAU_S, seed=21)
            tot = (ry["pnl"] + rn["pnl"]) / 2.0
            mu, se = stat(tot)
            my, sy = stat(ry["pnl"])
            mn, sn = stat(rn["pnl"])
            corr = np.corrcoef(ry["pnl"], rn["pnl"])[0, 1]
            print(f"   p0={p0} YES {Ly}x / NO {Ln}x lam*tau={lt}: EV {mu:+.4f} +-{se:.4f} per $1 total | YES leg {my:+.4f} +-{sy:.4f}, "
                  f"NO leg {mn:+.4f} +-{sn:.4f} | corr {corr:+.2f} | sd per $1: both {tot.std():.3f} vs single {ry['pnl'].std():.3f} | "
                  f"P(both legs win) {np.mean((ry['nwin'] > 0) & (rn['nwin'] > 0)):.4f}")
        sys.stdout.flush()
