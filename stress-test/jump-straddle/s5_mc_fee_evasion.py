"""
S5 - Does a straddle switch off the crowding fee?  (200,000 paths, 5 days, 30-minute steps.)

Market: "will X happen by the date" with NO at 0.80 and 30 days left.  NO drifts up and is hit by
bad-news crashes (the drift is exactly the compensator, so the price is a martingale).
  world P ("partial"): a crash takes NO down by 25-50% of its level (0.80 -> 0.40-0.60), intensity
          0.057/day (the same total variance as one jump to zero spread over 30 days);
  world Z ("to zero"): the only jump is NO -> 0 (X happened, market resolves YES), intensity
          (1-q)/(q*tau) = 0.0083/day: the case the fee's "implied hazard" was calibrated to.
Trader policies (the harvest leg is always $1 of margin on NO at the limit leverage, re-opened
whenever flat and the open gates allow):
  H0  harvest leg alone in the book (skewFrac = 1): pays the full crowding fee;
  H1  harvest leg in a deep balanced book (skewFrac = 0): the fee-free benchmark;
  H2  harvest leg + the trader's OWN YES leg at 2x sized so borrowed YES shares >= borrowed NO shares
      (the leverage-mismatch straddle): skewFrac = 0 by construction;
  H3  harvest leg + own YES leg at the SAME leverage and the same number of shares (true offset).
House P&L over the 5 days, per $1 of harvest margin and per $1 of peak total margin.
The slow price uses the contract's exact exponential (steps are 30 minutes; the drift is ~1.7 points
a day, so nothing but the crash happens faster than a step).
"""
import json
import sys
import time
import numpy as np
from engine import Engine, summarize
from rules import TICK, max_lev

P = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
DAY = 86400.0
WORLDS = sys.argv[2] if len(sys.argv) > 2 else "PZ"
DT = float(sys.argv[3]) if len(sys.argv) > 3 else 1800.0
DAYS = 5.0
NS = int(DAYS * DAY / DT)
TAU0 = 30 * DAY
Q0 = 0.80
OUT = {}


