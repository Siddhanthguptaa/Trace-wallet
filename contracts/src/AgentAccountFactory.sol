// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentAccount} from "./AgentAccount.sol";
import {AgentAccountAdmin} from "./AgentAccountAdmin.sol";

/// @title AgentAccountFactory: CREATE2 factory (IDEA 7.4). Deploys EIP-1167 clones of one
///        AgentAccount implementation, so the factory stays small whatever the account's size.
///        The implementation (and its AgentAccountAdmin) are deployed first and passed in, which
///        keeps the factory's initcode far from the EIP-3860 limit as the modules grow.
/// @notice The address binds the owner (salt = keccak256(owner, salt)), so anyone may deploy it
///         (the owner from MetaMask, or the EntryPoint's SenderCreator via initCode): the result is
///         the same account with the same owner. createAccount returns the existing account if any.
contract AgentAccountFactory {
    AgentAccount public immutable accountImplementation;
    AgentAccountAdmin public immutable accountAdmin;
    IEntryPoint public immutable entryPoint;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    error ImplementationMismatch();

    constructor(AgentAccount implementation) {
        accountImplementation = implementation;
        accountAdmin = AgentAccountAdmin(payable(implementation.admin()));
        entryPoint = implementation.entryPoint();
        if (address(accountAdmin).code.length == 0 || address(entryPoint).code.length == 0) {
            revert ImplementationMismatch();
        }
    }

    function createAccount(address owner, uint256 salt) external returns (AgentAccount account) {
        address addr = getAddress(owner, salt);
        if (addr.code.length > 0) return AgentAccount(payable(addr));
        account = AgentAccount(payable(Clones.cloneDeterministic(address(accountImplementation), _salt(owner, salt))));
        account.initialize(owner);
        emit AccountCreated(address(account), owner, salt);
    }

    function getAddress(address owner, uint256 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(address(accountImplementation), _salt(owner, salt));
    }

    function _salt(address owner, uint256 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
