"""
S4 - Repeated jumps: an in-play football match (200,000 matches, 20 s decision grid).

Price model (an exact martingale): goals are Poisson (home 1.6, away 1.1 per 90 min); the market is
"home team wins"; the reference mid is P(home wins | score, time left), rounded to the 1-cent tick.
Between goals the price drifts with the clock; a goal moves it 15-35 points; the last minutes carry
the jump to 0/1.  The market resolves at the final whistle.

Regimes
  A  rules as written: expiry = kickoff, every position above 1x is force-closed before kickoff,
     no opens in play.  Only 1x positions ride the match.
  B  the pre-kickoff force-close did NOT happen (keeper outage / nobody called it): positions opened
     a day (8x) or a week (21x) before ride the match.  B1: liquidation and collect still work.
     B2: no liquidations either (nobody is paid to liquidate a position with zero equity), the trader
     closes at the cap himself.
  C  counterfactual, in-play leverage allowed (no kickoff rule): a trader keeps re-opening at the
     tick-limit leverage.  C1: on the side the clock favours ("drift harvesting"), alone in the book
     (skewFrac = 1, crowding fee at the 1-hour tau floor).  C2: same, deep balanced book (skewFrac = 0).
     C3: always-on straddle, both sides, re-opened whenever flat.
House P&L is per match per $1 of margin per position (positions are always $1), profit share included.
Time grid: 20 s (the keeper polls every 4 s; between goals the price moves ~0.1 point per 20 s, and the
slow price uses the exact exponential so it does not depend on the grid).  A 4 s grid on fewer paths
is run as a check (argv: paths, regimes, step).
"""
import json
import sys
import time
import numpy as np
from scipy.stats import poisson
from engine import Engine, summarize
from rules import TICK

P = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
WHICH = sys.argv[2] if len(sys.argv) > 2 else "ABC"
LH, LA = 1.6, 1.1
T = 5400.0
DT = float(sys.argv[3]) if len(sys.argv) > 3 else 20.0
NS = int(T / DT)
DMAX = 12
OUT = {}


def price_table():
    tab = np.zeros((NS + 1, 2 * DMAX + 1))
    d = np.arange(-DMAX, DMAX + 1)
    a = np.arange(0, 40)
    for k in range(NS + 1):
        rem = max(T - k * DT, 0.0) / T
        if rem <= 0:
            tab[k] = (d > 0).astype(float)
            continue
        mh, ma = LH * rem, LA * rem
        pa = poisson.pmf(a, ma)
        # P(H + d > A) = sum_a P(A=a) P(H > a - d)
        for j, dd in enumerate(d):
            tab[k, j] = float(np.sum(pa * poisson.sf(a - dd, mh)))
    return tab


TAB = price_table()
P0 = round(TAB[0, DMAX], 2)
print(f"pre-match P(home win) = {TAB[0, DMAX]:.4f} -> mid {P0:.2f};  after an early home goal {TAB[1, DMAX+1]:.3f}, early away goal {TAB[1, DMAX-1]:.3f}")
print(f"clock drift at 0-0: minute 1 {(TAB[int(60/DT), DMAX]-TAB[0, DMAX])*100:+.2f} pts/min, minute 45 {(TAB[int(2760/DT), DMAX]-TAB[int(2700/DT), DMAX])*100:+.2f}, minute 80 {(TAB[int(4860/DT), DMAX]-TAB[int(4800/DT), DMAX])*100:+.2f}")


