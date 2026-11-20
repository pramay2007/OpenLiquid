"""Exact expectations (uniform-crash model, mid floored to tick, M=1, 10% profit share).
Slow-price lag on the close is ignored here (it is in s1/s2)."""
import numpy as np
from scipy.integrate import quad
TICK, PS = 0.01, 0.10
def tk(p0, p, tau0): return tau0*(1-p0/p)/(1-p0)                   # time the true prob reaches p
def fee_int(p0, pwin, tau0, floor, kind="spec"):                    # per borrowed share, mid=floor(true)
    tot, p = 0.0, p0
    while p < pwin - 1e-12:
        a, b = tk(p0, p, tau0), tk(p0, p+TICK, tau0)
        g = (1-p) if kind == "spec" else p*(1-p)
        tot += quad(lambda t: g/max(tau0-t, floor), a, b)[0]; p += TICK
    return tot
def ev(p0, L, tau0, floor=3600.0, fee_on=True, skew=1.0, boost=False, kind="spec"):
    n, B, C = L/p0, (L-1)/p0, (1-p0)/p0
    pwin = p0 + np.ceil((1-p0)/L/TICK - 1e-9)*TICK
    pw = p0/pwin; F = B*skew*fee_int(p0, pwin, tau0, floor, kind) if fee_on else 0.0
    gross = min(n*(pwin-p0), C)
    return pw*(gross-min(F, gross))*(1-PS) - (1-pw), F, gross
print("== 1. tau floor (fee rate uses max(tau,3600)); stale 5x at p0=0.90 that was not force-closed ==")
for tau0 in (3*86400, 7200, 3600, 1800, 600):
    a = ev(0.90, 5, tau0, 3600.0); b = ev(0.90, 5, tau0, 1e-9); c = ev(0.90, 5, tau0, fee_on=False)
    print(f"  tau0={tau0:>7.0f}s  EV floor={a[0]:+.4f} (fee {a[1]:.4f})   no floor={b[0]:+.4f} (fee {b[1]:.4f})   fee off={c[0]:+.4f}")
print("   leverage E3 still allows at tau (Ltime = min(p,1-p)/(3*sqrt(p(1-p)*120/tau))):")
for p in (0.5, 0.7, 0.9):
    print("    p=%.1f: " % p + ", ".join(f"tau={t/3600:.2f}h->{min(p,1-p)/(3*np.sqrt(p*(1-p)*120/t)):.2f}x" for t in (600, 1800, 3600, 7200, 38880, 86400)))
print("== 2. accrual charged at the price of the NEXT engine call for the whole interval ==")
for p, p2 in ((0.90, 0.91), (0.90, 0.95), (0.95, 0.96), (0.97, 0.98), (0.90, 0.99)):
    print(f"  interval at {p:.2f} accrued at {p2:.2f}: spec rate x{(1-p2)/(1-p):.3f}, code rate x{p2*(1-p2)/(p*(1-p)):.3f}")
print("== 3. offset fraction phi of borrowed shares held on NO at same leverage (one-tick round, p0=.90, L=5) ==")
p0, L = 0.90, 5; n, B = L/p0, (L-1)/p0; p1 = p0+TICK; pw = p0/p1
Fl = B*fee_int(p0, p1, 3*86400, 3600.0)
for phi in (0, 0.25, 0.5, 0.75, 1.0):
    nn = phi*n; Mn = nn*(1-p0)/L                       # NO shares, NO margin (same L => same borrowed frac)
    yes = pw*(n*TICK - min(Fl*(1-phi), n*TICK))*(1-PS) - (1-pw)
    no = pw*(-nn*TICK) + (1-pw)*Mn*p0/(1-p0)*(1-PS)
    print(f"  phi={phi:.2f}: fee saved {Fl*phi*pw:.4f}, NO-leg EV {no:+.4f}, total EV {yes+no:+.4f} on margin {1+Mn:.3f} -> {(yes+no)/(1+Mn):+.4f}/$")
print("== 4. Boost vs crowding fee, one-tick round p0=.90 L=5 (premium = fee at skewFrac 1, taken from equity) ==")
prem = Fl
print(f"  free, fee paid honestly: EV {pw*(n*TICK-min(Fl,n*TICK))*(1-PS)-(1-pw):+.4f};  boosted: EV {pw*(n*TICK-prem)*(1-PS)-(1-pw)*1.0:+.4f} "
      f"(premium {prem:.4f} also lost when it crashes: loss stays capped at M)")
print("== 5. scheduled one-sided step: p 0.50 -> 0.55 (90%) / 0.05 (10%), open 60 s before, tau=3d, L=15 ==")
p0, L, tau = 0.5, 15, 3*86400; B = (L-1)/p0; C = (1-p0)/p0
t_slow = 300*np.log(0.05/(0.55-(p0+(1-p0)/L)))          # wait for slow to reach the win line
fee = B*((1-p0)/tau*60 + (1-0.55)/tau*t_slow)
for deb in (0, 1):
    f = fee + deb*B*TICK
    print(f"  debit={deb}: fee {f:.4f} of a win {C:.2f}; EV/$ = {0.9*(C-f)*(1-PS)-0.1:+.4f}   (1x outright: {0.9*(0.05/0.5)*(1-PS)-0.1*0.9:+.4f})")
