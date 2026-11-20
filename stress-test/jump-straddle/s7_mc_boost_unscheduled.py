"""
S7 - Is Boost priced right when the jump time is NOT known?  (200,000 paths, 3 days, 5-minute steps.)

Market at 0.50 with 30 days left.  All of its expected variance, p(1-p)/tau per second, arrives as
symmetric jumps of +-F points at uniformly random (Poisson) times: rate = 0.25 / (tau * F^2).
(This is the variance assumption E3 itself uses, delivered as jumps instead of diffusion.)  A little
tick noise is added between jumps.

Trader: a permanently held boosted straddle, $1 on YES and $1 on NO at the same leverage
(min(E3 limit, 16x), so a winner is not force-closed after the jump).  After a jump the loser is
liquidated, the winner is closed once the slow price has converged, and both legs are re-opened.
Legs are refreshed (closed and re-opened in a calm market) before the premium runs equity down to the
liquidation level.  The premium is paid in full the whole time: the trader has NO timing information.

Reported: house P&L over the 3 days per $1 of margin in the straddle ($2), premium collected, and the
formula value from S6 for comparison.
"""
import json
import sys
import time
import numpy as np
from engine import Engine, summarize
from rules import TICK, max_lev

P = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
F = float(sys.argv[2]) if len(sys.argv) > 2 else 0.10
MODE = sys.argv[3] if len(sys.argv) > 3 else "boost"
DAY = 86400.0
DT = 300.0
DAYS = 3.0
NS = int(DAYS * DAY / DT)
TAU0 = 30 * DAY
LCAP = 16.0
NOISE = 0.005

rng = np.random.default_rng(21)
eng = Engine(P, 0.50, slow_rule="exact")
sy, sn = eng.add_slot(), eng.add_slot()
boost = MODE == "boost"
lam = 0.25 / (TAU0 * F * F)          # per second


def act(tau):
    calm = np.abs(eng.mid - eng.slow) < 0.005
    both_open = sy["open"] & sn["open"]
    one_open = sy["open"] ^ sn["open"]
    # a lone leg (its partner was liquidated) is closed once the slow price has caught up
    for s in (sy, sn):
        eng.close(s, s["open"] & one_open & calm)
    # refresh before the premium takes equity to the liquidation level
    low = both_open & calm & ((eng.equity_mid(sy) <= 0.35 * sy["M"]) | (eng.equity_mid(sn) <= 0.35 * sn["M"]))
    eng.close(sy, low)
    eng.close(sn, low)
    flat = ~sy["open"] & ~sn["open"] & calm
    L = np.minimum(max_lev(np.clip(eng.mid, 1e-6, 1 - 1e-6), tau), LCAP)
    ok = eng.open(sy, flat, +1.0, boost, 1.0, L, tau)
    eng.open(sn, ok, -1.0, boost, 1.0, L, tau)


act(TAU0)
njump = np.zeros(P)
t0 = time.time()
for k in range(1, NS + 1):
    t = k * DT
    tau = TAU0 - t
    u = rng.random(P)
    jump = u < lam * DT
    size = np.minimum(F, np.minimum(eng.mid - 0.05, 0.95 - eng.mid))
    sgn = np.where(rng.random(P) < 0.5, 1.0, -1.0)
    v = rng.random(P)
    noise = np.where(v < NOISE, TICK, np.where(v < 2 * NOISE, -TICK, 0.0))
    mid = eng.mid + np.where(jump, sgn * size, noise)
    mid = np.clip(np.round(mid / TICK) * TICK, 0.01, 0.99)
    njump += jump
    eng.step(mid, DT, tau)
    eng.upkeep(tau, force_close=True)
    if k < NS:
        act(tau)
    if k % int(DAY / DT) == 0:
        print(f"   ... day {t/DAY:.0f} ({time.time()-t0:.0f} s)", flush=True)
for s in (sy, sn):
    eng.close(s, s["open"])

print("=" * 110)
print(f"{MODE} straddle, jumps of +-{F*100:.0f} points at random times, {P:,} paths, {DAYS:.0f} days; jumps per path {njump.mean():.2f}")
print("=" * 110)
h = summarize(eng.house, "house P&L over 3 days per $1 of straddle margin", per=2.0)
print(f"      trader {eng.trader.mean()/2:+.4f}; premium collected {eng.prem.mean()/2:.4f}; crowding fee {eng.crowd.mean()/2:.4f}; profit share {eng.pfee.mean()/2:.4f};"
      f" liquidators {eng.liqfee.mean()/2:.4f}; opens {eng.n_opens.mean():.2f}, liquidations {eng.n_liq.mean():.2f}, force-closes {eng.n_force.mean():.2f}")
per_jump = eng.house.sum() / max(njump.sum(), 1) / 2
print(f"      house per jump per $1 of straddle margin: {per_jump:+.3f}")
with open(__file__.replace(".py", f"_{MODE}_{int(F*100)}.json"), "w") as f:
    json.dump(dict(F=F, mode=MODE, house=h[0], se=h[1], trader=float(eng.trader.mean() / 2), prem=float(eng.prem.mean() / 2),
                   pfee=float(eng.pfee.mean() / 2), jumps=float(njump.mean()), per_jump=float(per_jump),
                   n_force=float(eng.n_force.mean()), n_liq=float(eng.n_liq.mean())), f, indent=1)
