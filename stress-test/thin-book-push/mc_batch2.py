"""Batch 2: confirm the dangerous variants under book noise (two-leg, spoof, extreme price, fee-free)."""
import time
from mc_push import simulate, report
NP = 200_000
t0 = time.time()
print("Book $1,000 within 5 ticks, 1-tick spread, 30 days to expiry, kappa 0.5, n =", NP, "unless noted.\n")

print("2. Two-leg (long into push at L, then NO at the caught-up slow, release, close). Stale book, fee on.")
for L in (1, 10, 24):
    for m in (1, 2, 3):
        o = simulate(NP, seed=2000 + 31 * L + m, L=L, m_target=m, T_hold=900, two_leg=True, T2=900)
        print("  ", report(f"L={L:>2} push {m} hold 900s + leg2 900s", o))

print("\n3. Fee-free / maker-rebated attacker (taker=0), one and two legs, stale book.")
for two in (False, True):
    for m in (1, 2, 3):
        o = simulate(NP, seed=3000 + m + 7 * two, L=10, m_target=m, T_hold=900, two_leg=two, T2=900, taker=0.0)
        print("  ", report(f"{'two' if two else 'one'}-leg push {m} hold 900s, no fee", o))

print("\n4. Extreme price. Favourite NO side at 90.5c (push the YES mid DOWN with a NO long). usd_side='other'.")
print("   mid 0.905 so NO own-price 0.095; E3 caps leverage at 4x there. depth $1,000 within 5 ticks.")
for m in (2, 4, 6, 8):
    o = simulate(NP, seed=4000 + m, B0=90, s=1, L=4, m_target=m, T_hold=900, usd_side="other", tau_exp=30 * 86400.0)
    print("  ", report(f"NO@0.905 push {m} hold 900s one-leg", o))
for m in (2, 4, 6):
    o = simulate(NP, seed=4100 + m, B0=90, s=1, L=4, m_target=m, T_hold=900, two_leg=True, T2=900, usd_side="other")
    print("  ", report(f"NO@0.905 push {m} hold 900s two-leg", o))

print("\n5. Spoofed depth (Attack 2). Rest X per side 15 min (slowDepth ~95% of X), open, cancel, push 2, hold 600, two legs.")
for X in (0, 10_000, 100_000):
    o = simulate(NP, seed=5000 + X, L=10, m_target=2, T_hold=600, two_leg=True, T2=900, spoof_usd=X * 0.95)
    print("  ", report(f"spoof ${X:>7,}/side (eff ${X*0.95:>7,.0f})", o))

print(f"\n[{time.time()-t0:.0f}s]")
