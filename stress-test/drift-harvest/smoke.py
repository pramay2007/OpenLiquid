import time
from ol_sim import simulate, fmt, DAY
N = 20000
base = dict(N=N, seed=5, T=30*DAY, p0=0.5, H=5*DAY, dt=300.0)
runs = [
 ("1x benchmark", dict(strategy="one", fee_mode="E4")),
 ("cap, no fee", dict(strategy="cap", fee_mode="none")),
 ("cap, E4 sf=1", dict(strategy="cap", fee_mode="E4")),
 ("cap, E4 sf=0.5", dict(strategy="cap", fee_mode="E4", sf=0.5)),
 ("bank, no fee", dict(strategy="bank", fee_mode="none")),
 ("bank+reset 1h, E4 sf=1", dict(strategy="bank", fee_mode="E4", reset_every=3600.0)),
 ("bank no reset, E4 sf=1", dict(strategy="bank", fee_mode="E4", reset_every=1e18)),
 ("bank+reset, E4 + 1-tick entry fee", dict(strategy="bank", fee_mode="E4", entry_ticks=1.0)),
 ("bank+reset, E4 + carry", dict(strategy="bank", fee_mode="E4", carry=True)),
 ("bank+reset, E4, contract slow (exp)", dict(strategy="bank", fee_mode="E4", slow_mode="exp")),
]
for name, kw in runs:
    t0 = time.time()
    r = simulate(**{**base, **kw})
    print(f"{name:38s} {fmt(r)}  [{time.time()-t0:.1f}s]")
