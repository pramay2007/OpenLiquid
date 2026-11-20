import time
from model import *
from mc import run, fmt
if __name__ == "__main__":
    cor = Corridor(0.5, 25)
    lam = 1/270
    t=time.time()
    r = run(n=200_000, seed=11, cor=cor, lam=lam, d=2, J=0, policy="passive", tp_frac=0.9)
    print("honest passive TP0.9      :", fmt(r), " [%.0fs]" % (time.time()-t))
    solp = solve_dp(cor, lam, q=0.0, la_nonliq=False, la_liq=False, mode="passive", tp_frac=0.9, ds=0.005)
    print("   DP V(0,0) = %.4f   V(1,0) = %.4f" % (value_at(solp,0,0), value_at(solp,1,0)))
    t=time.time()
    r = run(n=200_000, seed=12, cor=cor, lam=lam, d=2, J=1, policy="passive", tp_frac=0.9)
    print("entry-snipe passive (d=2) :", fmt(r), " [%.0fs]" % (time.time()-t))
    t=time.time()
    r = run(n=200_000, seed=13, cor=cor, lam=lam, d=1, J=1, policy="passive", tp_frac=0.9)
    print("entry-snipe passive (d=1) :", fmt(r), " [%.0fs]" % (time.time()-t))
