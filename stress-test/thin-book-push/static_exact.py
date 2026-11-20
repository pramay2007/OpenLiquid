"""
Exact (no simulation) profit and cost of the push-and-hold attack on a static reference book,
rules as written.  All dollar figures are per $1,000 of 5-tick depth (they scale linearly with depth).
"""
import numpy as np
from book import Book, attack_static, n_levels_in_band
from venue import l_max, win_line, liq_line, cap_free, GEMINI_TAKER, catchup_exact

np.set_printoptions(linewidth=200)
D5 = 1000.0


def ubook(p_mid_tick2, s, d5=D5):
    """Uniform book with keeper depth d5; p_mid_tick2 = 2*mid in ticks (so 99 -> mid 0.495)."""
    B0 = (p_mid_tick2 - s) // 2
    assert 2 * B0 + s == p_mid_tick2
    rho = d5 / n_levels_in_band(s)
    return Book.uniform(B0, s, rho)


def best_attack(book, Ts=(60, 150, 300, 600, 900, 1800), ms=range(0, 9), **kw):
    best = None
    for m in ms:
        for T in Ts:
            r = attack_static(book, m, T, **kw)
            if r["delta"] <= 0: continue
            if best is None or r["net"] > best[2]["net"]:
                best = (m, T, r)
    return best


print("=" * 110)
print("A. Rules as written. Uniform book, 1-tick spread, mid 49.5c, $1,000 within 5 ticks ($200 per level), kappa 0.5,")
print("   Gemini taker fee 0.07*P*(1-P).  Leg 1 only (YES long opened calm, closed at slow).  L = 1 (cap never binds).")
print("   rows: levels consumed m (push = m ticks); columns: hold time T.  cell = venue profit / reference cost -> net")
bk = ubook(99, 1)
Ts = (60, 150, 300, 600, 900, 1800)
print("        " + "".join(f"T={T:>5}s            " for T in Ts))
for m in range(1, 6):
    row = []
    for T in Ts:
        r = attack_static(bk, m, T)
        row.append(f"{r['venue']:6.2f}/{r['ref_cost']:6.2f}->{r['net']:+6.2f}")
    print(f" m={m}   " + "  ".join(row))
r = attack_static(bk, 1, 600)
print(f"   (m=1: {r['contracts']:.0f} contracts consumed for ${r['ref_usd']:.0f}; notional on venue ${r['N1']:.0f}; taker-unwind would add ${r['unwind']:.2f})")

print()
print("B. Same, Gemini taker fee = 0 (fee holiday / fee-rebated account)")
for m in range(1, 6):
    row = []
    for T in Ts:
        r = attack_static(bk, m, T, taker=0.0)
        row.append(f"{r['venue']:6.2f}/{r['ref_cost']:6.2f}->{r['net']:+6.2f}")
    print(f" m={m}   " + "  ".join(row))

print()
print("C. Leverage. Same book, with fee. Per attack: margin, cap, venue profit, net, EV per $ of margin (best m,T up to 30 min)")
for L in (1, 2, 5, 10, 24):
    for two in (False, True):
        m, T, r = best_attack(bk, L=L, two_leg=two)
        print(f" L={L:>2} {'two-leg' if two else 'one-leg'}: best m={m} T={T:>4}s  margin ${r['margin']:8.2f}  venue ${r['venue']:7.2f}  ref cost ${r['ref_cost']:6.2f}"
              f"  net ${r['net']:+7.2f}  EV/margin {r['net']/r['margin']:+7.3f}  house loss/depth {r['house_loss']/D5:6.3%}")
print("   win line at L=24 from 49.5c:", round(float(win_line(0.495, 24)), 4), " liq line:", round(float(liq_line(0.495, 24)), 4))

print()
print("D. Two legs (long into the push, then NO opened at the caught-up slow price, closed after release). L=1, fee on.")
print("   rows m; columns T (leg-2 wait = 15 min after release)")
for m in range(1, 5):
    row = []
    for T in Ts:
        r = attack_static(bk, m, T, two_leg=True, T2=900)
        row.append(f"{r['venue']:6.2f}/{r['ref_cost']:6.2f}->{r['net']:+6.2f}")
    print(f" m={m}   " + "  ".join(row))

print()
print("E. Price level and side (one leg, T = 600 s, best m).  'YES' = push up with a YES long; 'NO' = push down with a NO long.")
print("   capacity is kappa * USD depth for both sides, as written.  net per $1,000 depth; kappa* = largest kappa with net <= 0 at T -> inf")
print("   mid     side  Lmax(30d)  fee/ctr   best m   venue    cost     net    kappa*(1 leg)  kappa*(2 legs)  kappa* no fee (2 legs)")
def kappa_star(book, direction, two_leg, taker):
    # net is linear in kappa: net = kappa*a - c  -> kappa* = min over m of c/a, at g=1
    ks = []
    for m in range(0, 9):
        r = attack_static(book, m, 1e9, kappa=1.0, direction=direction, two_leg=two_leg, taker=taker)
        if r["delta"] <= 0: continue
        ks.append(r["ref_cost"] / r["venue"] if r["venue"] > 0 else np.inf)
    return min(ks)
