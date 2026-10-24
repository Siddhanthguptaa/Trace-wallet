// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {AccountStorage} from "./lib/AccountStorage.sol";
import {TypedData} from "./lib/TypedData.sol";
import {AgentCall, OpContext, Outflow, Tier, Track} from "./lib/PolicyTypes.sol";

/// @title AccountCommon: events, errors and storage helpers shared by AgentAccount (core +
///        modules) and AgentAccountAdmin (owner setters and views, reached by delegatecall).
abstract contract AccountCommon {
    // ---------------------------------------------------------------- events

    /// One per executed agent op (the decision log). `outflows` = measured (or declared) outflow.
    event Decision(
        bytes32 indexed userOpHash,
        address indexed agentKey,
        address indexed target,
        bytes4 selector,
        address payee,
        Tier tier,
        Track track,
        Outflow[] outflows
    );
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event PolicySet(
        address indexed agentKey, uint64 indexed sessionId, uint32 gen, uint192 nonceKey, uint48 validAfter, uint48 validUntil
    );
    event Revoked(address indexed agentKey, uint64 indexed sessionId);
    event KeyRotated(address indexed oldKey, address indexed newKey, uint64 indexed sessionId, uint192 nonceKey);
    event GasCreditSet(address indexed agentKey, uint128 gasCredit);
    event RecipientSet(address indexed recipient, bool listed);
    event GlobalCapSet(address indexed asset, uint128 burst, uint128 ratePerDay);
    event ExploreCapSet(address indexed asset, uint128 burst, uint128 ratePerDay);
    event ExplorePerTxCapSet(address indexed asset, uint128 cap);
    event Sig1271ModeSet(uint8 mode);
    event AttestorSet(address indexed attestor);
    event EpochBumped(uint64 epoch);
    event Flagged(address indexed payee, address indexed by);
    event Unflagged(address indexed payee);
    event TrackedSpendersSet(address[] spenders);
    event TrackedNFTsSet(address[] nfts);
    // ---- phase 2: execution sandbox, freeze, recovery, paymaster
    /// An agent op passed validation but was blocked in execution (policy breach or tripwire); its
    /// effects were undone by the inner frame. `reason` = the inner frame's revert data.
    event PolicyBlocked(
        bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, bytes reason
    );
    event AgentFrozen(address indexed agentKey, address indexed by, bytes32 userOpHash);
    event AgentUnfrozen(address indexed agentKey);
    event WatcherSet(address indexed watcher);
    event AgentPaymasterSet(address indexed paymaster);
    /// Owner replaced by social recovery: every agent key revoked, attestEpoch bumped.
    event RecoveryApplied(address indexed previousOwner, address indexed newOwner, uint64 attestEpoch);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotOwnerOrAttestor();
    error NotEntryPoint();
    error AlreadyInitialized();
    error BadAddress(address a);
    error OpenEndedKey(uint48 validAfter, uint48 validUntil);
    error UnknownKey(address agentKey);
    error KeyInUse(address agentKey);
    error AssetNoGlobalCap(address asset);
    error DuplicateEntry();
    error BadMode(uint8 mode);
    error AgentKeyActive(address a);
    /// An agent op failed a policy check in execution (reason code, see Reason).
    error PolicyViolation(uint16 reason);
    error OwnerOpKind(uint256 kind);
    /// A tripwire hook asked to freeze (stage 0 = before the call, 1 = after).
    error TripwireTripped(uint8 stage);
    /// The agent op's target call reverted (bubbled to the EntryPoint: success = false, no strike).
    error CallFailed(bytes returnData);
    error NotSelf();
    error InnerNotArmed();

    // ---------------------------------------------------------------- shared helpers

    function _l() internal pure returns (AccountStorage.Layout storage) {
        return AccountStorage.layout();
    }

    /// owner, or the account itself (an owner op calling an admin function).
    function _isOwnerCaller() internal view returns (bool) {
        return msg.sender == _l().owner || msg.sender == address(this);
    }

    /// Social-recovery owner change (the only owner change besides the owner's own
    /// transferOwnership): new owner, every session key revoked, attestEpoch bumped.
    /// Called by RecoveryModule.executeRecovery only.
    function _applyRecovery(address newOwner) internal {
        AccountStorage.Layout storage l = _l();
        if (newOwner == address(0) || newOwner == address(this) || l.keyToSession[newOwner] != 0) {
            revert BadAddress(newOwner);
        }
        uint64 n = l.nextSessionId;
        for (uint64 sid = 1; sid <= n; ++sid) {
            l.sessions[sid].revoked = true;
        }
        address prev = l.owner;
        l.owner = newOwner;
        uint64 epoch = ++l.attestEpoch;
        emit OwnerChanged(prev, newOwner);
        emit RecoveryApplied(prev, newOwner, epoch);
    }

    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.execlock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant EXEC_LOCK_SLOT = 0xb39352720d31c5c3fc46f7b27ae6cecf8348a51a132053381a3c496287997900;

    /// True while an agent op executes (transient storage). isValidSignature then refuses everything (I3).
    function _isAgentExecuting() internal view returns (bool on) {
        bytes32 slot = EXEC_LOCK_SLOT;
        assembly ("memory-safe") {
            on := tload(slot)
        }
    }

    function _setAgentExecuting(bool on) internal {
        bytes32 slot = EXEC_LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, on)
        }
    }

    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.innerarm")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant INNER_ARM_SLOT = 0x04445b0e1d6e8c4774aa4b6b13323a9f6d5b1f478428d77a8952febefd674900;

    /// One-shot permission for the sandbox's inner self-call (transient).
    function _setInnerArmed(bool on) internal {
        bytes32 slot = INNER_ARM_SLOT;
        assembly ("memory-safe") {
            tstore(slot, on)
        }
    }

    function _isInnerArmed() internal view returns (bool on) {
        bytes32 slot = INNER_ARM_SLOT;
        assembly ("memory-safe") {
            on := tload(slot)
        }
    }
}

