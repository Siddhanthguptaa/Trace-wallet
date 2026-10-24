// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title OneDoorSpike (X2 spike only)
/// @notice The minimal "one door" from IDEA D1: `isValidSignature` accepts the owner key only and
///         returns 0xffffffff for anything the agent key (or anyone else) signs. The full account
///         with the opt-in x402 voucher envelope is built in M3.
contract OneDoorSpike is IERC1271 {
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && signer != address(0) && signer == owner) {
            return IERC1271.isValidSignature.selector;
        }
        return ERC1271_INVALID;
    }
}
