"""Does a one-tick entry debit (profit-only) close the reset attack?  Poisson tick model (see s1).
fee = debit*B*TICK  +  hs * B * sum(rate*time since last flat reset), capped at profit.
Strategies: reset until tick 1 lands (clock~U(0,Delta)), then hold until K ticks, wait w, close.
'honest' = never resets.  Crash at any time -> -1.  10% profit share on (profit-fee)."""
import numpy as np
rng = np.random.default_rng(11)
TICK, TSLOW, PSHARE = 0.01, 300.0, 0.10
def run(p0, L, tau0, K, debit, hs, reset, N=1_000_000, w=900.0, Delta=600.0):
    n = L/p0; B = (L-1)/p0; C = (1-p0)/p0
    t = np.zeros(N); alive = np.ones(N, bool); acc = np.zeros(N)   # acc = time-fee per borrowed share
    for k in range(K):
        p = p0 + k*TICK; mu = (1-p)/(TICK*tau0); lam = mu*TICK/p; r = (1-p)/np.maximum(tau0 - t, 3600.0)
        tu = rng.exponential(1/mu, N); tx = rng.exponential(1/lam, N)
        alive &= tu < tx
        held = np.minimum(rng.random(N)*Delta, tu) if (reset and k == 0) else tu
        acc += r*held; t += tu
    p1 = p0 + K*TICK; lam1 = (1-p1)/(TICK*tau0)*TICK/p1
    alive &= rng.exponential(1/lam1, N) > w
    acc += (1-p1)/np.maximum(tau0 - t, 3600.0)*w
    fill = p1 - TICK*np.exp(-w/TSLOW)
    gross = min(n*(fill-p0), C)
    fee = np.minimum(B*(debit*TICK + hs*acc), gross)
    x = np.where(alive, (gross-fee)*(1-PSHARE), -1.0)
    o = np.where(alive, (min((fill-p0)/p0, C))*(1-PSHARE), -1.0)   # 1x outright, same path
    return x.mean(), x.std(ddof=1)/np.sqrt(N), np.where(alive, fee, 0).mean(), o.mean()
print("p0=0.90 L=5 tau0=3d, EV per $ margin per round (se), fee paid, [1x outright EV on same paths]")
for K in (1, 2):
    for (debit, hs) in ((0, 1), (1, 1), (1, 2), (0, 2), (0, 3)):
        for reset in (True, False):
            m, se, f, o = run(0.90, 5, 3*86400, K, debit, hs, reset)
            print(f"  K={K} debit={debit} hazardScale={hs} {'RESET ' if reset else 'honest'}: EV={m:+.5f} ({se:.5f}) fee={f:.5f}  [1x {o:+.5f}]")
print("p0=0.80 L=10 tau0=7d")
for (debit, hs) in ((0, 1), (1, 1), (1, 2)):
    for K in (1, 2, 3):
        m, se, f, o = run(0.80, 10, 7*86400, K, debit, hs, True)
        print(f"  K={K} debit={debit} hazardScale={hs} RESET : EV={m:+.5f} ({se:.5f}) fee={f:.5f}  [1x {o:+.5f}]")
