// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArgRule, RuleOp, CallRuleInput, Reason, ANY_TARGET, TARGET_ARG, MAX_ARG_RULES} from "./PolicyTypes.sol";
import {AccountStorage} from "./AccountStorage.sol";

/// @title ArgRules: argument-rule evaluation and the setPolicy hard rules (IDEA.md 7.1).
/// @notice Rules read static 32-byte ABI words only. Hard rules (code, not config):
///         - asset-moving selectors are never allowed by a bare (target, selector) entry: the
///           `to` / `spender` / `operator` argument must be bound (transfer: EQ_SELF, IN_RECIPIENTS,
///           EQ or PAYEE; approvals and NFT moves: EQ_SELF or IN_RECIPIENTS only) [E56][E57];
///         - PAYEE only on ERC-20 transfer.to (arg 0) or the native-value target (TARGET_ARG with
///           selector 0x00000000); at most one PAYEE per entry;
///         - no rule on a known dynamic argument, no index past a known selector's arity;
///         - no entry for the account itself, the EntryPoint, or account-execution selectors.
library ArgRules {
    // ERC-20 / ERC-721 / ERC-1155 / Permit2 selectors that move or approve assets.
    bytes4 internal constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256) (20 and 721)
    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256) (20 and 721)
    bytes4 internal constant INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 internal constant SET_APPROVAL_FOR_ALL = 0xa22cb465; // setApprovalForAll(address,bool)
    bytes4 internal constant SAFE_TRANSFER_FROM_721 = 0x42842e0e; // safeTransferFrom(address,address,uint256)
    bytes4 internal constant SAFE_TRANSFER_FROM_721_DATA = 0xb88d4fde; // safeTransferFrom(address,address,uint256,bytes)
    bytes4 internal constant SAFE_TRANSFER_FROM_1155 = 0xf242432a; // safeTransferFrom(address,address,uint256,uint256,bytes)
    bytes4 internal constant SAFE_BATCH_TRANSFER_FROM_1155 = 0x2eb2c2d6; // safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)
    bytes4 internal constant PERMIT2_APPROVE = 0x87517c45; // approve(address,address,uint160,uint48)

    // Account-execution selectors: never a rule target selector (no nested execution).
    bytes4 internal constant EXECUTE = 0xb61d27f6; // execute(address,uint256,bytes)
    bytes4 internal constant EXECUTE_BATCH = 0x34fcd5be; // executeBatch((address,uint256,bytes)[])
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f; // executeUserOp(PackedUserOperation,bytes32)

    error RuleTargetForbidden(address target);
    error RuleSelectorForbidden(bytes4 selector);
    error RuleTooMany(uint256 count);
    error RuleArgIndex(uint256 ruleIndex, uint8 argIndex);
    error RuleDynamicArg(uint256 ruleIndex, uint8 argIndex);
    error RulePayeeSlot(uint256 ruleIndex);
    error RuleUnbound(address target, bytes4 selector);
    error RuleWildcard();

    struct SelectorInfo {
        bool known; // arity and dynamic args known
        bool moving; // moves or approves assets
        uint8 bindArg; // argument that must be bound (to / spender / operator)
        bool payeeOk; // PAYEE allowed on bindArg (ERC-20 transfer only)
        uint8 nArgs; // static head words
        uint16 dynMask; // bit i set = arg i is dynamic
    }

    function info(bytes4 sel) internal pure returns (SelectorInfo memory s) {
        if (sel == TRANSFER) return SelectorInfo(true, true, 0, true, 2, 0);
        if (sel == TRANSFER_FROM) return SelectorInfo(true, true, 1, false, 3, 0);
        if (sel == APPROVE) return SelectorInfo(true, true, 0, false, 2, 0);
        if (sel == INCREASE_ALLOWANCE) return SelectorInfo(true, true, 0, false, 2, 0);
        if (sel == SET_APPROVAL_FOR_ALL) return SelectorInfo(true, true, 0, false, 2, 0);
        if (sel == SAFE_TRANSFER_FROM_721) return SelectorInfo(true, true, 1, false, 3, 0);
        if (sel == SAFE_TRANSFER_FROM_721_DATA) return SelectorInfo(true, true, 1, false, 4, 1 << 3);
        if (sel == SAFE_TRANSFER_FROM_1155) return SelectorInfo(true, true, 1, false, 5, 1 << 4);
        if (sel == SAFE_BATCH_TRANSFER_FROM_1155) {
            return SelectorInfo(true, true, 1, false, 5, (1 << 2) | (1 << 3) | (1 << 4));
        }
        if (sel == PERMIT2_APPROVE) return SelectorInfo(true, true, 1, false, 4, 0);
        return s; // unknown: not moving, arity unknown
    }

    function isExecSelector(bytes4 sel) internal pure returns (bool) {
        return sel == EXECUTE || sel == EXECUTE_BATCH || sel == EXECUTE_USER_OP;
    }

    function _binds(RuleOp op, bool payeeOk) private pure returns (bool) {
        if (op == RuleOp.EQ_SELF || op == RuleOp.IN_RECIPIENTS) return true;
        if (payeeOk) return op == RuleOp.EQ || op == RuleOp.PAYEE;
        return false;
    }

    /// setPolicy hard rules for one (target, selector) entry. Reverts with the broken rule.
    function validateEntry(CallRuleInput calldata c, address self, address entryPoint) internal pure {
        if (c.target == self || c.target == entryPoint) revert RuleTargetForbidden(c.target);
        if (isExecSelector(c.selector)) revert RuleSelectorForbidden(c.selector);
        uint256 n = c.rules.length;
        if (n > MAX_ARG_RULES) revert RuleTooMany(n);
        bool wildcard = c.target == ANY_TARGET;
        if (wildcard && c.selector != bytes4(0)) revert RuleWildcard();

        SelectorInfo memory s = info(c.selector);
        bool bound;
        bool payeeSeen;
        bool targetBound;
        for (uint256 i; i < n; ++i) {
            ArgRule calldata r = c.rules[i];
            if (r.argIndex == TARGET_ARG) {
                // Only for plain value sends: the target is the native-value payee.
                if (c.selector != bytes4(0)) revert RuleArgIndex(i, r.argIndex);
                if (r.op != RuleOp.PAYEE && r.op != RuleOp.IN_RECIPIENTS && r.op != RuleOp.EQ) {
                    revert RuleArgIndex(i, r.argIndex);
                }
                if (r.op == RuleOp.PAYEE || r.op == RuleOp.IN_RECIPIENTS) targetBound = true;
            } else {
                if (c.selector == bytes4(0)) revert RuleArgIndex(i, r.argIndex); // no args on a value send
                if (s.known) {
                    if (r.argIndex >= s.nArgs) revert RuleArgIndex(i, r.argIndex);
                    if ((s.dynMask >> r.argIndex) & 1 == 1) revert RuleDynamicArg(i, r.argIndex);
                }
                if (s.moving && r.argIndex == s.bindArg && _binds(r.op, s.payeeOk)) bound = true;
            }
            if (r.op == RuleOp.PAYEE) {
                bool slotOk = (c.selector == TRANSFER && r.argIndex == 0)
                    || (c.selector == bytes4(0) && r.argIndex == TARGET_ARG);
                if (!slotOk || payeeSeen) revert RulePayeeSlot(i);
                payeeSeen = true;
            }
        }
        if (s.moving && !bound) revert RuleUnbound(c.target, c.selector);
        if (wildcard && !targetBound) revert RuleWildcard();
    }

    /// ABI word `argIndex` of `data` (4-byte selector first). ok = false if `data` is too short.
    function word(bytes memory data, uint256 argIndex) internal pure returns (bool ok, uint256 w) {
        uint256 end = 4 + 32 * (argIndex + 1);
        if (data.length < end) return (false, 0);
        assembly ("memory-safe") {
            w := mload(add(data, end))
        }
        return (true, w);
    }

    /// Evaluate one rule. Returns Reason.OK, or ARG_RULE(i) / RECIPIENT(i) / FLAGGED(i).
    /// For PAYEE, returns OK and the payee (the tier hook decides).
    function eval(
        AccountStorage.Layout storage l,
        ArgRule memory r,
        uint256 i,
        address target,
        bytes memory data,
        address self
    ) internal view returns (uint16 reason, bool isPayee, address payee) {
        uint256 w;
        if (r.argIndex == TARGET_ARG) {
            w = uint256(uint160(target));
        } else {
            bool ok;
            (ok, w) = word(data, r.argIndex);
            if (!ok) return (Reason.argRule(i), false, address(0));
        }
        if (r.op == RuleOp.LTE) return (w <= r.bound ? Reason.OK : Reason.argRule(i), false, address(0));
        if (r.op == RuleOp.EQ) return (w == r.bound ? Reason.OK : Reason.argRule(i), false, address(0));
        // Address operators: the word must be a clean address.
        if (w >> 160 != 0) return (Reason.argRule(i), false, address(0));
        address a = address(uint160(w));
        if (r.op == RuleOp.EQ_SELF) return (a == self ? Reason.OK : Reason.argRule(i), false, address(0));
        if (r.op == RuleOp.IN_RECIPIENTS) {
            if (!l.recipients[a]) return (Reason.RECIPIENT | uint16(i << 8), false, address(0));
            if (l.flagged[a]) return (Reason.FLAGGED | uint16(i << 8), false, address(0));
            return (Reason.OK, false, address(0));
        }
        // PAYEE
        return (Reason.OK, true, a);
    }
}
