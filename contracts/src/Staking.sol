// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Staking
/// @notice Stake OLQ, earn a share of protocol fees in USDC. Stakers receive fee revenue only;
///         trader losses belong to the LPs who carry the risk of trader wins.
contract Staking {
    using SafeERC20 for IERC20;

    IERC20 public immutable olq;
    IERC20 public immutable usdc;

    uint256 public totalStaked;
    uint256 public accPerShare; // USDC per staked OLQ, scaled 1e18
    uint256 public accounted; // USDC already distributed or awaiting claim

    mapping(address => uint256) public staked;
    mapping(address => uint256) private _debt;
    mapping(address => uint256) private _owed;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);

    constructor(IERC20 olq_, IERC20 usdc_) {
        olq = olq_;
        usdc = usdc_;
    }

    /// @dev Fees arrive as plain transfers; anything above `accounted` is new revenue. Only what
    ///      was actually credited to stakers is marked as accounted, so an amount too small to
    ///      divide stays pending and is distributed with the next fee instead of being lost.
    function _sync() internal {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal > accounted && totalStaked > 0) {
            uint256 inc = ((bal - accounted) * 1e18) / totalStaked;
            if (inc == 0) return;
            accPerShare += inc;
            accounted += (inc * totalStaked) / 1e18;
        }
    }

    function _settle(address user) internal {
        _sync();
        _owed[user] += (staked[user] * accPerShare) / 1e18 - _debt[user];
    }

    function stake(uint256 amount) external {
        _settle(msg.sender);
        olq.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        _debt[msg.sender] = (staked[msg.sender] * accPerShare) / 1e18;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external {
        _settle(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        _debt[msg.sender] = (staked[msg.sender] * accPerShare) / 1e18;
        olq.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external returns (uint256 amount) {
        _settle(msg.sender);
        _debt[msg.sender] = (staked[msg.sender] * accPerShare) / 1e18;
        amount = _owed[msg.sender];
        if (amount > 0) {
            _owed[msg.sender] = 0;
            accounted -= amount;
            usdc.safeTransfer(msg.sender, amount);
            emit Claimed(msg.sender, amount);
        }
    }

    function pending(address user) external view returns (uint256) {
        uint256 acc = accPerShare;
        uint256 bal = usdc.balanceOf(address(this));
        if (bal > accounted && totalStaked > 0) acc += ((bal - accounted) * 1e18) / totalStaked;
        return _owed[user] + (staked[user] * acc) / 1e18 - _debt[user];
    }
}
