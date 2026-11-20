"""Fee reset attack in a tick-quantised 'favourite that can only crash' market.
Rules modelled: free mode clamp, worse-of close (slow lags after an up-tick, tau_slow=300s),
crowding fee = B*skewFrac*(1-p_s)/max(tau,3600) per second (skewFrac=1: attacker alone on side),
fee taken from profit only, 10% profit share on (profit-fee), crash -> lose margin M=1.
Two tick-timing models:
  DET : uniform-crash model, mid = true prob floored to tick; tick at t1 = tau0*(1-p0/p1)/q.
  POI : martingale chain, up-tick rate mu=(1-p)/(tick*tau), crash rate lam=mu*tick/p (exp. times).
One round = open at p0 (mid==slow==p0, fair), wait for one up-tick, wait w sec for slow, close.
"""
import numpy as np, sys
rng = np.random.default_rng(7)
TICK, TSLOW, FLOOR, PSHARE = 0.01, 300.0, 3600.0, 0.10

def run(p0, L, tau0, model, N=1_000_000, w=900.0, Delta=600.0, kticks=1, rate_kind="spec"):
    q = 1 - p0; p1 = p0 + kticks*TICK
    n = L/p0; B = (L-1)/p0; C = (1-p0)/p0
    if model == "DET":
        t1 = np.full(N, tau0*(1-p0/p1)/q)
        u = rng.random(N); tc = np.where(u < q, tau0*u/q, np.inf)       # crash time
    else:  # POI: kticks independent levels, each exp; crash competes at each level
        t1 = np.zeros(N); tc = np.full(N, np.inf); alive = np.ones(N, bool)
        for k in range(kticks):
            p = p0 + k*TICK; mu = (1-p)/(TICK*tau0); lam = mu*TICK/p
            tu = rng.exponential(1/mu, N); tx = rng.exponential(1/lam, N)
            crash = alive & (tx < tu)
            tc = np.where(crash, t1 + tx, tc); alive &= ~crash
            t1 = t1 + tu
        # crash during the post-tick wait w at level p1
        lam1 = (1-p1)/(TICK*tau0)*TICK/p1
        tx = rng.exponential(1/lam1, N)
        tc = np.where(alive & (tx < w), t1 + tx, tc)
    tend = t1 + w
    win = tc > tend
    fill = p1 - TICK*np.exp(-w/TSLOW)                 # sell at min(mid, slow)
    def rate(p, tau):                                  # per borrowed share per second
        tau = np.maximum(tau, FLOOR)
        return ((1-p) if rate_kind == "spec" else p*(1-p))/tau
    # fee accrued over [a, t1] at level price (approx: last level price p1-TICK, tau at midpoint) + w at p1
    def fee_from(a):
        pl = p1 - TICK
        return B*(rate(pl, tau0-(a+t1)/2)*(t1-a) + rate(p1, tau0-t1-w/2)*w)
    out = {}
    def pnl(Lev, F):
        nn = Lev/p0; gross = np.minimum(nn*(fill-p0), C)
        fee = np.minimum(F, gross); net = (gross-fee)*(1-PSHARE)
        return np.where(win, net, -1.0), np.where(win, fee, 0.0)
    zero = np.zeros(N)
    out["1x outright"] = pnl(1, zero)
    out["lev, fee OFF"] = pnl(L, zero)
    # no gaming: for kticks>1 integrate level by level (DET only uses avg price; fine for k=1)
    out["lev, fee, hold"] = pnl(L, fee_from(zero))
    clock = rng.random(N)*Delta                        # time since last flat reset when the tick lands
    a = np.maximum(t1 - clock, 0.0)
    out["lev, fee, RESET"] = pnl(L, fee_from(a))
    # balanced pair: YES L + NO L equal shares (skewFrac=0 -> no fee). NO margin = n*(1-p0)/L
    Mn = n*(1-p0)/L; yes, _ = pnl(L, zero)
    no_loss = np.minimum(n*kticks*TICK, Mn)            # NO sells at min(mid,slow)=mid after YES up-tick
    no_win = Mn*p0/(1-p0)*(1-PSHARE)                   # crash: NO capped at C_n
    pair = np.where(win, yes - no_loss, -1.0 + no_win)/(1+Mn)
    out["balanced pair /$"] = (pair, zero)
    print(f"\n{model} p0={p0} L={L} tau0={tau0/86400:.1f}d kticks={kticks} w={w:.0f}s Delta={Delta:.0f}s rate={rate_kind} "
          f"N={N:,}  P(win)={win.mean():.4f}  mean hold={np.where(win,tend,np.minimum(tc,tend)).mean()/3600:.2f}h")
    for k, (x, f) in out.items():
        print(f"  {k:18s} EV/$margin={x.mean():+.5f} (se {x.std(ddof=1)/np.sqrt(N):.5f})   fee paid/$={f.mean():.5f}")
    return out

if __name__ == "__main__":
    for model in ("DET", "POI"):
        run(0.90, 5, 3*86400, model)
        run(0.90, 5, 3*86400, model, rate_kind="code")
    run(0.80, 10, 7*86400, "POI"); run(0.95, 2, 7*86400, "POI"); run(0.60, 20, 7*86400, "POI")
    run(0.90, 5, 3*86400, "POI", kticks=2)
