import time
from model import *
cor = Corridor(0.5, 25)
print(cor)
t=time.time()
# 1. no slow price, passive, TP at cap, no look-ahead: gambler's ruin -> -0.05
sol = solve_dp(cor, lam=1/270, tau=1e-9, q=0.0, la_nonliq=False, la_liq=False, mode="passive", tp_frac=1.0, ds=0.01)
print("no-slow passive honest V(0,0)=%.5f (expect -0.05)  V(1,0)=%.5f (expect 0.425) iters=%d %.1fs" % (value_at(sol,0,0), value_at(sol,1,0), sol["iters"], time.time()-t))
t=time.time()
sol = solve_dp(cor, lam=1/270, tau=1e-9, q=1.0, la_nonliq=False, la_liq=True, mode="passive", tp_frac=1.0, ds=0.01)
print("no-slow passive+dodge V(0,0)=%.5f (expect 0.20)  V(1,0)=%.5f (expect 0.55) iters=%d %.1fs" % (value_at(sol,0,0), value_at(sol,1,0), sol["iters"], time.time()-t))
t=time.time()
sol = solve_dp(cor, lam=1/270, tau=300, q=0.0, la_nonliq=False, la_liq=False, mode="passive", tp_frac=0.9, ds=0.005)
print("slow300 passive TP0.9 honest V(0,0)=%.5f V(1,0)=%.5f iters=%d %.1fs dt=%.2f" % (value_at(sol,0,0), value_at(sol,1,0), sol["iters"], time.time()-t, sol["dt"]))
t=time.time()
sol = solve_dp(cor, lam=1/270, tau=300, q=1.0, mode="opt", ds=0.005)
print("slow300 optimal q=1 V(0,0)=%.5f V(1,0)=%.5f iters=%d %.1fs" % (value_at(sol,0,0), value_at(sol,1,0), sol["iters"], time.time()-t))
