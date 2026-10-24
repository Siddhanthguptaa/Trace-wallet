// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {
    SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS, _packValidationData
} from "account-abstraction/core/Helpers.sol";

import {AgentAccountBase} from "./AgentAccountBase.sol";
import {MeterModule} from "./modules/MeterModule.sol";
import {OneDoorModule} from "./modules/OneDoorModule.sol";
import {PayeeTierModule} from "./modules/PayeeTierModule.sol";
import {ApprovalModule} from "./modules/ApprovalModule.sol";
import {FreezeModule} from "./modules/FreezeModule.sol";
import {AccountStorage} from "./lib/AccountStorage.sol";
import {PolicyCheck} from "./lib/PolicyCheck.sol";
import {
    AgentCall,
    OpContext,
    Outflow,
    OpKind,
    Tier,
    Track,
    Reason,
    Session,
    ERC1271_INVALID,
    ROLE_OWNER,
    ROLE_AGENT
} from "./lib/PolicyTypes.sol";

/// @title AgentAccount: ERC-4337 (EntryPoint v0.8) wallet whose agent key spends only within the
///        owner's policy (Hypnexis W3-02). See docs/api.md for the full contract surface.
/// @notice SimpleAccount-style owner (OZ ECDSA) plus session keys with a declarative Policy
///         (IDEA.md 7.1). The agent path is one policy-checked call through `executeUserOp`.
///         Five modules (Meter D2, OneDoor D1, PayeeTier D3, Approval M5, Freeze FRZ) plug in at
///         fixed hook points (AgentAccountBase). Agent execution runs in a sandbox: an outer frame
///         that persists strikes / freezes / events, and an inner self-call frame (call + metering)
///         that reverts on a policy breach or tripwire. Owner setters and views live in AgentAccountAdmin, reached
///         through this contract's fallback by DELEGATECALL (same storage, same msg.sender).
///         Deployed as an EIP-1167 clone by AgentAccountFactory.
contract AgentAccount is
    BaseAccount,
    IAccountExecute,
    IERC1271,
    MeterModule,
    OneDoorModule,
    PayeeTierModule,
    ApprovalModule,
    FreezeModule
{
    IEntryPoint private immutable _entryPoint;
    /// AgentAccountAdmin logic (owner setters + views), reached via `fallback` DELEGATECALL.
    address public immutable admin;

    /// The implementation is locked at construction; clones are initialized by the factory.
    constructor(IEntryPoint anEntryPoint, address admin_) {
        _entryPoint = anEntryPoint;
        admin = admin_;
        _l().initialized = true;
    }

    function initialize(address anOwner) external {
        AccountStorage.Layout storage l = _l();
        if (l.initialized) revert AlreadyInitialized();
        if (anOwner == address(0) || anOwner == address(this)) revert BadAddress(anOwner);
        l.initialized = true;
        l.owner = anOwner;
        l.attestEpoch = 1;
        emit OwnerChanged(address(0), anOwner);
    }

    receive() external payable {}

    /// Every selector not implemented here goes to AgentAccountAdmin (owner setters and views).
    fallback() external payable {
        address impl = admin;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    // ================================================================ ERC-4337

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    function _entryPointAddress() internal view override returns (address) {
        return address(_entryPoint);
    }

    /// Owner ops may use execute / executeBatch; agent ops are forced through executeUserOp.
    function _requireForExecute() internal view override {
        if (msg.sender != address(_entryPoint) && msg.sender != _l().owner) revert NotOwner();
    }

    /// Signature envelope parts (docs/api.md 4.2).
    struct SigParts {
        uint256 role;
        bytes sig;
        bytes attestation;
        bytes approval;
    }

    /// Validation result (kept in memory to stay under the stack limit).
    struct VResult {
        uint16 reason;
        uint64 sid;
        uint256 maxCost;
        uint48 validAfter;
        uint48 validUntil;
    }

    /// A raw 65-byte owner signature, or abi.encode(uint8 role, bytes sig, bytes attestation, bytes approval).
    function _decodeSig(bytes calldata s) internal pure returns (SigParts memory p) {
        if (s.length == 65) {
            p.role = ROLE_OWNER;
            p.sig = s;
            return p;
        }
        (p.role, p.sig, p.attestation, p.approval) = abi.decode(s, (uint256, bytes, bytes, bytes));
    }

    function _recoverOk(bytes32 hash, bytes memory sig) internal pure returns (address) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return err == ECDSA.RecoverError.NoError ? signer : address(0);
    }

    function _isOwnerSig(bytes32 hash, bytes memory sig) internal view returns (bool) {
        address signer = _recoverOk(hash, sig);
        return signer != address(0) && signer == _l().owner;
    }

    /// The agent policy: core checks + module hooks. View; no TIMESTAMP. Shared by validation,
    /// execution (re-check) and the `policyCheck` view used by the checkPolicy lens.
    /// `ctx` must carry agentKey and userOpHash; the rest of it is filled here.
    function _checkAgentOp(OpContext memory ctx, bytes calldata callData, bytes memory attestation, bytes memory approval)
        internal
        view
        returns (uint16 reason, AgentCall memory call, uint48 validUntil)
    {
        AccountStorage.Layout storage l = _l();
        ctx.sessionId = l.keyToSession[ctx.agentKey];
        ctx.callDataHash = keccak256(callData);
        ctx.hasApproval = approval.length != 0;

        (reason, call) = PolicyCheck.checkCall(l, ctx.sessionId, callData, address(this), address(_entryPoint));
        if (reason == Reason.OK) reason = _freezeReason(ctx);
        if (reason != Reason.OK) return (reason, call, 0);
        if (call.kind != OpKind.CALL) {
            reason = _doorDecodeOp(ctx, call);
            if (reason != Reason.OK) return (reason, call, 0);
        }
        validUntil = l.sessions[ctx.sessionId].validUntil;
        uint48 hookUntil;
        if (ctx.hasApproval) {
            // Owner approval path: the owner's signed maxOutflow replaces tier refusals and per-tx caps.
            (ctx.tier,,) = _tierOf(ctx, call, attestation);
            (reason, hookUntil) = _approvalValidate(ctx, call, approval);
            ctx.track = Track.APPROVAL;
        } else {
            (ctx.tier, reason, hookUntil) = _tierOf(ctx, call, attestation);
            ctx.track = ctx.tier == Tier.UNPROVEN ? Track.EXPLORE : Track.NORMAL;
            if (reason == Reason.OK) reason = PolicyCheck.checkPerTx(l, ctx.sessionId, call);
        }
        if (hookUntil < validUntil) validUntil = hookUntil;
    }

    /// Full agent validation without side effects (order: session, REVOKED, NONCE_KEY, policy, gas).
    function _validateAgent(PackedUserOperation calldata userOp, bytes32 userOpHash, SigParts memory p)
        internal
        view
        returns (VResult memory r)
    {
        OpContext memory ctx;
        ctx.agentKey = _recoverOk(userOpHash, p.sig);
        ctx.userOpHash = userOpHash;
        AccountStorage.Layout storage l = _l();
        r.sid = ctx.agentKey == address(0) ? 0 : l.keyToSession[ctx.agentKey];
        if (r.sid == 0) {
            r.reason = Reason.NO_SESSION;
            return r;
        }
        Session storage s = l.sessions[r.sid];
        if (s.revoked) {
            r.reason = Reason.REVOKED;
            return r;
        }
        r.reason = PolicyCheck.checkNonceKey(s, userOp.nonce, p.approval.length != 0);
        if (r.reason != Reason.OK) return r;
        (r.reason,, r.validUntil) = _checkAgentOp(ctx, userOp.callData, p.attestation, p.approval);
        if (r.reason != Reason.OK) return r;
        (r.reason, r.maxCost) = PolicyCheck.checkGas(s.gas, userOp, l.agentPaymaster);
        r.validAfter = s.validAfter;
    }

    /// BaseAccount hook: the whole validation (owner or agent). Agent ops debit the gas credit.
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        override
        returns (uint256 validationData)
    {
        SigParts memory p = _decodeSig(userOp.signature);
        if (p.role == ROLE_OWNER) return _isOwnerSig(userOpHash, p.sig) ? SIG_VALIDATION_SUCCESS : SIG_VALIDATION_FAILED;
        if (p.role != ROLE_AGENT) return SIG_VALIDATION_FAILED;
        VResult memory r = _validateAgent(userOp, userOpHash, p);
        if (r.reason != Reason.OK) return SIG_VALIDATION_FAILED;
        _l().sessions[r.sid].gas.gasCredit -= uint128(r.maxCost);
        return _packValidationData(false, r.validUntil, r.validAfter);
    }

    /// Execution entry for agent ops (and owner ops using the same encoding). Agent ops run in the
    /// sandbox: this outer frame persists strikes, freezes and events; the call and its metering
    /// run in the inner self-call frame, which reverts (undoing the spend) on a policy breach.
    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external override {
        _requireFromEntryPoint();
        SigParts memory p = _decodeSig(userOp.signature);
        if (p.role == ROLE_OWNER) {
            _ownerExecute(userOp.callData);
            return;
        }
        OpContext memory ctx;
        ctx.agentKey = _recoverOk(userOpHash, p.sig);
        ctx.userOpHash = userOpHash;
        (uint16 reason, AgentCall memory call,) = _checkAgentOp(ctx, userOp.callData, p.attestation, p.approval);
        _setAgentExecuting(true);
        if (reason != Reason.OK) {
            _blocked(ctx, call, abi.encodeWithSelector(PolicyViolation.selector, reason), false);
        } else {
            _setInnerArmed(true);
            try this.agentInnerExecute(ctx, call, p.approval) returns (Outflow[] memory outflows) {
                emit Decision(
                    ctx.userOpHash, ctx.agentKey, call.target, call.selector, call.payee, ctx.tier, ctx.track, outflows
                );
            } catch (bytes memory err) {
                _setInnerArmed(false);
                bytes4 sel = bytes4(err);
                if (sel == CallFailed.selector) {
                    // The target itself reverted: not a policy event. Bubble it (success = false).
                    assembly ("memory-safe") {
                        revert(add(err, 0x64), mload(add(err, 0x44)))
                    }
                }
                _blocked(ctx, call, err, sel == TripwireTripped.selector);
            }
        }
        _setAgentExecuting(false);
    }

    /// Outer frame bookkeeping for a blocked op: strike, optional freeze, events. Returns normally.
    function _blocked(OpContext memory ctx, AgentCall memory call, bytes memory err, bool tripped) internal {
        if (ctx.sessionId != 0 && _onBlocked(ctx, err, tripped)) {
            _freezeKey(ctx.agentKey);
            emit AgentFrozen(ctx.agentKey, address(this), ctx.userOpHash);
        }
        emit PolicyBlocked(ctx.userOpHash, ctx.agentKey, call.target, call.selector, err);
    }

    /// Inner frame of the sandbox. Only the account itself, only while armed by executeUserOp, once.
    function agentInnerExecute(OpContext memory ctx, AgentCall memory call, bytes memory approval)
        external
        returns (Outflow[] memory outflows)
    {
        if (msg.sender != address(this)) revert NotSelf();
        if (!_isInnerArmed()) revert InnerNotArmed();
        _setInnerArmed(false);
        if (_preCallTripwire(ctx, call)) revert TripwireTripped(0);
        bytes memory approvalState;
        if (ctx.hasApproval) approvalState = _approvalBefore(ctx, call, approval);
        if (call.kind == OpKind.CALL) {
            bytes memory snapshot = _meterBefore(ctx, call);
            (bool ok, bytes memory ret) = call.target.call{value: call.value}(call.data);
            if (!ok) revert CallFailed(ret);
            outflows = _meterAfter(ctx, call, snapshot);
        } else {
            _doorExecuteOp(ctx, call);
            _meterDebitDeclared(ctx, call.payAsset, call.payAmount);
            outflows = new Outflow[](1);
            outflows[0] = Outflow(call.payAsset, call.payAmount);
        }
        if (ctx.hasApproval) _approvalAfter(ctx, call, approval, approvalState, outflows);
        if (_postCallTripwire(ctx, call, outflows)) revert TripwireTripped(1);
    }

    function _ownerExecute(bytes calldata callData) internal {
        (uint256 kind, address target, uint256 value, bytes memory data) =
            abi.decode(callData[4:], (uint256, address, uint256, bytes));
        if (kind != uint256(OpKind.CALL)) revert OwnerOpKind(kind);
        _call(target, value, data);
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    // ================================================================ ERC-1271 (one door)

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        if (_isAgentExecuting()) return ERC1271_INVALID;
        return _door1271(hash, signature);
    }

    /// Validation-equivalent agent policy check (no time, no nonce, no gas): the base of the M5
    /// checkPolicy lens. reason = Reason code (OK = 0); track / tier as the op would be charged.
    function policyCheck(address agentKey, bytes calldata callData, bytes calldata attestation, bytes calldata approval)
        external
        view
        returns (uint16 reason, Tier tier, Track track, uint48 validUntil)
    {
        OpContext memory ctx;
        ctx.agentKey = agentKey;
        (reason,, validUntil) = _checkAgentOp(ctx, callData, attestation, approval);
        return (reason, ctx.tier, ctx.track, validUntil);
    }

    /// Full validation preview of a UserOp (no gas-credit debit). Owner ops return OK or NO_SESSION.
    function checkUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        view
        returns (uint16 reason, uint48 validAfter, uint48 validUntil)
    {
        SigParts memory p = _decodeSig(userOp.signature);
        if (p.role == ROLE_OWNER) return (_isOwnerSig(userOpHash, p.sig) ? Reason.OK : Reason.NO_SESSION, 0, 0);
        if (p.role != ROLE_AGENT) return (Reason.NO_SESSION, 0, 0);
        VResult memory r = _validateAgent(userOp, userOpHash, p);
        return (r.reason, r.validAfter, r.validUntil);
    }

    // ================================================================ token receivers

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}
