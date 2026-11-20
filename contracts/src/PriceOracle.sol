// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title PriceOracle
/// @notice Signed reference prices, relayed by anyone.
///
/// Each update carries the reference venue's mid price and the USD depth resting near the mid.
/// The oracle keeps, per market:
///   - `mid`       : the latest signed mid.
///   - `slow`      : an exponential time average of the mid. A price that was just pushed has no
///                   effect on `slow` until it has been held.
///   - `slowDepth` : the same average of the reported depth, so resting depth has to persist
///                   before it counts toward capacity.
/// The engine fills every trade at the worse of `mid` and `slow` for the trader, so a short-lived
/// push of the reference price cannot be traded against.
///
/// The average is exact: after a value has been held for `dt` seconds the average has covered
/// `1 - e^(-dt/tau)` of the gap, however many updates arrived in between.
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
        uint256 slowDepth;
        uint64 timestamp;
        bool resolved;
    }

    bytes32 public constant UPDATE_TYPEHASH =
        keccak256("PriceUpdate(uint32 marketId,uint256 price,uint256 depthUsd,uint64 timestamp,bool resolved)");

    /// @dev Tolerated lead of the signer's clock over the chain's.
    uint64 public constant MAX_FUTURE_DRIFT = 10;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant LN2 = 693147180559945309;

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

        uint64 tau_ = tau[u.marketId];
        if (f.timestamp == 0 || u.resolved || tau_ == 0) {
            f.slow = u.price;
            f.slowDepth = u.depthUsd;
        } else {
            uint256 decay = _expNeg((uint256(u.timestamp - f.timestamp) * WAD) / tau_);
            f.slow = _toward(f.slow, f.mid, decay);
            f.slowDepth = _toward(f.slowDepth, f.depthUsd, decay);
        }
        f.mid = u.price;
        f.depthUsd = u.depthUsd;
        f.timestamp = u.timestamp;
        f.resolved = u.resolved;
        emit PriceUpdated(u.marketId, f.mid, f.slow, f.depthUsd, f.timestamp, f.resolved);
    }

    /// @dev The average after the value `held` has prevailed: held + (avg - held) * decay.
    function _toward(uint256 avg, uint256 held, uint256 decay) internal pure returns (uint256) {
        if (avg >= held) return held + ((avg - held) * decay) / WAD;
        return held - ((held - avg) * decay) / WAD;
    }

    /// @dev e^(-x) for x >= 0, both in 1e18 fixed point. Writes x = k*ln2 + r with 0 <= r < ln2,
    ///      sums the series for e^r, and returns 2^-k / e^r. Accurate to about 1e-15.
    function _expNeg(uint256 x) internal pure returns (uint256) {
        uint256 k = x / LN2;
        if (k >= 60) return 0;
        uint256 r = x - k * LN2;
        uint256 term = WAD;
        uint256 sum = WAD;
        for (uint256 i = 1; i <= 16; i++) {
            term = (term * r) / (WAD * i);
            sum += term;
        }
        return ((WAD * WAD) / sum) >> k;
    }

    /// @notice Latest feed, with `slow` and `slowDepth` advanced to the current block time.
    function read(uint32 marketId) external view returns (Feed memory f) {
        f = _feeds[marketId];
        uint64 tau_ = tau[marketId];
        if (f.timestamp != 0 && !f.resolved && tau_ != 0 && block.timestamp > f.timestamp) {
            uint256 decay = _expNeg(((block.timestamp - f.timestamp) * WAD) / tau_);
            f.slow = _toward(f.slow, f.mid, decay);
            f.slowDepth = _toward(f.slowDepth, f.depthUsd, decay);
        }
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
