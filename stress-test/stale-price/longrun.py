"""
Long-run extraction rate of one relay-lag sniper on one event market near 50c at 25x.

Same one-second keeper timeline as mc.py (4 s poll, relay lands d seconds after the poll, keeper
wins ties, trader has one second of latency). One position at a time, 1 USDC of margin each time
(no compounding), both sides:
  * flat, sees an up-tick not yet on-chain and the buy fill max(mid, slow) is within `dmax` ticks
    of the stale mid  -> opens a long YES at max leverage;
  * mirror image for NO on a down-tick;
  * exits by the stop rules of the DP solution (voluntary close, look-ahead close, dodge).
Simplification: corridor parameters are frozen at their 50c values (k = 0.5 margin per tick,
C = 1, win line +2 ticks, liquidation at -2 ticks) while the mid random-walks around 50c.

Usage: python3 longrun.py <1/lam> <d> <hours> <fee_tau_days or 0> [n_paths]
"""
import math, sys, time, json
import numpy as np
from concurrent.futures import ProcessPoolExecutor
from model import Corridor, solve_dp, PROFIT_SHARE


def sim(args):
    lam, d, H, fee_rate, n, seed, solpack, dmax, snipe = args
    V, A, xs0, s_lo, ds_ = solpack
    nxr, nsr = V.shape
    cor = Corridor(0.5, 25)
    k, C, W, trig = cor.k, cor.C, cor.W, cor.trig
    rng = np.random.default_rng(seed)
    a = math.exp(-1.0 / 300.0)
    poll = 4
    phase = rng.integers(0, poll, n).astype(np.int32)
    g = np.zeros(n, dtype=np.int32); c = np.zeros(n, dtype=np.int32); s = np.zeros(n)
    last_sched = np.zeros(n, dtype=np.int32)
    pend_t = np.full(n, -1, dtype=np.int32); pend_val = np.zeros(n, dtype=np.int32)
    sig = np.zeros(n, dtype=np.int32)      # 0 flat, +1 long YES, -1 long NO
    e0 = np.zeros(n); t_open = np.zeros(n, dtype=np.int32)
    cum = np.zeros(n); ntr = np.zeros(n, dtype=np.int32); tin = np.zeros(n, dtype=np.int64)
    nwin = np.zeros(n, dtype=np.int32); nliq = np.zeros(n, dtype=np.int32)
    opp = np.zeros(n, dtype=np.int32); skipped = np.zeros(n, dtype=np.int32)
    for t in range(1, H + 1):
        g_prev = g.copy()
        u = rng.random(n)
        g = g + (u < 0.5 * lam).astype(np.int32) - ((u >= 0.5 * lam) & (u < lam)).astype(np.int32)
        pm = ((t - phase) % poll) == 0
        ch = pm & (g != last_sched)
        pend_val[ch] = g[ch]; pend_t[ch] = t + d; last_sched[ch] = g[ch]
        s = c + (s - c) * a
        ld = pend_t == t
        c[ld] = pend_val[ld]
        inpos = sig != 0
        tin += inpos
        x = sig * (c - e0)
        sp = sig * (s - e0)
        # keeper upkeep
        liq = inpos & (x <= trig + 1e-9)
        if liq.any():
            cum[liq] += cor.liq_net(x[liq]); nliq[liq] += 1
        col = inpos & ~liq & (np.minimum(x, sp) >= W - 1e-9)
        if col.any():
            cum[col] += (1 - PROFIT_SHARE) * np.maximum(C - fee_rate * (t - t_open[col]), 0.0); nwin[col] += 1
        closed = liq | col
        was_flat = ~inpos
        # trader: manage an open position
        act = inpos & ~closed
        if act.any():
            y = np.minimum(x, sp)
            r = cor.gross(y)
            cn = np.where(r > 0, (1 - PROFIT_SHARE) * r, r)
            D = sig * (g_prev - c)
            ix = np.clip(np.rint(x - xs0).astype(np.int64), 0, nxr - 1)
            js = np.clip(np.rint((sp - s_lo) / ds_).astype(np.int64), 0, nsr - 1)
            stop = act & (D == 0) & A[ix, js]
            adv = act & (D < 0)
            if adv.any() and snipe:
                xn = x + D
                ixn = np.rint(xn - xs0).astype(np.int64)
                liqn = (xn <= trig + 1e-9)
                Vn = np.where(liqn, cor.liq_net(xn), V[np.clip(ixn, 0, nxr - 1), js])
                stop |= adv & (cn > Vn + 1e-9)
            if stop.any():
                val = cor.close_net(y[stop], fee_rate * (t - t_open[stop]))
                cum[stop] += val; nwin[stop] += (val > 0)
                closed |= stop
        sig[closed] = 0
        # trader: open when flat
        Dm = g_prev - c
        if snipe:
            up = was_flat & (Dm >= 1)
            dn = was_flat & (Dm <= -1)
            opp += up | dn
            okl = up & ((np.maximum(c, s) - c) <= dmax)
            oks = dn & ((c - np.minimum(c, s)) <= dmax)
            skipped += (up & ~okl) | (dn & ~oks)
        else:
            # uninformed control: opens a random side at a random moment (same average frequency)
            v = rng.random(n)
            okl = was_flat & (v < 0.5 * lam) & ((np.maximum(c, s) - c) <= dmax)
            oks = was_flat & (v >= 0.5 * lam) & (v < lam) & ((c - np.minimum(c, s)) <= dmax)
        if okl.any():
            sig[okl] = 1; e0[okl] = np.maximum(c[okl], s[okl]); t_open[okl] = t; ntr[okl] += 1
        if oks.any():
            sig[oks] = -1; e0[oks] = np.minimum(c[oks], s[oks]); t_open[oks] = t; ntr[oks] += 1
    # mark any open position at its close value
    inpos = sig != 0
    if inpos.any():
        x = sig * (c - e0); sp = sig * (s - e0)
        cum[inpos] += cor.close_net(np.minimum(x, sp)[inpos], fee_rate * (H - t_open[inpos]))
    return cum, ntr, tin, nwin, nliq, opp, skipped


