"""
Exact-integer Python port of OpenLiquid's PriceOracle / PerpEngine / Vault
(contracts/src as of the working tree), used to fuzz solvency and accounting
invariants under the new event-market rules (E1-E6).

Every division mirrors Solidity: unsigned floor division, signed division
truncating toward zero. Amounts are USDC with 6 decimals, prices 1e18.

Rule variants (the task text and the contract differ in three places):
  free_cap_ceiling : True  = contract (free-mode reserve also capped at maxProfitMult * M)
                     False = task text E2 (reserve = M(1-p0)/p0, no ceiling)
  crowd_rate       : 'code' = p(1-p)/tau per borrowed share (same both sides)
                     'task' = (1-p_s)/tau per borrowed share of side s
  liq_fee_from_vault : False = contract (liquidator fee capped at remaining equity)
                       True  = literal R4 ("liquidator gets 5% of M"), shortfall paid from seized margin
"""
from math import isqrt

WAD = 10**18
BPS = 10**4
UNIT = 10**36
LN2 = 693147180559945309
HOUR = 3600
DAY = 86400

EVENT_MIN_DISTANCE = 2 * 10**16
TIME_Z = 3
TAU_FLOOR = HOUR
MAX_ENTRY_LOSS_BPS = 3000
EVENT_MIN_PRICE = 10**16
EVENT_MAX_PRICE = 99 * 10**16

CLOSE, LIQUIDATION, FORCECLOSE, SETTLEMENT, COLLECT = range(5)
KIND_NAMES = ["close", "liquidation", "forceClose", "settlement", "collect"]


class Revert(Exception):
    pass


