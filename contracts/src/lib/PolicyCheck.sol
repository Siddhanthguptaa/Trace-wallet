// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {
    AgentCall,
    OpKind,
    Session,
    GasPolicy,
    AssetLimit,
    RuleSet,
    Reason,
    NATIVE,
    ANY_TARGET,
    LANE_NORMAL,
    LANE_APPROVAL
} from "./PolicyTypes.sol";
import {AccountStorage} from "./AccountStorage.sol";
import {ArgRules} from "./ArgRules.sol";

/// @title PolicyCheck: the one agent policy check (BUILD M1, IDEA 7.1).
/// @notice Bounded and side-effect free. Reads calldata and the account's own storage only and
///         never reads TIMESTAMP [E2], so validateUserOp may use it. executeUserOp re-runs it
///         (so a revoke or rule change between validation and execution still bites), and the
///         checkPolicy lens (M5) and the proof layer (M9) build on the same functions.
///
///         Agent op encoding (userOp.callData):
///           executeUserOp.selector ++ abi.encode(uint8 kind, address target, uint256 value, bytes data)
///
///         Check order (first failure wins): session -> REVOKED -> op shape (OP_SHAPE) ->
///         (target, selector) rule (TARGET) -> argument rules (ARG_RULE(i) / RECIPIENT(i) / FLAGGED(i)).
///         Then the account runs the module hooks (tier, approval) and `checkPerTx`
///         (ASSET / PER_TX), then, in validation only, `checkNonceKey` and `checkGas`.
library PolicyCheck {
    using AccountStorage for AccountStorage.Layout;

    uint256 internal constant HEAD = 4 + 4 * 32; // selector + (kind, target, value, data offset)

    /// Decode the agent op body. Never reverts on short input; may revert on a malformed `data` offset.
    function decode(bytes calldata callData) internal pure returns (uint16 reason, AgentCall memory call) {
        if (callData.length < HEAD || bytes4(callData[:4]) != ArgRules.EXECUTE_USER_OP) {
            return (Reason.OP_SHAPE, call);
        }
        uint256 kind = uint256(bytes32(callData[4:36]));
        uint256 targetWord = uint256(bytes32(callData[36:68]));
        if (kind > uint256(type(OpKind).max) || targetWord >> 160 != 0) return (Reason.OP_SHAPE, call);
        (,, uint256 value, bytes memory data) = abi.decode(callData[4:], (uint256, address, uint256, bytes));
        call.kind = OpKind(kind);
        call.target = address(uint160(targetWord));
        call.value = value;
        call.data = data;
        if (data.length >= 4) {
            call.selector = bytes4(data);
        } else if (data.length != 0) {
            return (Reason.OP_SHAPE, call);
        }
        return (Reason.OK, call);
    }

    /// Session, shape, rule and argument-rule checks for session `sid`.
    /// For kind REGISTER_VOUCHER only the session and shape are checked here; OneDoorModule decodes the rest.
    function checkCall(AccountStorage.Layout storage l, uint64 sid, bytes calldata callData, address self, address ep)
        internal
        view
        returns (uint16 reason, AgentCall memory call)
    {
        (reason, call) = decode(callData); // decoded first so a refusal can still name the call
        if (sid == 0) return (Reason.NO_SESSION, call);
        if (l.sessions[sid].revoked) return (Reason.REVOKED, call);
        if (reason != Reason.OK || call.kind != OpKind.CALL) return (reason, call);

        // Single call to a non-self, non-EntryPoint target; no nested account execution.
        if (call.target == self || call.target == ep || ArgRules.isExecSelector(call.selector)) {
            return (Reason.OP_SHAPE, call);
        }
        RuleSet storage rs = l.ruleSet(sid, call.target, call.selector);
        if (!rs.allowed) {
            // Plain value send to any target, if the owner allowed native value to a payee.
            if (call.selector == bytes4(0) && call.data.length == 0) rs = l.ruleSet(sid, ANY_TARGET, bytes4(0));
            if (!rs.allowed) return (Reason.TARGET, call);
        }
        return (evalRules(l, rs, call, self), call);
    }

    /// Every argument rule of the entry must hold; records the PAYEE argument in `call`.
    function evalRules(AccountStorage.Layout storage l, RuleSet storage rs, AgentCall memory call, address self)
        internal
        view
        returns (uint16)
    {
        uint256 n = rs.rules.length;
        for (uint256 i; i < n; ++i) {
            (uint16 rr, bool isPayee, address payee) = ArgRules.eval(l, rs.rules[i], i, call.target, call.data, self);
            if (rr != Reason.OK) return rr;
            if (isPayee) {
                call.hasPayee = true;
                call.payee = payee;
            }
        }
        return Reason.OK;
    }

    /// Decoded per-tx early reject (IDEA 7.1 `assets[asset].perTxCap`, V). Also fills
    /// call.payAsset / call.payAmount for CALL ops (transfer / approve / increaseAllowance amount,
    /// else native value). For module-decoded ops (vouchers) the module fills them first.
    function checkPerTx(AccountStorage.Layout storage l, uint64 sid, AgentCall memory call)
        internal
        view
        returns (uint16)
    {
        if (call.value > 0) {
            AssetLimit storage n = l.keyAsset(sid, NATIVE);
            if (!n.enabled) return Reason.ASSET;
            if (call.value > n.perTxCap) return Reason.PER_TX;
        }
        if (call.kind != OpKind.CALL) {
            AssetLimit storage v = l.keyAsset(sid, call.payAsset);
            if (!v.enabled) return Reason.ASSET;
            if (call.payAmount > v.perTxCap) return Reason.PER_TX;
            return Reason.OK;
        }
        bytes4 sel = call.selector;
        if (sel == ArgRules.TRANSFER || sel == ArgRules.APPROVE || sel == ArgRules.INCREASE_ALLOWANCE) {
            (bool ok, uint256 amount) = ArgRules.word(call.data, 1);
            if (!ok) return Reason.OP_SHAPE;
            AssetLimit storage a = l.keyAsset(sid, call.target);
            if (a.enabled) {
                if (amount > a.perTxCap) return Reason.PER_TX;
                call.payAsset = call.target;
                call.payAmount = amount;
            } else if (sel == ArgRules.TRANSFER) {
                return Reason.ASSET; // asset absent = not spendable
            }
            // approve / increaseAllowance on a non-asset contract (e.g. an ERC-721 approve):
            // allowed only through its binding rule (spender EQ_SELF / IN_RECIPIENTS).
        } else if (call.value > 0) {
            call.payAsset = NATIVE;
            call.payAmount = call.value;
        }
        return Reason.OK;
    }

    /// The nonce key must be this session's, in the lane that matches the op
    /// (LANE_APPROVAL iff the approval slot is non-empty).
    function checkNonceKey(Session storage s, uint256 nonce, bool hasApproval) internal view returns (uint16) {
        uint192 key = uint192(nonce >> 64);
        if (key & ~uint192(0xff) != s.nonceKey) return Reason.NONCE_KEY;
        uint8 lane = uint8(key);
        if (lane != (hasApproval ? LANE_APPROVAL : LANE_NORMAL)) return Reason.NONCE_KEY;
        return Reason.OK;
    }

    /// Per-op gas caps and the gas credit (IDEA 7.1 `gas`, V). A paymaster is allowed only if it is
    /// the owner-set `agentPaymaster` (PAYMASTER otherwise). maxCost = the op's maximum gas cost
    /// (paymaster gas limits included), which validation debits from the credit.
    function checkGas(GasPolicy memory g, PackedUserOperation calldata op, address agentPaymaster)
        internal
        pure
        returns (uint16 reason, uint256 maxCost)
    {
        uint256 pmGas;
        bytes calldata pmd = op.paymasterAndData;
        if (pmd.length != 0) {
            if (agentPaymaster == address(0) || pmd.length < 52 || address(bytes20(pmd[:20])) != agentPaymaster) {
                return (Reason.PAYMASTER, 0);
            }
            pmGas = uint256(uint128(bytes16(pmd[20:36]))) + uint256(uint128(bytes16(pmd[36:52])));
        }
        uint256 verificationGas = uint256(op.accountGasLimits) >> 128;
        uint256 callGas = uint128(uint256(op.accountGasLimits));
        uint256 maxFee = uint128(uint256(op.gasFees));
        if (
            callGas > g.maxCallGas || verificationGas > g.maxVerificationGas
                || op.preVerificationGas > g.maxPreVerificationGas || maxFee > g.maxFeePerGas
                || pmGas > uint256(g.maxVerificationGas) + g.maxCallGas
        ) return (Reason.GAS_CAP, 0);
        maxCost = (verificationGas + callGas + op.preVerificationGas + pmGas) * maxFee;
        if (maxCost > g.gasCredit) return (Reason.GAS_CREDIT, maxCost);
        return (Reason.OK, maxCost);
    }
}
