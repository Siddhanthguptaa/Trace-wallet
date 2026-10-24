// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgentAccountBase} from "../AgentAccountBase.sol";
import {AccountStorage} from "../lib/AccountStorage.sol";
import {ArgRules} from "../lib/ArgRules.sol";
import {TypedData} from "../lib/TypedData.sol";
import {AgentCall, OpContext, OpKind, Reason, Tier, NATIVE} from "../lib/PolicyTypes.sol";

/// @title PayeeTierModule (D3, lane D3 / M4): attested payee tiers and the exploration track.
/// @notice `_tierOf` runs in validation AND in the execution re-check on the same userOp bytes, so
///         the tier (and the budget track) is re-derived at execution time: a flag, a revoked
///         attestor or an epoch bump between validation and execution still bites. It is a view of
///         (call, attestation, account storage) only and never reads TIMESTAMP [E2]; freshness goes
///         into validationData, which the EntryPoint enforces [E66].
///
///         Only payees of value transfers are tiered (a PAYEE rule: ERC-20 `transfer` arg 0, the
///         native-value target, the voucher `to`). Order, first match wins:
///           1. flagged                                  -> FLAGGED, refused (FLAGGED)
///           2. owner-listed                             -> PROVEN, normal caps
///           3. valid ScoreAttestation (docs/api.md 4.3) -> PROVEN, normal caps, validUntil folded
///           4. else                                     -> UNPROVEN, exploration track; refused with
///              EXPLORE_PER_TX if the decoded amount is above explorePerTxCap[asset]
///         Anything malformed, unsigned, wrong-signer, wrong-chain/wallet (EIP-712 domain), wrong
///         epoch, wrong recipient, tier != PROVEN or validUntil == 0 is UNPROVEN, never a failure
///         and never an upgrade (fail closed). An attestation only changes the track; it never
///         raises a cap (per-tx, key and global caps apply to PROVEN payees unchanged).
///         The exploration bucket, the key and global buckets and the measured explorePerTxCap
///         are debited / enforced by MeterModule on Track.EXPLORE (docs/api.md section 9).
///         Flags are escalate-only and live in AgentAccountAdmin: `flag` (attestor or owner),
///         `unflag` (owner), `setAttestor` (refuses a live agent key, F27), `bumpEpoch` (owner).
abstract contract PayeeTierModule is AgentAccountBase {
    /// @custom:storage-location erc7201:hypnexis.AgentAccount.payeetier
    struct PayeeTierStorage {
        uint256 version; // reserved; D3 keeps all its state in the core namespace (attestor, epoch, flags)
    }

    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.payeetier")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant PAYEETIER_SLOT = 0x55f917a41df0015e2d6b18b6f966f560d156e83464296839b2eabefcc97b3c00;

    /// Canonical attestation slot: abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes sig)
    /// with a 65-byte (r, s, v) signature = 4 head words + length word + 3 data words.
    uint256 internal constant ATTESTATION_LEN = 256;

    function _payeeTierStorage() internal pure returns (PayeeTierStorage storage $) {
        bytes32 slot = PAYEETIER_SLOT;
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _tierOf(OpContext memory, AgentCall memory call, bytes memory attestation)
        internal
        view
        virtual
        override
        returns (Tier tier, uint16 reason, uint48 validUntil)
    {
        validUntil = type(uint48).max; // never 0: 0 means "no expiry" to the EntryPoint
        if (!call.hasPayee) return (Tier.NONE, Reason.OK, validUntil);
        AccountStorage.Layout storage l = _l();
        address payee = call.payee;
        if (l.flagged[payee]) return (Tier.FLAGGED, Reason.FLAGGED, validUntil);
        if (l.recipients[payee]) return (Tier.PROVEN, Reason.OK, validUntil);
        uint48 until = _attestedUntil(l, payee, attestation);
        if (until != 0) return (Tier.PROVEN, Reason.OK, until);
        // Exploration track: decoded per-op cap here; measured outflow + exploreCap in MeterModule.
        (address asset, uint256 amount) = _payOf(call);
        if (amount > l.explorePerTxCap[asset] || (asset != NATIVE && call.value > l.explorePerTxCap[NATIVE])) {
            return (Tier.UNPROVEN, Reason.EXPLORE_PER_TX, validUntil);
        }
        return (Tier.UNPROVEN, Reason.OK, validUntil);
    }

    /// Expiry of a valid PROVEN attestation for `payee` in this account's EIP-712 domain
    /// {AgentAccount, 1, chainId, this} at the current epoch, signed by the current attestor;
    /// 0 for anything else. Strict layout, never reverts on malformed input.
    function _attestedUntil(AccountStorage.Layout storage l, address payee, bytes memory a)
        internal
        view
        returns (uint48)
    {
        address attestor = l.attestor;
        if (attestor == address(0) || a.length != ATTESTATION_LEN) return 0;
        uint256 tier;
        uint256 until;
        uint256 epoch;
        uint256 off;
        uint256 len;
        bytes32 r;
        bytes32 s;
        uint256 v;
        assembly ("memory-safe") {
            tier := mload(add(a, 0x20))
            until := mload(add(a, 0x40))
            epoch := mload(add(a, 0x60))
            off := mload(add(a, 0x80))
            len := mload(add(a, 0xa0))
            r := mload(add(a, 0xc0))
            s := mload(add(a, 0xe0))
            v := byte(0, mload(add(a, 0x100)))
        }
        if (
            tier != uint8(Tier.PROVEN) || until == 0 || until > type(uint48).max || epoch != l.attestEpoch
                || off != 0x80 || len != 65
        ) return 0;
        bytes32 digest =
            _hashTyped(keccak256(abi.encode(TypedData.SCORE_ATTESTATION_TYPEHASH, payee, tier, until, epoch)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, uint8(v), r, s);
        return err == ECDSA.RecoverError.NoError && signer == attestor ? uint48(until) : 0;
    }

    /// Decoded (asset, amount) paid to the payee. Vouchers: set by OneDoorModule before this hook.
    /// ERC-20 transfer: (token, amount; max if the word is missing). Native value send: (NATIVE, value).
    function _payOf(AgentCall memory call) internal pure returns (address asset, uint256 amount) {
        if (call.kind != OpKind.CALL) return (call.payAsset, call.payAmount);
        if (call.selector == ArgRules.TRANSFER) {
            (bool ok, uint256 w) = ArgRules.word(call.data, 1);
            return (call.target, ok ? w : type(uint256).max);
        }
        return (NATIVE, call.value);
    }
}