def sdiv(a, b):
    """Solidity signed division (truncates toward zero)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def exp_neg(x):
    k = x // LN2
    if k >= 60:
        return 0
    r = x - k * LN2
    term = WAD
    s = WAD
    for i in range(1, 17):
        term = (term * r) // (WAD * i)
        s += term
    return ((WAD * WAD) // s) >> k


def toward(avg, held, decay):
    if avg >= held:
        return held + ((avg - held) * decay) // WAD
    return held - ((held - avg) * decay) // WAD


class Feed:
    __slots__ = ("mid", "slow", "depthUsd", "slowDepth", "timestamp", "resolved")

    def __init__(self):
        self.mid = 0
        self.slow = 0
        self.depthUsd = 0
        self.slowDepth = 0
        self.timestamp = 0
        self.resolved = False

    def copy(self):
        f = Feed()
        f.mid, f.slow, f.depthUsd, f.slowDepth, f.timestamp, f.resolved = (
            self.mid, self.slow, self.depthUsd, self.slowDepth, self.timestamp, self.resolved)
        return f


class Oracle:
    def __init__(self):
        self.feeds = {}
        self.tau = {}

    def push(self, market, price, depth, ts, resolved, now):
        if ts > now + 10:
            raise Revert("FutureTimestamp")
        f = self.feeds.setdefault(market, Feed())
        if f.resolved or ts <= f.timestamp:
            return False
        tau = self.tau.get(market, 0)
        if f.timestamp == 0 or resolved or tau == 0:
            f.slow = price
            f.slowDepth = depth
        else:
            decay = exp_neg(((ts - f.timestamp) * WAD) // tau)
            f.slow = toward(f.slow, f.mid, decay)
            f.slowDepth = toward(f.slowDepth, f.depthUsd, decay)
        f.mid = price
        f.depthUsd = depth
        f.timestamp = ts
        f.resolved = resolved
        return True

    def read(self, market, now):
        f0 = self.feeds.get(market)
        if f0 is None:
            return Feed()
        f = f0.copy()
        tau = self.tau.get(market, 0)
        if f.timestamp != 0 and not f.resolved and tau != 0 and now > f.timestamp:
            decay = exp_neg(((now - f.timestamp) * WAD) // tau)
            f.slow = toward(f.slow, f.mid, decay)
            f.slowDepth = toward(f.slowDepth, f.depthUsd, decay)
        return f


class Config:
    __slots__ = ("enabled", "isEvent", "boostEnabled", "maxLeverage", "maxProfitMult", "profitFeeBps",
                 "kappaBps", "maxGapBps", "maxAge", "reactionSeconds", "expiry", "maxPositionNotional",
                 "crowdingPerDay", "hazardScale")

    def __init__(self, **kw):
        self.enabled = True
        self.isEvent = False
        self.boostEnabled = False
        self.maxLeverage = 1000
        self.maxProfitMult = 10
        self.profitFeeBps = 500
        self.kappaBps = 5000
        self.maxGapBps = 20
        self.maxAge = 20
        self.reactionSeconds = 0
        self.expiry = 0
        self.maxPositionNotional = 10_000_000 * 10**6
        self.crowdingPerDay = 5 * 10**14
        self.hazardScale = 0
        for k, v in kw.items():
            setattr(self, k, v)


class State:
    __slots__ = ("longOI", "shortOI", "longUnits", "shortUnits", "longBorrowed", "shortBorrowed",
                 "cumFeeLong", "cumFeeShort", "cumBoostLong", "cumBoostShort", "lastAccrual")

    def __init__(self, now):
        self.longOI = self.shortOI = self.longUnits = self.shortUnits = 0
        self.longBorrowed = self.shortBorrowed = 0
        self.cumFeeLong = self.cumFeeShort = self.cumBoostLong = self.cumBoostShort = 0
        self.lastAccrual = now


class Position:
    __slots__ = ("owner", "marketId", "isLong", "boosted", "openedAt", "margin", "notional", "entryPrice",
                 "reserve", "borrowedUnits", "entryFee", "entryBoost")


class Vault:
    """ERC-4626 (OpenZeppelin 5.0.2 math, decimals offset 6) + the engine hooks."""

    def __init__(self):
        self.cash = 0
        self.marginHeld = 0
        self.reserved = 0
        self.totalSupply = 0
        self.balance = {}
        self.engine = None
        self.now = 0  # set by the driver; totalAssets reads the oracle at this time
        self.staking_received = 0

    # -- views
    def freeLiquidity(self):
        locked = self.marginHeld + self.reserved
        return self.cash - locked if self.cash > locked else 0

    def totalAssets(self):
        owed = self.engine.unrealizedPnl(self.now) if self.engine else 0
        if owed > self.reserved:
            owed = self.reserved
        if owed < -self.marginHeld:
            owed = -self.marginHeld
        nav = self.cash - self.marginHeld - owed
        return nav if nav > 0 else 0

    def _toShares(self, assets, ceil=False):
        num = assets * (self.totalSupply + 10**6)
        den = self.totalAssets() + 1
        return -((-num) // den) if ceil else num // den

    def _toAssets(self, shares, ceil=False):
        num = shares * (self.totalAssets() + 1)
        den = self.totalSupply + 10**6
        return -((-num) // den) if ceil else num // den

    def maxWithdraw(self, who):
        own = self._toAssets(self.balance.get(who, 0))
        free = self.freeLiquidity()
        return own if own < free else free

    def maxRedeem(self, who):
        own = self.balance.get(who, 0)
        fs = self._toShares(self.freeLiquidity())
        return own if own < fs else fs

    # -- LP actions
    def deposit(self, who, assets):
        shares = self._toShares(assets)
        self.cash += assets
        self.totalSupply += shares
        self.balance[who] = self.balance.get(who, 0) + shares
        return shares

    def withdraw(self, who, assets):
        if assets > self.maxWithdraw(who):
            raise Revert("ERC4626ExceededMaxWithdraw")
        shares = self._toShares(assets, ceil=True)
        if shares > self.balance.get(who, 0):
            raise Revert("ERC20InsufficientBalance")
        self.balance[who] -= shares
        self.totalSupply -= shares
        self.cash -= assets
        return shares

    def redeem(self, who, shares):
        if shares > self.maxRedeem(who):
            raise Revert("ERC4626ExceededMaxRedeem")
        assets = self._toAssets(shares)
        self.balance[who] -= shares
        self.totalSupply -= shares
        if assets > self.cash:
            raise Revert("ERC20InsufficientBalance(vault)")
        self.cash -= assets
        return assets

    # -- engine hooks
    def lockPosition(self, margin, reserve):
        cash = self.cash + margin
        if cash < self.marginHeld + margin + self.reserved + reserve:
            raise Revert("InsufficientLiquidity")
        self.cash = cash
        self.marginHeld += margin
        self.reserved += reserve

    def settlePosition(self, margin, reserve, traderPayout, feeAmount, liquidatorFee):
        if margin > self.marginHeld or reserve > self.reserved:
            raise Revert("underflow(marginHeld/reserved)")
        out = traderPayout + feeAmount + liquidatorFee
        if out > self.cash:
            raise Revert("ERC20InsufficientBalance(vault)")
        self.marginHeld -= margin
        self.reserved -= reserve
        self.cash -= out
        self.staking_received += feeAmount


class Engine:
    def __init__(self, oracle, vault, free_cap_ceiling=True, crowd_rate="code", liq_fee_from_vault=False,
                 staked=True):
        self.oracle = oracle
        self.vault = vault
        vault.engine = self
        self.maintBps = 2000
        self.liqFeeBps = 500
        self.stakerShareBps = 3000
        self.minMargin = 10**6
        self.nextId = 1
        self.marketIds = []
        self.markets = {}
        self.states = {}
        self.positions = {}
        self.free_cap_ceiling = free_cap_ceiling
        self.crowd_rate = crowd_rate
        self.liq_fee_from_vault = liq_fee_from_vault
        self.staked = staked
        self.closed_log = []  # filled by _settle, drained by the fuzzer

    def setMarket(self, marketId, config, now):
        if marketId not in self.states:
            self.marketIds.append(marketId)
            self.states[marketId] = State(now)
        else:
            self._accrue(marketId, self.markets[marketId], self.oracle.read(marketId, now), now)
        self.markets[marketId] = config

    # ---- helpers ------------------------------------------------------------------------
    @staticmethod
    def _fill(f, isBuy):
        if isBuy:
            return f.mid if f.mid > f.slow else f.slow
        return f.mid if f.mid < f.slow else f.slow

    @staticmethod
    def _gapBps(c, f):
        diff = f.mid - f.slow if f.mid > f.slow else f.slow - f.mid
        return (diff * BPS) // (WAD if c.isEvent else f.slow)

    @staticmethod
    def _sideCap(c, f):
        depth = f.depthUsd if f.depthUsd < f.slowDepth else f.slowDepth
        return (depth * c.kappaBps) // BPS

    @staticmethod
    def _timeLeverage(c, mid, now):
        if not c.isEvent:
            return c.maxLeverage
        if now >= c.expiry:
            return 1
        if c.reactionSeconds == 0:
            return c.maxLeverage
        if mid >= WAD:
            return 1
        spread = (mid * (WAD - mid)) // WAD
        if spread == 0:
            return 1
        dist = mid if mid < WAD - mid else WAD - mid
        root = isqrt(((c.expiry - now) * UNIT) // (c.reactionSeconds * spread))
        lev = (dist * root) // (TIME_Z * 10**9 * WAD)
        if lev > c.maxLeverage:
            lev = c.maxLeverage
        if lev == 0:
            lev = 1
        return lev

    def _maxLeverage(self, c, f, now):
        lev = c.maxLeverage
        if not c.isEvent:
            return lev
        if now >= c.expiry:
            return 0
        dist = f.mid if f.mid < WAD - f.mid else WAD - f.mid
        tickLev = dist // EVENT_MIN_DISTANCE
        if tickLev < lev:
            lev = tickLev
        timeLev = self._timeLeverage(c, f.mid, now)
        if timeLev < lev:
            lev = timeLev
        if lev == 0:
            lev = 1
        return lev

    @staticmethod
    def _units(isEvent, isLong, amount, entry):
        if isEvent and not isLong:
            return (amount * UNIT) // (WAD - entry)
        return (amount * UNIT) // entry

    @staticmethod
    def _pnl(isEvent, isLong, notional, entry, exit_):
        if isLong:
            return sdiv(notional * (exit_ - entry), entry)
        if isEvent:
            return sdiv(notional * (entry - exit_), WAD - entry)
        return sdiv(notional * (entry - exit_), entry)

    def _reserveFor(self, c, isLong, boost, margin, notional, entry):
        ceiling = margin * c.maxProfitMult
        natural = notional
        if c.isEvent:
            stake = notional if boost else margin
            natural = (stake * (WAD - entry)) // entry if isLong else (stake * entry) // (WAD - entry)
            if not boost and not self.free_cap_ceiling:
                return natural  # task text E2: the outright payoff, no ceiling
        return natural if natural < ceiling else ceiling

    def _deltas(self, c, s, f, dt, now):
        if dt == 0 or f.timestamp == 0 or f.resolved:
            return (0, 0, 0, 0)
        if not c.isEvent:
            cap = self._sideCap(c, f)
            if cap == 0 or c.crowdingPerDay == 0 or s.longOI == s.shortOI:
                return (0, 0, 0, 0)
            longCrowded = s.longOI > s.shortOI
            skew = ((s.longOI - s.shortOI if longCrowded else s.shortOI - s.longOI) * WAD) // cap
            if skew > WAD:
                skew = WAD
            grown = (skew * c.crowdingPerDay * dt) // (DAY * WAD)
            return (grown, 0, 0, 0) if longCrowded else (0, grown, 0, 0)
        if c.hazardScale == 0:
            return (0, 0, 0, 0)
        tau = (c.expiry - now if now < c.expiry else 0) + dt // 2
        if tau < TAU_FLOOR:
            tau = TAU_FLOOR
        mid = WAD if f.mid > WAD else f.mid
        if self.crowd_rate == "code":
            boostLong = ((mid * (WAD - mid)) // WAD * c.hazardScale * dt) // (tau * WAD)
            boostShort = boostLong
        else:  # task text: (1 - p_s)/tau per borrowed share of side s
            boostLong = ((WAD - mid) * c.hazardScale * dt) // (tau * WAD)
            boostShort = (mid * c.hazardScale * dt) // (tau * WAD)
        feeLong = feeShort = 0
        if s.longBorrowed > s.shortBorrowed:
            feeLong = (boostLong * (s.longBorrowed - s.shortBorrowed)) // s.longBorrowed
        elif s.shortBorrowed > s.longBorrowed:
            feeShort = (boostShort * (s.shortBorrowed - s.longBorrowed)) // s.shortBorrowed
        return (feeLong, feeShort, boostLong, boostShort)

    def _accrue(self, marketId, c, f, now):
        s = self.states[marketId]
        dt = now - s.lastAccrual
        if dt == 0:
            return
        fl, fs, bl, bs = self._deltas(c, s, f, dt, now)
        s.lastAccrual = now
        s.cumFeeLong += fl
        s.cumFeeShort += fs
        s.cumBoostLong += bl
        s.cumBoostShort += bs

    @staticmethod
    def _chargesAt(p, isEvent, cumFee, cumBoost):
        if not isEvent:
            return ((p.notional * (cumFee - p.entryFee)) // WAD, 0)
        if p.boosted:
            return (0, (p.borrowedUnits * (cumBoost - p.entryBoost)) // UNIT)
        return ((p.borrowedUnits * (cumFee - p.entryFee)) // UNIT, 0)

    def _charges(self, p, isEvent, s):
        return self._chargesAt(p, isEvent, s.cumFeeLong if p.isLong else s.cumFeeShort,
                               s.cumBoostLong if p.isLong else s.cumBoostShort)

    def _result(self, p, isEvent, price, premium):
        r = self._pnl(isEvent, p.isLong, p.notional, p.entryPrice, price)
        if r > p.reserve:
            r = p.reserve
        r -= premium
        if r < -p.margin:
            r = -p.margin
        return r

    # ---- trading ------------------------------------------------------------------------
    def open(self, who, marketId, isLong, margin, leverage, boost, now):
        c = self.markets[marketId]
        if not c.enabled:
            raise Revert("MarketDisabled")
        f = self.oracle.read(marketId, now)
        if f.resolved:
            raise Revert("MarketResolved")
        if f.timestamp == 0 or now > f.timestamp + c.maxAge:
            raise Revert("StalePrice")
        if c.isEvent and (f.mid < EVENT_MIN_PRICE or f.mid > EVENT_MAX_PRICE):
            raise Revert("EventPriceOutOfRange")
        if self._gapBps(c, f) > c.maxGapBps:
            raise Revert("PriceDislocated")
        if margin < self.minMargin:
            raise Revert("BadMargin")
        if leverage == 0 or leverage > self._maxLeverage(c, f, now):
            raise Revert("BadLeverage")
        if boost and not c.boostEnabled:
            raise Revert("BoostUnavailable")
        notional = margin * leverage
        if notional > c.maxPositionNotional:
            raise Revert("PositionTooLarge")
        self._accrue(marketId, c, f, now)
        s = self.states[marketId]
        if (s.longOI if isLong else s.shortOI) + notional > self._sideCap(c, f):
            raise Revert("SideCapExceeded")
        entry = self._fill(f, isLong)
        if -self._pnl(c.isEvent, isLong, notional, entry, f.mid) > (margin * MAX_ENTRY_LOSS_BPS) // BPS:
            raise Revert("EntryTooFarFromMid")
        reserve = self._reserveFor(c, isLong, boost, margin, notional, entry)
        self.vault.lockPosition(margin, reserve)
        borrowed = (self._units(True, isLong, notional, entry) - self._units(True, isLong, margin, entry)
                    if c.isEvent else 0)
        if isLong:
            s.longOI += notional
            s.longUnits += self._units(c.isEvent, True, notional, entry)
            s.longBorrowed += borrowed
        else:
            s.shortOI += notional
            s.shortUnits += self._units(c.isEvent, False, notional, entry)
            s.shortBorrowed += borrowed
        p = Position()
        p.owner = who
        p.marketId = marketId
        p.isLong = isLong
        p.boosted = boost
        p.openedAt = now
        p.margin = margin
        p.notional = notional
        p.entryPrice = entry
        p.reserve = reserve
        p.borrowedUnits = borrowed
        p.entryFee = s.cumFeeLong if isLong else s.cumFeeShort
        p.entryBoost = s.cumBoostLong if isLong else s.cumBoostShort
        pid = self.nextId
        self.nextId += 1
        self.positions[pid] = p
        return pid

    def _get(self, pid):
        p = self.positions.get(pid)
        if p is None:
            raise Revert("NoPosition")
        return p

    def close(self, who, pid, now):
        p = self._get(pid)
        c = self.markets[p.marketId]
        f = self.oracle.read(p.marketId, now)
        self._accrue(p.marketId, c, f, now)
        if f.resolved:
            return self._settle(pid, p, c, f.mid, SETTLEMENT, False, f.mid)
        if who != p.owner:
            raise Revert("NotOwner")
        if f.timestamp == 0 or now > f.timestamp + c.maxAge:
            raise Revert("StalePrice")
        return self._settle(pid, p, c, self._fill(f, not p.isLong), CLOSE, False, f.mid)

    def liquidate(self, pid, now):
        p = self._get(pid)
        c = self.markets[p.marketId]
        f = self.oracle.read(p.marketId, now)
        if f.resolved:
            raise Revert("MarketResolved")
        if f.timestamp == 0 or now > f.timestamp + c.maxAge:
            raise Revert("StalePrice")
        self._accrue(p.marketId, c, f, now)
        _, premium = self._charges(p, c.isEvent, self.states[p.marketId])
        if p.margin + self._result(p, c.isEvent, f.mid, premium) > (p.margin * self.maintBps) // BPS:
            raise Revert("NotLiquidatable")
        return self._settle(pid, p, c, f.mid, LIQUIDATION, True, f.mid)

    def forceClose(self, pid, now):
        p = self._get(pid)
        c = self.markets[p.marketId]
        f = self.oracle.read(p.marketId, now)
        if f.resolved:
            raise Revert("MarketResolved")
        if (not c.isEvent) or p.notional <= p.margin * self._timeLeverage(c, f.mid, now):
            raise Revert("NotForceClosable")
        if f.timestamp == 0 or now > f.timestamp + c.maxAge:
            raise Revert("StalePrice")
        self._accrue(p.marketId, c, f, now)
        return self._settle(pid, p, c, self._fill(f, not p.isLong), FORCECLOSE, False, f.mid)

    def collect(self, pid, now):
        p = self._get(pid)
        c = self.markets[p.marketId]
        f = self.oracle.read(p.marketId, now)
        if f.resolved:
            raise Revert("MarketResolved")
        if f.timestamp == 0 or now > f.timestamp + c.maxAge:
            raise Revert("StalePrice")
        self._accrue(p.marketId, c, f, now)
        price = self._fill(f, not p.isLong)
        if self._pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, price) < p.reserve:
            raise Revert("NotCollectable")
        return self._settle(pid, p, c, price, COLLECT, False, f.mid)

    def poke(self, marketId, now):
        self._accrue(marketId, self.markets[marketId], self.oracle.read(marketId, now), now)

    def _settle(self, pid, p, c, exitPrice, kind, liquidated, mid):
        s = self.states[p.marketId]
        crowding, premium = self._charges(p, c.isEvent, s)
        accruedCrowding = crowding
        result = self._result(p, c.isEvent, exitPrice, premium)
        fee = 0
        if result > 0:
            profit = result
            if crowding > profit:
                crowding = profit
            profit -= crowding
            fee = (profit * c.profitFeeBps) // BPS
            payout = p.margin + profit - fee
        else:
            crowding = 0
            payout = p.margin - (-result)
        liqFee = 0
        if kind == LIQUIDATION:
            liqFee = (p.margin * self.liqFeeBps) // BPS
            if self.liq_fee_from_vault:
                if liqFee > payout:
                    # literal R4: the liquidator is always paid 5% of M; any shortfall comes out of
                    # the margin the vault would otherwise have kept.
                    payout = 0
                else:
                    payout -= liqFee
            else:
                if liqFee > payout:
                    liqFee = payout
                payout -= liqFee
        if p.isLong:
            s.longOI -= p.notional
            s.longUnits -= self._units(c.isEvent, True, p.notional, p.entryPrice)
            s.longBorrowed -= p.borrowedUnits
        else:
            s.shortOI -= p.notional
            s.shortUnits -= self._units(c.isEvent, False, p.notional, p.entryPrice)
            s.shortBorrowed -= p.borrowedUnits
        if min(s.longOI, s.shortOI, s.longUnits, s.shortUnits, s.longBorrowed, s.shortBorrowed) < 0:
            raise Revert("underflow(state)")
        del self.positions[pid]
        stakerFee = (fee * self.stakerShareBps) // BPS if self.staked else 0
        self.vault.settlePosition(p.margin, p.reserve, payout, stakerFee, liqFee)
        rec = dict(id=pid, kind=kind, isEvent=c.isEvent, isLong=p.isLong, boosted=p.boosted, margin=p.margin,
                   notional=p.notional, entry=p.entryPrice, reserve=p.reserve, exit=exitPrice, result=result,
                   fee=fee, stakerFee=stakerFee, liqFee=liqFee, payout=payout, crowding=crowding,
                   accruedCrowding=accruedCrowding, premium=premium, mid=mid,
                   linAtMid=self._pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, mid))
        self.closed_log.append(rec)
        return rec

    # ---- views --------------------------------------------------------------------------
    def unrealizedPnl(self, now):
        total = 0
        for m in self.marketIds:
            s = self.states[m]
            mid = self.oracle.read(m, now).mid
            total += (s.longUnits * mid) // UNIT - s.longOI
            if self.markets[m].isEvent:
                if mid > WAD:
                    raise Revert("panic: underflow in unrealizedPnl")
                total += (s.shortUnits * (WAD - mid)) // UNIT - s.shortOI
            else:
                total += s.shortOI - (s.shortUnits * mid) // UNIT
        return total

    def view(self, pid, now):
        """Subset of positionView used by the keeper."""
        p = self._get(pid)
        c = self.markets[p.marketId]
        f = self.oracle.read(p.marketId, now)
        s = self.states[p.marketId]
        fl, fs, bl, bs = self._deltas(c, s, f, now - s.lastAccrual, now)
        crowding, premium = self._chargesAt(
            p, c.isEvent, (s.cumFeeLong + fl) if p.isLong else (s.cumFeeShort + fs),
            (s.cumBoostLong + bl) if p.isLong else (s.cumBoostShort + bs))
        mark = f.mid if f.resolved else self._fill(f, not p.isLong)
        equityAtMid = p.margin + self._result(p, c.isEvent, f.mid, premium)
        return dict(
            p=p, f=f, c=c, crowding=crowding, premium=premium, markPrice=mark,
            equityAtMid=equityAtMid,
            liquidatable=(not f.resolved) and equityAtMid <= (p.margin * self.maintBps) // BPS,
            forceClosable=(not f.resolved) and c.isEvent and p.notional > p.margin * self._timeLeverage(c, f.mid, now),
            collectable=(not f.resolved) and self._pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, mark) >= p.reserve,
            fresh=(f.timestamp != 0 and now <= f.timestamp + c.maxAge),
        )