/// @title AgentAccountBase: shared base of AgentAccount and its four modules.
/// @notice CORE-owned. Declares every module hook (abstract, `internal virtual`); each hook is
///         implemented by exactly one module file, so lanes D2 / D1 / D3 / APPC edit only their
///         own module. Hook call points are fixed in AgentAccount (docs/api.md section 3):
///
///   validateUserOp (agent role, no TIMESTAMP, view hooks only):
///     PolicyCheck.checkCall -> [kind != CALL] _doorDecodeOp -> [approval] _approvalValidate
///     | [no approval] _tierOf -> PolicyCheck.checkPerTx -> checkNonceKey -> checkGas -> credit debit
///   executeUserOp (agent role; agent-execution lock held), sandboxed:
///     outer frame: re-run the same checks (+ _freezeReason) -> try this.agentInnerExecute(...)
///       inner frame (onlySelf, one-shot armed): _preCallTripwire -> [approval] _approvalBefore ->
///         CALL: _meterBefore -> call -> _meterAfter | VOUCHER: _doorExecuteOp -> _meterDebitDeclared
///         -> [approval] _approvalAfter -> _postCallTripwire
///     ok: emit Decision | target call failed: bubble (success=false) |
///     policy breach / tripwire: _onBlocked (strike) -> [freeze] _freezeKey + AgentFrozen ->
///     emit PolicyBlocked, return normally (state persists, the spend is undone)
///   isValidSignature: lock held -> 0xffffffff, else _door1271
abstract contract AgentAccountBase is AccountCommon, EIP712 {
    constructor() EIP712(TypedData.NAME, TypedData.VERSION) {}

    /// EntryPoint address (implemented by AgentAccount).
    function _entryPointAddress() internal view virtual returns (address);

    function _hashTyped(bytes32 structHash) internal view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }

    // ---------------------------------------------------------------- hooks: FreezeModule (lane FRZ)

    /// Validation + execution re-check: FROZEN if the session key is frozen. View, no TIMESTAMP.
    function _freezeReason(OpContext memory ctx) internal view virtual returns (uint16 reason);

    /// Inner frame, before the call: return true to trip (the op is undone and the key frozen).
    function _preCallTripwire(OpContext memory ctx, AgentCall memory call) internal virtual returns (bool trip);

    /// Inner frame, after metering: return true to trip (the op is undone and the key frozen).
    function _postCallTripwire(OpContext memory ctx, AgentCall memory call, Outflow[] memory outflows)
        internal
        virtual
        returns (bool trip);

    /// Outer frame, after the inner frame reverted with a policy breach (`tripped` = a tripwire fired):
    /// record a strike; return true to freeze the key now.
    function _onBlocked(OpContext memory ctx, bytes memory reason, bool tripped) internal virtual returns (bool freezeNow);

    /// Outer frame: persist the freeze of `agentKey`.
    function _freezeKey(address agentKey) internal virtual;

    // ---------------------------------------------------------------- hooks: PayeeTierModule (D3, M4)

    /// Tier of the op's payee. Called in validation AND execution with the same bytes, so it must
    /// be a pure function of (call, attestation, own storage); never reads TIMESTAMP.
    /// reason != OK refuses the op on the normal path (an owner approval may still carry it).
    /// validUntil = attestation expiry folded into validationData (type(uint48).max if none).
    function _tierOf(OpContext memory ctx, AgentCall memory call, bytes memory attestation)
        internal
        view
        virtual
        returns (Tier tier, uint16 reason, uint48 validUntil);

    // ---------------------------------------------------------------- hooks: MeterModule (D2, M2)

    /// Execution, before the one call: snapshot what the meter needs (opaque bytes).
    function _meterBefore(OpContext memory ctx, AgentCall memory call) internal virtual returns (bytes memory snapshot);

    /// Execution, after the call: measure outflow and allowance growth, check per-tx / key / global
    /// (and exploration if ctx.track == EXPLORE) caps, debit, revert on breach. Returns measured outflows.
    function _meterAfter(OpContext memory ctx, AgentCall memory call, bytes memory snapshot)
        internal
        virtual
        returns (Outflow[] memory outflows);

    /// Execution: debit a declared amount with no call (voucher registration). Revert on breach.
    function _meterDebitDeclared(OpContext memory ctx, address asset, uint256 amount) internal virtual;

    /// Credit a declared amount back (voucher reclaim), never above burst.
    function _meterCredit(uint64 sessionId, Track track, address asset, uint256 amount) internal virtual;

    // ---------------------------------------------------------------- hooks: OneDoorModule (D1, M3)

    /// ERC-1271 when no agent op is executing (the core already refuses during execution).
    function _door1271(bytes32 hash, bytes calldata signature) internal view virtual returns (bytes4);

    /// Validation + execution: decode a non-CALL agent op (REGISTER_VOUCHER) into `call`
    /// (payee, payAsset, payAmount, hasPayee). Return a reason; never reads TIMESTAMP.
    function _doorDecodeOp(OpContext memory ctx, AgentCall memory call) internal view virtual returns (uint16 reason);

    /// Execution of a non-CALL agent op (register the voucher). The core then debits
    /// call.payAmount of call.payAsset through _meterDebitDeclared.
    function _doorExecuteOp(OpContext memory ctx, AgentCall memory call) internal virtual;

    // ---------------------------------------------------------------- hooks: ApprovalModule (APPC, M5)

    /// Validation (only when the approval slot is non-empty): check the owner's OutcomeApproval
    /// against ctx.callDataHash / call. Never reads TIMESTAMP; returns its validUntil.
    function _approvalValidate(OpContext memory ctx, AgentCall memory call, bytes memory approval)
        internal
        view
        virtual
        returns (uint16 reason, uint48 validUntil);

    /// Execution, before the call (approval ops only): e.g. consume the approval nonce.
    function _approvalBefore(OpContext memory ctx, AgentCall memory call, bytes memory approval)
        internal
        virtual
        returns (bytes memory state);

    /// Execution, after the call (approval ops only): enforce maxOutflow on the measured outflows,
    /// revert on breach, emit ApprovedExecuted.
    function _approvalAfter(
        OpContext memory ctx,
        AgentCall memory call,
        bytes memory approval,
        bytes memory state,
        Outflow[] memory outflows
    ) internal virtual;
}
