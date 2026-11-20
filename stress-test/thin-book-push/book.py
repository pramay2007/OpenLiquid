"""
Static reference book and the push attack against it, in exact ticks.

Book: best bid at tick B0, best ask at tick A0 = B0 + s.  usd_ask[j] rests at tick A0+j, usd_bid[j] at
tick B0-j, in USD measured the way the keeper measures depth (price * contracts).

Push "up" (helps a YES long): the attacker lifts the first m non-empty ask levels (taker), which makes
the next non-empty ask A* the best ask, and rests a 1-contract bid at A*-1 (maker, inside the spread).
The reference mid, as the keeper computes it ((best bid + best ask)/2), becomes (A* - 0.5) ticks.
Push "down" (helps a NO long) is the mirror image on the bid side.

Cost of a push = what the attacker overpays against the pre-push mid on the contracts he consumes
(inventory marked at the pre-push mid, i.e. at fair value) + Gemini taker fees.  An optional
unwind cost (selling the inventory back as a taker) is reported separately as an upper bound.
"""
import numpy as np
from venue import TICK, DEPTH_TICKS, GEMINI_TAKER, catchup_written, catchup_exact, cap_free, PROFIT_SHARE_EVENT


class Book:
    def __init__(self, B0, s, usd_bid, usd_ask):
        self.B0 = int(B0); self.s = int(s); self.A0 = self.B0 + self.s
        self.usd_bid = np.asarray(usd_bid, float); self.usd_ask = np.asarray(usd_ask, float)
        assert self.usd_bid[0] > 0 and self.usd_ask[0] > 0, "level 0 is the best quote by definition"

    @classmethod
    def uniform(cls, B0, s, rho, levels=40):
        return cls(B0, s, np.full(levels, float(rho)), np.full(levels, float(rho)))

    # prices
    def ask_px(self): return (self.A0 + np.arange(len(self.usd_ask))) * TICK
    def bid_px(self): return (self.B0 - np.arange(len(self.usd_bid))) * TICK
    @property
    def mid(self): return (self.B0 + self.A0) / 2 * TICK

    def depth5(self):
        """Keeper's depth: USD within 5 ticks of the mid, thinner side."""
        band = DEPTH_TICKS * TICK + 1e-9
        da = self.usd_ask[np.abs(self.ask_px() - self.mid) <= band].sum()
        db = self.usd_bid[np.abs(self.bid_px() - self.mid) <= band].sum()
        return min(da, db)

    def contracts5(self):
        """Contracts (not USD) within 5 ticks of the mid, thinner side."""
        band = DEPTH_TICKS * TICK + 1e-9
        ka = np.abs(self.ask_px() - self.mid) <= band; kb = np.abs(self.bid_px() - self.mid) <= band
        return min((self.usd_ask[ka] / self.ask_px()[ka]).sum(), (self.usd_bid[kb] / self.bid_px()[kb]).sum())

    def push(self, m, direction=+1, taker=GEMINI_TAKER):
        """Consume the first m non-empty levels on one side. Returns dict(delta, cost_fair, fees, contracts, usd, new_mid)."""
        if direction > 0:
            px, usd = self.ask_px(), self.usd_ask
        else:
            px, usd = self.bid_px(), self.usd_bid
        nz = np.flatnonzero(usd > 0)
        eat = nz[:m]
        nxt = nz[m]                                   # next resting level becomes the best quote
        c = usd[eat] / px[eat]
        overpay = (c * np.abs(px[eat] - self.mid)).sum()
        fees = (c * taker * px[eat] * (1 - px[eat])).sum()
        if direction > 0:
            best_ask_tick = self.A0 + nxt
            bid_tick = max(self.B0, best_ask_tick - 1)      # attacker's 1-lot bid
            new_mid = (bid_tick + best_ask_tick) / 2 * TICK
        else:
            best_bid_tick = self.B0 - nxt
            ask_tick = min(self.A0, best_bid_tick + 1)      # attacker's 1-lot ask
            new_mid = (best_bid_tick + ask_tick) / 2 * TICK
        return dict(delta=abs(new_mid - self.mid), new_mid=new_mid, cost_fair=overpay, fees=fees,
                    contracts=c.sum(), usd=usd[eat].sum(), eaten=eat, next_level=nxt)

    def unwind_cost(self, contracts, direction=+1, taker=GEMINI_TAKER):
        """Extra cost of dumping `contracts` back into the opposite side as a taker (beyond marking them at the mid)."""
        if contracts <= 0: return 0.0
        px, usd = (self.bid_px(), self.usd_bid) if direction > 0 else (self.ask_px(), self.usd_ask)
        left, cost = contracts, 0.0
        for p_, u_ in zip(px, usd):
            c = min(left, u_ / p_)
            cost += c * (abs(p_ - self.mid) + taker * p_ * (1 - p_))
            left -= c
            if left <= 1e-12: break
        return cost

    def depth5_after_push(self, m, direction=+1):
        """Keeper's depth right after the push (the 1-lot support counts for nothing)."""
        r = self.push(m, direction, taker=0.0)
        band = DEPTH_TICKS * TICK + 1e-9
        ua, ub = self.usd_ask.copy(), self.usd_bid.copy()
        if direction > 0: ua[r["eaten"]] = 0
        else: ub[r["eaten"]] = 0
        da = ua[np.abs(self.ask_px() - r["new_mid"]) <= band].sum()
        db = ub[np.abs(self.bid_px() - r["new_mid"]) <= band].sum()
        return min(da, db)


