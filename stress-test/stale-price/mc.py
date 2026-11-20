"""
Explicit-mechanics Monte Carlo of ONE trade on an event market, on a one-second clock.

This is deliberately a different abstraction from the dynamic program in model.py: here the
look-ahead is not a probability q, it emerges from the keeper timeline in R6:

  second t:
   (a) the trader's information is the Gemini mid as of t-1 (one second of latency end to end);
   (b) the Gemini mid ticks (+/-1c with probability lam per second, symmetric);
   (c) the keeper polls Gemini when (t - phase) % 4 == 0; a changed mid is signed and relayed and
       lands on-chain d seconds later (d = 1 or 2);
   (d) the on-chain slow price decays toward the on-chain mid (exact exponential, tau = 300 s);
   (e) a relay due at t lands: the on-chain mid changes;
   (f) keeper upkeep, carrying that price: liquidate (equity at the MID <= 20%), collect at the cap;
   (g) the trader's transaction lands LAST in the second and executes at the on-chain (mid, slow).

So the trader beats the keeper only if the relay has not landed by the trader's second, and the
keeper always wins ties. The signed price the trader needs (the old mid, newer than on-chain) is
at most d seconds old, which is why the 20 s validity never binds (max age is reported).

fix = "nextobs": every trader order (open or close) is a REQUEST that fills at the first price
observed by a keeper poll strictly after the request, when that price lands on-chain.
"""
import math
import numpy as np
from concurrent.futures import ProcessPoolExecutor
from model import Corridor, PROFIT_SHARE

OUT_NAMES = {0: "no trade (race lost)", 1: "liquidated", 2: "collected at cap", 3: "voluntary close",
             4: "look-ahead close", 5: "liquidation dodge", 6: "timeout"}


