// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "account-abstraction/core/UserOperationLib.sol";
import {Bucket} from "../lib/PolicyTypes.sol";
import {Buckets} from "../lib/Buckets.sol";

/// @title AgentPaymaster: staked EntryPoint v0.8 paymaster with a per-agent gas quota (IDEA.md s13, R21, I14).
/// @notice The owner registers agent accounts. Each one gets a gas quota in wei: a lib/Buckets token bucket
///         (burst + 24 h refill, so sponsored gas in any 24 h window <= burst + ratePerDay).
///
///         Validation (`validatePaymasterUserOp`; ERC-7562 rules for a staked paymaster):
///         - unregistered sender -> revert `NotRegistered` (a Sybil account gets nothing);
///         - every gas field is capped (`GasCaps`): maxFeePerGas, callGasLimit, verificationGasLimit,
///           preVerificationGas, paymasterVerificationGasLimit, paymasterPostOpGasLimit; and the postOp limit
///           must be >= MIN_POSTOP_GAS, so postOp cannot be starved;
///         - reserves maxCost as a hold against that sender's quota only (`pending`). The admission check
///           needs no TIMESTAMP: the stored level is the level at `lastRefill` (always <= now, it is only
///           written in execution), so if pending + maxCost exceeds it the paymaster returns
///           validAfter = the first second the bucket refills enough, and the EntryPoint enforces it
///           (an exhausted quota answers "AA32 paymaster expired or not due" until it refills);
///         - touches storage keyed by the sender only (`_agents[sender]`), plus its own config read-only.
///
///         postOp (execution, real block.timestamp): releases the hold and debits only the charged part
///         from the bucket with `Buckets.tryDebit(.., block.timestamp)`, so the unused part is refunded.
///         charged = min(maxCost, actualGasCost + (paymasterPostOpGasLimit + POSTOP_OVERHEAD_GAS) x fee) is an
///         upper bound of what the EntryPoint takes from the deposit for the op (postOp gas + its unused-gas
///         penalty <= the postOp limit; POSTOP_OVERHEAD_GAS covers the EntryPoint's own postOp bookkeeping).
///         If postOp never runs (a reverted postOp or the EntryPoint's low-prefund path), the hold stays: the
///         EntryPoint charges <= maxCost and that agent's capacity stays reduced by maxCost. Ops that fail
///         account validation revert the whole bundle, so they cost nobody anything. An op that reverts in
///         execution is still charged to its own agent's quota, so spam drains only that quota.
///
///         Bound (I14): every debit is a Buckets debit at the real block time and is >= the deposit charge, so
///         per agent the sponsored gas in any window of t seconds <= burst + ratePerDay x t / 86400, and the
///         deposit drain over t <= `maxSponsoredOver(t)` (the sum of the quotas).
///
///         paymasterAndData (EntryPoint v0.8): paymaster (20) | verificationGasLimit (uint128) |
///         postOpGasLimit (uint128) | data (ignored; may be empty). Helper: packages/shared/src/paymaster.
///         Staking: `addStake(unstakeDelaySec)` (owner) before serving a bundler; `isStaked()`.
contract AgentPaymaster is BasePaymaster {
    using Buckets for Bucket;
    using UserOperationLib for PackedUserOperation;

    uint256 internal constant DAY = 86400;

    /// Lower bound for paymasterPostOpGasLimit (postOp needs < half of it; tests check).
    uint256 public constant MIN_POSTOP_GAS = 30_000;
    /// EntryPoint gas spent around postOp that the postOp limit does not cover (measured well below this).
    uint256 public constant POSTOP_OVERHEAD_GAS = 15_000;

    /// Gas field indexes in `GasFieldAboveCap`.
    uint8 public constant F_MAX_FEE_PER_GAS = 0;
    uint8 public constant F_CALL_GAS = 1;
    uint8 public constant F_VERIFICATION_GAS = 2;
    uint8 public constant F_PRE_VERIFICATION_GAS = 3;
    uint8 public constant F_PM_VERIFICATION_GAS = 4;
    uint8 public constant F_PM_POSTOP_GAS = 5;

    struct GasCaps {
        uint64 maxFeePerGas;
        uint32 callGasLimit;
        uint32 verificationGasLimit;
        uint32 preVerificationGas;
        uint32 paymasterVerificationGasLimit;
        uint32 paymasterPostOpGasLimit;
    }

    /// Per-agent state, keyed by the agent account (ERC-7562 associated storage of the sender).
    struct AgentQuota {
        Bucket quota; // wei; burst + ratePerDay; level is the level at lastRefill
        uint128 pending; // holds of ops validated whose postOp has not run yet
        bool registered;
    }

    GasCaps internal _caps;
    mapping(address account => AgentQuota) internal _agents;
    uint256 public totalBurst;
    uint256 public totalRatePerDay;
    uint256 public agentCount;

    event AgentRegistered(address indexed account, uint128 burst, uint128 ratePerDay);
    event AgentDeregistered(address indexed account);
    event GasCapsSet(GasCaps caps);
    /// One per sponsored op that reached postOp. reserved = maxCost; charged = debited from the quota.
    event GasSponsored(
        address indexed account, bytes32 indexed userOpHash, uint256 reserved, uint256 charged, bool opSucceeded
    );

    error ZeroAddress();
    error NotRegistered(address account);
    error GasFieldAboveCap(uint8 field, uint256 value, uint256 cap);
    error PostOpGasTooLow(uint256 value, uint256 min);
    /// pending + maxCost can never fit (above burst, or no refill configured).
    error QuotaExceeded(address account, uint256 needed, uint256 burst);

    constructor(IEntryPoint entryPoint_, address owner_, GasCaps memory caps_) BasePaymaster(entryPoint_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (owner_ != msg.sender) _transferOwnership(owner_);
        _setGasCaps(caps_);
    }

    // ------------------------------------------------------------------ owner

    /// Register (or re-quota) an agent account. A re-quota keeps what is already spent
    /// (Buckets.configure: level = min(available now, new burst)); a new account starts full.
    function registerAgent(address account, uint128 burst, uint128 ratePerDay) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        AgentQuota storage a = _agents[account];
        if (a.registered) {
            totalBurst -= a.quota.burst;
            totalRatePerDay -= a.quota.ratePerDay;
        } else {
            a.registered = true;
            agentCount += 1;
        }
        a.quota.configure(burst, ratePerDay, block.timestamp);
        totalBurst += burst;
        totalRatePerDay += ratePerDay;
        emit AgentRegistered(account, burst, ratePerDay);
    }

    /// Stop sponsoring an account. Its bucket is kept, so a later re-registration cannot refill it early.
    function deregisterAgent(address account) external onlyOwner {
        AgentQuota storage a = _agents[account];
        if (!a.registered) revert NotRegistered(account);
        a.registered = false;
        agentCount -= 1;
        totalBurst -= a.quota.burst;
        totalRatePerDay -= a.quota.ratePerDay;
        emit AgentDeregistered(account);
    }

    function setGasCaps(GasCaps calldata caps_) external onlyOwner {
        _setGasCaps(caps_);
    }

    // ------------------------------------------------------------------ views

    function gasCaps() external view returns (GasCaps memory) {
        return _caps;
    }

    /// Stored state of `account` (bucket level is the level at bucket.lastRefill).
    function agentOf(address account) external view returns (bool registered, Bucket memory quota, uint256 pending) {
        AgentQuota storage a = _agents[account];
        return (a.registered, a.quota, a.pending);
    }

    /// Quota left for new reservations now: Buckets.availableAt(now) - pending (0 if unregistered).
    function available(address account) public view returns (uint256) {
        AgentQuota storage a = _agents[account];
        if (!a.registered) return 0;
        uint256 lvl = Buckets.availableAt(a.quota, block.timestamp);
        return lvl > a.pending ? lvl - a.pending : 0;
    }

    /// Validation's admission rule as a view: the validAfter an op of `maxCost` from `account` gets now
    /// (0 = valid immediately). Reverts like validation.
    function previewValidAfter(address account, uint256 maxCost) external view returns (uint48 validAfter) {
        AgentQuota storage a = _agents[account];
        if (!a.registered) revert NotRegistered(account);
        (validAfter,) = _admit(a, account, maxCost);
    }

    /// I14 deposit bound: the most the paymaster can sponsor over any window of `window` seconds
    /// = sum over registered agents of (burst + ratePerDay x window / 86400), rounded up.
    function maxSponsoredOver(uint256 window) external view returns (uint256) {
        return totalBurst + (totalRatePerDay * window + DAY - 1) / DAY;
    }

    function isStaked() external view returns (bool) {
        IStakeManager.DepositInfo memory info = entryPoint.getDepositInfo(address(this));
        return info.staked;
    }

    // ------------------------------------------------------------------ EntryPoint hooks

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        address sender = userOp.sender;
        AgentQuota storage a = _agents[sender];
        if (!a.registered) revert NotRegistered(sender);
        uint256 postOpGas = _checkGasCaps(userOp);
        (uint48 validAfter, uint256 needed) = _admit(a, sender, maxCost);
        a.pending = uint128(needed);
        context = abi.encode(sender, userOpHash, maxCost, postOpGas);
        // sigFailed = false, validUntil = 0 (no expiry), validAfter as computed (EntryPoint v0.8 layout).
        validationData = uint256(validAfter) << 208;
    }

    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        internal
        override
    {
        (address sender, bytes32 userOpHash, uint256 reserved, uint256 postOpGas) =
            abi.decode(context, (address, bytes32, uint256, uint256));
        uint256 charged =
            _settle(sender, reserved, actualGasCost + (postOpGas + POSTOP_OVERHEAD_GAS) * actualUserOpFeePerGas);
        emit GasSponsored(sender, userOpHash, reserved, charged, mode == PostOpMode.opSucceeded);
    }

    // ------------------------------------------------------------------ internals

    /// Release the hold and debit min(bound, reserved) from the bucket at the real block time.
    function _settle(address sender, uint256 reserved, uint256 bound) internal returns (uint256 charged) {
        charged = bound > reserved ? reserved : bound;
        AgentQuota storage a = _agents[sender];
        uint256 p = a.pending;
        a.pending = uint128(p > reserved ? p - reserved : 0);
        // available(now) >= the hold of this op >= charged, so this cannot fail unless the owner lowered
        // the quota mid-bundle; then the level is emptied.
        if (!a.quota.tryDebit(charged, block.timestamp)) a.quota.level = 0;
    }

    /// Admission without TIMESTAMP. stored level = level at lastRefill <= now, so the bucket holds at least
    /// `needed` from readyAt = lastRefill + ceil((needed - level) x DAY / rate) on (Buckets refill formula);
    /// return validAfter = readyAt - 1 because the EntryPoint requires block.timestamp > validAfter.
    function _admit(AgentQuota storage a, address sender, uint256 maxCost)
        internal
        view
        returns (uint48 validAfter, uint256 needed)
    {
        Bucket memory b = a.quota;
        needed = uint256(a.pending) + maxCost;
        if (needed > b.burst) revert QuotaExceeded(sender, needed, b.burst);
        if (needed > b.level) {
            if (b.ratePerDay == 0) revert QuotaExceeded(sender, needed, b.burst);
            uint256 dt = ((needed - b.level) * DAY + b.ratePerDay - 1) / b.ratePerDay;
            uint256 readyAt = uint256(b.lastRefill) + dt;
            validAfter = readyAt > type(uint48).max ? type(uint48).max : uint48(readyAt - 1);
        }
    }

    function _checkGasCaps(PackedUserOperation calldata op) internal view returns (uint256 postOpGas) {
        GasCaps memory c = _caps;
        (uint256 verificationGas, uint256 callGas) = UserOperationLib.unpackUints(op.accountGasLimits);
        uint256 maxFee = op.unpackMaxFeePerGas();
        uint256 pmVerificationGas = op.unpackPaymasterVerificationGasLimit();
        postOpGas = op.unpackPostOpGasLimit();
        _cap(F_MAX_FEE_PER_GAS, maxFee, c.maxFeePerGas);
        _cap(F_CALL_GAS, callGas, c.callGasLimit);
        _cap(F_VERIFICATION_GAS, verificationGas, c.verificationGasLimit);
        _cap(F_PRE_VERIFICATION_GAS, op.preVerificationGas, c.preVerificationGas);
        _cap(F_PM_VERIFICATION_GAS, pmVerificationGas, c.paymasterVerificationGasLimit);
        _cap(F_PM_POSTOP_GAS, postOpGas, c.paymasterPostOpGasLimit);
        if (postOpGas < MIN_POSTOP_GAS) revert PostOpGasTooLow(postOpGas, MIN_POSTOP_GAS);
    }

    function _cap(uint8 field, uint256 value, uint256 cap_) internal pure {
        if (value > cap_) revert GasFieldAboveCap(field, value, cap_);
    }

    function _setGasCaps(GasCaps memory caps_) internal {
        if (caps_.paymasterPostOpGasLimit < MIN_POSTOP_GAS) {
            revert PostOpGasTooLow(caps_.paymasterPostOpGasLimit, MIN_POSTOP_GAS);
        }
        _caps = caps_;
        emit GasCapsSet(caps_);
    }
}
