// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title TypedData: the account's EIP-712 types (docs/api.md section 5).
/// @notice Domain {name "AgentAccount", version "1", chainId, verifyingContract = the account}.
///         ScoreAttestation is signed by the attestor (D3 / ATT); OutcomeApproval by the owner (M5).
///         Struct layouts are fixed in M1; changes are additive and logged in docs/api.md.
library TypedData {
    string internal constant NAME = "AgentAccount";
    string internal constant VERSION = "1";

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// tier uses the Tier enum numbering (1 = PROVEN). Only PROVEN upgrades a payee.
    bytes32 internal constant SCORE_ATTESTATION_TYPEHASH =
        keccak256("ScoreAttestation(address recipient,uint8 tier,uint48 validUntil,uint64 epoch)");

    bytes32 internal constant ASSET_AMOUNT_TYPEHASH = keccak256("AssetAmount(address asset,uint256 amount)");

    /// callDataHash = keccak256(userOp.callData) of the agent op being approved.
    bytes32 internal constant OUTCOME_APPROVAL_TYPEHASH = keccak256(
        "OutcomeApproval(address account,uint256 chainId,uint256 nonce,address target,bytes4 selector,address payee,AssetAmount[] maxOutflow,bytes32 callDataHash,uint48 validUntil)AssetAmount(address asset,uint256 amount)"
    );

    struct ScoreAttestation {
        address recipient;
        uint8 tier;
        uint48 validUntil;
        uint64 epoch;
    }

    struct AssetAmount {
        address asset;
        uint256 amount;
    }

    struct OutcomeApproval {
        address account;
        uint256 chainId;
        uint256 nonce;
        address target;
        bytes4 selector;
        address payee;
        AssetAmount[] maxOutflow;
        bytes32 callDataHash;
        uint48 validUntil;
    }

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), chainId, verifyingContract)
        );
    }

    function hashScoreAttestation(ScoreAttestation memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(SCORE_ATTESTATION_TYPEHASH, a.recipient, a.tier, a.validUntil, a.epoch));
    }

    function hashAssetAmounts(AssetAmount[] memory xs) internal pure returns (bytes32) {
        bytes32[] memory hs = new bytes32[](xs.length);
        for (uint256 i; i < xs.length; ++i) {
            hs[i] = keccak256(abi.encode(ASSET_AMOUNT_TYPEHASH, xs[i].asset, xs[i].amount));
        }
        return keccak256(abi.encodePacked(hs));
    }

    function hashOutcomeApproval(OutcomeApproval memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                OUTCOME_APPROVAL_TYPEHASH,
                a.account,
                a.chainId,
                a.nonce,
                a.target,
                a.selector,
                a.payee,
                hashAssetAmounts(a.maxOutflow),
                a.callDataHash,
                a.validUntil
            )
        );
    }

    function digest(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }
}
