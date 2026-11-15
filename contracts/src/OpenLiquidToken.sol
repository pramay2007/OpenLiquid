// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title OpenLiquidToken (OLQ)
/// @notice Transferable from day one. Minted only by the engine, and only against protocol fees
///         actually paid, on a decaying curve with a hard supply ceiling:
///
///             rate(F) = R0 * (H / (H + F))^2      tokens per 1 USDC of fee
///
///         where F is cumulative fees paid so far. The integral over all future fees is
///         R0 * H, which is the maximum supply.
contract OpenLiquidToken is ERC20, Ownable {
    /// @notice Tokens (18 dp) minted per 1 USDC (6 dp) of fee at launch.
    uint256 public immutable R0;
    /// @notice Half-life scale of the curve, in USDC (6 dp).
    uint256 public immutable H;

    address public minter;
    uint256 public cumulativeFees;

    error OnlyMinter();
    error MinterAlreadySet();

    constructor(uint256 r0, uint256 h, address owner_) ERC20("OpenLiquid", "OLQ") Ownable(owner_) {
        R0 = r0;
        H = h;
    }

    function setMinter(address minter_) external onlyOwner {
        if (minter != address(0)) revert MinterAlreadySet();
        minter = minter_;
    }

    function maxSupply() external view returns (uint256) {
        return (R0 * H) / 1e6;
    }

    /// @notice Tokens that a fee of `fee` USDC would mint right now.
    function quoteMint(uint256 fee) public view returns (uint256) {
        // Closed form of the integral of rate(F) from F to F + fee.
        uint256 a = H + cumulativeFees;
        return (R0 * H * H * fee) / (a * (a + fee)) / 1e6;
    }

    function mintForFee(address to, uint256 fee) external returns (uint256 amount) {
        if (msg.sender != minter) revert OnlyMinter();
        amount = quoteMint(fee);
        cumulativeFees += fee;
        if (amount > 0) _mint(to, amount);
    }
}
