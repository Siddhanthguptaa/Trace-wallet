// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {NaiveAccount} from "../../src/baselines/NaiveAccount.sol";
import {ERC1271_MAGIC} from "../../src/lib/PolicyTypes.sol";

/// R2 baseline behaves exactly as EXPERIMENTS X1 defines it (docs/api.md section 10),
/// including its holes (no argument rules, calendar-day cap, permissive 1271).
contract M1NaiveTest is M1Fixture {
    NaiveAccount internal r2;

    function setUp() public {
        _setUpFixture();
        r2 = _deployR2(agent);
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TRANSFER, to, amount);
    }

    function test_r2_transferToRecipient() public {
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 5e6))));
        assertEq(usdc.balanceOf(address(grocery)), 5e6);
    }

    function test_r2_staticRecipientList() public {
        _expectAA24(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(attacker, 1e6)));
    }

    function test_r2_perTxCap() public {
        _expectAA24(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), uint256(PER_TX) + 1)));
    }

    function test_r2_allowlistOnly() public {
        _expectAA24(_r2Op(r2, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER_FROM, address(r2), attacker, 1)));
        PackedUserOperation memory op = _r2Op(r2, AGENT_PK, address(r2), 0, "");
        _expectAA24(op); // self not allowlisted
    }

    function test_r2_calendarDailyCap() public {
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 10e6))));
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 10e6))));
        assertFalse(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 1))), "cap hit");
        vm.warp((block.timestamp / 86400 + 1) * 86400);
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 10e6))), "new day");
    }

    function test_r2_midnightHole() public {
        uint256 midnight = (block.timestamp / 86400 + 1) * 86400;
        vm.warp(midnight - 60);
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 10e6))));
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 10e6))));
        vm.warp(midnight + 60);
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 10e6))));
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, _transfer(address(grocery), 10e6))));
        assertEq(usdc.balanceOf(address(grocery)), 2 * R2_DAILY_CAP, "2x the daily cap within 120 s");
    }

    function test_r2_noArgumentRules() public {
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(APPROVE, address(ticket), TICKET_PRICE))));
        assertTrue(_handle(_r2Op(r2, AGENT_PK, address(ticket), 0, abi.encodeWithSelector(BUY, 1, attacker))));
        assertEq(ticket.ownerOf(1), attacker, "R2 buys the ticket for the attacker");
    }

    function test_r2_permissive1271() public view {
        bytes32 h = keccak256("any digest");
        assertEq(r2.isValidSignature(h, _sign65(AGENT_PK, h)), ERC1271_MAGIC, "session key accepted");
    }

    function test_r2_executeAgentOnlyEntryPoint() public {
        vm.expectRevert(NaiveAccount.NotEntryPoint.selector);
        r2.executeAgent(address(usdc), 0, _transfer(attacker, 1));
        vm.expectRevert(NaiveAccount.AlreadyConfigured.selector);
        vm.prank(owner);
        r2.configure(IEntryPoint(address(ep)), NaiveAccount.R2Config(new address[](0), new bytes4[](0), new address[](0), new address[](0), new uint256[](0), new uint256[](0)));
    }
}
