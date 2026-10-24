// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @title NaiveAccount (R2 baseline, EXPERIMENTS.md X1)
/// @notice "What most teams build": a 4337 account with a session (agent) key limited by a
///         target+selector allowlist, a decoded per-tx cap, a calendar-day daily cap, a static
///         recipient list on the decoded ERC-20 `transfer.to`, and an ERC-1271 that accepts the
///         session key (the "permissive" account the x402 docs describe [E42]).
///         Policy lives on the UserOp path only: no argument rules beyond `transfer.to`, no gas caps,
///         no metering of approvals, merchant pulls or NFT moves. Config published in docs/api.md s10.
///         The constructor and the 1271 part are M0's (used unchanged by the X2 spike).
contract NaiveAccount is IAccount, IERC1271 {
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    struct R2Config {
        address[] targets; // allowlist: targets[i] + selectors[i]
        bytes4[] selectors;
        address[] recipients; // static list for decoded ERC-20 transfer.to
        address[] tokens; // address(0) = native ETH
        uint256[] perTxCaps;
        uint256[] dailyCaps; // calendar day (block.timestamp / 86400)
    }

    address public owner;
    address public agent;
    IEntryPoint public entryPoint;

    mapping(address => mapping(bytes4 => bool)) public allowed;
    mapping(address => bool) public isRecipient;
    mapping(address => uint256) public perTxCap;
    mapping(address => uint256) public dailyCap;
    mapping(address => mapping(uint256 => uint256)) public spentOnDay;

    error NotOwner();
    error NotEntryPoint();
    error AlreadyConfigured();
    error DailyCapExceeded(address token, uint256 day, uint256 spent, uint256 cap);
    error BadConfig();

    constructor(address owner_, address agent_) {
        owner = owner_;
        agent = agent_;
    }

    receive() external payable {}

    /// One-time R2 setup by the owner (kept out of the constructor so the M0 X2 spike is unchanged).
    function configure(IEntryPoint ep, R2Config calldata cfg) external {
        if (msg.sender != owner) revert NotOwner();
        if (address(entryPoint) != address(0)) revert AlreadyConfigured();
        if (cfg.targets.length != cfg.selectors.length || cfg.tokens.length != cfg.perTxCaps.length
            || cfg.tokens.length != cfg.dailyCaps.length) revert BadConfig();
        entryPoint = ep;
        for (uint256 i; i < cfg.targets.length; ++i) {
            allowed[cfg.targets[i]][cfg.selectors[i]] = true;
        }
        for (uint256 i; i < cfg.recipients.length; ++i) {
            isRecipient[cfg.recipients[i]] = true;
        }
        for (uint256 i; i < cfg.tokens.length; ++i) {
            perTxCap[cfg.tokens[i]] = cfg.perTxCaps[i];
            dailyCap[cfg.tokens[i]] = cfg.dailyCaps[i];
        }
    }

    // ---------------------------------------------------------------- ERC-4337

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(userOpHash, userOp.signature);
        if (err != ECDSA.RecoverError.NoError || signer == address(0)) {
            validationData = SIG_VALIDATION_FAILED;
        } else if (signer == owner) {
            validationData = 0;
        } else if (signer == agent) {
            validationData = _agentAllowed(userOp.callData) ? 0 : SIG_VALIDATION_FAILED;
        } else {
            validationData = SIG_VALIDATION_FAILED;
        }
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok);
        }
    }

    /// Agent ops: executeAgent(target, value, data) with an allowlisted (target, selector),
    /// decoded transfer.to in the recipient list and decoded amounts within the per-tx caps.
    function _agentAllowed(bytes calldata callData) internal view returns (bool) {
        if (callData.length < 4 || bytes4(callData[:4]) != this.executeAgent.selector) return false;
        (address target, uint256 value, bytes memory data) = abi.decode(callData[4:], (address, uint256, bytes));
        bytes4 sel = data.length >= 4 ? bytes4(data) : bytes4(0);
        if (!allowed[target][sel]) return false;
        if (value > perTxCap[address(0)]) return false;
        if (sel == TRANSFER) {
            (address to, uint256 amount) = _decodeTransfer(data);
            if (!isRecipient[to] || amount > perTxCap[target]) return false;
        }
        return true;
    }

    function _decodeTransfer(bytes memory data) internal pure returns (address to, uint256 amount) {
        if (data.length < 68) return (address(0), type(uint256).max);
        assembly ("memory-safe") {
            to := mload(add(data, 36))
            amount := mload(add(data, 68))
        }
    }

    /// Agent execution path: calendar-day daily cap on decoded transfer amounts and native value.
    function executeAgent(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        uint256 day = block.timestamp / 86400;
        if (value > 0) _spend(address(0), day, value);
        if (data.length >= 68 && bytes4(data[:4]) == TRANSFER) {
            (, uint256 amount) = abi.decode(data[4:68], (address, uint256));
            _spend(target, day, amount);
        }
        _call(target, value, data);
    }

    function _spend(address token, uint256 day, uint256 amount) internal {
        uint256 spent = spentOnDay[token][day] + amount;
        if (spent > dailyCap[token]) revert DailyCapExceeded(token, day, spent, dailyCap[token]);
        spentOnDay[token][day] = spent;
    }

    /// Owner path (EntryPoint with an owner signature, or the owner EOA directly).
    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != address(entryPoint) && msg.sender != owner) revert NotOwner();
        _call(target, value, data);
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function addDeposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    // ---------------------------------------------------------------- ERC-1271 (M0, unchanged)

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && signer != address(0) && (signer == owner || signer == agent)) {
            return IERC1271.isValidSignature.selector;
        }
        return ERC1271_INVALID;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