def match(engines, seed=5):
    """engines: list of dicts(eng=Engine, tau=fn(t)->tau for fees/limits, expired=bool, force=bool, strat=fn(k,d,eng))."""
    rng = np.random.default_rng(seed)
    d = np.zeros(P, dtype=np.int64)
    ph, pa = LH * DT / T, LA * DT / T
    allp = np.ones(P, dtype=bool)
    t0 = time.time()
    for k in range(1, NS + 1):
        u = rng.random(P)
        d += (u < ph)
        d -= (u > 1 - pa)
        t = k * DT
        if k < NS:
            mid = np.clip(np.round(TAB[k, np.clip(d, -DMAX, DMAX) + DMAX] / TICK) * TICK, 0.01, 0.99)
            for E in engines:
                eng = E["eng"]
                eng.step(mid, DT, E["tau"](t))
                eng.upkeep(E["tau"](t), force_close=E["force"], expired=E["expired"])
                if E.get("strat") is not None:
                    E["strat"](k, d, eng)
        else:
            for E in engines:
                E["eng"].resolve(allp, (d > 0).astype(float))
        if k % max(1, NS // 5) == 0:
            print(f"      ... minute {t/60:.0f}  ({time.time()-t0:.0f} s)", flush=True)
    return d


def report(label, eng, per=1.0):
    print(f"  {label}")
    h = summarize(eng.house, "house P&L per match per $1 position", per=per)
    tr = summarize(eng.trader, "trader", per=per, out=False)
    print(f"      trader {tr[0]:+.4f} (s.e. {tr[1]:.4f}); liquidators {eng.liqfee.mean()/per:+.4f}; opens/match {eng.n_opens.mean():.2f}, liquidations {eng.n_liq.mean():.2f},"
          f" collects {eng.n_collect.mean():.2f}, force {eng.n_force.mean():.2f}, settled at whistle {eng.n_settle.mean():.2f};"
          f" profit share {eng.pfee.mean()/per:.4f}, crowding fee {eng.crowd.mean()/per:.4f}; margin posted/match {eng.margin_opened.mean():.2f}")
    turnover = eng.margin_opened.mean()
    OUT[label] = dict(house=h[0], se=h[1], trader=tr[0], liq=float(eng.liqfee.mean() / per), opens=float(eng.n_opens.mean()),
                      n_liq=float(eng.n_liq.mean()), n_collect=float(eng.n_collect.mean()), crowd=float(eng.crowd.mean() / per),
                      pfee=float(eng.pfee.mean() / per), posted=float(turnover), house_per_posted=float(eng.house.mean() / max(turnover, 1e-12)))


allp = np.ones(P, dtype=bool)
BIG = 1e12
kick = lambda t: 0.0                     # expiry = kickoff: tau = 0 in play (fee uses the 1-hour floor)
rem = lambda t: max(T - t, 0.0)          # counterfactual: expiry = final whistle

if "A" in WHICH:
    print("=" * 110)
    print("A. Rules as written: only 1x positions ride the match (outright YES + outright NO)")
    print("=" * 110)
    engs = []
    for lab, legs in (("A1 1x straddle, balanced margin (p : 1-p)", [(+1, P0), (-1, 1 - P0)]),
                      ("A2 1x YES only", [(+1, 1.0)]), ("A3 1x NO only", [(-1, 1.0)])):
        eng = Engine(P, P0, slow_rule="exact")
        for side, M in legs:
            s = eng.add_slot()
            eng.open(s, allp, side, False, M, 1.0, BIG, check=False)
        engs.append(dict(eng=eng, tau=kick, expired=True, force=True, strat=None, lab=lab, per=sum(M for _, M in legs)))
    match(engs)
    for E in engs:
        report(E["lab"], E["eng"], E["per"])

if "B" in WHICH:
    print("=" * 110)
    print("B. Pre-kickoff force-close missed: leveraged positions opened before kickoff ride the match")
    print("=" * 110)
    engs = []
    Z = (0.0, 0.0)
    BAL = (1e9, 1e9)
    specs = [
        ("B1 8x free YES only, alone in the book (liq + collect on)", [(+1, 1.0, 8)], True, Z),
        ("B1 8x free NO only, alone in the book (liq + collect on)", [(-1, 1.0, 8)], True, Z),
        ("B1 8x free straddle, balanced margin (liq + collect on)", [(+1, P0, 8), (-1, 1 - P0, 8)], True, Z),
        ("B1 21x free straddle, balanced margin (liq + collect on)", [(+1, P0, 21), (-1, 1 - P0, 21)], True, Z),
        ("B1b 8x free YES only, deep balanced book (no crowding fee)", [(+1, 1.0, 8)], True, BAL),
        ("B1b 8x free NO only, deep balanced book (no crowding fee)", [(-1, 1.0, 8)], True, BAL),
        ("B1b 21x free NO only, deep balanced book (no crowding fee)", [(-1, 1.0, 21)], True, BAL),
        ("B2 8x free NO only, NO liquidations in play, deep balanced book", [(-1, 1.0, 8)], False, BAL),
        ("B2 8x free straddle balanced, NO liquidations in play", [(+1, P0, 8), (-1, 1 - P0, 8)], False, Z),
    ]
    for lab, legs, liq, ext in specs:
        eng = Engine(P, P0, slow_rule="exact", liq_on=liq, ext_B=ext)
        for side, M, L in legs:
            s = eng.add_slot()
            eng.open(s, allp, side, False, M, float(L), BIG, check=False)
        engs.append(dict(eng=eng, tau=kick, expired=True, force=False, strat=None, lab=lab, per=sum(M for _, M, _ in legs)))
    match(engs)
    for E in engs:
        report(E["lab"], E["eng"], E["per"])

if "C" in WHICH:
    print("=" * 110)
    print("C. Counterfactual: in-play opens with leverage allowed (no kickoff rule), tick-limit leverage")
    print("=" * 110)

    def tick_lev(mid):
        return np.maximum(1.0, np.minimum(50.0, np.floor(np.minimum(mid, 1 - mid) / 0.02 + 1e-9)))

    def harvest(k, d, eng):
        s = eng.slots[0]
        side = np.where(d >= 1, 1.0, -1.0)           # the side the clock favours
        eng.open(s, ~s["open"], side, False, 1.0, tick_lev(eng.mid), BIG, check=True)

    def straddle(k, d, eng):
        for s, side in zip(eng.slots, (1.0, -1.0)):
            eng.open(s, ~s["open"], side, False, 1.0, tick_lev(eng.mid), BIG, check=True)

    def anti(k, d, eng):
        s = eng.slots[0]
        side = np.where(d >= 1, -1.0, 1.0)           # against the clock (what a naive punter backing the loser does)
        eng.open(s, ~s["open"], side, False, 1.0, tick_lev(eng.mid), BIG, check=True)

    engs = []
    e1 = Engine(P, P0, slow_rule="exact"); e1.add_slot()
    engs.append(dict(eng=e1, tau=rem, expired=False, force=False, strat=harvest, lab="C1 clock-side harvester, alone in the book (skewFrac=1, fee on)", per=1.0))
    e2 = Engine(P, P0, slow_rule="exact", ext_B=(1e9, 1e9)); e2.add_slot()
    engs.append(dict(eng=e2, tau=rem, expired=False, force=False, strat=harvest, lab="C2 clock-side harvester, deep balanced book (skewFrac=0)", per=1.0))
    e3 = Engine(P, P0, slow_rule="exact"); e3.add_slot(); e3.add_slot()
    engs.append(dict(eng=e3, tau=rem, expired=False, force=False, strat=straddle, lab="C3 always-on straddle (both sides re-opened when flat)", per=1.0))
    e4 = Engine(P, P0, slow_rule="exact", ext_B=(1e9, 1e9)); e4.add_slot()
    engs.append(dict(eng=e4, tau=rem, expired=False, force=False, strat=anti, lab="C4 against-the-clock side only, deep balanced book", per=1.0))
    for E in engs:                                    # first positions at kickoff
        E["strat"](0, np.zeros(P, dtype=np.int64), E["eng"])
    match(engs)
    for E in engs:
        report(E["lab"], E["eng"], E["per"])

with open(__file__.replace(".py", f"_{WHICH}_{int(DT)}s_{P}.json"), "w") as f:
    json.dump(OUT, f, indent=1)
print("done")