for mid2 in (41, 61, 81, 99, 119, 139, 159, 179):
    bkp = ubook(mid2, 1)
    for direction, name in ((+1, "YES"), (-1, "NO ")):
        m, T, r = best_attack(bkp, Ts=(600,), direction=direction)
        k1 = kappa_star(bkp, direction, False, GEMINI_TAKER); k2 = kappa_star(bkp, direction, True, GEMINI_TAKER)
        k0 = kappa_star(bkp, direction, True, 0.0)
        print(f"  {bkp.mid:5.3f}   {name}   {int(l_max(bkp.mid, 30*86400)):>3}      {GEMINI_TAKER*bkp.mid*(1-bkp.mid):.4f}     {m}     {r['venue']:7.2f} {r['ref_cost']:7.2f} {r['net']:+8.2f}"
              f"      {k1:6.3f}         {k2:6.3f}          {k0:6.3f}")

print()
print("F. Spread. Uniform book, depth $1,000 within the band, mid ~50c. m=0 is the free inside-spread push (a 1-lot bid one tick under the ask).")
print("   spread  levels in band  free push (ticks)  venue profit at T=300/600/900 s (one leg, L=1)   cost")
for s in (1, 2, 3, 4, 5, 6, 8, 10):
    bks = ubook(100 if s % 2 == 0 else 99, s)
    r = [attack_static(bks, 0, T) for T in (300, 600, 900)]
    print(f"    {s:>2}        {n_levels_in_band(s)}               {r[0]['delta']/0.01:4.1f}            {r[0]['venue']:6.2f} / {r[1]['venue']:6.2f} / {r[2]['venue']:6.2f}                       {r[0]['ref_cost']:.2f}")

print()
print("G. Spoofed depth. Natural book as in A ($1,000 within 5 ticks). Attacker rests X per side inside the band for 15 min")
print("   (slowDepth reaches 95% of X), opens, cancels, pushes m=2 ticks, holds 600 s.  One leg and two legs, L=1.")
print("   X per side   capacity    venue(1 leg)  venue(2 legs)   push cost   net(1)     net(2)    gain/cost(2)")
for X in (0, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000):
    eff = X * (1 - np.exp(-900 / 300))
    r1 = attack_static(bk, 2, 600, spoof_usd=eff); r2 = attack_static(bk, 2, 600, spoof_usd=eff, two_leg=True, T2=900)
    print(f"   {X:>9,}   {r1['N1']:>9,.0f}    {r1['venue']:>9,.2f}    {r2['venue']:>9,.2f}      {r1['ref_cost']:6.2f}   {r1['net']:>+9,.2f}  {r2['net']:>+9,.2f}   {r2['venue']/r2['ref_cost']:8.1f}")

print()
print("H. Refill. The consumed levels are re-posted at rate r and consumed again while the push is held (cost x (1 + r*T)).")
print("   Largest mean refill delay 1/r at which the attack still breaks even (best m, T), book A, by variant:")
def breakeven_delay(**kw):
    lo, hi = 0.1, 1e6      # seconds of mean refill delay
    for _ in range(60):
        mid_ = np.sqrt(lo * hi)
        m, T, r = best_attack(bk, Ts=(30, 60, 100, 150, 200, 300, 450, 600, 900, 1200, 1800), refill_rate=1 / mid_, **kw)
        if r["net"] > 0: hi = mid_
        else: lo = mid_
    return hi
for label, kw in (("one leg, fee on", {}), ("two legs, fee on", dict(two_leg=True, T2=900)),
                  ("one leg, no fee", dict(taker=0.0)), ("two legs, no fee", dict(two_leg=True, T2=900, taker=0.0)),
                  ("two legs, fee on, spoof 10x depth", dict(two_leg=True, T2=900, spoof_usd=10_000)),
                  ("two legs, fee on, spoof 100x depth", dict(two_leg=True, T2=900, spoof_usd=100_000))):
    d = breakeven_delay(**kw)
    print(f"   {label:38s}: profitable when the book takes longer than {d:8.1f} s to refill" if d < 9e5 else f"   {label:38s}: never profitable")
bkno = ubook(159, 1)
for label, kw in (("NO side at 79.5c, one leg, fee on", dict(direction=-1)), ("NO side at 79.5c, two legs, fee on", dict(direction=-1, two_leg=True, T2=900))):
    lo, hi = 0.1, 1e6
    for _ in range(60):
        mid_ = np.sqrt(lo * hi)
        m, T, r = best_attack(bkno, Ts=(30, 60, 100, 150, 200, 300, 450, 600, 900, 1200, 1800), refill_rate=1 / mid_, **kw)
        if r["net"] > 0: hi = mid_
        else: lo = mid_
    print(f"   {label:38s}: profitable when the book takes longer than {hi:8.1f} s to refill")
