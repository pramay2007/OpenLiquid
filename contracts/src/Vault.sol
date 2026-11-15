// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IEngineView {
    function unrealizedPnl() external view returns (int256);
}

/// @title Vault
/// @notice Pre-funded USDC pool that is the counterparty to every trade.
///
/// Two balances inside the vault are not LP money:
///   - `marginHeld`: trader margin on open positions.
///   - `reserved`  : the maximum profit of every open position, locked when it opens.
/// The engine can only open a position if the vault can lock its full maximum profit, and LPs
/// can only withdraw what is not locked. A winner is therefore always paid at close; there is
/// no payout queue.
contract Vault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    address public engine;
    uint256 public marginHeld;
    uint256 public reserved;

    error OnlyEngine();
    error EngineAlreadySet();
    error InsufficientLiquidity();

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    constructor(IERC20 usdc, address owner_) ERC20("OpenLiquid LP", "olLP") ERC4626(usdc) Ownable(owner_) {}

    function setEngine(address engine_) external onlyOwner {
        if (engine != address(0)) revert EngineAlreadySet();
        engine = engine_;
    }

    /// @dev Virtual-share offset against first-depositor share inflation.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function cash() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice USDC that is neither trader margin nor locked against open positions.
    function freeLiquidity() public view returns (uint256) {
        uint256 c = cash();
        uint256 locked = marginHeld + reserved;
        return c > locked ? c - locked : 0;
    }

    /// @notice LP net asset value: cash, less trader margin, less what traders are currently
    ///         owed on open positions at the oracle price. Marking open positions means an LP
    ///         cannot leave ahead of a winning trader's close and push the loss onto the others.
    function totalAssets() public view override returns (uint256) {
        int256 owed = engine == address(0) ? int256(0) : IEngineView(engine).unrealizedPnl();
        // A trader cannot lose more than margin or win more than the reserve.
        if (owed > int256(reserved)) owed = int256(reserved);
        if (owed < -int256(marginHeld)) owed = -int256(marginHeld);
        int256 nav = int256(cash()) - int256(marginHeld) - owed;
        return nav > 0 ? uint256(nav) : 0;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 own = super.maxWithdraw(owner_);
        uint256 free = freeLiquidity();
        return own < free ? own : free;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 own = super.maxRedeem(owner_);
        uint256 freeShares = convertToShares(freeLiquidity());
        return own < freeShares ? own : freeShares;
    }

    // ---- engine hooks -------------------------------------------------------------------

    /// @notice Take margin from the trader and lock the position's maximum profit.
    function lockPosition(address trader, uint256 margin, uint256 reserve) external onlyEngine {
        IERC20(asset()).safeTransferFrom(trader, address(this), margin);
        marginHeld += margin;
        reserved += reserve;
        if (cash() < marginHeld + reserved) revert InsufficientLiquidity();
    }

    /// @notice Release a position's margin and reserve, and pay out what is owed.
    /// @dev The engine guarantees the three payments sum to at most `margin + reserve`.
    function settlePosition(
        uint256 margin,
        uint256 reserve,
        address trader,
        uint256 traderPayout,
        address feeRecipient,
        uint256 feeAmount,
        address liquidator,
        uint256 liquidatorFee
    ) external onlyEngine {
        marginHeld -= margin;
        reserved -= reserve;
        IERC20 usdc = IERC20(asset());
        if (traderPayout > 0) usdc.safeTransfer(trader, traderPayout);
        if (feeAmount > 0) usdc.safeTransfer(feeRecipient, feeAmount);
        if (liquidatorFee > 0) usdc.safeTransfer(liquidator, liquidatorFee);
    }
}
