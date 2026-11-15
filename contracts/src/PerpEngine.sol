// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {PriceOracle} from "./PriceOracle.sol";

interface IVault {
    function lockPosition(address trader, uint256 margin, uint256 reserve) external;
    function settlePosition(
        uint256 margin,
        uint256 reserve,
        address trader,
        uint256 traderPayout,
        address feeRecipient,
        uint256 feeAmount,
        address liquidator,
        uint256 liquidatorFee
    ) external;
}

interface IStakingView {
    function totalStaked() external view returns (uint256);
}

interface IFeeToken {
    function mintForFee(address to, uint256 fee) external returns (uint256);
}

/// @title PerpEngine
/// @notice Oracle-priced synthetic perpetuals against a pre-funded vault, with isolated margin
///         and losses capped at margin.
///
/// The rules that differ from a plain "fill any size at the oracle mid" design:
///   1. Worse-of fills. Buys fill at max(mid, slow), sells at min(mid, slow). In a calm market
///      the two are equal and the fill has no slippage. A briefly pushed reference price moves
///      `mid` but not `slow`, so it cannot be opened against or closed into.
///   2. Depth-backed caps. Open interest on each side is capped at a multiple of the USD depth
///      actually resting near the mid on the reference venue.
///   3. Reserved payouts. Each position's maximum profit is locked in the vault when it opens.
///   4. Skew funding. The crowded side pays; the rate scales with skew relative to the cap.
///   5. Event markets (binary, price in [0,1]). A short is a long on NO, so 1x is always fully
///      collateralised. Leverage is limited by distance-to-liquidation in ticks and compresses
///      to 1x as resolution approaches; anything still above the cap can be force-closed.
contract PerpEngine is Ownable, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.UintSet;

    enum CloseKind {
        Close,
        Liquidation,
        ForceClose,
        Settlement
    }

    struct MarketConfig {
        bool enabled;
        bool isEvent;
        uint32 maxLeverage;
        uint32 maxProfitMult; // maximum profit as a multiple of margin
        uint16 profitFeeBps; // charged on positive PnL only
        uint32 kappaBps; // side OI cap = reference depth * kappaBps / 1e4
        uint16 maxGapBps; // opens blocked while |mid - slow| exceeds this
        uint32 maxAge; // seconds a price stays usable
        uint64 expiry; // event markets: scheduled resolution time
        uint64 compressWindow; // event markets: leverage decays to 1x over this many seconds
        uint256 maxPositionNotional;
        uint256 fundingPerDay; // 1e18 = 100% of notional per day at full skew
        uint256 borrowPerDay; // 1e18 = 100% per day, charged on notional minus margin
    }

    struct MarketState {
        uint256 longOI;
        uint256 shortOI;
        uint256 longUnits;
        uint256 shortUnits;
        int256 cumFunding; // per unit of notional, 1e18
        uint64 lastFunding;
    }

    struct Position {
        address owner;
        uint32 marketId;
        bool isLong;
        uint64 openedAt;
        uint256 margin;
        uint256 notional;
        uint256 entryPrice;
        uint256 reserve;
        int256 entryFunding;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    uint256 internal constant UNIT = 1e36;
    /// @notice Event markets: minimum distance from entry to the zero-equity price (two 1c ticks).
    uint256 public constant EVENT_MIN_LIQ_DISTANCE = 0.02e18;
    /// @notice An open is refused if its worse-of fill would cost more than this share of margin
    ///         against the mid. At high leverage this lowers the usable leverage while the price
    ///         is moving fast, instead of opening a position that is already near liquidation.
    uint256 public constant MAX_ENTRY_LOSS_BPS = 3000;
    uint256 public constant EVENT_MIN_PRICE = 0.01e18;
    uint256 public constant EVENT_MAX_PRICE = 0.99e18;

    PriceOracle public immutable oracle;
    IVault public immutable vault;
    IFeeToken public immutable token;
    address public immutable staking;

    /// @notice A position is liquidatable once equity falls to this share of its margin.
    uint16 public maintBps = 2000;
    /// @notice Liquidator reward, as a share of margin, paid out of the remaining equity.
    uint16 public liqFeeBps = 500;
    /// @notice Share of profit fees sent to OLQ stakers; the rest stays with LPs.
    uint16 public stakerShareBps = 3000;
    uint256 public minMargin = 1e6;

    uint256 public nextPositionId = 1;
    uint32[] public marketIds;
    mapping(uint32 => MarketConfig) public markets;
    mapping(uint32 => MarketState) public states;
    mapping(uint256 => Position) public positions;
    EnumerableSet.UintSet private _open;
    mapping(address => EnumerableSet.UintSet) private _openOf;

    event MarketSet(uint32 indexed marketId, MarketConfig config);
    event ParamsSet(uint16 maintBps, uint16 liqFeeBps, uint16 stakerShareBps, uint256 minMargin);
    event PositionOpened(
        uint256 indexed id,
        address indexed owner,
        uint32 indexed marketId,
        bool isLong,
        uint256 margin,
        uint256 notional,
        uint256 entryPrice,
        uint256 reserve
    );
    event PositionClosed(
        uint256 indexed id,
        address indexed owner,
        uint32 indexed marketId,
        CloseKind kind,
        uint256 exitPrice,
        int256 pnl,
        uint256 fee,
        uint256 payout,
        uint256 olqMinted
    );

    error MarketDisabled();
    error MarketResolved();
    error StalePrice();
    error PriceDislocated();
    error EntryTooFarFromMid();
    error BadMargin();
    error BadLeverage();
    error PositionTooLarge();
    error SideCapExceeded();
    error EventPriceOutOfRange();
    error NoPosition();
    error NotOwner();
    error NotLiquidatable();
    error NotForceClosable();
    error BadParams();

    constructor(PriceOracle oracle_, IVault vault_, IFeeToken token_, address staking_, address owner_)
        Ownable(owner_)
    {
        oracle = oracle_;
        vault = vault_;
        token = token_;
        staking = staking_;
    }

    // ---- admin --------------------------------------------------------------------------

    function setMarket(uint32 marketId, MarketConfig calldata config) external onlyOwner {
        if (config.maxLeverage == 0 || config.maxProfitMult == 0 || config.profitFeeBps > 5000) revert BadParams();
        if (states[marketId].lastFunding == 0) {
            marketIds.push(marketId);
            states[marketId].lastFunding = uint64(block.timestamp);
        } else {
            _accrue(marketId);
        }
        markets[marketId] = config;
        emit MarketSet(marketId, config);
    }

    function setParams(uint16 maintBps_, uint16 liqFeeBps_, uint16 stakerShareBps_, uint256 minMargin_)
        external
        onlyOwner
    {
        if (maintBps_ >= BPS || liqFeeBps_ > maintBps_ || stakerShareBps_ > BPS) revert BadParams();
        maintBps = maintBps_;
        liqFeeBps = liqFeeBps_;
        stakerShareBps = stakerShareBps_;
        minMargin = minMargin_;
        emit ParamsSet(maintBps_, liqFeeBps_, stakerShareBps_, minMargin_);
    }

    // ---- trading ------------------------------------------------------------------------

    /// @param priceData Optional abi.encode(PriceUpdate[], bytes[]) relayed to the oracle first.
    function open(uint32 marketId, bool isLong, uint256 margin, uint32 leverage, bytes calldata priceData)
        external
        nonReentrant
        returns (uint256 id)
    {
        _pushPrices(priceData);
        MarketConfig memory c = markets[marketId];
        if (!c.enabled) revert MarketDisabled();
        PriceOracle.Feed memory f = oracle.read(marketId);
        if (f.resolved) revert MarketResolved();
        _requireFresh(f, c);
        if (c.isEvent && (f.mid < EVENT_MIN_PRICE || f.mid > EVENT_MAX_PRICE)) revert EventPriceOutOfRange();
        if (_gapBps(c, f) > c.maxGapBps) revert PriceDislocated();
        if (margin < minMargin) revert BadMargin();
        if (leverage == 0 || leverage > _maxLeverage(c, f, isLong)) revert BadLeverage();

        uint256 notional = margin * leverage;
        if (notional > c.maxPositionNotional) revert PositionTooLarge();

        _accrue(marketId);
        MarketState storage s = states[marketId];
        uint256 cap = (f.depthUsd * c.kappaBps) / BPS;
        if ((isLong ? s.longOI : s.shortOI) + notional > cap) revert SideCapExceeded();

        uint256 entry = _fill(f, isLong);
        if (-_pnl(c.isEvent, isLong, notional, entry, f.mid) > int256((margin * MAX_ENTRY_LOSS_BPS) / BPS)) {
            revert EntryTooFarFromMid();
        }
        uint256 reserve = _reserveFor(c, isLong, margin, notional, entry);
        vault.lockPosition(msg.sender, margin, reserve);

        if (isLong) {
            s.longOI += notional;
            s.longUnits += _units(c.isEvent, true, notional, entry);
        } else {
            s.shortOI += notional;
            s.shortUnits += _units(c.isEvent, false, notional, entry);
        }

        id = nextPositionId++;
        positions[id] = Position({
            owner: msg.sender,
            marketId: marketId,
            isLong: isLong,
            openedAt: uint64(block.timestamp),
            margin: margin,
            notional: notional,
            entryPrice: entry,
            reserve: reserve,
            entryFunding: s.cumFunding
        });
        _open.add(id);
        _openOf[msg.sender].add(id);
        emit PositionOpened(id, msg.sender, marketId, isLong, margin, notional, entry, reserve);
    }

    /// @notice Close a position. Once the market has resolved, anyone may settle it for the owner.
    function close(uint256 id, bytes calldata priceData) external nonReentrant {
        _pushPrices(priceData);
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        _accrue(p.marketId);
        if (f.resolved) {
            _settle(id, p, c, f.mid, CloseKind.Settlement, address(0));
            return;
        }
        if (msg.sender != p.owner) revert NotOwner();
        _requireFresh(f, c);
        _settle(id, p, c, _fill(f, !p.isLong), CloseKind.Close, address(0));
    }

    /// @notice Liquidate a position whose equity at the mid has fallen to the maintenance level.
    ///         Whatever equity is left after the liquidator's reward goes back to the trader.
    function liquidate(uint256 id, bytes calldata priceData) external nonReentrant {
        _pushPrices(priceData);
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        if (f.resolved) revert MarketResolved();
        _requireFresh(f, c);
        _accrue(p.marketId);
        if (_equity(p, c, f.mid) > int256((p.margin * maintBps) / BPS)) revert NotLiquidatable();
        _settle(id, p, c, f.mid, CloseKind.Liquidation, msg.sender);
    }

    /// @notice Event markets: close a position whose leverage is above the time-compressed cap.
    ///         No penalty is charged; the owner receives the normal close payout.
    function forceClose(uint256 id, bytes calldata priceData) external nonReentrant {
        _pushPrices(priceData);
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        if (f.resolved) revert MarketResolved();
        if (!c.isEvent || p.notional <= p.margin * _timeLeverage(c)) revert NotForceClosable();
        _requireFresh(f, c);
        _accrue(p.marketId);
        _settle(id, p, c, _fill(f, !p.isLong), CloseKind.ForceClose, address(0));
    }

    // ---- internals ----------------------------------------------------------------------

    function _pushPrices(bytes calldata priceData) internal {
        if (priceData.length == 0) return;
        (PriceOracle.PriceUpdate[] memory updates, bytes[] memory sigs) =
            abi.decode(priceData, (PriceOracle.PriceUpdate[], bytes[]));
        oracle.push(updates, sigs);
    }

    function _get(uint256 id) internal view returns (Position memory p) {
        p = positions[id];
        if (p.owner == address(0)) revert NoPosition();
    }

    function _requireFresh(PriceOracle.Feed memory f, MarketConfig memory c) internal view {
        if (f.timestamp == 0 || block.timestamp > uint256(f.timestamp) + c.maxAge) revert StalePrice();
    }

    /// @dev Worse-of fill: buys at the higher of the two prices, sells at the lower.
    function _fill(PriceOracle.Feed memory f, bool isBuy) internal pure returns (uint256) {
        if (isBuy) return f.mid > f.slow ? f.mid : f.slow;
        return f.mid < f.slow ? f.mid : f.slow;
    }

    function _gapBps(MarketConfig memory c, PriceOracle.Feed memory f) internal pure returns (uint256) {
        uint256 diff = f.mid > f.slow ? f.mid - f.slow : f.slow - f.mid;
        // Event prices are probabilities, so the gap is measured in points of 1.00.
        return (diff * BPS) / (c.isEvent ? WAD : f.slow);
    }

    function _timeLeverage(MarketConfig memory c) internal view returns (uint256) {
        if (!c.isEvent || c.compressWindow == 0) return c.maxLeverage;
        if (block.timestamp >= c.expiry) return 1;
        uint256 remaining = c.expiry - block.timestamp;
        if (remaining >= c.compressWindow) return c.maxLeverage;
        return 1 + ((uint256(c.maxLeverage) - 1) * remaining) / c.compressWindow;
    }

    function _maxLeverage(MarketConfig memory c, PriceOracle.Feed memory f, bool isLong)
        internal
        view
        returns (uint256 lev)
    {
        lev = c.maxLeverage;
        if (!c.isEvent) return lev;
        if (block.timestamp >= c.expiry) return 0;
        // A long loses its margin after a move of price/leverage; a short after (1-price)/leverage.
        uint256 room = isLong ? f.mid : WAD - f.mid;
        uint256 tickLev = room / EVENT_MIN_LIQ_DISTANCE;
        if (tickLev < lev) lev = tickLev;
        uint256 timeLev = _timeLeverage(c);
        if (timeLev < lev) lev = timeLev;
        if (lev == 0) lev = 1;
    }

    /// @dev Position size in contracts, scaled by 1e36 so that marking the aggregate back to
    ///      USDC loses nothing to rounding. An event short holds NO contracts bought at (1 - price).
    function _units(bool isEvent, bool isLong, uint256 notional, uint256 entry) internal pure returns (uint256) {
        if (isEvent && !isLong) return (notional * UNIT) / (WAD - entry);
        return (notional * UNIT) / entry;
    }

    function _pnl(bool isEvent, bool isLong, uint256 notional, uint256 entry, uint256 exit)
        internal
        pure
        returns (int256)
    {
        int256 n = int256(notional);
        if (isLong) return (n * (int256(exit) - int256(entry))) / int256(entry);
        if (isEvent) return (n * (int256(entry) - int256(exit))) / int256(WAD - entry);
        return (n * (int256(entry) - int256(exit))) / int256(entry);
    }

    function _reserveFor(MarketConfig memory c, bool isLong, uint256 margin, uint256 notional, uint256 entry)
        internal
        pure
        returns (uint256 reserve)
    {
        reserve = margin * c.maxProfitMult;
        uint256 natural; // the most the position can make before the cap
        if (c.isEvent) {
            natural = isLong ? (notional * (WAD - entry)) / entry : (notional * entry) / (WAD - entry);
        } else {
            natural = isLong ? type(uint256).max : notional;
        }
        if (natural < reserve) reserve = natural;
    }

    /// @dev Funding and borrow charges accrued by a position; positive means the trader pays.
    function _carry(Position memory p, MarketConfig memory c) internal view returns (int256) {
        int256 funding = (int256(p.notional) * (states[p.marketId].cumFunding - p.entryFunding)) / int256(WAD);
        if (!p.isLong) funding = -funding;
        uint256 borrow =
            ((p.notional - p.margin) * c.borrowPerDay * (block.timestamp - p.openedAt)) / (1 days * WAD);
        return funding + int256(borrow);
    }

    function _equity(Position memory p, MarketConfig memory c, uint256 price) internal view returns (int256) {
        return int256(p.margin) + _pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, price) - _carry(p, c);
    }

    function _accrue(uint32 marketId) internal {
        MarketState storage s = states[marketId];
        uint256 dt = block.timestamp - s.lastFunding;
        if (dt == 0) return;
        s.lastFunding = uint64(block.timestamp);
        s.cumFunding += _fundingDelta(marketId, s, dt);
    }

    function _fundingDelta(uint32 marketId, MarketState storage s, uint256 dt) internal view returns (int256) {
        MarketConfig memory c = markets[marketId];
        uint256 cap = (oracle.read(marketId).depthUsd * c.kappaBps) / BPS;
        if (cap == 0 || c.fundingPerDay == 0) return 0;
        int256 ratio = ((int256(s.longOI) - int256(s.shortOI)) * int256(WAD)) / int256(cap);
        if (ratio > int256(WAD)) ratio = int256(WAD);
        if (ratio < -int256(WAD)) ratio = -int256(WAD);
        return (ratio * int256(c.fundingPerDay) * int256(dt)) / int256(1 days * WAD);
    }

    function _settle(
        uint256 id,
        Position memory p,
        MarketConfig memory c,
        uint256 exitPrice,
        CloseKind kind,
        address liquidator
    ) internal {
        int256 gross = _pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, exitPrice) - _carry(p, c);

        uint256 payout;
        uint256 fee;
        if (gross > 0) {
            uint256 profit = uint256(gross) > p.reserve ? p.reserve : uint256(gross);
            fee = (profit * c.profitFeeBps) / BPS;
            payout = p.margin + profit - fee;
        } else {
            uint256 loss = uint256(-gross) > p.margin ? p.margin : uint256(-gross);
            payout = p.margin - loss;
        }

        uint256 liqFee;
        if (kind == CloseKind.Liquidation) {
            liqFee = (p.margin * liqFeeBps) / BPS;
            if (liqFee > payout) liqFee = payout;
            payout -= liqFee;
        }

        MarketState storage s = states[p.marketId];
        if (p.isLong) {
            s.longOI -= p.notional;
            s.longUnits -= _units(c.isEvent, true, p.notional, p.entryPrice);
        } else {
            s.shortOI -= p.notional;
            s.shortUnits -= _units(c.isEvent, false, p.notional, p.entryPrice);
        }
        delete positions[id];
        _open.remove(id);
        _openOf[p.owner].remove(id);

        uint256 stakerFee = IStakingView(staking).totalStaked() > 0 ? (fee * stakerShareBps) / BPS : 0;
        vault.settlePosition(p.margin, p.reserve, p.owner, payout, staking, stakerFee, liquidator, liqFee);
        uint256 minted = fee > 0 ? token.mintForFee(p.owner, fee) : 0;

        emit PositionClosed(id, p.owner, p.marketId, kind, exitPrice, gross, fee, payout, minted);
    }

    // ---- views --------------------------------------------------------------------------

    /// @notice Net unrealised trader PnL across all markets at the oracle mid (USDC, 6 dp).
    function unrealizedPnl() external view returns (int256 total) {
        for (uint256 i = 0; i < marketIds.length; i++) {
            uint32 m = marketIds[i];
            MarketState storage s = states[m];
            uint256 mid = oracle.read(m).mid;
            total += int256((s.longUnits * mid) / UNIT) - int256(s.longOI);
            if (markets[m].isEvent) {
                total += int256((s.shortUnits * (WAD - mid)) / UNIT) - int256(s.shortOI);
            } else {
                total += int256(s.shortOI) - int256((s.shortUnits * mid) / UNIT);
            }
        }
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    struct MarketView {
        uint32 marketId;
        MarketConfig config;
        MarketState state;
        PriceOracle.Feed feed;
        uint256 sideCap;
        uint256 maxLeverageLong;
        uint256 maxLeverageShort;
        int256 fundingPerDayNow; // 1e18; positive means longs pay
    }

    function marketView(uint32 marketId) public view returns (MarketView memory v) {
        v.marketId = marketId;
        v.config = markets[marketId];
        v.state = states[marketId];
        v.feed = oracle.read(marketId);
        v.sideCap = (v.feed.depthUsd * v.config.kappaBps) / BPS;
        if (!v.feed.resolved && v.feed.timestamp != 0) {
            v.maxLeverageLong = _maxLeverage(v.config, v.feed, true);
            v.maxLeverageShort = _maxLeverage(v.config, v.feed, false);
        }
        v.fundingPerDayNow = _fundingDelta(marketId, states[marketId], 1 days);
    }

    function allMarkets() external view returns (MarketView[] memory out) {
        out = new MarketView[](marketIds.length);
        for (uint256 i = 0; i < marketIds.length; i++) {
            out[i] = marketView(marketIds[i]);
        }
    }

    struct PositionView {
        uint256 id;
        Position position;
        uint256 markPrice; // price a close would fill at now
        int256 pnl; // at markPrice, after carry, before fee and cap
        int256 equityAtMid;
        uint256 liquidationPrice;
        bool liquidatable;
        bool forceClosable;
    }

    function positionView(uint256 id) public view returns (PositionView memory v) {
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        // Carry as it would be charged if the position were settled in this block.
        Position memory q = p;
        q.entryFunding = p.entryFunding - _fundingDelta(p.marketId, states[p.marketId], block.timestamp - states[p.marketId].lastFunding);
        int256 carry = _carry(q, c);

        v.id = id;
        v.position = p;
        v.markPrice = f.resolved ? f.mid : _fill(f, !p.isLong);
        v.pnl = _pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, v.markPrice) - carry;
        v.equityAtMid = int256(p.margin) + _pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, f.mid) - carry;
        v.liquidatable = !f.resolved && v.equityAtMid <= int256((p.margin * maintBps) / BPS);
        v.forceClosable = !f.resolved && c.isEvent && p.notional > p.margin * _timeLeverage(c);
        v.liquidationPrice = _liquidationPrice(p, c, carry);
    }

    /// @dev Price at which equity equals the maintenance level, given carry so far.
    function _liquidationPrice(Position memory p, MarketConfig memory c, int256 carry)
        internal
        view
        returns (uint256)
    {
        // Loss the position can absorb before liquidation, as a fraction of notional (1e18).
        int256 buffer = int256(p.margin) - int256((p.margin * maintBps) / BPS) - carry;
        if (buffer <= 0) return p.entryPrice;
        uint256 frac = (uint256(buffer) * WAD) / p.notional;
        if (p.isLong) {
            return frac >= WAD ? 0 : (p.entryPrice * (WAD - frac)) / WAD;
        }
        uint256 base = c.isEvent ? WAD - p.entryPrice : p.entryPrice;
        uint256 px = p.entryPrice + (base * frac) / WAD;
        return c.isEvent && px > WAD ? WAD : px;
    }

    function positionsOf(address owner_) external view returns (PositionView[] memory out) {
        uint256[] memory ids = _openOf[owner_].values();
        out = new PositionView[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = positionView(ids[i]);
        }
    }

    function openPositionCount() external view returns (uint256) {
        return _open.length();
    }

    /// @notice Page through open positions, for keepers scanning for liquidations.
    function openPositions(uint256 offset, uint256 limit) external view returns (PositionView[] memory out) {
        uint256 n = _open.length();
        if (offset >= n) return new PositionView[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new PositionView[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = positionView(_open.at(i));
        }
    }
}
