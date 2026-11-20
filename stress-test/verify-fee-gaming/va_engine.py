"""Independent re-simulation of the 'fee reset' claim: a path-by-path state machine of the venue
rules AS WRITTEN (R1 worse-of fills with the discrete slow update, R6 fresh signed price pushed
with every trade, E1/E2 free-mode clamp, E3 leverage limit incl. Ltime and permissionless
force-close, E4 crowding fee accrued per second at the prevailing price, R7 10% profit share).

Nothing here is copied from the analyst's scripts: the engine is event driven (every reset is an
actual close + open against engine state), not a closed-form shortcut.

Market models for one 'round' (position opened at p0, mid==slow==p0):
  DET  uniform-crash: true prob q(t)=p0/(1-(1-p0)t/tau0), mid=floor(q) -> tick at a fixed time,
       crash time uniform with total mass (1-p0).
  POI  martingale chain, constant rates over the round: up-tick mu=(1-p)/(tick*tau0), crash lam=mu*tick/p.
  POIT martingale chain with rates on the REMAINING time: mu(t)=(1-p)/(tick*(tau0-t)).
"""
import math, sys
import numpy as np

TICK, TAU_SLOW, FLOOR, PSHARE = 0.01, 300.0, 3600.0, 0.10
MAXGAP = 0.05


def ltime(p, tau, h=120.0):
    if tau <= 0:
        return 1.0
    return min(p, 1 - p) / (3.0 * math.sqrt(p * (1 - p) * h / tau))


def lmax(p, tau):
    return min(50.0, min(p, 1 - p) / 0.02 + 1e-9, ltime(p, tau))


class Engine:
    """One event market; the attacker trades YES and is alone on its side (skewFrac = 1)."""

    def __init__(self, mid, expiry, slow_mode="rule", rate_kind="spec", hs=1.0):
        self.t = 0.0
        self.mid = mid
        self.slow = mid
        self.t_upd = 0.0
        self.expiry = expiry
        self.slow_mode = slow_mode
        self.rate_kind = rate_kind
        self.hs = hs
        self.cum = 0.0          # crowding-fee index, USDC per borrowed YES share
        self.t_acc = 0.0
        self.B_yes = 0.0
        self.B_no = 0.0
        self.pos = None

    # E4: per-second accrual at the prevailing mid, tau floored at 1 hour (integrated exactly)
    def _accrue(self, t):
        if t <= self.t_acc:
            return
        if self.B_yes > self.B_no and self.B_yes > 0:
            skew = (self.B_yes - self.B_no) / self.B_yes
            p = self.mid
            g = (1 - p) if self.rate_kind == "spec" else p * (1 - p)
            a, b = self.expiry - self.t_acc, self.expiry - t
            if b >= FLOOR:
                integ = math.log(a / b)
            elif a <= FLOOR:
                integ = (a - b) / FLOOR
            else:
                integ = math.log(a / FLOOR) + (FLOOR - b) / FLOOR
            self.cum += self.hs * skew * g * integ
        self.t_acc = t

    # R1/R6: push a signed price newer than the one on-chain
    def push(self, t, mid):
        self._accrue(t)
        dt = t - self.t_upd
        if dt > 0:
            if self.slow_mode == "rule":          # slow += (previousMid - slow)*dt/(tau+dt)
                self.slow += (self.mid - self.slow) * dt / (TAU_SLOW + dt)
            else:                                  # deployed oracle: exact exponential
                self.slow = self.mid + (self.slow - self.mid) * math.exp(-dt / TAU_SLOW)
        self.mid = mid
        self.t_upd = t
        self.t = t

    def open_long(self, M, L, check_e3=True):
        tau = self.expiry - self.t
        assert tau > 0, "E3: no opens after expiry"
        assert abs(self.mid - self.slow) <= MAXGAP, "R2 gate"
        if check_e3:
            assert L <= lmax(self.mid, tau) + 1e-9, "E3 limit"
        p0 = max(self.mid, self.slow)               # a buy fills at max(mid, slow)
        n = M * L / p0
        B = n * (1 - 1 / L)
        self.B_yes += B
        self.pos = dict(M=M, L=L, p0=p0, n=n, B=B, C=M * (1 - p0) / p0, entry=self.cum)

    def close(self, at_mid=False):
        P = self.pos
        fill = self.mid if at_mid else min(self.mid, self.slow)   # a sell fills at min(mid, slow)
        pnl = max(-P["M"], min(P["C"], P["n"] * (fill - P["p0"])))
        fee = 0.0
        if pnl > 0:                                 # E4: fee only out of profit
            fee = min(P["B"] * (self.cum - P["entry"]), pnl)
            net = (pnl - fee) * (1 - PSHARE)        # R7: 10% of net profit
        else:
            net = pnl
        self.B_yes -= P["B"]
        self.pos = None
        return net, fee, pnl


