// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC3009Bytes {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @title ApiSeller (demo shop, the x402 payee)
/// @notice The pay-to address of the mock x402 API. `settle` plays the facilitator for local
///         runs: it submits the payer's EIP-3009 authorization with `to = address(this)`.
///         Anyone may call it, as with a real facilitator; the token checks the signature.
contract ApiSeller {
    using SafeERC20 for IERC20;

    address public immutable token;
    uint256 public immutable price;
    address public immutable owner;

    event Served(address indexed payer, uint256 value, bytes32 indexed nonce, string resource);

    constructor(address token_, uint256 price_, address owner_) {
        token = token_;
        price = price_;
        owner = owner_;
    }

    function settle(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        string calldata resource
    ) external {
        require(value >= price, "ApiSeller: underpaid");
        IERC3009Bytes(token).transferWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        emit Served(from, value, nonce, resource);
    }

    function withdraw(address to, uint256 amount) external {
        require(msg.sender == owner, "ApiSeller: not owner");
        IERC20(token).safeTransfer(to, amount);
    }
}
