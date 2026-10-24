// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title MockUSDC3009
/// @notice Local stand-in for USDC (FiatTokenV2_2) on Base: 6 decimals, EIP-712 domain
///         "USD Coin" / "2", EIP-3009 and EIP-2612. Every signature path goes through
///         SignatureChecker, so a contract signer is asked via ERC-1271 `isValidSignature`,
///         as on the real token. Revert strings copy FiatTokenV2_2. Mint is open: local only.
contract MockUSDC3009 is ERC20, EIP712 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;
    mapping(address => uint256) public nonces;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("USD Coin", "USDC") EIP712("USD Coin", "2") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function version() external pure returns (string memory) {
        return "2";
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    // ---------------------------------------------------------------- EIP-3009

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        _cancelAuthorization(authorizer, nonce, abi.encodePacked(r, s, v));
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external {
        _cancelAuthorization(authorizer, nonce, signature);
    }

    // ---------------------------------------------------------------- EIP-2612

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        _permit(owner, spender, value, deadline, abi.encodePacked(r, s, v));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) external {
        _permit(owner, spender, value, deadline, signature);
    }

    // ---------------------------------------------------------------- internals

    function _transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _requireValidSignature(
            from,
            keccak256(
                abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
            ),
            signature
        );
        _markAuthorizationAsUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _requireValidSignature(
            from,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            signature
        );
        _markAuthorizationAsUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) internal {
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
        _requireValidSignature(authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), signature);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) internal {
        require(deadline == type(uint256).max || deadline >= block.timestamp, "FiatTokenV2: permit is expired");
        _requireValidSignature(
            owner, keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline)), signature
        );
        _approve(owner, spender, value);
    }

    function _requireValidAuthorization(address authorizer, bytes32 nonce, uint256 validAfter, uint256 validBefore)
        internal
        view
    {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
    }

    function _requireValidSignature(address signer, bytes32 structHash, bytes memory signature) internal view {
        require(
            SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature),
            "FiatTokenV2: invalid signature"
        );
    }

    function _markAuthorizationAsUsed(address authorizer, bytes32 nonce) internal {
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}