def draw_round(model, p0, tau0, rng):
    q = 1 - p0
    p1 = p0 + TICK
    if model == "DET":
        t1 = tau0 * (1 - p0 / p1) / q
        u = rng.random()
        return t1, (tau0 * u / q if u < q else math.inf)
    if model == "POI":
        mu = (1 - p0) / (TICK * tau0)
        lam = mu * TICK / p0
        return rng.exponential(1 / mu), rng.exponential(1 / lam)
    if model == "POIT":            # P(no tick by t) = ((tau0-t)/tau0)^((1-p)/tick)
        k = (1 - p0) / TICK
        kc = k * TICK / p0
        return tau0 * (1 - rng.random() ** (1 / k)), tau0 * (1 - rng.random() ** (1 / kc))
    raise ValueError(model)


def one_round(t1, tc, phase, p0, L_target, tau0, *, reset=True, Delta=600.0, w=900.0, poke=None,
              slow_mode="rule", rate_kind="spec", e3="off", int_lev=False, crash_to=0.02, gas=0.0, M=1.0):
    """e3: 'off'  ignore Ltime after the first open (the analyst's simplification)
           'open' every (re-)open obeys the leverage limit in force at that moment
           'adv'  as 'open', and anyone force-closes the position the moment the tick puts it above Ltime
    """
    eng = Engine(p0, tau0, slow_mode, rate_kind)
    p1 = p0 + TICK

    def do_open(t):
        if e3 == "off":
            eng.open_long(M, L_target, check_e3=False)
            return
        L = min(L_target, lmax(eng.mid, tau0 - t))
        if int_lev:
            L = float(math.floor(L + 1e-9))
        eng.open_long(M, max(L, 1.0))

    do_open(0.0)
    total, fee_total, n_reset, reset_pnl, txs = 0.0, 0.0, 0, 0.0, 1
    if reset:
        t = phase
        t_stop = min(t1, tc)
        while t < t_stop:
            eng.push(t, p0)                          # fresh signed price, mid unchanged
            net, fee, _ = eng.close()                # sell at min(mid, slow) = p0
            reset_pnl += net; total += net; fee_total += fee
            do_open(t)                               # buy at max(mid, slow) = p0, fresh fee snapshot
            n_reset += 1; txs += 2
            t += Delta
    Lpos = eng.pos["L"]
    out = dict(n_reset=n_reset, reset_pnl=reset_pnl, L=Lpos, forced=False, win=False)
    if tc < t1:                                       # crash before the tick: liquidated at the mid
        eng.push(tc, crash_to)
        net, fee, _ = eng.close(at_mid=True)
        out.update(net=total + net - gas * txs, fee=fee_total + fee)
        return out
    eng.push(t1, p1)                                  # keeper relays the up-tick
    if e3 == "adv" and Lpos > ltime(p1, tau0 - t1) + 1e-9:
        net, fee, _ = eng.close()                     # force-close at the normal close price = min(mid, slow)
        out.update(net=total + net - gas * txs, fee=fee_total + fee, forced=True, win=True)
        return out
    t_close = t1 + w
    if tc < t_close:                                  # crash during the wait
        eng.push(tc, crash_to)
        net, fee, _ = eng.close(at_mid=True)
        out.update(net=total + net - gas * txs, fee=fee_total + fee)
        return out
    if poke:
        t = t1 + poke
        while t < t_close - 1e-9:
            eng.push(t, p1); txs += 1
            t += poke
    eng.push(t_close, p1)
    net, fee, _ = eng.close(); txs += 1
    out.update(net=total + net - gas * txs, fee=fee_total + fee, win=True)
    return out


def run(label, N, model, p0, L_target, tau0, seed=1, **kw):
    rng = np.random.default_rng(seed)                 # common random numbers across variants
    nets = np.empty(N); fees = np.empty(N); nres = np.empty(N); rp = np.empty(N)
    forced = 0; wins = 0; Lsum = 0.0
    for i in range(N):
        t1, tc = draw_round(model, p0, tau0, rng)
        phase = rng.random() * kw.get("Delta", 600.0)
        r = one_round(t1, tc, phase, p0, L_target, tau0, **kw)
        nets[i] = r["net"]; fees[i] = r["fee"]; nres[i] = r["n_reset"]; rp[i] = r["reset_pnl"]
        forced += r["forced"]; wins += r["win"]; Lsum += r["L"]
    print(f"{label:56s} EV/$={nets.mean():+.5f} (se {nets.std(ddof=1)/math.sqrt(N):.5f}) fee={fees.mean():.5f} "
          f"resets={nres.mean():5.1f} resetPnL={rp.mean():+.1e} P(win)={wins/N:.4f} L@tick={Lsum/N:.2f}"
          + (f" forced={forced/N:.3f}" if forced else ""))
    return nets.mean(), nets.std(ddof=1) / math.sqrt(N), fees.mean()