def simulate_trades(cor, lam, n, seed, tau=300.0, d=1, poll=4, J=1, policy="passive", tp_frac=0.9,
                    use_dodge=False, sol=None, use_la_nonliq=True, use_la_liq=True, fee_rate=0.0,
                    fix="none", T_max=400_000, haircut=0.0):
    """
    J = 0: honest entry at a quiet moment (t = 2).  J >= 1: a J-tick favourable move happens at
    t = 1 and the trader tries to open at the pre-move price at t = 2.
    policy = "passive": hold; close when the close P&L >= tp_frac*C; dodge liquidation if use_dodge.
    policy = "table"  : follow the stop rules implied by the DP solution `sol`.
    haircut: ticks added to the entry fill and taken off every trader close fill (candidate fix).
    """
    rng = np.random.default_rng(seed)
    a = math.exp(-1.0 / tau)
    k, C, W = cor.k, cor.C, cor.W
    trig_x = cor.trig
    pnl = np.zeros(n)
    hold = np.zeros(n, dtype=np.int32)
    outc = np.zeros(n, dtype=np.int8)
    maxage = 0

    ids = np.arange(n)
    phase = rng.integers(0, poll, n).astype(np.int32)
    g = np.zeros(n, dtype=np.int32)
    c = np.zeros(n, dtype=np.int32)
    s = np.zeros(n)
    last_sched = np.zeros(n, dtype=np.int32)
    pend_t = np.full(n, -1, dtype=np.int32)
    pend_val = np.zeros(n, dtype=np.int32)
    pos = np.zeros(n, dtype=bool)
    e0 = np.zeros(n)
    t_open = np.zeros(n, dtype=np.int32)
    order = np.zeros(n, dtype=np.int8)        # nextobs: 0 none, 1 open, 2 close
    order_t = np.zeros(n, dtype=np.int32)     # request time
    exec_t = np.full(n, -1, dtype=np.int32)   # scheduled execution time (set at first poll > request)

    if policy == "table":
        V, A, xs0, s_lo, ds_ = sol["V"], sol["A"], sol["xs"][0], sol["s_lo"], sol["ds"]
        nxr, nsr = V.shape
        la_row0_ok = use_la_liq
        la_rows_ok = use_la_nonliq

    def finish(mask, values, code, t):
        nonlocal ids, pos
        w = ids[mask]
        pnl[w] = values
        outc[w] = code
        hold[w] = t - t_open[mask]

    t = 0
    alive = np.ones(n, dtype=bool)
    while True:
        t += 1
        m = len(ids)
        if m == 0:
            break
        # (a) information available to the trader this second
        g_prev = g.copy()
        # (b) ticks
        if t == 1:
            if J:
                g = g + J
        else:
            u = rng.random(m)
            g = g + (u < 0.5 * lam).astype(np.int32) - ((u >= 0.5 * lam) & (u < lam)).astype(np.int32)
        # (c) keeper poll
        pm = ((t - phase) % poll) == 0
        ch = pm & (g != last_sched)
        if ch.any():
            pend_val[ch] = g[ch]
            pend_t[ch] = t + d
            last_sched[ch] = g[ch]
        if fix == "nextobs":
            # a request made before this poll is scheduled to fill when this poll's price lands
            sch = pm & (order > 0) & (exec_t < 0) & (order_t < t)
            exec_t[sch] = t + d
        # (d) slow decays toward the on-chain mid held over the last second
        s = c + (s - c) * a
        # (e) relay lands
        ld = pend_t == t
        if ld.any():
            c[ld] = pend_val[ld]
        done = np.zeros(m, dtype=bool)
        # (f) keeper upkeep
        if pos.any():
            x = c - e0
            sp = s - e0
            liq = pos & (x <= trig_x + 1e-9)
            if liq.any():
                finish(liq, cor.liq_net(x[liq]), 1, t)
                done |= liq
            col = pos & ~liq & (np.minimum(x, sp) >= W - 1e-9)
            if col.any():
                fee = fee_rate * (t - t_open[col])
                finish(col, (1 - PROFIT_SHARE) * np.maximum(C - fee, 0.0), 2, t)
                done |= col
        # (g) trader
        if fix == "nextobs":
            ex = (exec_t == t) & ~done
            if ex.any():
                op = ex & (order == 1)
                if op.any():
                    e0[op] = np.maximum(c[op], s[op]) + haircut
                    pos[op] = True
                    t_open[op] = t
                cl = ex & (order == 2) & pos
                if cl.any():
                    y = np.minimum(c[cl], s[cl]) - e0[cl] - haircut
                    fee = fee_rate * (t - t_open[cl])
                    finish(cl, cor.close_net(y, fee), 3, t)
                    done |= cl
                order[ex] = 0
                exec_t[ex] = -1
        if t == 2:
            if fix == "nextobs":
                order[:] = 1
                order_t[:] = t
            else:
                if J:
                    ok = (c == 0) & (s <= 1e-12)      # on-chain price still the pre-move one
                    lost = ~ok
                    if lost.any():
                        w = ids[lost]
                        outc[w] = 0
                        done |= lost
                    if ok.any() and d >= 1:
                        maxage = max(maxage, int(np.max(np.where(pend_t[ok] > t, t - (pend_t[ok] - d) + 1, 0))))
                else:
                    ok = np.ones(m, dtype=bool)
                e0[ok] = np.maximum(c[ok], s[ok]) + haircut
                pos[ok] = True
                t_open[ok] = t
        elif t > 2:
            act = pos & ~done
            if act.any():
                x = c - e0
                sp = s - e0
                yfill = np.minimum(x, sp) - haircut
                r = cor.gross(yfill)
                D = g_prev - c                      # change the trader knows about, not yet on-chain
                stop = np.zeros(m, dtype=bool)
                code = np.zeros(m, dtype=np.int8)
                if policy == "passive":
                    tp = act & (r >= tp_frac * C - 1e-12)
                    stop |= tp
                    code[tp] = 3
                    if use_dodge:
                        dg = act & (D < 0) & ((x + D) <= trig_x + 1e-9)
                        stop |= dg
                        code[dg] = 5
                else:
                    ix = np.clip(np.rint(x - xs0).astype(np.int64), 0, nxr - 1)
                    js = np.clip(np.rint((sp - s_lo) / ds_).astype(np.int64), 0, nsr - 1)
                    cn = np.where(r > 0, (1 - PROFIT_SHARE) * r, r)
                    vol = act & (D == 0) & A[ix, js]
                    stop |= vol
                    code[vol] = 3
                    adv = act & (D < 0)
                    if adv.any():
                        xn = x + D
                        ixn = np.rint(xn - xs0).astype(np.int64)
                        liqn = ixn < 0
                        Vn = np.where(liqn, cor.liq_net(xn), V[np.clip(ixn, 0, nxr - 1), js])
                        want = adv & (cn > Vn + 1e-9)
                        want &= np.where(liqn, la_row0_ok, la_rows_ok)
                        stop |= want
                        code[want & liqn] = 5
                        code[want & ~liqn] = 4
                if stop.any():
                    if fix == "nextobs":
                        newo = stop & (order == 0)
                        order[newo] = 2
                        order_t[newo] = t
                    else:
                        la = stop & (D != 0)
                        if la.any():
                            maxage = max(maxage, int(np.max(np.where(pend_t[la] > t, t - (pend_t[la] - d) + 1, 0))))
                        for cd in (3, 4, 5):
                            mk = stop & (code == cd)
                            if mk.any():
                                finish(mk, cor.close_net(yfill[mk], fee_rate * (t - t_open[mk])), cd, t)
                        done |= stop
        if t >= T_max:
            rem = pos & ~done
            if rem.any():
                y = np.minimum(c[rem], s[rem]) - e0[rem] - haircut
                finish(rem, cor.close_net(y, fee_rate * (t - t_open[rem])), 6, t)
            break
        if done.any():
            keep = ~done
            ids = ids[keep]; phase = phase[keep]; g = g[keep]; c = c[keep]; s = s[keep]
            last_sched = last_sched[keep]; pend_t = pend_t[keep]; pend_val = pend_val[keep]
            pos = pos[keep]; e0 = e0[keep]; t_open = t_open[keep]
            order = order[keep]; order_t = order_t[keep]; exec_t = exec_t[keep]
    return pnl, outc, hold, maxage


