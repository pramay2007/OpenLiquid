"""
E2/E3.  Exact values on the tick lattice (no simulation error).

E2: what 1-cent ticks do to P(win) = p0 and to EV, for the honest "hold to collect or
    liquidation" bet, by entry price and leverage.
E3: scan every entry price on the lattice and every INTEGER leverage allowed by E3 for the
    best trader EV, under four descriptions of how the reference mid moves.
"""
import numpy as np
from lattice import lattice_value, regime, max_int_leverage

np.set_printoptions(linewidth=200)
TAU = 30 * 86400.0          # far from expiry: 30 days


def honest_table(reg_name, **kw):
    h, st, pr = regime(reg_name, **kw)
    print(f"\n--- honest hold-to-collect-or-liquidation bet, reference regime '{reg_name}' {kw} ---")
    print(f"{'p0':>5} {'L':>3} {'stop':>5} {'win':>5} | {'P(win)':>7} {'claim':>6} {'cont+80%':>8} | "
          f"{'EV':>8} {'fee':>7} {'liqcut':>7} {'clamp gain':>10} {'steps':>6}")
    for p0 in [0.2, 0.35, 0.5, 0.65, 0.8]:
        lmax = max_int_leverage(p0, TAU)
        for L in sorted({lmax, max(lmax // 2, 1), 5, 2, 1}, reverse=True):
            if L > lmax:
                continue
            r = lattice_value(p0, L, h, st, pr, policy="hold")
            th = 0.8 * p0 / (1 - 0.2 * p0)
            print(f"{p0:5.2f} {L:3d} {r['ds_ticks']:5.2f} {r['dw_ticks']:5.2f} | {r['p_win']:7.4f} {p0:6.3f} {th:8.4f} | "
                  f"{r['ev']:+8.4f} {-r['e_fee']:+7.4f} {-r['e_liqcut']:+7.4f} {r['e_under']:+10.4f} {r['e_steps']:6.1f}")


def scan(reg_name, fix=None, self_liq=False, **kw):
    """best EV over (entry price, integer leverage) with optimal stopping (close-at-mid bound)."""
    h, st, pr = regime(reg_name, **kw)
    best = []
    grid = np.round(np.arange(0.02, 0.981, 0.005 if h == 0.005 else 0.005), 3)
    for p0 in grid:
        lmax = max_int_leverage(p0, TAU)
        for L in range(2, lmax + 1):
            r = lattice_value(p0, L, h, st, pr, policy="optimal", liq_buffer_ticks=fix, self_liq=self_liq)
            rh = lattice_value(p0, L, h, st, pr, policy="hold", liq_buffer_ticks=fix, self_liq=self_liq)
            best.append((r["ev"], p0, L, r["ds_ticks"], r["dw_ticks"], rh["ev"], rh["e_under"], rh["p_liq"], rh["e_steps"]))
    best.sort(reverse=True)
    npos = sum(1 for b in best if b[0] > 1e-9)
    return best, npos, len(best)


if __name__ == "__main__":
    honest_table("full")
    honest_table("half")

    print("\n\n=== E3: scan for positive EV, integer leverage, optimal stopping (upper bound on exit) ===")
    for name, kw in [("full", {}), ("half", {}), ("mix", {"q": 0.25}), ("mix", {"q": 0.5}), ("mix", {"q": 0.1})]:
        best, npos, ntot = scan(name, **kw)
        print(f"\nregime {name} {kw}: {npos} of {ntot} (price, leverage) pairs have EV > 0; top 8:")
        print(f"{'EV opt':>8} {'p0':>6} {'L':>3} {'stop(t)':>8} {'win(t)':>7} {'EV hold':>8} {'clamp gain':>10} {'P(liq)':>7} {'steps':>6}")
        for b in best[:8]:
            print(f"{b[0]:+8.4f} {b[1]:6.3f} {b[2]:3d} {b[3]:8.3f} {b[4]:7.2f} {b[5]:+8.4f} {b[6]:+10.4f} {b[7]:7.3f} {b[8]:6.1f}")
        bh = sorted(best, key=lambda z: -z[5])[:3]
        print("   best under plain hold (no skill):", [(round(z[5], 4), z[1], z[2]) for z in bh])

    print("\n\n=== same scan with the proposed fix: liquidatable when equity <= max(20% M, P&L of one 1c tick) ===")
    for name, kw in [("full", {}), ("mix", {"q": 0.5})]:
        best, npos, ntot = scan(name, fix=1.0, **kw)
        print(f"regime {name} {kw}: {npos} of {ntot} pairs with EV > 0; best EV {best[0][0]:+.5f} at p0={best[0][1]} L={best[0][2]}")
        bh = sorted(best, key=lambda z: -z[5])[:1]
        print("   best plain-hold EV:", round(bh[0][5], 4), "at", bh[0][1], bh[0][2])
    print("\n=== alternative fix: minimum stop distance 5 ticks (L <= min(p,1-p)/0.05), full-tick regime ===")
    h, st, pr = regime("full")
    worst = (-9, None)
    for p0 in np.round(np.arange(0.05, 0.951, 0.005), 3):
        for L in range(2, int(np.floor(min(p0, 1 - p0) / 0.05 + 1e-9)) + 1):
            r = lattice_value(p0, L, h, st, pr, policy="optimal")
            if r["ev"] > worst[0]:
                worst = (r["ev"], (p0, L))
    print("   best trader EV:", worst)

    print("\n=== continuous leverage (the brief does not restrict L to integers): full-tick regime ===")
    h, st, pr = regime("full")
    bestc = (-9, None)
    for p0 in np.round(np.arange(0.05, 0.56, 0.01), 2):
        for ds in np.arange(2.501, 2.70, 0.001):           # stop distance in ticks
            L = p0 / (ds * 0.01)
            if L > min(50, min(p0, 1 - p0) / 0.02):
                continue
            r = lattice_value(p0, L, h, st, pr, policy="optimal")
            if r["ev"] > bestc[0]:
                bestc = (r["ev"], (p0, round(L, 3), round(ds, 3)))
    print("   best EV:", bestc)

    print("\n=== sensitivity of the best full-tick pocket to the liquidator cut being recaptured (self-liquidation) ===")
    best, npos, ntot = scan("full", self_liq=True)
    print(f"   self-liquidating trader: {npos} of {ntot} pairs EV>0, best {best[0][0]:+.4f} at {best[0][1]}, L={best[0][2]}")