def main():
    inv_lam = float(sys.argv[1]); d = int(sys.argv[2]); hours = float(sys.argv[3])
    fee_days = float(sys.argv[4]); n = int(sys.argv[5]) if len(sys.argv) > 5 else 200_000
    snipe = (sys.argv[6] != "control") if len(sys.argv) > 6 else True
    lam = 1.0 / inv_lam
    H = int(hours * 3600)
    cor = Corridor(0.5, 25)
    q = 1.0 if d >= 2 else 0.75
    if not snipe:
        q = 0.0
    fee_rate = 0.0 if fee_days == 0 else (cor.L - 1) / cor.p0 * (1 - cor.p0) / (fee_days * 86400.0)
    t0 = time.time()
    sol = solve_dp(cor, lam, q=q, mode="opt", la_nonliq=snipe, la_liq=snipe, ds=0.005)
    pack = (sol["V"], sol["A"], sol["xs"][0], sol["s_lo"], sol["ds"])
    workers = 8
    ss = np.random.SeedSequence(20261119 + int(inv_lam) + 7 * d).spawn(workers)
    per = n // workers
    with ProcessPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(sim, [(lam, d, H, fee_rate, per, ss[i], pack, 0.10, snipe) for i in range(workers)]))
    cum = np.concatenate([r[0] for r in res]); ntr = np.concatenate([r[1] for r in res])
    tin = np.concatenate([r[2] for r in res]); nwin = np.concatenate([r[3] for r in res])
    nliq = np.concatenate([r[4] for r in res]); opp = np.concatenate([r[5] for r in res])
    skp = np.concatenate([r[6] for r in res])
    N = len(cum)
    perh = cum / hours
    out = dict(inv_lam=inv_lam, d=d, q=q, hours=hours, fee_days=fee_days, fee_rate_per_s=fee_rate, n=N, snipe=snipe,
               pnl_per_hour=float(perh.mean()), se=float(perh.std(ddof=1) / math.sqrt(N)),
               trades_per_hour=float(ntr.mean() / hours), ev_per_trade=float(cum.sum() / max(ntr.sum(), 1)),
               frac_time_in_pos=float(tin.mean() / H), win_frac=float(nwin.sum() / max(ntr.sum(), 1)),
               liq_frac=float(nliq.sum() / max(ntr.sum(), 1)),
               opp_seconds_per_hour=float(opp.mean() / hours), skipped_frac=float(skp.sum() / max(opp.sum(), 1)),
               p_path_negative=float((cum < 0).mean()), secs=round(time.time() - t0))
    print(json.dumps(out))


if __name__ == "__main__":
    main()
