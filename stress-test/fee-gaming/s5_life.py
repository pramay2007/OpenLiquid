"""Tick-by-tick reset scalping from 0.90 to 0.97 at the leverage E3 allows at each level
(L <= floor((1-p)/0.02)); sums per-round EVs (Poisson tick model, s1.run)."""
import io, contextlib, numpy as np
import s1_reset as s
tot = {"lev, fee OFF": 0.0, "lev, fee, hold": 0.0, "lev, fee, RESET": 0.0, "1x outright": 0.0}; var = dict.fromkeys(tot, 0.0)
surv = 1.0
for p in (0.90, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96):
    L = int(np.floor((1-p)/0.02 + 1e-9))
    with contextlib.redirect_stdout(io.StringIO()):
        out = s.run(p, L, 3*86400, "POI", N=400_000)
    row = []
    for k in tot:
        x = out[k][0]; tot[k] += surv*x.mean(); var[k] += (surv*x.std(ddof=1))**2/len(x); row.append(f"{k}={x.mean():+.4f}")
    print(f"p={p:.2f} L={L}: " + "  ".join(row))
    surv *= p/(p+0.01)
print("\nSum over the 7 levels, per $1 of margin redeployed each round (weighted by survival to that level):")
for k in tot: print(f"  {k:16s} {tot[k]:+.4f} (se {np.sqrt(var[k]):.4f})")
print(f"  P(crash somewhere on the way) = {1-surv:.3f}")
