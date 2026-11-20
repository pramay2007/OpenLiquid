"""
S2 - Monte Carlo of ONE scheduled jump with the full mechanics (validates S1 under microstructure).

Timeline per path (keeper poll every 4 s, mid on the 1-cent grid):
  t = 0          positions open in a calm market (mid = slow = p0)
  0..60 s        tick noise (each poll the mid moves +1 / -1 tick with probability q each)
  t = 60 s       the jump (drawn from the stated mean-zero distribution), then it persists
  60..780 s      tick noise; keeper liquidates at the mid, collects at the cap (worse-of price),
                 force-closes anything above Ltime(mid)
  t = 780 s      whatever is still open is closed by the trader at the worse-of price
200,000 paths per case.  House P&L is per $1 of total trader margin, 10% profit share included.
"""
import json
import sys
import numpy as np
from scipy.stats import norm
from engine import Engine, summarize
from rules import TICK

DAY = 86400.0
P = 200_000
OUT = {}


def run(structure, p0, shocks, *, tau_days=30.0, q=0.02, seed=7, pre_s=60, post_s=720, dt=4,
        force_close=True, label="", ext_B=(0.0, 0.0), quiet=False):
    """shocks: function(rng, P) -> list of (seconds_after_pre, jump_array)."""
    rng = np.random.default_rng(seed)
    eng = Engine(P, p0, ext_B=ext_B)
    tau = tau_days * DAY
    slots = []
    for (side, mode, M, L) in structure:
        s = eng.add_slot()
        ok = eng.open(s, np.ones(P, dtype=bool), side, mode == "boost", M, L, tau)
        if not ok.all():
            raise RuntimeError(f"open refused for {side, mode, M, L} at p0={p0}, tau={tau_days}d")
        slots.append(s)
    sched = {}
    for (sec, arr) in shocks(rng, P):
        sched[int(pre_s // dt + sec // dt)] = arr
    t = 0.0
    for k in range(int((pre_s + post_s) // dt)):
        u = rng.random(P)
        dm = np.where(u < q, TICK, np.where(u < 2 * q, -TICK, 0.0))
        new_mid = eng.mid + dm
        if k in sched:
            new_mid = new_mid + sched[k]
        new_mid = np.clip(np.round(new_mid / TICK) * TICK, 0.01, 0.99)
        t += dt
        eng.step(new_mid, dt, tau - t)
        eng.upkeep(tau - t, force_close=force_close)
    for s in slots:
        eng.close(s, s["open"])
    margin = sum(M for (_, _, M, _) in structure)
    if not quiet:
        print(f"  {label}")
        h = summarize(eng.house, "house P&L per $1 margin", per=margin)
        tr = summarize(eng.trader, "trader P&L per $1 margin", per=margin, out=False)
        lf = summarize(eng.liqfee, "liquidator", per=margin, out=False)
        print(f"      trader {tr[0]:+.4f} (s.e. {tr[1]:.4f}); liquidators {lf[0]:+.4f}; per path: liquidations {eng.n_liq.mean():.3f},"
              f" collects {eng.n_collect.mean():.3f}, force-closes {eng.n_force.mean():.3f}, trader closes {eng.n_close.mean():.3f};"
              f" crowding fee {eng.crowd.mean()/margin:.4f}, premium {eng.prem.mean()/margin:.4f}")
        OUT[label] = dict(house=h[0], house_se=h[1], trader=tr[0], trader_se=tr[1], liq=lf[0],
                          n_liq=float(eng.n_liq.mean()), n_collect=float(eng.n_collect.mean()),
                          n_force=float(eng.n_force.mean()), crowd=float(eng.crowd.mean() / margin),
                          prem=float(eng.prem.mean() / margin))
    return eng, margin


def sym(F):
    return lambda rng, P: [(0, np.where(rng.random(P) < 0.5, F, -F))]


def twopt(U, D):
    pi = D / (U + D)
    return lambda rng, P: [(0, np.where(rng.random(P) < pi, U, -D))]


def unif(lo, hi):
    return lambda rng, P: [(0, rng.uniform(lo, hi, P) * np.where(rng.random(P) < 0.5, 1.0, -1.0))]


def latent(p0, m=4):
    """Martingale: p = Phi(S/sqrt(m)) with m unit shocks left; one shock arrives."""
    S = np.sqrt(m) * norm.ppf(p0)
    return lambda rng, P: [(0, norm.cdf((S + rng.standard_normal(P)) / np.sqrt(m - 1)) - p0)]


def to_resolution(p0):
    # the price itself jumps to 0.99 / 0.01 (clipped by the engine); settlement handled separately
    return lambda rng, P: [(0, np.where(rng.random(P) < p0, 1.0 - p0, -p0))]


def spike(S, hold_s):
    """A jump that fully reverts after hold_s seconds (one-sided overshoot, direction 50/50)."""
    def f(rng, P):
        sgn = np.where(rng.random(P) < 0.5, 1.0, -1.0)
        return [(0, S * sgn), (hold_s, -S * sgn)]
    return f


if __name__ == "__main__":
    print("=" * 110)
    print("1. p0 = 0.50, tau = 30 d (max leverage 25x)")
    print("=" * 110)
    run([(+1, "free", 1, 25), (-1, "free", 1, 25)], 0.50, sym(0.20), label="free/free 25x straddle, +-20")
    run([(+1, "boost", 1, 25), (-1, "boost", 1, 25)], 0.50, sym(0.20), label="boost/boost 25x straddle, +-20")
    run([(+1, "boost", 1, 25), (-1, "free", 1, 25)], 0.50, sym(0.20), label="boost YES + free NO 25x, +-20")
    run([(+1, "boost", 1, 25), (-1, "boost", 1, 25)], 0.50, sym(0.10), label="boost/boost 25x straddle, +-10")
    run([(+1, "boost", 1, 16), (-1, "boost", 1, 16)], 0.50, unif(0.10, 0.40), label="boost/boost 16x straddle, size U(10,40) either way")
    run([(+1, "free", 1, 25), (-1, "free", 1, 25)], 0.50, unif(0.10, 0.40), label="free/free 25x straddle, size U(10,40) either way")

    print("=" * 110)
    print("2. p0 = 0.30: the cheap side through a symmetric jump (free mode)")
    print("=" * 110)
    run([(+1, "free", 1, 15)], 0.30, sym(0.20), label="free YES 15x only, +-20")
    run([(+1, "free", 1, 4)], 0.30, sym(0.20), label="free YES 4x only, +-20")
    run([(-1, "free", 1, 15)], 0.30, sym(0.20), label="free NO 15x only (the favourite side), +-20")
    run([(+1, "free", 0.3, 15), (-1, "free", 0.7, 15)], 0.30, sym(0.20), label="free/free 15x balanced straddle (0.3 : 0.7), +-20")
    run([(+1, "free", 0.15, 4), (-1, "free", 0.85, 1)], 0.30, sym(0.20), label="hedged: 15% YES 4x + 85% NO 1x, +-20")
    run([(+1, "free", 1, 4)], 0.30, latent(0.30), label="free YES 4x only, latent-normal shock (1 of 4)")
    run([(-1, "free", 1, 4)], 0.30, latent(0.30), label="free NO 4x only, latent-normal shock (1 of 4)")

    print("=" * 110)
    print("3. p0 = 0.50: skewed mean-zero jump +10 (p=.8) / -40 (p=.2) (free mode)")
    print("=" * 110)
    run([(+1, "free", 1, 5)], 0.50, twopt(0.10, 0.40), label="free YES 5x, +10/-40")
    run([(+1, "free", 1, 25), (-1, "free", 1, 25)], 0.50, twopt(0.10, 0.40), label="free/free 25x straddle, +10/-40")

    print("=" * 110)
    print("4. Jump straight to resolution (oracle resolves in one update; settlement)")
    print("=" * 110)
    for p0, L in [(0.50, 25), (0.30, 15)]:
        rng = np.random.default_rng(11)
        yes = rng.random(P) < p0
        eng = Engine(P, p0)
        for side, M in ((+1, p0), (-1, 1 - p0)):
            s = eng.add_slot()
            eng.open(s, np.ones(P, dtype=bool), side, False, M, L, 30 * DAY)
        eng.resolve(np.ones(P, dtype=bool), yes.astype(float))
        h = summarize(eng.house, f"p0={p0}: free/free {L}x balanced straddle", per=1.0)
        OUT[f"resolve_balanced_{p0}"] = dict(house=h[0], house_se=h[1])
        for side in (+1, -1):
            eng = Engine(P, p0)
            s = eng.add_slot()
            eng.open(s, np.ones(P, dtype=bool), side, False, 1.0, L, 30 * DAY)
            eng.resolve(np.ones(P, dtype=bool), yes.astype(float))
            h = summarize(eng.house, f"p0={p0}: free {'YES' if side>0 else 'NO'} {L}x only", per=1.0)
            OUT[f"resolve_{'Y' if side>0 else 'N'}_{p0}"] = dict(house=h[0], house_se=h[1])

    print("=" * 110)
    print("5. One-sided overshoot: a 6-point spike in the mid that fully reverts (direction 50/50)")
    print("=" * 110)
    run([(+1, "free", 1, 25), (-1, "free", 1, 25)], 0.50, spike(0.06, 4), label="free/free 25x straddle, 6-pt spike held 4 s then reverts")
    run([(+1, "free", 1, 25), (-1, "free", 1, 25)], 0.50, spike(0.06, 60), label="free/free 25x straddle, 6-pt spike held 60 s then reverts")
    run([(+1, "boost", 1, 25), (-1, "boost", 1, 25)], 0.50, spike(0.06, 20), label="boost/boost 25x straddle, 6-pt spike held 20 s then reverts")

    print("=" * 110)
    print("6. Winner force-closed at the lagging slow price: tau = 7 d, 23x (the time limit at 0.50), +-20")
    print("=" * 110)
    run([(+1, "free", 1, 23), (-1, "free", 1, 23)], 0.50, sym(0.20), tau_days=7, label="free/free 23x straddle, keeper force-closes above Ltime(mid)")
    run([(+1, "free", 1, 23), (-1, "free", 1, 23)], 0.50, sym(0.20), tau_days=7, force_close=False, label="free/free 23x straddle, NO force-close (reference)")
    run([(+1, "boost", 1, 23), (-1, "boost", 1, 23)], 0.50, sym(0.20), tau_days=7, label="boost/boost 23x straddle, keeper force-closes above Ltime(mid)")
    run([(+1, "boost", 1, 15), (-1, "boost", 1, 15)], 0.50, sym(0.20), tau_days=7, label="boost/boost 15x straddle (= Ltime(0.70)), force-close on")
    run([(+1, "free", 1, 10)], 0.70, sym(0.20), tau_days=3, label="free YES 10x at 0.70, tau 3 d (Ltime(0.90)=5): winner force-closed")
    run([(+1, "free", 1, 10)], 0.70, sym(0.20), tau_days=3, force_close=False, label="free YES 10x at 0.70, tau 3 d, NO force-close (reference)")

    with open(__file__.replace(".py", ".json"), "w") as f:
        json.dump(OUT, f, indent=1)
    print("done")