def venue_leg_profit(N, L, q0, dq, crowd_fee=0.0, share=PROFIT_SHARE_EVENT):
    """Net trader profit of a free-mode position with notional N, leverage L, own-side entry q0, closed dq higher."""
    M = N / L
    gross = np.minimum(cap_free(M, q0), (N / q0) * dq)
    fee = np.minimum(crowd_fee, np.maximum(gross, 0))
    return np.where(gross > 0, (gross - fee) * (1 - share), gross), gross


def attack_static(book, m, T, kappa=0.5, L=1, direction=+1, two_leg=False, T2=1e9, tau=300.0,
                  taker=GEMINI_TAKER, spoof_usd=0.0, refill_rate=0.0, capacity="usd", topup=True,
                  slow="exact", share=PROFIT_SHARE_EVENT, abs_cap=None):
    """
    Exact P&L of one push-and-hold cycle on a static book.
      direction=+1: leg 1 is a YES long (entry at the mid, exit at slow); optional leg 2 is a NO long opened
                    at the caught-up slow price and closed after the push is released.
      direction=-1: mirror image (leg 1 is a NO long).
      capacity: "usd"    -> N <= kappa * USD depth within 5 ticks (the rule as written),
                "shares" -> contracts <= kappa * contracts within 5 ticks (same thing for YES; NO scaled by (1-p)/p).
      refill_rate: the consumed levels are re-posted at this Poisson rate while the push is held and are
                   consumed again each time (expected cost multiplier 1 + rate*T).
    Returns a dict of dollar amounts.
    """
    g = catchup_exact(T, tau) if slow == "exact" else catchup_written(T, tau)
    pr = book.push(m, direction, taker)
    mid0, d = book.mid, pr["delta"]
    q0 = mid0 if direction > 0 else 1 - mid0                 # own-side entry of leg 1
    dep = book.depth5() + spoof_usd
    if capacity == "usd":
        N1 = kappa * dep
    else:                                                    # contracts-based
        N1 = kappa * (book.contracts5() + spoof_usd / mid0) * q0
    if abs_cap is not None: N1 = min(N1, abs_cap)
    net1, gross1 = venue_leg_profit(N1, L, q0, d * g, share=share)
    net2 = gross2 = N2 = 0.0
    if two_leg:
        slowT = d * g                                        # displacement of slow when leg 2 opens
        gap_ok = (d - slowT) <= 0.05 + 1e-12                 # R2: opens refused while |mid - slow| > 5 points
        q0b = (1 - (mid0 + slowT)) if direction > 0 else (mid0 - slowT)   # own-side entry of leg 2 (worse-of)
        dep2 = (book.depth5() if topup else book.depth5_after_push(m, direction)) + spoof_usd
        if capacity == "usd":
            N2 = kappa * dep2
        else:
            N2 = kappa * (book.contracts5() + spoof_usd / mid0) * q0b
        if abs_cap is not None: N2 = min(N2, abs_cap)
        if not gap_ok: N2 = 0.0
        g2 = 1 - np.exp(-T2 / tau)
        net2, gross2 = venue_leg_profit(N2, L, q0b, slowT * g2, share=share) if N2 > 0 else (0.0, 0.0)
    mult = 1.0 + refill_rate * T
    cost = (pr["cost_fair"] + pr["fees"]) * mult
    return dict(delta=d, g=g, N1=N1, N2=N2, margin=(N1 + N2) / L, venue=float(net1 + net2), house_loss=float(net1 + net2),
                gross=float(gross1 + gross2), ref_cost=cost, ref_usd=pr["usd"] * mult, contracts=pr["contracts"] * mult,
                unwind=book.unwind_cost(pr["contracts"], direction, taker), net=float(net1 + net2) - cost)


def n_levels_in_band(s):
    return int(np.floor(DEPTH_TICKS - s / 2 + 1e-9)) + 1 if s <= 2 * DEPTH_TICKS else 0
