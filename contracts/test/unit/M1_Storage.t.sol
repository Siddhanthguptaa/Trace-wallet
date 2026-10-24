// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AccountStorage} from "../../src/lib/AccountStorage.sol";
import {FreezeStorage} from "../../src/modules/FreezeModule.sol";
import {RecoveryStorage} from "../../src/modules/RecoveryModule.sol";

/// Exposes the module slot constants (internal) for the check below.
contract SlotHarness is AgentAccount {
    constructor() AgentAccount(IEntryPoint(address(1)), address(0)) {}

    function slots() external pure returns (bytes32, bytes32, bytes32, bytes32, bytes32) {
        return (METER_SLOT, ONEDOOR_SLOT, PAYEETIER_SLOT, APPROVAL_SLOT, EXEC_LOCK_SLOT);
    }

    function innerArmSlot() external pure returns (bytes32) {
        return INNER_ARM_SLOT;
    }
}

/// ERC-7201 namespaces (docs/api.md section 6) match the formula.
contract M1StorageTest is Test {
    function _erc7201(string memory id) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256(bytes(id))) - 1)) & ~bytes32(uint256(0xff));
    }

    function test_storage_erc7201Slots() public {
        assertEq(AccountStorage.SLOT, _erc7201("hypnexis.AgentAccount.core"));
        (bytes32 meter, bytes32 door, bytes32 tier, bytes32 appr, bytes32 lock) = new SlotHarness().slots();
        assertEq(meter, _erc7201("hypnexis.AgentAccount.meter"));
        assertEq(door, _erc7201("hypnexis.AgentAccount.onedoor"));
        assertEq(tier, _erc7201("hypnexis.AgentAccount.payeetier"));
        assertEq(appr, _erc7201("hypnexis.AgentAccount.approval"));
        assertEq(lock, _erc7201("hypnexis.AgentAccount.execlock"));
        assertEq(new SlotHarness().innerArmSlot(), _erc7201("hypnexis.AgentAccount.innerarm"));
        assertEq(FreezeStorage.SLOT, _erc7201("hypnexis.AgentAccount.freeze"));
        assertEq(RecoveryStorage.SLOT, _erc7201("hypnexis.AgentAccount.recovery"));
    }
}
