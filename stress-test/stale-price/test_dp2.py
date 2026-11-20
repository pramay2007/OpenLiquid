import time
from model import *
cor = Corridor(0.5, 25)
for ds, dt in [(0.01,3.0),(0.005,3.0),(0.002,3.0),(0.002,1.5),(0.001,1.0)]:
    t=time.time()
    sol = solve_dp(cor, lam=1/270, tau=300, q=0.75, mode="opt", ds=ds, dt=dt)
    solp = solve_dp(cor, lam=1/270, tau=300, q=0.0, la_nonliq=False, la_liq=False, mode="passive", tp_frac=0.9, ds=ds, dt=dt)
    print("ds=%.3f dt=%.1f  opt q=.75: V(0,0)=%.5f V(1,0)=%.5f | passive honest V(0,0)=%.5f V(1,0)=%.5f  iters=%d,%d  %.1fs" % (
        ds, dt, value_at(sol,0,0), value_at(sol,1,0), value_at(solp,0,0), value_at(solp,1,0), sol["iters"], solp["iters"], time.time()-t))
