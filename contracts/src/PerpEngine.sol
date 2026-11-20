// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
/// @notice Leveraged positions filled at one reference price, with no order book, against a
///         pre-funded vault. Margin is isolated and a position can lose at most its margin.
///
/// The rules that make one price safe to offer:
///   1. Worse-of fills. Buys fill at max(mid, slow), sells at min(mid, slow). In a calm market
///      the two are equal and the fill has no slippage. A briefly pushed reference price moves
///      `mid` but not `slow`, so it cannot be opened against or closed into.
///   2. Depth-backed capacity. Open interest on each side is capped at a multiple of the USD
///      depth resting near the mid on the reference venue, and that depth has to persist.
///   3. Reserved payouts. Each position's maximum profit is locked in the vault when it opens.
///   4. No fee to open or close, and no funding between traders. The only holding cost is a
///      crowding fee on the side the vault is exposed to; a balanced book pays nothing.
///
/// Event markets (binary, price in [0,1]) add:
///   5. A short is a long on NO, so a 1x position is a plain purchase of shares: it is never
///      liquidated and it is paid the full outright result.
///   6. Leverage zooms the odds. A leveraged position wins at most what its margin would win
///      outright, and never more than the margin itself, and reaches that after a move
///      1/leverage as large. Its win line and its stop line are therefore never further from
///      entry than each other, which is what keeps a jump across both from paying the trader.
///   7. Boost. A position may instead keep the leveraged upside by paying, out of its margin,
///      a premium for the jump risk that upside carries.
///   8. Leverage falls with the square root of the time to the market's next scheduled
///      information event, and anything above the limit can be closed by anyone.
///   9. A market stops trading at its expiry (kickoff, or the moment the result is fixed).
///      Nothing opens or closes at a price after that; positions wait for the result.
contract PerpEngine is Ownable, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.UintSet;

    enum CloseKind {
        Close,
        Liquidation,
        ForceClose,
        Settlement,
        Collect
    }

    struct MarketConfig {
        bool enabled;
        bool isEvent;
        uint32 maxLeverage;
        uint32 maxProfitMult; // ceiling on profit as a multiple of margin
        uint16 profitFeeBps; // share of net profit
        uint32 kappaBps; // side OI cap = persistent reference depth * kappaBps / 1e4
        uint16 maxGapBps; // opens blocked while |mid - slow| exceeds this
        uint32 maxAge; // seconds a price stays usable
        uint32 reactionSeconds; // event markets: reaction time in the leverage limit; 0 disables it
        uint64 expiry; // event markets: when trading stops and positions wait for the result
        uint64 nextEvent; // event markets: next scheduled information event; 0 means the expiry
        uint256 minDistance; // event markets: both lines at least this far from entry (1e18 = 1.00)
        uint256 maxPositionNotional;
        uint256 maxSideNotional; // ceiling on each side's open interest, whatever the book shows; 0 = none
        uint256 crowdingPerDay; // other markets: 1e18 = 100% of notional per day at full skew
        uint256 crowdingScale; // event markets: multiple of the implied hazard charged to the crowded side
        uint256 boostScale; // event markets: multiple of the implied hazard charged for Boost; 0 = no Boost
    }

    struct MarketState {
        uint256 longOI;
        uint256 shortOI;
        uint256 longUnits;
        uint256 shortUnits;
        uint256 longBorrowed; // event markets: units financed by leverage, per side
        uint256 shortBorrowed;
        uint256 longMargin; // per-side sums that bound what a side can lose and win
        uint256 shortMargin;
        uint256 longReserve;
        uint256 shortReserve;
        uint256 cumFeeLong; // crowding fee index, per side
        uint256 cumFeeShort;
        uint256 cumBoost; // boost premium index
        uint256 lastMid; // event markets: the mid in force since the last accrual
        uint64 lastAccrual;
    }

    struct Position {
        address owner;
        uint32 marketId;
        bool isLong;
        bool boosted;
        uint64 openedAt;
        uint256 margin;
        uint256 notional;
        uint256 entryPrice;
        uint256 reserve; // the most this position can be paid in profit
        uint256 borrowedUnits; // event markets: units financed by leverage
        uint256 entryFee;
        uint256 entryBoost;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 1e4;
    uint256 internal constant UNIT = 1e36;
    /// @notice Event markets: the stop line sits at least this many standard deviations of the
    ///         price's expected movement over the reaction time away from entry.
    uint256 internal constant TIME_Z = 3;
    /// @notice Event markets: floor on the time-to-expiry used in fee and premium rates.
    uint256 internal constant TAU_FLOOR = 1 hours;
    /// @notice An open is refused if its worse-of fill would cost more than this share of margin
    ///         against the mid. At high leverage this lowers the usable leverage while the price
    ///         is moving fast, instead of opening a position that is already near liquidation.
    uint256 public constant MAX_ENTRY_LOSS_BPS = 3000;
    /// @notice Event markets: nothing opens within three cents of certainty. A market that close
    ///         to 0 or 1 may already have been decided.
    uint256 public constant EVENT_MIN_PRICE = 0.03e18;
    uint256 public constant EVENT_MAX_PRICE = 0.97e18;
    /// @notice A position is force-closed only once its leverage is this far above the limit, so
    ///         one opened at the limit is not closed a moment later.
    uint256 internal constant FORCE_CLOSE_SLACK_BPS = 12500;
    /// @notice Before expiry a forced close needs the mid and the slow price within one cent, so
    ///         nobody can pick a momentary print to close someone else at.
    uint256 internal constant FORCE_CLOSE_GAP_BPS = 100;

    PriceOracle public immutable oracle;
    IVault public immutable vault;
    IFeeToken public immutable token;
    address public immutable staking;

    /// @notice A position is liquidatable once equity falls to this share of its margin.
    uint16 public maintBps = 2000;
    /// @notice Liquidator reward, as a share of margin. It comes out of the remaining equity,
    ///         and out of the margin the vault keeps when no equity is left.
    uint16 public liqFeeBps = 500;
    /// @notice Share of profit fees sent to OLQ stakers; the rest stays with LPs.
    uint16 public stakerShareBps = 3000;
    uint256 public minMargin = 1e6;

    uint256 internal nextPositionId = 1;
    uint32[] public marketIds;
    mapping(uint32 => bool) public listed;
    mapping(uint32 => MarketConfig) internal markets;
    mapping(uint32 => MarketState) internal states;
    mapping(uint256 => Position) internal positions;
    EnumerableSet.UintSet private _open;
    mapping(address => EnumerableSet.UintSet) private _openOf;

    event MarketSet(uint32 indexed marketId);
    event PositionOpened(
        uint256 indexed id,
        address indexed owner,
        uint32 indexed marketId,
        bool isLong,
        bool boosted,
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
        uint256 olqMinted,
        uint256 crowdingFee,
        uint256 boostPremium
    );

    error MarketDisabled();
    error MarketResolved();
    error MarketClosed();
    error StalePrice();
    error PriceDislocated();
    error EntryTooFarFromMid();
    error BadMargin();
    error BadLeverage();
    error BoostUnavailable();
    error PositionTooLarge();
    error SideCapExceeded();
    error EventPriceOutOfRange();
    error NoPosition();
    error NotOwner();
    error NotLiquidatable();
    error NotForceClosable();
    error NotCollectable();
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
        if (
            config.maxLeverage == 0 || config.maxProfitMult == 0 || config.profitFeeBps > 5000
                || config.crowdingScale > 20 * WAD || config.boostScale > 20 * WAD
        ) revert BadParams();
        if (config.isEvent) {
            // Lines closer than one tick would be decided by noise; Boost may not be the cheaper
            // way to hold the crowded side.
            if (config.minDistance < 0.01e18 || config.minDistance > 0.5e18) revert BadParams();
            if (config.boostScale != 0 && config.boostScale < config.crowdingScale) revert BadParams();
        } else if (config.boostScale != 0 || config.crowdingScale != 0) {
            revert BadParams();
        }
        if (!listed[marketId]) {
            listed[marketId] = true;
            marketIds.push(marketId);
            states[marketId].lastAccrual = uint64(block.timestamp);
        } else {
            // A market's kind decides how its shorts are valued, so it never changes.
            if (markets[marketId].isEvent != config.isEvent) revert BadParams();
            _accrue(marketId, markets[marketId], oracle.read(marketId));
        }
        markets[marketId] = config;
        emit MarketSet(marketId);
    }

    function setParams(uint16 maintBps_, uint16 liqFeeBps_, uint16 stakerShareBps_, uint256 minMargin_)
        external
        onlyOwner
    {
        if (maintBps_ >= BPS || liqFeeBps_ > maintBps_ || stakerShareBps_ > BPS || minMargin_ == 0) {
            revert BadParams();
        }
        maintBps = maintBps_;
        liqFeeBps = liqFeeBps_;
        stakerShareBps = stakerShareBps_;
        minMargin = minMargin_;
    }

    // ---- trading ------------------------------------------------------------------------

    /// @param boost     Event markets only: keep the leveraged upside and pay the premium.
    /// @param priceData Optional abi.encode(PriceUpdate[], bytes[]) relayed to the oracle first.
    function open(
        uint32 marketId,
        bool isLong,
        uint256 margin,
        uint32 leverage,
        bool boost,
        bytes calldata priceData
    ) external nonReentrant returns (uint256 id) {
        _pushPrices(priceData);
        MarketConfig memory c = markets[marketId];
        if (!c.enabled) revert MarketDisabled();
        PriceOracle.Feed memory f = oracle.read(marketId);
        if (f.resolved) revert MarketResolved();
        _requireFresh(f, c);
        if (c.isEvent && (f.mid < EVENT_MIN_PRICE || f.mid > EVENT_MAX_PRICE)) revert EventPriceOutOfRange();
        if (_dislocated(c, f, c.maxGapBps)) revert PriceDislocated();
        if (margin < minMargin) revert BadMargin();

        uint256 entry = _fill(f, isLong);
        // The limit has to hold at the price the position is actually entered at as well.
        if (leverage == 0 || leverage > _maxLeverage(c, f.mid) || leverage > _maxLeverage(c, entry)) {
            revert BadLeverage();
        }
        if (boost && (c.boostScale == 0 || leverage < 2)) revert BoostUnavailable();

        uint256 notional = margin * leverage;
        if (notional > c.maxPositionNotional) revert PositionTooLarge();

        _accrue(marketId, c, f);
        MarketState storage s = states[marketId];
        if ((isLong ? s.longOI : s.shortOI) + notional > _sideCap(c, f)) revert SideCapExceeded();

        if (-_pnl(c.isEvent, isLong, notional, entry, f.mid) > int256((margin * MAX_ENTRY_LOSS_BPS) / BPS)) {
            revert EntryTooFarFromMid();
        }
        uint256 reserve = _reserveFor(c, isLong, boost, margin, notional, entry);
        vault.lockPosition(msg.sender, margin, reserve);

        uint256 borrowed =
            c.isEvent ? _units(true, isLong, notional, entry) - _units(true, isLong, margin, entry) : 0;
        if (isLong) {
            s.longOI += notional;
            s.longUnits += _units(c.isEvent, true, notional, entry);
            s.longBorrowed += borrowed;
            s.longMargin += margin;
            s.longReserve += reserve;
        } else {
            s.shortOI += notional;
            s.shortUnits += _units(c.isEvent, false, notional, entry);
            s.shortBorrowed += borrowed;
            s.shortMargin += margin;
            s.shortReserve += reserve;
        }

        id = nextPositionId++;
        positions[id] = Position({
            owner: msg.sender,
            marketId: marketId,
            isLong: isLong,
            boosted: boost,
            openedAt: uint64(block.timestamp),
            margin: margin,
            notional: notional,
            entryPrice: entry,
            reserve: reserve,
            borrowedUnits: borrowed,
            entryFee: isLong ? s.cumFeeLong : s.cumFeeShort,
            entryBoost: s.cumBoost
        });
        _open.add(id);
        _openOf[msg.sender].add(id);
        emit PositionOpened(id, msg.sender, marketId, isLong, boost, margin, notional, entry, reserve);
    }

    /// @notice Close a position. Once the market has resolved, anyone may settle it for the owner.
    ///         An event market stops trading at its expiry: from then on positions wait for the result.
    function close(uint256 id, bytes calldata priceData) external nonReentrant {
        _pushPrices(priceData);
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        _accrue(p.marketId, c, f);
        if (f.resolved) {
            _settle(id, p, c, f.mid, CloseKind.Settlement, address(0), _late(p, c, f));
            return;
        }
        if (msg.sender != p.owner) revert NotOwner();
        if (c.isEvent && block.timestamp >= c.expiry) revert MarketClosed();
        _requireFresh(f, c);
        _settle(id, p, c, _fill(f, !p.isLong), CloseKind.Close, address(0), false);
    }

    /// @notice Liquidate a position whose equity at the mid has fallen to the maintenance level.
    ///         Whatever equity is left after the liquidator's reward goes back to the trader.
    ///         A 1x event position is a plain purchase of shares and is never liquidated.
    function liquidate(uint256 id, bytes calldata priceData) external nonReentrant {
        _pushPrices(priceData);
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        if (f.resolved) revert MarketResolved();
        _requireFresh(f, c);
        _accrue(p.marketId, c, f);
        if (c.isEvent && p.notional <= p.margin) revert NotLiquidatable();
        (uint256 crowding, uint256 premium) = _charges(p, c.isEvent, states[p.marketId]);
        if (
            int256(p.margin) + _result(p, c.isEvent, f.mid, crowding + premium)
                > int256((p.margin * maintBps) / BPS)
        ) revert NotLiquidatable();
        _settle(id, p, c, f.mid, CloseKind.Liquidation, msg.sender, false);
    }

    /// @notice Event markets: close a leveraged position that the time limit no longer allows.
    ///         Before expiry the owner receives the normal close payout, with no penalty. From
    ///         expiry on, a position that is still leveraged is paid back at most its margin.
    function forceClose(uint256 id, bytes calldata priceData) external nonReentrant {
        _pushPrices(priceData);
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        if (f.resolved) revert MarketResolved();
        if (!c.isEvent || p.notional <= p.margin) revert NotForceClosable();
        bool expired = block.timestamp >= c.expiry;
        if (!expired) {
            if (!_overLimit(p, c)) revert NotForceClosable();
            _requireFresh(f, c);
            if (_dislocated(c, f, FORCE_CLOSE_GAP_BPS)) revert PriceDislocated();
        }
        _accrue(p.marketId, c, f);
        _settle(id, p, c, _fill(f, !p.isLong), CloseKind.ForceClose, address(0), expired);
    }

    /// @notice Close a position that has reached its maximum profit and pay its owner. Beyond that
    ///         point the position has nothing more to gain, so anyone may collect it for them.
    function collect(uint256 id, bytes calldata priceData) external nonReentrant {
        _pushPrices(priceData);
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        if (f.resolved) revert MarketResolved();
        if (c.isEvent && block.timestamp >= c.expiry) revert MarketClosed();
        _requireFresh(f, c);
        _accrue(p.marketId, c, f);
        uint256 price = _fill(f, !p.isLong);
        if (_pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, price) < int256(p.reserve)) revert NotCollectable();
        _settle(id, p, c, price, CloseKind.Collect, address(0), false);
    }

    /// @notice Bring a market's fee and premium indexes up to date. Anyone may call it.
    function poke(uint32 marketId) external {
        if (!listed[marketId]) revert MarketDisabled();
        _accrue(marketId, markets[marketId], oracle.read(marketId));
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

    /// @dev True while the mid and the slow price are more than `bps` apart. Event prices are
    ///      probabilities, so their gap is measured in points of 1.00. Compared without dividing,
    ///      so nothing is rounded in the trader's favour.
    function _dislocated(MarketConfig memory c, PriceOracle.Feed memory f, uint256 bps) internal pure returns (bool) {
        uint256 diff = f.mid > f.slow ? f.mid - f.slow : f.slow - f.mid;
        return diff * BPS > bps * (c.isEvent ? WAD : f.slow);
    }

    /// @dev Capacity per side: depth counts only once it has persisted. On an event market a
    ///      share on the cheap side pays many times its price, so capacity is sized in shares:
    ///      it is scaled by twice the distance to the nearer of 0 and 1. A ceiling that does not
    ///      come from the signed book bounds what quotes resting on a thin book can unlock.
    function _sideCap(MarketConfig memory c, PriceOracle.Feed memory f) internal pure returns (uint256 cap) {
        uint256 depth = f.depthUsd < f.slowDepth ? f.depthUsd : f.slowDepth;
        cap = (depth * c.kappaBps) / BPS;
        if (c.isEvent) {
            uint256 near = f.mid >= WAD ? 0 : (f.mid < WAD - f.mid ? f.mid : WAD - f.mid);
            cap = (cap * 2 * near) / WAD;
        }
        if (c.maxSideNotional != 0 && cap > c.maxSideNotional) cap = c.maxSideNotional;
    }

    /// @dev Event markets: one hundred times the leverage at which the stop line sits TIME_Z
    ///      standard deviations of the price's expected movement over `reactionSeconds` away.
    ///      The expected squared movement of a probability before it resolves is p(1-p)
    ///      (Augenblick and Rabin 2021), which spread over the time left gives a variance of
    ///      p(1-p) * h / tau over h seconds. Leverage therefore falls with the square root of the
    ///      time left. The clock runs to the next scheduled information event: a result known to
    ///      be coming is a jump known to be coming, whether it ends the market or not.
    function _timeLeverageX100(MarketConfig memory c, uint256 price) internal view returns (uint256 lev) {
        uint256 ceiling = uint256(c.maxLeverage) * 100;
        if (!c.isEvent) return ceiling;
        uint256 clock = c.nextEvent != 0 && c.nextEvent < c.expiry ? c.nextEvent : c.expiry;
        if (block.timestamp >= clock) return 100;
        if (c.reactionSeconds == 0) return ceiling;
        if (price == 0 || price >= WAD) return 100;
        uint256 spread = (price * (WAD - price)) / WAD; // p(1-p)
        if (spread == 0) return 100;
        uint256 dist = price < WAD - price ? price : WAD - price;
        // sqrt(tau / (h * p(1-p))), scaled by 1e9.
        uint256 root = Math.sqrt(((clock - block.timestamp) * UNIT) / (uint256(c.reactionSeconds) * spread));
        lev = (dist * root * 100) / (TIME_Z * 1e9 * WAD);
        if (lev > ceiling) lev = ceiling;
        if (lev < 100) lev = 100;
    }

    /// @dev The most leverage a new position may take at `price`. Zero once an event has expired.
    function _maxLeverage(MarketConfig memory c, uint256 price) internal view returns (uint256 lev) {
        lev = c.maxLeverage;
        if (!c.isEvent) return lev;
        if (block.timestamp >= c.expiry) return 0;
        // The stop line is price/leverage below entry; the win line is no further away than that.
        uint256 dist = price >= WAD ? 0 : (price < WAD - price ? price : WAD - price);
        uint256 tickLev = dist / c.minDistance;
        if (tickLev < lev) lev = tickLev;
        uint256 timeLev = _timeLeverageX100(c, price) / 100;
        if (timeLev < lev) lev = timeLev;
        if (lev == 0) lev = 1;
    }

    /// @dev Whether a leveraged position is far enough above the time limit to be closed for its
    ///      owner. The limit is taken at the position's own entry price, so a move in its favour
    ///      never makes it closable; only the passing of time does.
    function _overLimit(Position memory p, MarketConfig memory c) internal view returns (bool) {
        return p.notional * 100 * BPS > p.margin * _timeLeverageX100(c, p.entryPrice) * FORCE_CLOSE_SLACK_BPS;
    }

    /// @dev A leveraged position still open when its market expired. It had until then to close
    ///      at a price; from then on it can lose but it cannot win.
    function _late(Position memory p, MarketConfig memory c, PriceOracle.Feed memory f) internal pure returns (bool) {
        return c.isEvent && p.notional > p.margin && f.timestamp >= c.expiry;
    }

    /// @dev Position size in contracts, scaled by 1e36 so that marking the aggregate back to
    ///      USDC loses nothing to rounding. An event short holds NO contracts bought at (1 - price).
    function _units(bool isEvent, bool isLong, uint256 amount, uint256 entry) internal pure returns (uint256) {
        if (isEvent && !isLong) return (amount * UNIT) / (WAD - entry);
        return (amount * UNIT) / entry;
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

    /// @dev The most a position can be paid in profit, locked in the vault when it opens.
    ///
    ///      Event markets. `outright` is what the margin would win if spent on shares and the
    ///      side won.
    ///        1x:        the outright win. A plain purchase of shares, with no ceiling.
    ///        leveraged: the smaller of the outright win and the margin itself. The win line is
    ///                   then never further from entry than the stop line, so a jump that crosses
    ///                   both pays the trader only if it is more likely to be favourable than the
    ///                   larger of one half and the price of the side.
    ///        boosted:   the leveraged win, up to `maxProfitMult` times margin.
    ///      Other markets: a 100% move, up to `maxProfitMult` times margin.
    function _reserveFor(
        MarketConfig memory c,
        bool isLong,
        bool boost,
        uint256 margin,
        uint256 notional,
        uint256 entry
    ) internal pure returns (uint256 reserve) {
        uint256 ceiling = margin * c.maxProfitMult;
        if (!c.isEvent) return notional < ceiling ? notional : ceiling;
        uint256 stake = boost ? notional : margin;
        uint256 natural = isLong ? (stake * (WAD - entry)) / entry : (stake * entry) / (WAD - entry);
        if (boost) return natural < ceiling ? natural : ceiling;
        if (notional <= margin) return natural;
        return natural < margin ? natural : margin;
    }

    /// @dev Index growth over `dt` seconds: (crowding fee long, crowding fee short, boost).
    ///
    ///      Event markets. The implied hazard is p(1-p) / tau per share per second: what a share
    ///      would drift by if all of its side's remaining uncertainty were a single jump at a time
    ///      spread evenly over the time left, and equally the expected extra payout that jump would
    ///      hand a borrowed share with uncapped upside. It is the same number for YES and for NO.
    ///      A boosted position pays `boostScale` times it on every share it has borrowed. A free
    ///      position pays `crowdingScale` times it, in proportion to how one-sided the borrowed
    ///      shares are, because the vault is exposed to a side's drift only on the borrowed shares
    ///      the other side does not offset.
    ///
    ///      Other markets. The crowded side accrues `crowdingPerDay` of notional, scaled by the
    ///      imbalance relative to capacity. With no capacity left the whole imbalance is uncovered.
    function _growth(
        MarketConfig memory c,
        MarketState storage s,
        PriceOracle.Feed memory f,
        uint256 mid,
        uint256 dt,
        uint256 tau
    ) internal view returns (uint256 feeLong, uint256 feeShort, uint256 boost) {
        if (!c.isEvent) {
            if (c.crowdingPerDay == 0 || s.longOI == s.shortOI) return (0, 0, 0);
            bool longCrowded = s.longOI > s.shortOI;
            uint256 imbalance = longCrowded ? s.longOI - s.shortOI : s.shortOI - s.longOI;
            uint256 cap = _sideCap(c, f);
            uint256 skew = imbalance >= cap ? WAD : (imbalance * WAD) / cap;
            uint256 grown = (skew * c.crowdingPerDay * dt) / (1 days * WAD);
            if (longCrowded) feeLong = grown;
            else feeShort = grown;
            return (feeLong, feeShort, 0);
        }
        if (c.crowdingScale == 0 && c.boostScale == 0) return (0, 0, 0);
        if (mid > WAD) mid = WAD;
        uint256 hazard = (((mid * (WAD - mid)) / WAD) * dt) / tau;
        boost = (hazard * c.boostScale) / WAD;
        uint256 crowd = (hazard * c.crowdingScale) / WAD;
        if (s.longBorrowed > s.shortBorrowed) {
            feeLong = (crowd * (s.longBorrowed - s.shortBorrowed)) / s.longBorrowed;
        } else if (s.shortBorrowed > s.longBorrowed) {
            feeShort = (crowd * (s.shortBorrowed - s.longBorrowed)) / s.shortBorrowed;
        }
    }

    /// @dev What the indexes have grown by since the last accrual. The interval is priced at the
    ///      mid that was in force when it began, so nobody can choose the price that charges time
    ///      already elapsed, and the stretch that ends in a result is charged up to the result.
    function _pending(MarketConfig memory c, MarketState storage s, PriceOracle.Feed memory f)
        internal
        view
        returns (uint256 feeLong, uint256 feeShort, uint256 boost)
    {
        if (f.timestamp == 0 || s.lastAccrual == 0) return (0, 0, 0);
        uint256 upTo = block.timestamp;
        if (f.resolved && f.timestamp < upTo) upTo = f.timestamp;
        if (upTo <= s.lastAccrual) return (0, 0, 0);
        uint256 dt = upTo - s.lastAccrual;
        // The rate rises as expiry nears, so the interval is priced at its midpoint.
        uint256 midpoint = upTo - dt / 2;
        uint256 tau = c.expiry > midpoint + TAU_FLOOR ? c.expiry - midpoint : TAU_FLOOR;
        return _growth(c, s, f, s.lastMid == 0 ? f.mid : s.lastMid, dt, tau);
    }

    function _accrue(uint32 marketId, MarketConfig memory c, PriceOracle.Feed memory f) internal {
        MarketState storage s = states[marketId];
        if (s.lastAccrual == 0) return; // never listed
        (uint256 feeLong, uint256 feeShort, uint256 boost) = _pending(c, s, f);
        s.cumFeeLong += feeLong;
        s.cumFeeShort += feeShort;
        s.cumBoost += boost;
        s.lastAccrual = uint64(block.timestamp);
        if (f.timestamp != 0 && !f.resolved) s.lastMid = f.mid > WAD ? WAD : f.mid;
    }

    /// @dev What a position has accrued against the stored indexes: (crowding fee, boost premium).
    ///      A boosted position pays the premium and not the crowding fee.
    function _charges(Position memory p, bool isEvent, MarketState storage s)
        internal
        view
        returns (uint256 crowding, uint256 premium)
    {
        return _chargesAt(p, isEvent, p.isLong ? s.cumFeeLong : s.cumFeeShort, s.cumBoost);
    }

    function _chargesAt(Position memory p, bool isEvent, uint256 cumFee, uint256 cumBoost)
        internal
        pure
        returns (uint256 crowding, uint256 premium)
    {
        if (!isEvent) {
            crowding = (p.notional * (cumFee - p.entryFee)) / WAD;
        } else if (p.boosted) {
            premium = (p.borrowedUnits * (cumBoost - p.entryBoost)) / UNIT;
        } else {
            crowding = (p.borrowedUnits * (cumFee - p.entryFee)) / UNIT;
        }
    }

    /// @dev A position's result at `price`: price P&L, never more than its reserve, less what it
    ///      has accrued in crowding fee and Boost premium, never less than minus its margin.
    ///      The holding charges come out of the position whatever its result, so closing and
    ///      opening again does not shed them. The profit share is taken from this number only
    ///      when it is positive.
    function _result(Position memory p, bool isEvent, uint256 price, uint256 charges) internal pure returns (int256 r) {
        r = _pnl(isEvent, p.isLong, p.notional, p.entryPrice, price);
        if (r > int256(p.reserve)) r = int256(p.reserve);
        r -= int256(charges);
        if (r < -int256(p.margin)) r = -int256(p.margin);
    }

    function _settle(
        uint256 id,
        Position memory p,
        MarketConfig memory c,
        uint256 exitPrice,
        CloseKind kind,
        address liquidator,
        bool noGain
    ) internal {
        MarketState storage s = states[p.marketId];
        (uint256 crowding, uint256 premium) = _charges(p, c.isEvent, s);
        int256 result = _result(p, c.isEvent, exitPrice, crowding + premium);
        if (noGain && result > 0) result = 0;

        uint256 payout;
        uint256 fee;
        if (result > 0) {
            fee = (uint256(result) * c.profitFeeBps) / BPS;
            payout = p.margin + uint256(result) - fee;
        } else {
            payout = p.margin - uint256(-result);
        }

        uint256 liqFee;
        if (kind == CloseKind.Liquidation) {
            // Paid in full even when the price has jumped through the stop and no equity is
            // left, so that somebody always has a reason to clear the position.
            liqFee = (p.margin * liqFeeBps) / BPS;
            payout = payout > liqFee ? payout - liqFee : 0;
        }

        if (p.isLong) {
            s.longOI -= p.notional;
            s.longUnits -= _units(c.isEvent, true, p.notional, p.entryPrice);
            s.longBorrowed -= p.borrowedUnits;
            s.longMargin -= p.margin;
            s.longReserve -= p.reserve;
        } else {
            s.shortOI -= p.notional;
            s.shortUnits -= _units(c.isEvent, false, p.notional, p.entryPrice);
            s.shortBorrowed -= p.borrowedUnits;
            s.shortMargin -= p.margin;
            s.shortReserve -= p.reserve;
        }
        delete positions[id];
        _open.remove(id);
        _openOf[p.owner].remove(id);

        uint256 stakerFee = IStakingView(staking).totalStaked() > 0 ? (fee * stakerShareBps) / BPS : 0;
        vault.settlePosition(p.margin, p.reserve, p.owner, payout, staking, stakerFee, liquidator, liqFee);
        uint256 minted = fee > 0 ? token.mintForFee(p.owner, fee) : 0;

        emit PositionClosed(id, p.owner, p.marketId, kind, exitPrice, result, fee, payout, minted, crowding, premium);
    }

    // ---- views --------------------------------------------------------------------------

    /// @notice What traders are owed, net, across all markets at the oracle mid (USDC, 6 dp).
    ///         Each side of each market is bounded by what it can lose (its margin) and what it
    ///         can win (its reserve) before the sides are added, so a position past its stop or
    ///         past its cap is not marked against another market's headroom.
    function unrealizedPnl() external view returns (int256 total) {
        for (uint256 i = 0; i < marketIds.length; i++) {
            uint32 m = marketIds[i];
            MarketState storage s = states[m];
            bool isEvent = markets[m].isEvent;
            uint256 mid = oracle.read(m).mid;
            if (isEvent && mid > WAD) mid = WAD;
            int256 longPnl = int256((s.longUnits * mid) / UNIT) - int256(s.longOI);
            int256 shortPnl = isEvent
                ? int256((s.shortUnits * (WAD - mid)) / UNIT) - int256(s.shortOI)
                : int256(s.shortOI) - int256((s.shortUnits * mid) / UNIT);
            total += _bound(longPnl, s.longMargin, s.longReserve) + _bound(shortPnl, s.shortMargin, s.shortReserve);
        }
    }

    function _bound(int256 pnl, uint256 margin, uint256 reserve) internal pure returns (int256) {
        if (pnl > int256(reserve)) return int256(reserve);
        if (pnl < -int256(margin)) return -int256(margin);
        return pnl;
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
        // What the next day would add to each index at the current state. Event markets: USDC
        // per borrowed share (1e18). Other markets: a fraction of notional (1e18).
        uint256 feePerDayLong;
        uint256 feePerDayShort;
        uint256 boostPerDay;
        bool closed; // event markets: past expiry and waiting for the result
    }

    function marketView(uint32 marketId) public view returns (MarketView memory v) {
        v.marketId = marketId;
        v.config = markets[marketId];
        v.state = states[marketId];
        v.feed = oracle.read(marketId);
        v.sideCap = _sideCap(v.config, v.feed);
        v.closed = v.config.isEvent && block.timestamp >= v.config.expiry;
        if (v.feed.resolved || v.feed.timestamp == 0) return v;
        v.maxLeverageLong = _maxLeverage(v.config, v.feed.mid);
        v.maxLeverageShort = v.maxLeverageLong;
        uint256 tau = v.config.expiry > block.timestamp + TAU_FLOOR ? v.config.expiry - block.timestamp : TAU_FLOOR;
        (v.feePerDayLong, v.feePerDayShort, v.boostPerDay) =
            _growth(v.config, states[marketId], v.feed, v.feed.mid, 1 days, tau);
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
        int256 pnl; // at markPrice: capped, after the crowding fee and any boost premium, before the profit share
        int256 equityAtMid;
        uint256 liquidationPrice;
        uint256 winPrice; // price at which the position reaches its maximum profit
        uint256 crowdingFee; // accrued so far
        uint256 boostPremium; // accrued so far
        bool liquidatable;
        bool forceClosable;
        bool collectable;
    }

    function positionView(uint256 id) public view returns (PositionView memory v) {
        Position memory p = _get(id);
        MarketConfig memory c = markets[p.marketId];
        PriceOracle.Feed memory f = oracle.read(p.marketId);
        MarketState storage s = states[p.marketId];
        // Charges as they would stand if the position were settled in this block.
        (uint256 feeLong, uint256 feeShort, uint256 boost) = _pending(c, s, f);
        (v.crowdingFee, v.boostPremium) =
            _chargesAt(p, c.isEvent, p.isLong ? s.cumFeeLong + feeLong : s.cumFeeShort + feeShort, s.cumBoost + boost);
        uint256 charges = v.crowdingFee + v.boostPremium;
        bool leveraged = p.notional > p.margin;
        bool expired = c.isEvent && block.timestamp >= c.expiry;

        v.id = id;
        v.position = p;
        v.markPrice = f.resolved ? f.mid : _fill(f, !p.isLong);
        v.pnl = _result(p, c.isEvent, v.markPrice, charges);
        // From expiry on a position that is still leveraged can no longer win.
        if (v.pnl > 0 && c.isEvent && leveraged && (f.resolved ? f.timestamp >= c.expiry : expired)) v.pnl = 0;
        v.equityAtMid = int256(p.margin) + _result(p, c.isEvent, f.mid, charges);
        v.liquidationPrice = _liquidationPrice(p, c.isEvent, charges);
        v.winPrice = _winPrice(p, c.isEvent);
        if (f.resolved) return v;
        v.liquidatable = !(c.isEvent && !leveraged) && v.equityAtMid <= int256((p.margin * maintBps) / BPS);
        v.forceClosable = c.isEvent && leveraged
            && (expired || (_overLimit(p, c) && !_dislocated(c, f, FORCE_CLOSE_GAP_BPS)));
        v.collectable =
            !expired && _pnl(c.isEvent, p.isLong, p.notional, p.entryPrice, v.markPrice) >= int256(p.reserve);
    }

    /// @dev Price at which equity equals the maintenance level, given the charges accrued so far.
    ///      A 1x event position is never liquidated: its line is the losing result itself.
    function _liquidationPrice(Position memory p, bool isEvent, uint256 charges) internal view returns (uint256) {
        if (isEvent && p.notional <= p.margin) return p.isLong ? 0 : WAD;
        // Loss the position can absorb before liquidation. Negative once the charges have used
        // it up, and the line is then on the winning side of entry.
        int256 buffer = int256(p.margin) - int256((p.margin * maintBps) / BPS) - int256(charges);
        uint256 base = isEvent && !p.isLong ? WAD - p.entryPrice : p.entryPrice;
        uint256 move = ((buffer >= 0 ? uint256(buffer) : uint256(-buffer)) * base) / p.notional;
        // A long loses as the price falls; a short as it rises.
        bool below = p.isLong == (buffer >= 0);
        if (below) return move >= p.entryPrice ? 0 : p.entryPrice - move;
        uint256 price = p.entryPrice + move;
        return isEvent && price > WAD ? WAD : price;
    }

    /// @dev Price at which the price P&L equals the reserve.
    function _winPrice(Position memory p, bool isEvent) internal pure returns (uint256) {
        uint256 frac = (p.reserve * WAD) / p.notional; // profit as a fraction of notional
        if (p.isLong) {
            uint256 price = p.entryPrice + (p.entryPrice * frac) / WAD;
            return isEvent && price > WAD ? WAD : price;
        }
        uint256 base = isEvent ? WAD - p.entryPrice : p.entryPrice;
        uint256 drop = (base * frac) / WAD;
        return drop >= p.entryPrice ? 0 : p.entryPrice - drop;
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

    /// @notice Page through open positions, for keepers scanning for upkeep.
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
