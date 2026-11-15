// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title PriceOracle
/// @notice Signed reference prices, relayed by anyone.
///
/// Each update carries the reference venue's mid price and the USD depth resting near the mid.
/// The oracle keeps two prices per market:
///   - `mid`  : the latest signed mid.
///   - `slow` : a time-weighted average that only moves as time passes. A price that was just
///              pushed has no effect on `slow` until it has been held.
/// The engine fills every trade at the worse of the two for the trader, so a short-lived push of
/// the reference price cannot be traded against.
contract PriceOracle is Ownable, EIP712 {
    struct PriceUpdate {
        uint32 marketId;
        uint256 price; // 1e18
        uint256 depthUsd; // USDC (6 dp) resting within the reference band, thinner side
        uint64 timestamp; // signer's clock, seconds
        bool resolved; // event markets only: `price` is the final 0 or 1e18
    }

    struct Feed {
        uint256 mid;
        uint256 slow;
        uint256 depthUsd;
        uint64 timestamp;
        bool resolved;
    }

    bytes32 public constant UPDATE_TYPEHASH =
        keccak256("PriceUpdate(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)");

    /// @dev Tolerated lead of the signer's clock over the chain's.
    uint64 public constant MAX_FUTURE_DRIFT = 10;

    mapping(address => bool) public isSigner;
    mapping(uint32 => Feed) private _feeds;
    /// @notice Averaging time of the slow price, per market, in seconds. Zero disables it.
    mapping(uint32 => uint64) public tau;

    event SignerSet(address indexed signer, bool allowed);
    event TauSet(uint32 indexed marketId, uint64 tau);
    event PriceUpdated(uint32 indexed marketId, uint256 mid, uint256 slow, uint256 depthUsd, uint64 timestamp, bool resolved);

    error BadSignature();
    error FutureTimestamp();
    error LengthMismatch();

    constructor(address owner_) Ownable(owner_) EIP712("OpenLiquidOracle", "1") {}

    function setSigner(address signer, bool allowed) external onlyOwner {
        isSigner[signer] = allowed;
        emit SignerSet(signer, allowed);
    }

    function setTau(uint32 marketId, uint64 tau_) external onlyOwner {
        tau[marketId] = tau_;
        emit TauSet(marketId, tau_);
    }

    /// @notice Relay signed updates. Stale or post-resolution updates are skipped, not reverted,
    ///         so a trade that bundles a price never fails because a keeper got there first.
    function push(PriceUpdate[] calldata updates, bytes[] calldata sigs) external {
        if (updates.length != sigs.length) revert LengthMismatch();
        for (uint256 i = 0; i < updates.length; i++) {
            _apply(updates[i], sigs[i]);
        }
    }

    function _apply(PriceUpdate calldata u, bytes calldata sig) internal {
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(UPDATE_TYPEHASH, u.marketId, u.price, u.depthUsd, u.timestamp, u.resolved))
        );
        if (!isSigner[ECDSA.recover(digest, sig)]) revert BadSignature();
        if (u.timestamp > block.timestamp + MAX_FUTURE_DRIFT) revert FutureTimestamp();

        Feed storage f = _feeds[u.marketId];
        if (f.resolved || u.timestamp <= f.timestamp) return;

        if (f.timestamp == 0 || u.resolved || tau[u.marketId] == 0) {
            f.slow = u.price;
        } else {
            f.slow = _advance(f.slow, f.mid, u.timestamp - f.timestamp, tau[u.marketId]);
        }
        f.mid = u.price;
        f.depthUsd = u.depthUsd;
        f.timestamp = u.timestamp;
        f.resolved = u.resolved;
        emit PriceUpdated(u.marketId, f.mid, f.slow, f.depthUsd, f.timestamp, f.resolved);
    }

    /// @dev Move `slow` toward the price that prevailed over the last `dt` seconds.
    function _advance(uint256 slow, uint256 held, uint256 dt, uint64 tau_) internal pure returns (uint256) {
        if (tau_ == 0 || dt == 0) return tau_ == 0 ? held : slow;
        if (held >= slow) return slow + ((held - slow) * dt) / (tau_ + dt);
        return slow - ((slow - held) * dt) / (tau_ + dt);
    }

    /// @notice Latest feed, with `slow` advanced to the current block time.
    function read(uint32 marketId) external view returns (Feed memory f) {
        f = _feeds[marketId];
        if (f.timestamp != 0 && !f.resolved && block.timestamp > f.timestamp) {
            f.slow = _advance(f.slow, f.mid, block.timestamp - f.timestamp, tau[marketId]);
        }
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