def det_exact(label, p0, L_target, tau0, phases=40, **kw):
    """DET model is deterministic given 'crash or not': evaluate the winning path with the engine and
    weight by the crash probability up to the close (uniform crash density (1-p0)/tau0)."""
    q = 1 - p0; p1 = p0 + TICK
    t1 = tau0 * (1 - p0 / p1) / q
    w = kw.get("w", 900.0)
    nets, fees, Ls, forced = [], [], [], 0
    for k in range(phases):
        r = one_round(t1, math.inf, (k + 0.5) / phases * kw.get("Delta", 600.0), p0, L_target, tau0, **kw)
        nets.append(r["net"]); fees.append(r["fee"]); Ls.append(r["L"]); forced += r["forced"]
    t_end = t1 if forced else t1 + w
    pc = q * t_end / tau0
    ev = (1 - pc) * float(np.mean(nets)) - pc * 1.0
    print(f"{label:56s} EV/$={ev:+.5f} (exact)      fee={(1-pc)*np.mean(fees):.5f} P(win)={1-pc:.4f} "
          f"net if win={np.mean(nets):+.5f} L@tick={np.mean(Ls):.2f}" + (" FORCED" if forced else ""))
    return ev


if __name__ == "__main__":
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 40_000
    D3, D7 = 3 * 86400.0, 7 * 86400.0
    print(f"margin $1; one round = wait for one up-tick, wait 15 min, close.  MC lines: N={N:,}, common random numbers.\n")
    print("== A. The claim's case: YES 0.90, 5x, 3 days; Ltime ignored after first open (analyst's simplification) ==")
    base = dict(e3="off", poke=10.0)
    det_exact("DET  1x outright", 0.90, 1.0, D3, reset=False, **base)
    det_exact("DET  5x hold (fee paid honestly)", 0.90, 5.0, D3, reset=False, **base)
    det_exact("DET  5x RESET every 10 min", 0.90, 5.0, D3, reset=True, **base)
    for model in ("POI", "POIT"):
        run(f"{model} 1x outright", N, model, 0.90, 1.0, D3, reset=False, **base)
        run(f"{model} 5x hold (fee paid honestly)", N, model, 0.90, 5.0, D3, reset=False, **base)
        run(f"{model} 5x RESET every 10 min", N, model, 0.90, 5.0, D3, reset=True, **base)
    print("\n== B. Slow price exactly as written vs deployed (how the 15 min wait is spent) ==")
    det_exact("DET RESET, rule-as-written slow, NO pokes (1 update)", 0.90, 5.0, D3, reset=True, e3="off", poke=None)
    det_exact("DET RESET, rule slow, poke every 150 s", 0.90, 5.0, D3, reset=True, e3="off", poke=150.0)
    det_exact("DET RESET, rule slow, no pokes, wait 60 min", 0.90, 5.0, D3, reset=True, e3="off", poke=None, w=3600.0)
    det_exact("DET RESET, deployed exact-exponential slow", 0.90, 5.0, D3, reset=True, e3="off", poke=None, slow_mode="exact")
    det_exact("DET RESET, deployed fee rate p(1-p)/tau", 0.90, 5.0, D3, reset=True, e3="off", poke=10.0, rate_kind="code")
    print("\n== C. E3 enforced on every re-open (Ltime at 0.90 drops below 5 about 4.5 h in) and on the tick ==")
    b2 = dict(poke=10.0)
    det_exact("DET RESET, E3 on re-opens, fractional leverage", 0.90, 5.0, D3, reset=True, e3="open", **b2)
    det_exact("DET RESET, E3 on re-opens, integer leverage", 0.90, 5.0, D3, reset=True, e3="open", int_lev=True, **b2)
    det_exact("DET RESET, + anyone force-closes above Ltime", 0.90, 5.0, D3, reset=True, e3="adv", **b2)
    det_exact("DET RESET at 4.5x (never above Ltime)", 0.90, 4.5, D3, reset=True, e3="adv", **b2)
    det_exact("DET RESET at 4x integer (never above Ltime)", 0.90, 4.0, D3, reset=True, e3="adv", int_lev=True, **b2)
    det_exact("DET RESET 5x but 7 days out (Ltime 7.9)", 0.90, 5.0, D7, reset=True, e3="adv", **b2)
    run("POI RESET, + anyone force-closes above Ltime", N, "POI", 0.90, 5.0, D3, reset=True, e3="adv", **b2)
    run("POI RESET at 4.5x, force-close adversary", N, "POI", 0.90, 4.5, D3, reset=True, e3="adv", **b2)
    run("POI RESET 5x, 7 days out, force-close adversary", N, "POI", 0.90, 5.0, D7, reset=True, e3="adv", **b2)
    print("\n== D. Gas: 1e-4 per $ of margin per transaction ($0.01 on $100) ==")
    det_exact("DET RESET, gas 1e-4/$ per tx", 0.90, 5.0, D3, reset=True, e3="off", poke=150.0, gas=1e-4)
    det_exact("DET RESET every 60 min, gas 1e-4/$ per tx", 0.90, 5.0, D3, reset=True, e3="off", poke=150.0, gas=1e-4, Delta=3600.0)
    print("\n== E. Other quoted cases ==")
    run("POI 0.80/10x/7d hold", N, "POI", 0.80, 10.0, D7, reset=False, e3="adv", **b2)
    run("POI 0.80/10x/7d RESET (10x safe: Ltime 11.8->11.1)", N, "POI", 0.80, 10.0, D7, reset=True, e3="adv", **b2)
    run("POI 0.60/19x/7d RESET (Ltime 19.3)", N, "POI", 0.60, 19.0, D7, reset=True, e3="open", **b2)
