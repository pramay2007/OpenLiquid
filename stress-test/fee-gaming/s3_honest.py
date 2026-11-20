"""Cost of the crowding fee to an HONEST leveraged trader on the crowded side of a DIFFUSIVE event
market (no one-sided jumps).  Mid = symmetric +-1 tick walk, tick rate nu = v*p0(1-p0)/(tau*TICK^2)
(Augenblick-Rabin variance spread evenly over tau; v = speed multiplier).  Free mode, skewFrac=1.
Exit: win line (cap C) or liquidation trigger (equity<=20% M at mid; liquidator 5% M).  Simplification:
closes fill at the mid (slow-price lag ignored), tau held at tau0 (holding times << tau0).
Fee variants: spec (1-p_s)/tau | code p(1-p)/tau | fix = spec*2 + one-tick debit.  10% profit share."""
import numpy as np
rng = np.random.default_rng(5)
TICK, PS = 0.01, 0.10
def run(p0, L, tau0, v=1.0, N=400_000):
    n = L/p0; B = (L-1)/p0; C = (1-p0)/p0
    up = int(np.ceil((1-p0)/L/TICK - 1e-9)); dn = int(np.ceil(0.8*p0/L/TICK - 1e-9))
    nu = v*p0*(1-p0)/(tau0*TICK**2)
    k = np.zeros(N, int); live = np.ones(N, bool); As = np.zeros(N); Ac = np.zeros(N); T = np.zeros(N)
    while live.any():
        m = live.sum(); dt = rng.exponential(1/nu, m); p = p0 + k[live]*TICK
        As[live] += (1-p)/tau0*dt; Ac[live] += p*(1-p)/tau0*dt; T[live] += dt
        k[live] += np.where(rng.random(m) < 0.5, 1, -1)
        live &= (k < up) & (k > -dn)
    win = k >= up
    gross = min(n*up*TICK, C); loss = min(n*dn*TICK, 1.0)
    lossnet = min(loss + 0.05, 1.0)                       # liquidator's 5% out of remaining equity
    res = {}
    for name, F in (("no fee", 0*As), ("spec", B*As), ("code", B*Ac), ("fix", B*(2*As + TICK))):
        fee = np.minimum(F, gross); x = np.where(win, (gross-fee)*(1-PS), -lossnet)
        res[name] = (x.mean(), x.std(ddof=1)/np.sqrt(N), fee[win].mean()/gross)
    print(f"p0={p0} L={L} tau={tau0/86400:.0f}d v={v}: win {up} ticks / liq {dn} ticks, P(win)={win.mean():.3f}, "
          f"mean hold {T.mean()/3600:.1f}h")
    for kname, (m_, se, fr) in res.items():
        print(f"    {kname:6s} EV/$margin={m_:+.4f} (se {se:.4f})  fee = {100*fr:5.1f}% of a win")
for a in ((0.5, 10, 7*86400), (0.5, 25, 7*86400), (0.5, 5, 7*86400), (0.8, 10, 7*86400), (0.9, 5, 7*86400),
          (0.2, 5, 7*86400), (0.2, 10, 7*86400), (0.1, 5, 7*86400), (0.5, 10, 7*86400, 5.0), (0.2, 5, 7*86400, 5.0)):
    run(*a)