def run_world(world, seed=9):
    rng = np.random.default_rng(seed)
    allp = np.ones(P, dtype=bool)
    lam_day = 0.057 if world == "P" else (1 - Q0) / (Q0 * 30.0)
    mean_c = 0.375 if world == "P" else 1.0

    def mk(ext=(0.0, 0.0), nslots=1):
        e = Engine(P, 1 - Q0, slow_rule="exact", ext_B=ext)
        for _ in range(nslots):
            e.add_slot()
        return e

    E = dict(H0=mk(), H1=mk((1e9, 1e9)), H2=mk(nslots=2), H3=mk(nslots=2))
    peak = {k: np.zeros(P) for k in E}

    def act(name, eng, tau):
        hv = eng.slots[0]
        L = max_lev(np.clip(eng.mid, 1e-6, 1 - 1e-6), tau)
        can = ~hv["open"] & (L >= 2)                       # harvesting needs leverage
        if name in ("H0", "H1"):
            eng.open(hv, can, -1.0, False, 1.0, L, tau)
        else:
            hd = eng.slots[1]
            calm = np.abs(eng.mid - eng.slow) < 0.01
            eY = np.maximum(eng.mid, eng.slow)
            if name == "H2":
                # borrowed shares a new $1 harvest position would carry
                eN = np.maximum(1 - eng.mid, 1 - eng.slow)
                newB = (L / eN) * (1 - 1 / np.maximum(L, 1.0))
                # a YES leg that no longer covers the next harvest position is closed once the slow
                # price has converged (after a crash it is in profit), then both legs are rebuilt
                eng.close(hd, hd["open"] & ~hv["open"] & (hd["B"] < newB) & calm)
                eng.open(hv, can & (~hd["open"] | (hd["B"] >= newB)), -1.0, False, 1.0, L, tau)
                need = hv["open"] & ~hd["open"]
                Mh = 1.05 * hv["B"] * eY / (2.0 - 1.0)      # B_YES = M (L-1)/e with L = 2
                eng.open(hd, need, +1.0, False, Mh, 2.0, tau)
            else:
                # same leverage, same number of shares, opened together with the harvest leg
                eng.close(hd, hd["open"] & ~hv["open"] & calm & (eng.pnl_close(hd) > 0))
                ok = eng.open(hv, can & ~hd["open"], -1.0, False, 1.0, L, tau)
                Mh = hv["n"] * eY / np.maximum(hv["L"], 1.0)
                eng.open(hd, ok, +1.0, False, Mh, hv["L"], tau)
        tot = sum(np.where(s["open"], s["M"], 0.0) for s in eng.slots)
        peak[name] = np.maximum(peak[name], tot)

    q = np.full(P, Q0)
    alive = np.ones(P, dtype=bool)
    for name, eng in E.items():
        act(name, eng, TAU0)
    t0 = time.time()
    for k in range(1, NS + 1):
        t = k * DT
        tau = TAU0 - t
        dtd = DT / DAY
        crash = alive & (rng.random(P) < lam_day * dtd)
        c = rng.uniform(0.25, 0.5, P) if world == "P" else np.ones(P)
        q = np.where(alive & ~crash & (q < 0.985), q * (1 + lam_day * mean_c * dtd), q)
        q = np.where(crash, q * (1 - c), q)
        mid = np.clip(np.round((1 - q) / TICK) * TICK, 0.01, 0.99)
        for name, eng in E.items():
            eng.step(mid, DT, tau)
            if world == "Z":
                eng.resolve(crash, 1.0)
            eng.upkeep(tau, force_close=True)
            if k < NS:
                act(name, eng, tau)
        if world == "Z":
            alive &= ~crash
        if k % max(1, int(DAY / DT)) == 0:
            print(f"      ... day {t/DAY:.0f} ({time.time()-t0:.0f} s)", flush=True)
    res = {}
    for name, eng in E.items():
        for s in eng.slots:
            eng.close(s, s["open"])
        print(f"  [{world}] {name}")
        h = summarize(eng.house, "house P&L over 5 days per $1 of harvest margin")
        hp = summarize(eng.house / np.maximum(peak[name], 1e-9), "house P&L per $1 of peak total margin")
        hv = eng.slots[0]
        extra = ""
        if len(eng.slots) > 1:
            extra = f"; harvest leg trader P&L {hv['pnl'].mean():+.4f}, other leg {eng.slots[1]['pnl'].mean():+.4f}, peak total margin {peak[name].mean():.2f}"
        print(f"      trader {eng.trader.mean():+.4f}; crowding fee paid {eng.crowd.mean():.4f}; profit share {eng.pfee.mean():.4f}; liquidators {eng.liqfee.mean():.4f};"
              f" opens {eng.n_opens.mean():.2f}, collects {eng.n_collect.mean():.2f}, liquidations {eng.n_liq.mean():.2f}{extra}")
        res[name] = dict(house=h[0], se=h[1], house_per_total=hp[0], se_total=hp[1], trader=float(eng.trader.mean()),
                         crowd=float(eng.crowd.mean()), pfee=float(eng.pfee.mean()), liq=float(eng.liqfee.mean()),
                         peak=float(peak[name].mean()), harvest_leg=float(hv["pnl"].mean()),
                         other_leg=float(eng.slots[1]["pnl"].mean()) if len(eng.slots) > 1 else 0.0)
    return res


for w, lab in (("P", "world P: partial crashes (NO falls 25-50% of its level)"), ("Z", "world Z: the only jump is NO -> 0")):
    if w not in WORLDS:
        continue
    print("=" * 110)
    print(lab)
    print("=" * 110)
    OUT[w] = run_world(w)

with open(__file__.replace(".py", f"_{WORLDS}.json"), "w") as f:
    json.dump(OUT, f, indent=1)
print("done")
