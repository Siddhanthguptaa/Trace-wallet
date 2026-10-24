// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Buckets} from "../lib/Buckets.sol";
import {TypedData} from "../lib/TypedData.sol";
import {Bucket, AssetLimit, Session, Outflow, Tier, Track, Reason, NATIVE} from "../lib/PolicyTypes.sol";

/// The account functions the lens reads (core `policyCheck` + AgentAccountAdmin views, docs/api.md 2.2 / 2.3).
interface IAgentAccountLensView {
    function policyCheck(address agentKey, bytes calldata callData, bytes calldata attestation, bytes calldata approval)
        external
        view
        returns (uint16 reason, Tier tier, Track track, uint48 validUntil);
    function sessionOf(address agentKey) external view returns (uint64 sid, Session memory s);
    function keyAsset(address agentKey, address asset) external view returns (AssetLimit memory);
    function globalBucket(address asset) external view returns (Bucket memory);
    function exploreBucket(address asset) external view returns (Bucket memory);
    function explorePerTxCap(address asset) external view returns (uint128);
}

/// @title PolicyLens (lane APPC / M5): the `checkPolicy` lens (IDEA 7.2).
/// @notice Stateless and view-only; deploy once per chain and call it with `eth_call` (it may read
///         block.timestamp, unlike validation). Never part of the trust path: the account
///         re-checks everything itself. Order (first failure wins, IDEA 7.2 order):
///         1. `account.policyCheck(...)` (validation-equivalent, no time / nonce / gas): NO_SESSION,
///            REVOKED, then the core / module codes (TARGET, ARG_RULE(i), RECIPIENT, FLAGGED,
///            PER_TX, EXPLORE_PER_TX, ASSET, OP_SHAPE, FROZEN, APPROVAL ...); a revert there
///            (malformed bytes) gives OP_SHAPE, or APPROVAL when an approval slot was given;
///         2. EXPIRED: session window (`validAfter < now <= validUntil`, checked before any
///            non-session code) and the attestation / approval validUntil folded by the account;
///         3. outflows: `q.outflows` if given (e.g. an eth_call simulation, one entry per asset is
///            not required: entries are summed per asset), else decoded from callData (native
///            value; ERC-20 transfer / approve / increaseAllowance amount on an enabled asset;
///            voucher body word 1 on the voucher token). Per asset, NORMAL / EXPLORE track:
///            ASSET (not enabled), PER_TX, EXPLORE_PER_TX (explore), KEY_BUCKET, GLOBAL_BUCKET,
///            EXPLORE_BUCKET (explore), bucket levels refilled to now with Buckets.availableAt;
///            APPROVAL track: summed outflow <= the approval's maxOutflow (missing = 0) else APPROVAL;
///         4. GAS_CREDIT: maxGasCost (the op's max cost in wei; 0 = worst case at the session's
///            per-op caps, which may refuse early) > the session's remaining gasCredit.
///         reasonCode = code | (detail << 8) (docs/api.md 7.1); ok iff reasonCode == OK.
contract PolicyLens {
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f;
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant INCREASE_ALLOWANCE = 0x39509351;

    struct Query {
        address account;
        address agentKey;
        bytes callData; // userOp.callData of the agent op
        bytes attestation; // attestation slot (may be empty)
        bytes approval; // approval slot (may be empty); non-empty = APPROVAL track
        uint256 maxGasCost; // the op's max gas cost (wei); 0 = worst case at the session's caps
        Outflow[] outflows; // expected outflows; empty = decoded from callData
    }

    struct Result {
        bool ok;
        uint16 reasonCode;
        Tier tier;
        Track track;
        uint48 validUntil; // min(session, attestation / approval) validUntil from the account
        uint256 maxGasCost; // the cost GAS_CREDIT was checked against
        Outflow[] outflows; // the per-asset outflows the cap checks used
    }

    /// IDEA 7.2 `checkPolicy(agentKey, callData, attestation) -> (ok, track, reasonCode)` for `account`.
    function checkPolicy(address account, address agentKey, bytes calldata callData, bytes calldata attestation)
        external
        view
        returns (bool ok, Track track, uint16 reasonCode)
    {
        Query memory q;
        q.account = account;
        q.agentKey = agentKey;
        q.callData = callData;
        q.attestation = attestation;
        Result memory r = _evaluate(q);
        return (r.ok, r.track, r.reasonCode);
    }

    /// Full form: approval slot, the op's gas cost and simulated outflows; returns every field.
    function checkPolicyEx(Query calldata q) external view returns (Result memory) {
        return _evaluate(q);
    }

    /// EIP-712 digest of an OutcomeApproval in the account's domain
    /// {"AgentAccount", "1", a.chainId, a.account}: what the owner signs (raw ECDSA, no prefix).
    function outcomeApprovalDigest(TypedData.OutcomeApproval calldata a) external pure returns (bytes32) {
        return TypedData.digest(TypedData.domainSeparator(a.chainId, a.account), TypedData.hashOutcomeApproval(a));
    }

    /// The approval slot bytes (docs/api.md 4.4): abi.encode(OutcomeApproval, bytes ownerSig).
    function encodeApproval(TypedData.OutcomeApproval calldata a, bytes calldata ownerSig)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(a, ownerSig);
    }

    // ---------------------------------------------------------------- internals

    function _evaluate(Query memory q) internal view returns (Result memory r) {
        IAgentAccountLensView acct = IAgentAccountLensView(q.account);
        try acct.policyCheck(q.agentKey, q.callData, q.attestation, q.approval) returns (
            uint16 rc, Tier tier, Track track, uint48 until
        ) {
            (r.reasonCode, r.tier, r.track, r.validUntil) = (rc, tier, track, until);
        } catch {
            r.reasonCode = q.approval.length != 0 ? Reason.APPROVAL : Reason.OP_SHAPE;
            return r;
        }
        if (r.reasonCode == Reason.NO_SESSION || r.reasonCode == Reason.REVOKED) return r;
        (, Session memory s) = acct.sessionOf(q.agentKey);
        if (block.timestamp <= s.validAfter || block.timestamp > s.validUntil) {
            r.reasonCode = Reason.EXPIRED;
            return r;
        }
        if (r.reasonCode != Reason.OK) return r;
        if (block.timestamp > r.validUntil) {
            r.reasonCode = Reason.EXPIRED;
            return r;
        }
        r.outflows = _sumPerAsset(q.outflows.length != 0 ? q.outflows : _decoded(acct, q.agentKey, q.callData));
        r.reasonCode = r.track == Track.APPROVAL
            ? _checkApprovalOutflows(q.approval, r.outflows)
            : _checkCaps(acct, q.agentKey, r.track == Track.EXPLORE, r.outflows);
        if (r.reasonCode != Reason.OK) return r;
        r.maxGasCost = q.maxGasCost != 0
            ? q.maxGasCost
            : (uint256(s.gas.maxVerificationGas) + s.gas.maxCallGas + s.gas.maxPreVerificationGas) * s.gas.maxFeePerGas;
        if (r.maxGasCost > s.gas.gasCredit) {
            r.reasonCode = Reason.GAS_CREDIT;
            return r;
        }
        r.ok = true;
    }

    /// Per-asset caps on the NORMAL / EXPLORE tracks (what MeterModule enforces in execution).
    function _checkCaps(IAgentAccountLensView acct, address agentKey, bool explore, Outflow[] memory outs)
        internal
        view
        returns (uint16)
    {
        for (uint256 i; i < outs.length; ++i) {
            uint256 amt = outs[i].amount;
            if (amt == 0) continue;
            address asset = outs[i].asset;
            AssetLimit memory lim = acct.keyAsset(agentKey, asset);
            if (!lim.enabled) return Reason.ASSET;
            if (amt > lim.perTxCap) return Reason.PER_TX;
            if (explore && amt > acct.explorePerTxCap(asset)) return Reason.EXPLORE_PER_TX;
            if (amt > Buckets.availableAt(lim.bucket, block.timestamp)) return Reason.KEY_BUCKET;
            if (amt > Buckets.availableAt(acct.globalBucket(asset), block.timestamp)) return Reason.GLOBAL_BUCKET;
            if (explore && amt > Buckets.availableAt(acct.exploreBucket(asset), block.timestamp)) {
                return Reason.EXPLORE_BUCKET;
            }
        }
        return Reason.OK;
    }

    /// APPROVAL track: summed outflow per asset <= maxOutflow (missing asset = 0, duplicates: smallest).
    function _checkApprovalOutflows(bytes memory approval, Outflow[] memory outs) internal pure returns (uint16) {
        (TypedData.OutcomeApproval memory a,) = abi.decode(approval, (TypedData.OutcomeApproval, bytes));
        for (uint256 i; i < outs.length; ++i) {
            if (outs[i].amount == 0) continue;
            uint256 cap = type(uint256).max;
            bool listed;
            for (uint256 j; j < a.maxOutflow.length; ++j) {
                if (a.maxOutflow[j].asset == outs[i].asset) {
                    listed = true;
                    if (a.maxOutflow[j].amount < cap) cap = a.maxOutflow[j].amount;
                }
            }
            if (!listed || outs[i].amount > cap) return Reason.APPROVAL;
        }
        return Reason.OK;
    }

    /// Decoded outflows of an agent op whose encoding the account already accepted.
    function _decoded(IAgentAccountLensView acct, address agentKey, bytes memory callData)
        internal
        view
        returns (Outflow[] memory out)
    {
        (uint256 kind, address target, uint256 value, bytes memory data) =
            abi.decode(_tail4(callData), (uint256, address, uint256, bytes));
        out = new Outflow[](2);
        uint256 n;
        if (value != 0) out[n++] = Outflow(NATIVE, value);
        if (kind == 1) {
            // REGISTER_VOUCHER body (docs/api.md 4.1): (address to, uint256 value, ...) on token = target.
            if (data.length >= 64) out[n++] = Outflow(target, _word(data, 32));
        } else if (data.length >= 68) {
            bytes4 sel = bytes4(data);
            if (
                (sel == TRANSFER || sel == APPROVE || sel == INCREASE_ALLOWANCE)
                    && acct.keyAsset(agentKey, target).enabled
            ) out[n++] = Outflow(target, _word(data, 36));
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// One entry per asset, amounts summed (first-seen order).
    function _sumPerAsset(Outflow[] memory xs) internal pure returns (Outflow[] memory out) {
        out = new Outflow[](xs.length);
        uint256 n;
        for (uint256 i; i < xs.length; ++i) {
            uint256 k;
            while (k < n && out[k].asset != xs[i].asset) ++k;
            if (k == n) out[n++] = Outflow(xs[i].asset, 0);
            out[k].amount += xs[i].amount;
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    function _tail4(bytes memory b) private pure returns (bytes memory t) {
        uint256 n = b.length - 4;
        t = new bytes(n);
        assembly ("memory-safe") {
            mcopy(add(t, 32), add(b, 36), n)
        }
    }

    function _word(bytes memory b, uint256 offset) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(b, 32), offset))
        }
    }
}
