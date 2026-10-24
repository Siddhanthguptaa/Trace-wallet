// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgentAccountBase} from "../AgentAccountBase.sol";
import {TypedData} from "../lib/TypedData.sol";
import {AccountStorage} from "../lib/AccountStorage.sol";
import {AgentCall, OpContext, Outflow, Reason} from "../lib/PolicyTypes.sol";

/// @title ApprovalLib: the OutcomeApproval logic, an EXTERNAL linked library (EIP-170 budget).
/// @notice Reached only by DELEGATECALL from the account (Solidity external library calls), so
///         `address(this)`, storage and emitted events are the account's. Deploy it once per chain
///         and link it into AgentAccount (forge links automatically in tests and scripts; viem /
///         hand deploys must replace the `__$...$__` placeholder). Semantics: see ApprovalModule.
library ApprovalLib {
    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.approval")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xef8735f5bc79a62329e83666e1f010327e85446f0af8dda503c2cdd6acd48c00;

    /// @custom:storage-location erc7201:hypnexis.AgentAccount.approval
    struct Layout {
        uint256 version;
        mapping(uint256 => bool) used; // OutcomeApproval nonces executed or cancelled
    }

    /// approvalHash = the EIP-712 digest the owner signed; outflow = measured outflow of the op.
    event ApprovedExecuted(bytes32 indexed approvalHash, address indexed payee, Outflow[] outflow);

    /// Measured outflow of `asset` (summed over the op) above the owner's maxOutflow for it.
    error ApprovalOutflowExceeded(address asset, uint256 outflow, uint256 maxOutflow);
    /// Same selector as AccountCommon.PolicyViolation.
    error PolicyViolation(uint16 reason);

    function store() internal pure returns (Layout storage $) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _decode(bytes calldata approval)
        private
        view
        returns (TypedData.OutcomeApproval memory a, bytes32 digest, bytes memory sig)
    {
        (a, sig) = abi.decode(approval, (TypedData.OutcomeApproval, bytes));
        // Same digest as the account's EIP712._hashTypedDataV4 (domain {"AgentAccount","1",chainid,this}).
        digest = TypedData.digest(
            TypedData.domainSeparator(block.chainid, address(this)), TypedData.hashOutcomeApproval(a)
        );
    }

    /// Validation (view, no TIMESTAMP). Returns (APPROVAL, 0) on any mismatch.
    function validate(bytes calldata approval, bytes32 callDataHash, address target, bytes4 selector, address payee)
        external
        view
        returns (uint16, uint48)
    {
        (TypedData.OutcomeApproval memory a, bytes32 digest, bytes memory sig) = _decode(approval);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (
            err != ECDSA.RecoverError.NoError || signer != AccountStorage.layout().owner || a.account != address(this)
                || a.chainId != block.chainid || a.target != target || a.selector != selector || a.payee != payee
                || a.callDataHash != callDataHash || a.validUntil == 0 || store().used[a.nonce]
        ) return (Reason.APPROVAL, 0);
        return (Reason.OK, a.validUntil);
    }

    /// Execution, before the call: consume the nonce (a same-bundle replay reverts here).
    function consume(bytes calldata approval) external {
        (TypedData.OutcomeApproval memory a,,) = _decode(approval);
        Layout storage $ = store();
        if ($.used[a.nonce]) revert PolicyViolation(Reason.APPROVAL);
        $.used[a.nonce] = true;
    }

    /// Execution, after metering: measured outflow per asset (summed) <= maxOutflow[asset]
    /// (missing asset = 0; duplicate entries: the smallest counts); then ApprovedExecuted.
    function settle(bytes calldata approval, address payee, Outflow[] calldata outflows) external {
        (TypedData.OutcomeApproval memory a, bytes32 digest,) = _decode(approval);
        TypedData.AssetAmount[] memory m = a.maxOutflow;
        uint256 n = outflows.length;
        for (uint256 i; i < n; ++i) {
            address asset = outflows[i].asset;
            bool seen;
            for (uint256 k; k < i; ++k) {
                if (outflows[k].asset == asset) seen = true;
            }
            if (seen) continue;
            uint256 total;
            for (uint256 k = i; k < n; ++k) {
                if (outflows[k].asset == asset) total += outflows[k].amount;
            }
            uint256 cap = type(uint256).max;
            bool listed;
            for (uint256 j; j < m.length; ++j) {
                if (m[j].asset == asset) {
                    listed = true;
                    if (m[j].amount < cap) cap = m[j].amount;
                }
            }
            if (!listed) cap = 0;
            if (total > cap) revert ApprovalOutflowExceeded(asset, total, cap);
        }
        emit ApprovedExecuted(digest, payee, outflows);
    }
}

