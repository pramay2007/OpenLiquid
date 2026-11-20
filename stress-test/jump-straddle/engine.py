"""
Vectorised path engine for OpenLiquid event markets (one market, many independent paths).

Implements, per path:
  R1  mid + slow price, worse-of fills (buy = max, sell = min; a NO is a long at 1-p)
  R2  opens refused while |mid - slow| > 5 points; closes always allowed
  R4  liquidation when equity AT THE MID <= 20% of margin; liquidator takes 5% of margin out of
      the remaining equity; the rest returns to the trader
  R7  10% of profit (net of the crowding fee) at close
  E1/E2 free mode: P&L = clamp(n (p - p0), -M, +M (1-p0)/p0); collect() at the cap (close price)
  E3  open limit L <= min(50, min(p,1-p)/0.02, Ltime); optional keeper force-close of L > Ltime(mid)
  E4  crowding fee on borrowed shares * skewFrac * (1-p_s)/tau, from profit only
  E5  Boost: cap min(10 M, n (1-p0)); premium borrowed * (1-p_s)/tau out of equity
Contract details also modelled (they are in the draft engine, not in the rule list):
  * integer leverage; an open is refused if the worse-of fill costs > 30% of margin against the mid;
  * opens only while 0.01 <= mid <= 0.99.
Slow price: the rule text says slow += (prevMid - slow) * dt / (tau + dt) per update; the contract
uses the exact exponential.  `slow_rule` selects; at 4 s steps the two differ by < 1e-4 per step.
Capacity (R3/E6) and the vault lock (R5) are not binding here: results are per $1 of margin.
"""
import numpy as np
from rules import (MAINT, LIQ_FEE, PROFIT_SHARE, TAU_SLOW, MAX_GAP, TAU_FLOOR, BOOST_MULT,
                   lev_time, max_lev)


