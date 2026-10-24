// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TypedData} from "contracts/src/lib/TypedData.sol";

/// @notice Test-only stand-in for the AgentAccount's D3 surface, used by the ATT lane to check the
///         TypeScript signer and flag sender on anvil before the real account exists. The digest
///         comes from CORE's TypedData library (contracts/src/lib/TypedData.sol), so "TS digest ==
///         contract digest" is checked against the real library. Not deployed anywhere else.
contract AttestorStub {
    address public owner;
    address public attestor;
    uint64 public attestEpoch = 1;
    mapping(address => bool) internal _flagged;

    event Flagged(address indexed payee, address indexed by);

    error NotOwnerOrAttestor();
    error NotOwner();

    constructor(address attestor_) {
        owner = msg.sender;
        attestor = attestor_;
    }

    function flag(address payee) external {
        if (msg.sender != attestor && msg.sender != owner) revert NotOwnerOrAttestor();
        _flagged[payee] = true;
        emit Flagged(payee, msg.sender);
    }

    /// @dev same name as AgentAccountAdmin.isFlagged (docs/api.md 2.3).
    function isFlagged(address a) external view returns (bool) {
        return _flagged[a];
    }

    function bumpEpoch() external {
        if (msg.sender != owner) revert NotOwner();
        attestEpoch++;
    }

    function digestOf(address recipient, uint8 tier, uint48 validUntil, uint64 epoch) public view returns (bytes32) {
        TypedData.ScoreAttestation memory a = TypedData.ScoreAttestation(recipient, tier, validUntil, epoch);
        return TypedData.digest(TypedData.domainSeparator(block.chainid, address(this)), TypedData.hashScoreAttestation(a));
    }

    /// @return proven true iff the attestation is the attestor's PROVEN signature for this chain,
    ///         this wallet and the current epoch; validUntil is returned, not compared to TIMESTAMP.
    function check(address recipient, bytes calldata attestation) external view returns (bool proven, uint48 validUntil) {
        (uint8 tier, uint48 vu, uint64 epoch, bytes memory sig) = abi.decode(attestation, (uint8, uint48, uint64, bytes));
        if (tier != 1 || epoch != attestEpoch || sig.length != 65) return (false, 0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        address signer = ecrecover(digestOf(recipient, tier, vu, epoch), v, r, s);
        if (signer == address(0) || signer != attestor) return (false, 0);
        return (true, vu);
    }
}

/// @notice Test-only token that just emits ERC-20 Transfer events, for the x402 receipt verifier.
contract StubToken {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfer(address to, uint256 value) external returns (bool) {
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