/// @title ApprovalModule (lane APPC / M5 contract part): owner OutcomeApprovals.
/// @notice An agent op on nonce lane 1 carries `approval = abi.encode(TypedData.OutcomeApproval a,
///         bytes ownerSig)` in the approval slot of userOp.signature (docs/api.md 4.2 / 4.4).
///         Validation (view, no TIMESTAMP): ownerSig is the owner's raw ECDSA signature over the
///         EIP-712 digest of `a` in the account's domain {"AgentAccount","1",chainid,this};
///         a.account == this; a.chainId == block.chainid; a.target / a.selector / a.payee equal
///         the decoded call (payee = the PAYEE-rule argument or voucher `to`, else address(0));
///         a.callDataHash == keccak256(userOp.callData); a.validUntil != 0 (returned and folded
///         into validationData, so the EntryPoint enforces expiry; 0 would mean "forever");
///         a.nonce not used. Malformed approval bytes revert (AA23), like a malformed envelope.
///         Execution (sandbox inner frame): the nonce is consumed before the call; after metering
///         the measured outflow, summed per asset, must be <= the owner's maxOutflow for that
///         asset, else `ApprovalOutflowExceeded` reverts the inner frame, which undoes the spend
///         and the nonce use (success = true + PolicyBlocked). On success: ApprovedExecuted.
///         The approval path waives tier refusals and per-tx caps only; TARGET / ARG_RULE /
///         RECIPIENT rule checks, REVOKED and FROZEN still apply (core).
///         `a.nonce` is an owner-chosen single-use id (not the EntryPoint nonce); it is spent only
///         when the approved op executes, or by `cancelApproval`. Logic lives in ApprovalLib.
abstract contract ApprovalModule is AgentAccountBase {
    /// Same signature as ApprovalLib.ApprovedExecuted (emitted from the account by the library).
    event ApprovedExecuted(bytes32 indexed approvalHash, address indexed payee, Outflow[] outflow);
    event ApprovalCancelled(uint256 indexed nonce);

    error ApprovalOutflowExceeded(address asset, uint256 outflow, uint256 maxOutflow);

    /// ERC-7201 namespace (docs/api.md section 6); layout = ApprovalLib.Layout.
    bytes32 internal constant APPROVAL_SLOT = ApprovalLib.SLOT;

    function _approvalStorage() internal pure returns (ApprovalLib.Layout storage) {
        return ApprovalLib.store();
    }

    /// True once an OutcomeApproval nonce was executed or cancelled.
    function approvalNonceUsed(uint256 nonce) external view returns (bool) {
        return ApprovalLib.store().used[nonce];
    }

    /// Owner kill switch for one signed approval (burns its nonce).
    function cancelApproval(uint256 nonce) external {
        if (!_isOwnerCaller()) revert NotOwner();
        ApprovalLib.store().used[nonce] = true;
        emit ApprovalCancelled(nonce);
    }

    function _approvalValidate(OpContext memory ctx, AgentCall memory call, bytes memory approval)
        internal
        view
        virtual
        override
        returns (uint16 reason, uint48 validUntil)
    {
        return ApprovalLib.validate(approval, ctx.callDataHash, call.target, call.selector, call.payee);
    }

    function _approvalBefore(OpContext memory, AgentCall memory, bytes memory approval)
        internal
        virtual
        override
        returns (bytes memory)
    {
        ApprovalLib.consume(approval);
        return "";
    }

    function _approvalAfter(
        OpContext memory,
        AgentCall memory call,
        bytes memory approval,
        bytes memory,
        Outflow[] memory outflows
    ) internal virtual override {
        ApprovalLib.settle(approval, call.payee, outflows);
    }
}