class Engine:
    def __init__(self, P, p0, *, tau_slow=TAU_SLOW, slow_rule="task", profit_share=PROFIT_SHARE,
                 ext_B=(0.0, 0.0), entry_gate=True, liq_on=True):
        self.P = P
        self.mid = np.full(P, float(p0))
        self.slow = np.full(P, float(p0))
        self.tau_slow = tau_slow
        self.slow_rule = slow_rule
        self.profit_share = profit_share
        self.ext_B = ext_B          # external borrowed shares (YES side, NO side), scalars or arrays
        self.entry_gate = entry_gate
        self.liq_on = liq_on
        self.cumFee = np.zeros((2, P))
        self.cumBoost = np.zeros((2, P))
        self.resolved = np.zeros(P, dtype=bool)
        self.slots = []
        z = lambda: np.zeros(P)
        self.house, self.trader, self.liqfee, self.pfee, self.crowd, self.prem = z(), z(), z(), z(), z(), z()
        self.margin_opened, self.n_opens = z(), z()
        self.n_liq, self.n_collect, self.n_force, self.n_close, self.n_settle = z(), z(), z(), z(), z()

    # ------------------------------------------------------------------ helpers
    def add_slot(self):
        P = self.P
        s = dict(open=np.zeros(P, dtype=bool), side=np.ones(P), boost=np.zeros(P, dtype=bool),
                 M=np.zeros(P), L=np.ones(P), e=np.full(P, 0.5), n=np.zeros(P), B=np.zeros(P),
                 cap=np.zeros(P), fee0=np.zeros(P), boost0=np.zeros(P), pnl=np.zeros(P),
                 house=np.zeros(P), opened=np.zeros(P), t_open=np.zeros(P))
        self.slots.append(s)
        return s

    @staticmethod
    def own(side, x):
        return np.where(side > 0, x, 1.0 - x)

    def borrowed(self):
        BY = np.zeros(self.P) + self.ext_B[0]
        BN = np.zeros(self.P) + self.ext_B[1]
        for s in self.slots:
            BY = BY + np.where(s["open"] & (s["side"] > 0), s["B"], 0.0)
            BN = BN + np.where(s["open"] & (s["side"] < 0), s["B"], 0.0)
        return BY, BN

    # ------------------------------------------------------------------ price step + accrual
    def step(self, new_mid, dt, tau_exp):
        live = ~self.resolved
        if self.slow_rule == "task":
            new_slow = self.slow + (self.mid - self.slow) * dt / (self.tau_slow + dt)
        else:
            new_slow = self.mid + (self.slow - self.mid) * np.exp(-dt / self.tau_slow)
        self.slow = np.where(live, new_slow, self.slow)
        self.mid = np.where(live, new_mid, self.mid)
        tau_eff = np.maximum(tau_exp, TAU_FLOOR)
        BY, BN = self.borrowed()
        rY = np.where(live, (1.0 - self.mid) / tau_eff * dt, 0.0)
        rN = np.where(live, self.mid / tau_eff * dt, 0.0)
        self.cumBoost[0] += rY
        self.cumBoost[1] += rN
        skY = np.where(BY > BN, (BY - BN) / np.maximum(BY, 1e-300), 0.0)
        skN = np.where(BN > BY, (BN - BY) / np.maximum(BN, 1e-300), 0.0)
        self.cumFee[0] += rY * skY
        self.cumFee[1] += rN * skN

    def _charges(self, s):
        yes = s["side"] > 0
        cumF = np.where(yes, self.cumFee[0], self.cumFee[1])
        cumB = np.where(yes, self.cumBoost[0], self.cumBoost[1])
        crowd = np.where(s["boost"], 0.0, s["B"] * (cumF - s["fee0"]))
        prem = np.where(s["boost"], s["B"] * (cumB - s["boost0"]), 0.0)
        return crowd, prem

    # ------------------------------------------------------------------ settlement
    def _settle(self, s, mask, price_own, kind):
        mask = mask & s["open"]
        if not mask.any():
            return mask
        crowd, prem = self._charges(s)
        gross = np.minimum(s["n"] * (price_own - s["e"]), s["cap"])
        res = np.maximum(gross - prem, -s["M"])
        win = res > 0
        crowd = np.where(win, np.minimum(crowd, res), 0.0)
        profit = np.where(win, res - crowd, 0.0)
        fee = self.profit_share * profit
        payout = np.where(win, s["M"] + profit - fee, s["M"] + res)
        if kind == "liq":
            lf = np.minimum(LIQ_FEE * s["M"], payout)
        else:
            lf = np.zeros(self.P)
        payout = payout - lf
        tr = payout - s["M"]
        hs = -tr - lf
        m = mask
        self.trader += np.where(m, tr, 0.0)
        self.house += np.where(m, hs, 0.0)
        self.liqfee += np.where(m, lf, 0.0)
        self.pfee += np.where(m, fee, 0.0)
        self.crowd += np.where(m, crowd, 0.0)
        self.prem += np.where(m, np.minimum(prem, np.maximum(s["M"] + gross, 0.0)), 0.0)
        s["pnl"] += np.where(m, tr, 0.0)
        s["house"] += np.where(m, hs, 0.0)
        cnt = dict(liq=self.n_liq, collect=self.n_collect, force=self.n_force, close=self.n_close,
                   settle=self.n_settle)[kind]
        cnt += m
        s["open"] = s["open"] & ~m
        return m

    def close(self, s, mask):
        cs = np.minimum(self.own(s["side"], self.mid), self.own(s["side"], self.slow))
        return self._settle(s, mask & ~self.resolved, cs, "close")

    def equity_mid(self, s):
        crowd, prem = self._charges(s)
        ms = self.own(s["side"], self.mid)
        res = np.maximum(np.minimum(s["n"] * (ms - s["e"]), s["cap"]) - prem, -s["M"])
        return s["M"] + res

    def pnl_close(self, s):
        """Unrealised result at the worse-of close price (capped, after premium, before fees)."""
        crowd, prem = self._charges(s)
        cs = np.minimum(self.own(s["side"], self.mid), self.own(s["side"], self.slow))
        return np.maximum(np.minimum(s["n"] * (cs - s["e"]), s["cap"]) - prem, -s["M"])

    def upkeep(self, tau_exp, force_close=True, expired=False):
        """Keeper sweep: liquidate, then collect, then force-close (the keeper's own order)."""
        live = ~self.resolved
        for s in self.slots:
            if not s["open"].any():
                continue
            ms = self.own(s["side"], self.mid)
            if self.liq_on:
                liq = s["open"] & live & (self.equity_mid(s) <= MAINT * s["M"] + 1e-12)
                self._settle(s, liq, ms, "liq")
            cs = np.minimum(ms, self.own(s["side"], self.slow))
            col = s["open"] & live & (s["n"] * (cs - s["e"]) >= s["cap"] - 1e-12)
            self._settle(s, col, cs, "collect")
            if force_close:
                if expired:
                    lt = np.ones(self.P)
                else:
                    lt = np.maximum(1.0, np.minimum(50.0, np.floor(lev_time(np.clip(self.mid, 1e-9, 1 - 1e-9), tau_exp) + 1e-9)))
                fc = s["open"] & live & (s["L"] > lt + 1e-9)
                self._settle(s, fc, cs, "force")

    # ------------------------------------------------------------------ opening
    def open(self, s, mask, side, boost, M, L, tau_exp, t=0.0, check=True):
        P = self.P
        side = np.zeros(P) + side
        boost = np.zeros(P, dtype=bool) | boost
        M = np.zeros(P) + M
        L = np.zeros(P) + L
        ms = self.own(side, self.mid)
        ss = self.own(side, self.slow)
        e = np.maximum(ms, ss)
        ok = mask & ~s["open"] & ~self.resolved & (M > 0)
        n = M * L / np.maximum(e, 1e-12)
        if check:
            ok &= np.abs(self.mid - self.slow) <= MAX_GAP + 1e-12
            ok &= (self.mid >= 0.01 - 1e-12) & (self.mid <= 0.99 + 1e-12)
            ok &= L <= max_lev(np.clip(self.mid, 1e-9, 1 - 1e-9), tau_exp) + 1e-9
            if self.entry_gate:
                ok &= n * (e - ms) <= 0.30 * M + 1e-12
        cap = np.where(boost, np.minimum(BOOST_MULT * M, n * (1 - e)), M * (1 - e) / np.maximum(e, 1e-12))
        yes = side > 0
        for k, v in (("side", side), ("boost", boost), ("M", M), ("L", L), ("e", e), ("n", n),
                     ("B", n * (1 - 1 / L)), ("cap", cap),
                     ("fee0", np.where(yes, self.cumFee[0], self.cumFee[1])),
                     ("boost0", np.where(yes, self.cumBoost[0], self.cumBoost[1])),
                     ("t_open", np.zeros(P) + t)):
            s[k] = np.where(ok, v, s[k])
        s["open"] = s["open"] | ok
        s["opened"] += np.where(ok, M, 0.0)
        self.margin_opened += np.where(ok, M, 0.0)
        self.n_opens += ok
        return ok

    # ------------------------------------------------------------------ resolution
    def resolve(self, mask, final_yes):
        """Market resolves on `mask` paths to final_yes (0/1 array). Everything open is settled."""
        mask = mask & ~self.resolved
        fy = np.zeros(self.P) + final_yes
        self.mid = np.where(mask, fy, self.mid)
        self.slow = np.where(mask, fy, self.slow)
        for s in self.slots:
            self._settle(s, mask, self.own(s["side"], fy), "settle")
        self.resolved = self.resolved | mask


def summarize(x, label="", per=None, out=True):
    """Mean and standard error of a per-path array (optionally divided by a scalar)."""
    x = np.asarray(x, dtype=float)
    if per is not None:
        x = x / per
    m = x.mean()
    se = x.std(ddof=1) / np.sqrt(len(x))
    if out:
        print(f"    {label:58s} mean {m:+9.4f}  (s.e. {se:.4f})   min {x.min():+8.3f}  max {x.max():+8.3f}")
    return float(m), float(se)
