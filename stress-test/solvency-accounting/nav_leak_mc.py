"""
Monte Carlo: how far the vault's LINEAR mark of a free-mode event position is from what the
position can actually be paid (E2 clamp), at the moment the keeper can first act, and what
that is worth to (a) a same-block depositor and (b) an LP who leaves first.

Rules modelled exactly as written (per $1 of margin, YES side; NO is the mirror image):
  n = L/p0 shares, cap C = (1-p0)/p0, P&L = clamp(n(p-p0), -1, +C)
  win line p0+(1-p0)/L, stop line p0-p0/L, liquidation when equity at the mid <= 0.20
  liquidator gets min(0.05, equity) out of the remaining equity; the rest returns to the trader
  profit share 10% of net profit; 30% of it leaves the vault to stakers (contract default)
  1-cent ticks. The keeper acts at the first mid at which the position is collectable /
  liquidatable (best case for the house: no latency at all).

Price: an exact martingale on the tick grid. Each price change is +-k ticks, k drawn from the
regime's size distribution; near 0/1 the up/down probabilities are adjusted so E[dp]=0 and a
move that reaches 0 or 1 is the resolution. With `hazard` > 0 the market can also resolve
early at any change: to 1 with probability p, else to 0.

Simplifications: (1) fills at entry are at the mid (mid == slow, a calm book); (2) the slow
price does not delay collect(); in the contract it does, which only widens the window;
(3) no crowding fee (balanced book). None of these reduce the mis-mark.

usage: python3 nav_leak_mc.py [paths_per_config]
"""
import sys
import numpy as np

REGIMES = {
    # sizes (ticks), probabilities
    "calm (1-tick moves only)": ([1], [1.0]),
    "normal (15% multi-tick)": ([1, 2, 3, 5, 10], [0.85, 0.10, 0.03, 0.015, 0.005]),
    "newsy (30% multi-tick)": ([1, 2, 3, 5, 10, 25], [0.70, 0.15, 0.07, 0.04, 0.03, 0.01]),
}


def simulate(p0_tick, L, sizes, probs, hazard, n_paths, rng, max_steps=200_000):
    p0 = p0_tick / 100.0
    n = L / p0
    C = (1 - p0) / p0
    sizes = np.asarray(sizes)
    pos = np.full(n_paths, p0_tick, dtype=np.int64)
    alive = np.ones(n_paths, dtype=bool)
    lin_exit = np.zeros(n_paths)
    steps = np.zeros(n_paths, dtype=np.int64)
    resolved_exit = np.zeros(n_paths, dtype=bool)
    for _ in range(max_steps):
        idx = np.flatnonzero(alive)
        if idx.size == 0:
            break
        p = pos[idx]
        m = idx.size
        k = sizes[rng.choice(len(sizes), size=m, p=probs)]
        u = np.minimum(k, 100 - p)
        d = np.minimum(k, p)
        up = rng.random(m) < d / (u + d)
        newp = np.where(up, p + u, p - d)
        if hazard > 0:
            res = rng.random(m) < hazard
            to_one = rng.random(m) < p / 100.0
            newp = np.where(res, np.where(to_one, 100, 0), newp)
        pos[idx] = newp
        steps[idx] += 1
        lin = n * (newp - p0_tick) / 100.0
        done = (lin >= C - 1e-12) | (1.0 + lin <= 0.2 + 1e-12)
        di = idx[done]
        lin_exit[di] = lin[done]
        resolved_exit[di] = (newp[done] == 0) | (newp[done] == 100)
        alive[di] = False
    assert not alive.any(), "paths still alive"
    win = lin_exit >= C - 1e-12
    true = np.clip(lin_exit, -1.0, C)
    d_plus = np.where(win, lin_exit - C, 0.0)           # mark above what can be paid
    d_minus = np.where(~win, np.maximum(0.0, -1.0 - lin_exit), 0.0)  # mark below what can be lost
    equity = np.where(~win, np.maximum(0.0, 1.0 + lin_exit), 0.0)
    liq_fee = np.where(~win, np.minimum(0.05, equity), 0.0)
    fee = np.where(win, 0.10 * C, 0.0)
    fee_lp = 0.7 * fee
    return dict(win=win, true=true, d_plus=d_plus, d_minus=d_minus, liq_fee=liq_fee, fee=fee, fee_lp=fee_lp,
                steps=steps, C=C, n=n, resolved_exit=resolved_exit, zero_liq=(~win) & (equity <= 1e-12))


def ms(x):
    x = np.asarray(x, dtype=float)
    return x.mean(), x.std(ddof=1) / np.sqrt(x.size)


if __name__ == "__main__":
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 400_000
    rng = np.random.default_rng(20261119)
    configs = [(50, 5), (50, 10), (50, 20), (50, 24), (50, 25), (30, 10), (30, 15), (80, 5), (80, 10)]
    print(f"paths per row = {N:,}; all figures per $1 of margin opened; (SE) in parentheses")
    hdr = ("p0   L  | P(win)  E[trader pre-fee]  E[D+] mark>cap   E[D-] mark<-M   LP fee inc. | passive-LP EV: no JIT   "
           "JIT=pool (50%)   JIT=9x pool (90%) | liq w/ $0 reward")
    for hz in (0.0, 0.002):
        for name, (sizes, probs) in REGIMES.items():
            print(f"\n== regime: {name}; early-resolution hazard per price change = {hz} ==")
            print(hdr)
            for p0t, L in configs:
                r = simulate(p0t, L, sizes, probs, hz, N, rng)
                pw, _ = ms(r["win"])
                tr, tr_se = ms(r["true"])
                dp, dp_se = ms(r["d_plus"])
                dm, dm_se = ms(r["d_minus"])
                fl, fl_se = ms(r["fee_lp"])
                # passive LP P&L per $1 margin: -(trader true P&L) + fee kept by vault, minus what a
                # same-block depositor holding share s of the pool takes of the NAV jump at collect.
                base = -r["true"] + r["fee_lp"] - r["fee"] * 0  # fee already reduces trader payout
                # trader's net = true - fee; vault keeps fee_lp of it; stakers get the rest.
                lp0 = -r["true"] + r["fee_lp"]
                jump = r["d_plus"] + r["fee_lp"]
                out = []
                for s in (0.0, 0.5, 0.9):
                    out.append(ms(lp0 - s * jump))
                nl = (~r["win"]).sum()
                zl = r["zero_liq"].sum() / max(1, nl)
                print(f"{p0t/100:.2f} {L:3d} | {pw:.3f}  {tr:+.4f} ({tr_se:.4f})   {dp:.4f} ({dp_se:.4f})  "
                      f"{dm:.4f} ({dm_se:.4f})  {fl:.4f} | "
                      f"{out[0][0]:+.4f} ({out[0][1]:.4f})   {out[1][0]:+.4f} ({out[1][1]:.4f})   "
                      f"{out[2][0]:+.4f} ({out[2][1]:.4f}) | {100*zl:.0f}%")
