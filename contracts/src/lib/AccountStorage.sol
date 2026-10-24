// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Bucket, Session, AssetLimit, RuleSet, RuleRef, Voucher} from "./PolicyTypes.sol";

/// @title AccountStorage: the account-wide policy state of IDEA.md section 7.1 (ERC-7201).
/// @notice Namespace "hypnexis.AgentAccount.core". CORE-owned; append-only (never reorder or
///         remove a field). Modules keep their private extras in their own namespaces.
///         Only owner-only setters in AgentAccount write these fields, except:
///         - `flagged` (attestor or owner via `flag`),
///         - bucket levels, gas credit and voucher state (written by the agent path itself).
library AccountStorage {
    /// @custom:storage-location erc7201:hypnexis.AgentAccount.core
    struct Layout {
        // ---- account-wide (IDEA 7.1 "Account-wide fields")
        address owner;
        bool initialized;
        uint8 sig1271Mode; // SIG1271_* (OneDoorModule reads it)
        address attestor; // unset = owner-listed payees only
        uint64 attestEpoch; // starts at 1
        uint64 nextSessionId; // session ids start at 1 (0 = none)
        uint32 nonceSalt; // bumped on every new nonce key (24 bits used)
        mapping(address => bool) recipients; // owner-listed payees
        address[] recipientList; // enumeration; may hold de-listed entries (check `recipients`)
        mapping(address => Bucket) globalBucket; // per asset, shared by every key and both tracks
        mapping(address => Bucket) exploreBucket; // per asset, unproven payees only
        mapping(address => uint128) explorePerTxCap; // per asset
        address[] trackedAssets; // assets with a configured global bucket (ERC-20s and NATIVE)
        mapping(address => bool) isTrackedAsset;
        mapping(address => bool) flagged; // set by attestor/owner, cleared by owner only
        address[] trackedSpenders; // allowances to these are metered as spend (D2)
        address[] trackedNFTs; // balanceOf(this) must not drop on the agent path (D2)
        mapping(bytes32 => Voucher) vouchers; // x402 nonce => voucher (D1)
        // ---- per session key (IDEA 7.1 "Per session key")
        mapping(address => uint64) keyToSession;
        mapping(uint64 => Session) sessions;
        mapping(bytes32 => RuleSet) rules; // ruleKey(sid, gen, target, selector)
        mapping(uint64 => RuleRef[]) ruleRefs; // current gen's entries, for get_policy
        mapping(bytes32 => AssetLimit) keyAssets; // assetKey(sid, gen, asset)
        mapping(uint64 => address[]) keyAssetList; // current gen's assets
        // ---- appended after M1 (phase 2)
        address agentPaymaster; // the only paymaster agent ops may name (0 = none allowed)
    }

    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.core")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xca31081fa2b076faf525cab77e8d16adb2d2bb3ecfbf020c1ea3cc7dff89ee00;

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            l.slot := slot
        }
    }

    function ruleKey(uint64 sid, uint32 gen, address target, bytes4 selector) internal pure returns (bytes32) {
        return keccak256(abi.encode(sid, gen, target, selector));
    }

    function assetKey(uint64 sid, uint32 gen, address asset) internal pure returns (bytes32) {
        return keccak256(abi.encode(sid, gen, asset));
    }

    /// The asset limit of session `sid` (current gen) for `asset`.
    function keyAsset(Layout storage l, uint64 sid, address asset) internal view returns (AssetLimit storage) {
        return l.keyAssets[assetKey(sid, l.sessions[sid].gen, asset)];
    }

    /// The rule set of session `sid` (current gen) for (target, selector).
    function ruleSet(Layout storage l, uint64 sid, address target, bytes4 selector)
        internal
        view
        returns (RuleSet storage)
    {
        return l.rules[ruleKey(sid, l.sessions[sid].gen, target, selector)];
    }
}
