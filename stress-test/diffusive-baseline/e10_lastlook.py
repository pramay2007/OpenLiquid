"""
E10.  The stale-price window on the EXIT side ("last look"), exact lattice value.
Whole-cent walk.  When the next mid change is adverse, the holder closes at the price from before
the change with probability s (he saw the reference book move, or holds the previous signed price,
and his close lands before the keeper's relay).  Otherwise the bet runs as normal.
s = 0 is the honest bet.  Close-at-mid idealisation (slow price caught up) -> upper bound for exits
after an up-move; exact for exits at or below entry.
Also the ENTRY side: value of opening one tick before the relay (V(+1)) from e3.
"""
import numpy as np
from lattice import max_int_leverage

def value(p0, L, s, fee=0.10, maint=0.20, liqfee=0.05, h=0.01, optimal=True):
    n, C = L / p0, (1 - p0) / p0
    k_liq = int(np.floor((maint - 1) / (n * h) + 1e-9))
    k_cap = int(np.ceil(C / (n * h) - 1e-9))
    ks = np.arange(k_liq, k_cap + 1)
    lin = n * ks * h
    eq = np.maximum(1 + lin, 0)
    term = np.where(ks <= k_liq, eq - np.minimum(liqfee, eq) - 1, np.minimum(lin, C) * (1 - fee))
    close = np.where(lin > 0, lin * (1 - fee), lin)
    V = np.where((ks > k_liq) & (ks < k_cap), close, term)
    inter = (ks > k_liq) & (ks < k_cap)
    for _ in range(100000):
        up = np.roll(V, -1); dn = np.roll(V, 1)
        look = np.maximum(close, dn) if optimal else close
        cont = 0.5 * up + 0.5 * (s * look + (1 - s) * dn)
        Vn = np.where(inter, np.maximum(close, cont) if optimal else cont, term)
        if np.max(np.abs(Vn - V)) < 1e-14:
            break
        V = Vn
    i0 = int(np.where(ks == 0)[0][0])
    up = np.roll(V, -1); dn = np.roll(V, 1)
    look = np.maximum(close, dn) if optimal else close
    return (0.5 * up + 0.5 * (s * look + (1 - s) * dn))[i0]

print("EV per $1 margin of ONE bet opened honestly at the mid, with a last look on adverse ticks (success probability s)")
print(f"{'p0':>6} {'L':>3} | " + " ".join(f"s={s:<5}" for s in [0, 0.1, 0.25, 0.5, 0.75, 1.0]) + " | s* (breakeven)")
for p0, L in [(0.5, 25), (0.5, 10), (0.5, 5), (0.665, 16), (0.2, 10), (0.8, 10), (0.5, 2)]:
    vals = [value(p0, L, s) for s in [0, 0.1, 0.25, 0.5, 0.75, 1.0]]
    lo, hi = 0.0, 1.0
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if value(p0, L, mid) > 1e-12:
            hi = mid
        else:
            lo = mid
    print(f"{p0:6.3f} {L:3d} | " + " ".join(f"{v:+7.4f}" for v in vals) + f" | {hi:.3f}")
print("\n(plain hold-to-cap policy, exiting on every adverse tick the last look catches)")
for p0, L in [(0.5, 25), (0.5, 10), (0.665, 16)]:
    print(f"{p0:6.3f} {L:3d} | " + " ".join(f"{value(p0, L, s, optimal=False):+7.4f}" for s in [0, 0.1, 0.25, 0.5, 0.75, 1.0]))