def _worker(args):
    kw, n, seed = args
    return simulate_trades(n=n, seed=seed, **kw)


def run(n=200_000, seed=1, workers=8, **kw):
    """Run n paths split over worker processes. Returns dict of summary statistics."""
    ss = np.random.SeedSequence(seed).spawn(workers)
    per = [n // workers + (1 if i < n % workers else 0) for i in range(workers)]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(_worker, [(kw, per[i], ss[i]) for i in range(workers)]))
    pnl = np.concatenate([r[0] for r in res])
    outc = np.concatenate([r[1] for r in res])
    hold = np.concatenate([r[2] for r in res])
    maxage = max(r[3] for r in res)
    return summarize(pnl, outc, hold, maxage)


def summarize(pnl, outc, hold, maxage):
    n = len(pnl)
    traded = outc != 0
    nt = int(traded.sum())
    out = dict(n=n, n_traded=nt, p_trade=nt / n, maxage=maxage)
    out["ev_all"] = float(pnl.mean())
    out["se_all"] = float(pnl.std(ddof=1) / math.sqrt(n))
    if nt > 1:
        pt = pnl[traded]
        out["ev_trade"] = float(pt.mean())
        out["se_trade"] = float(pt.std(ddof=1) / math.sqrt(nt))
        out["hold_mean"] = float(hold[traded].mean())
        out["hold_median"] = float(np.median(hold[traded]))
        out["p_loss"] = float((pt < 0).mean())
        out["outcomes"] = {OUT_NAMES[cd]: float((outc[traded] == cd).mean()) for cd in (1, 2, 3, 4, 5, 6)}
    return out


def fmt(res):
    o = res.get("outcomes", {})
    os_ = ", ".join(f"{kk} {vv:.3f}" for kk, vv in o.items() if vv > 0)
    return (f"EV/trade {res.get('ev_trade', float('nan')):+.4f} (se {res.get('se_trade', float('nan')):.4f}), "
            f"P(trade) {res['p_trade']:.3f}, EV/attempt {res['ev_all']:+.4f} (se {res['se_all']:.4f}), "
            f"hold mean {res.get('hold_mean', float('nan')):.0f}s median {res.get('hold_median', float('nan')):.0f}s, "
            f"P(loss) {res.get('p_loss', float('nan')):.3f}, max price age {res['maxage']}s | {os_}")
