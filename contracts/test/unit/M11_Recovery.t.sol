// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {RecoveryModule} from "../../src/modules/RecoveryModule.sol";
import {Session, Reason} from "../../src/lib/PolicyTypes.sol";

/// M11 (lane REC): 3-of-5 guardian recovery, 48 h delay, owner veto (IDEA.md 13, I12).
contract M11RecoveryTest is M1Fixture {
    uint256 internal constant NEW_OWNER_PK = 0x0E11E;
    uint256 internal constant DELAY = 48 hours;

    address[] internal g;
    address internal newOwner;

    function setUp() public {
        _setUpFixture();
        newOwner = vm.addr(NEW_OWNER_PK);
        g = _guardianSet("guardian");
        vm.startPrank(owner);
        admin.setPolicy(agent2, _demoPolicy());
        admin.setGuardians(g, 3);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _guardianSet(string memory tag) internal returns (address[] memory s) {
        s = new address[](5);
        for (uint256 i; i < 5; ++i) {
            s[i] = makeAddr(string(abi.encodePacked(tag, vm.toString(i))));
        }
    }

    function _propose(AgentAccountAdmin a, uint256 i, address who) internal {
        vm.prank(g[i]);
        a.proposeRecovery(who);
    }

    function _approve(AgentAccountAdmin a, uint256 i, uint64 id) internal {
        vm.prank(g[i]);
        a.approveRecovery(id);
    }

    /// g0 proposes, g1 and g2 approve: 3 distinct approvals.
    function _threeOfFive() internal {
        _propose(admin, 0, newOwner);
        _approve(admin, 1, 1);
        _approve(admin, 2, 1);
    }

    function _pending() internal view returns (uint64 id, address n, uint48 at, uint256 bits, bool vetoed) {
        return admin.pendingRecovery();
    }

    function _validAgentOp() internal view returns (PackedUserOperation memory) {
        return _agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(api), API_PRICE));
    }

    // ---------------------------------------------------------------- setGuardians

    function test_setGuardians_ownerOnly() public {
        address[3] memory who = [stranger, g[0], agent];
        for (uint256 i; i < who.length; ++i) {
            vm.expectRevert(AccountCommon.NotOwner.selector);
            vm.prank(who[i]);
            admin.setGuardians(g, 3);
        }
        (address[] memory got, uint8 thr) = admin.guardians();
        assertEq(got.length, 5);
        assertEq(got[4], g[4]);
        assertEq(thr, 3);
    }

    function test_setGuardians_exactlyFiveThresholdThree() public {
        address[] memory four = new address[](4);
        address[] memory six = new address[](6);
        for (uint256 i; i < 6; ++i) {
            if (i < 4) four[i] = g[i];
            six[i] = i < 5 ? g[i] : makeAddr("sixth");
        }
        vm.startPrank(owner);
        vm.expectRevert(RecoveryModule.BadGuardians.selector);
        admin.setGuardians(four, 3);
        vm.expectRevert(RecoveryModule.BadGuardians.selector);
        admin.setGuardians(six, 3);
        vm.expectRevert(RecoveryModule.BadGuardians.selector);
        admin.setGuardians(new address[](0), 0);
        uint8[4] memory bad = [0, 2, 4, 5];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(RecoveryModule.BadGuardians.selector);
            admin.setGuardians(g, bad[i]);
        }
        vm.stopPrank();
    }

    function test_setGuardians_refusesBadEntries() public {
        address[] memory fresh = _guardianSet("fresh");
        address[5] memory bad = [fresh[2], address(0), owner, address(acct), agent]; // fresh[2] = duplicate
        vm.startPrank(owner);
        for (uint256 i; i < bad.length; ++i) {
            address[] memory s = _guardianSet("fresh");
            s[1] = bad[i];
            vm.expectRevert(RecoveryModule.BadGuardians.selector);
            admin.setGuardians(s, 3);
        }
        admin.setGuardians(fresh, 3); // the fresh set itself is fine
        vm.stopPrank();
    }

    function test_setGuardians_resetCancelsPendingAndOldGuardians() public {
        _threeOfFive();
        address[] memory s = _guardianSet("next");
        vm.expectEmit(true, false, false, false, address(acct));
        emit RecoveryModule.RecoveryCancelled(1);
        vm.prank(owner);
        admin.setGuardians(s, 3);
        (, address n,,,) = _pending();
        assertEq(n, address(0), "pending proposal cancelled");
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        admin.executeRecovery();
        vm.expectRevert(RecoveryModule.NotGuardian.selector);
        vm.prank(g[3]);
        admin.approveRecovery(1);
        vm.expectRevert(RecoveryModule.NotGuardian.selector);
        vm.prank(g[0]);
        admin.proposeRecovery(newOwner);
        assertEq(admin.owner(), owner);
    }

    // ---------------------------------------------------------------- proposeRecovery

    function test_propose_notEnabledWithoutGuardians() public {
        AgentAccountAdmin fresh = AgentAccountAdmin(payable(address(factory.createAccount(owner, 7))));
        vm.expectRevert(RecoveryModule.RecoveryNotEnabled.selector);
        vm.prank(g[0]);
        fresh.proposeRecovery(newOwner);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        fresh.executeRecovery();
    }

    function test_propose_nonGuardianRefused() public {
        address[4] memory who = [stranger, owner, agent, address(acct)];
        for (uint256 i; i < who.length; ++i) {
            vm.expectRevert(RecoveryModule.NotGuardian.selector);
            vm.prank(who[i]);
            admin.proposeRecovery(newOwner);
        }
    }

    function test_propose_badNewOwnerRefused() public {
        address[5] memory bad = [address(0), address(acct), owner, g[3], agent];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(AccountCommon.BadAddress.selector, bad[i]));
            vm.prank(g[0]);
            admin.proposeRecovery(bad[i]);
        }
    }

    function test_propose_countsAsProposerApproval() public {
        vm.expectEmit(true, true, true, false, address(acct));
        emit RecoveryModule.RecoveryProposed(1, newOwner, g[2]);
        vm.expectEmit(true, true, false, false, address(acct));
        emit RecoveryModule.RecoveryApproved(1, g[2]);
        _propose(admin, 2, newOwner);
        (uint64 id, address n, uint48 at, uint256 bits, bool vetoed) = _pending();
        assertEq(id, 1);
        assertEq(n, newOwner);
        assertEq(at, block.timestamp);
        assertEq(bits, 1 << 2);
        assertFalse(vetoed);
    }

    function test_propose_oneActiveAtATime() public {
        _propose(admin, 0, newOwner);
        vm.expectRevert(abi.encodeWithSelector(RecoveryModule.RecoveryPending.selector, uint64(1)));
        vm.prank(g[1]);
        admin.proposeRecovery(stranger);
        vm.expectRevert(abi.encodeWithSelector(RecoveryModule.RecoveryPending.selector, uint64(1)));
        vm.prank(g[0]);
        admin.proposeRecovery(stranger);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert(abi.encodeWithSelector(RecoveryModule.RecoveryPending.selector, uint64(1)));
        vm.prank(g[1]);
        admin.proposeRecovery(stranger);
    }

    /// Liveness: a proposal under threshold for 48 h is stale; another guardian may replace it and
    /// the stale proposer is barred, so a minority cannot keep the slot blocked.
    function test_propose_staleReplacedAndProposerBarred() public {
        _propose(admin, 0, attacker); // a lone guardian's bogus proposal
        _approve(admin, 1, 1); // 2 of 3
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(true, false, false, false, address(acct));
        emit RecoveryModule.RecoveryCancelled(1);
        _propose(admin, 2, newOwner);
        (uint64 id, address n,, uint256 bits,) = _pending();
        assertEq(id, 2);
        assertEq(n, newOwner);
        assertEq(bits, 1 << 2, "old approvals do not carry over");
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        vm.prank(g[1]);
        admin.approveRecovery(1);
        // proposal 2 also goes stale: g0 (barred) cannot take the slot back, g3 can
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.GuardianBarred.selector);
        vm.prank(g[0]);
        admin.proposeRecovery(attacker);
        _propose(admin, 3, newOwner);
        // a guardian cannot renew its own stale proposal either
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.GuardianBarred.selector);
        vm.prank(g[3]);
        admin.proposeRecovery(newOwner);
        // the owner's guardian reset clears the bars
        vm.prank(owner);
        admin.setGuardians(g, 3);
        _propose(admin, 0, newOwner);
        (id,,,,) = _pending();
        assertEq(id, 4);
    }

    function test_propose_thresholdReachedNotReplaceable() public {
        _threeOfFive();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(RecoveryModule.RecoveryPending.selector, uint64(1)));
        vm.prank(g[3]);
        admin.proposeRecovery(stranger);
    }

    // ---------------------------------------------------------------- approveRecovery

    function test_approve_nonGuardianRefused() public {
        _propose(admin, 0, newOwner);
        address[4] memory who = [stranger, owner, agent, newOwner];
        for (uint256 i; i < who.length; ++i) {
            vm.expectRevert(RecoveryModule.NotGuardian.selector);
            vm.prank(who[i]);
            admin.approveRecovery(1);
        }
    }

    function test_approve_wrongOrNoProposalRefused() public {
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        _approve(admin, 1, 0);
        _propose(admin, 0, newOwner);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        _approve(admin, 1, 0);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        _approve(admin, 1, 2);
    }

    // ---------------------------------------------------------------- replay

    function test_replay_doubleApprovalRefused() public {
        _propose(admin, 0, newOwner);
        _approve(admin, 1, 1);
        vm.expectRevert(RecoveryModule.AlreadyApproved.selector);
        _approve(admin, 1, 1);
        vm.expectRevert(RecoveryModule.AlreadyApproved.selector);
        _approve(admin, 0, 1); // the proposal already counts as the proposer's approval
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.RecoveryNotReady.selector);
        admin.executeRecovery(); // still 2 distinct
    }

    function test_replay_vetoedApprovalsDoNotCarry() public {
        _threeOfFive();
        vm.prank(owner);
        admin.vetoRecovery();
        _propose(admin, 3, newOwner);
        (uint64 id,,, uint256 bits,) = _pending();
        assertEq(id, 2);
        assertEq(bits, 1 << 3);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        _approve(admin, 1, 1); // approval for the vetoed id
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.RecoveryNotReady.selector);
        admin.executeRecovery();
    }

    /// Same guardians, same proposal id on two accounts: approvals on one never count on the other.
    function test_replay_crossAccount() public {
        AgentAccount acct2 = factory.createAccount(owner, 1);
        AgentAccountAdmin admin2 = AgentAccountAdmin(payable(address(acct2)));
        vm.prank(owner);
        admin2.setGuardians(g, 3);
        _threeOfFive();
        _propose(admin2, 0, newOwner);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.RecoveryNotReady.selector);
        admin2.executeRecovery();
        admin.executeRecovery();
        assertEq(admin.owner(), newOwner);
        assertEq(admin2.owner(), owner, "other account untouched");
    }

    function test_replay_executeOnce() public {
        _threeOfFive();
        vm.warp(block.timestamp + DELAY);
        admin.executeRecovery();
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        admin.executeRecovery();
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        _approve(admin, 3, 1);
        (uint64 id, address n,,,) = _pending();
        assertEq(id, 1);
        assertEq(n, address(0));
    }

    /// A guardian the owner later made a session key loses its vote (agent key leak != guardian vote).
    function test_replay_guardianTurnedSessionKeyCannotAct() public {
        _propose(admin, 0, newOwner);
        vm.prank(owner);
        try admin.setPolicy(g[1], _demoPolicy()) {}
        catch {
            return; // a later setPolicy guard that refuses guardians as keys is equally fine
        }
        vm.expectRevert(RecoveryModule.NotGuardian.selector);
        _approve(admin, 1, 1);
    }

    // ---------------------------------------------------------------- executeRecovery

    function test_execute_twoOfFiveFails() public {
        _propose(admin, 0, newOwner);
        _approve(admin, 4, 1);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.RecoveryNotReady.selector);
        admin.executeRecovery();
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(RecoveryModule.RecoveryNotReady.selector);
        admin.executeRecovery();
        assertEq(admin.owner(), owner);
    }

    function test_execute_beforeDelayFails() public {
        uint256 t0 = block.timestamp;
        _propose(admin, 0, newOwner);
        vm.warp(t0 + 1 hours);
        _approve(admin, 1, 1);
        _approve(admin, 2, 1);
        vm.warp(t0 + DELAY - 1); // the delay runs from the proposal, not the last approval
        vm.expectRevert(RecoveryModule.RecoveryNotReady.selector);
        admin.executeRecovery();
        vm.warp(t0 + DELAY);
        admin.executeRecovery();
        assertEq(admin.owner(), newOwner);
    }

    function test_execute_noProposalFails() public {
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        admin.executeRecovery();
    }

    /// Happy path, executed by a stranger: new owner, every agent key revoked, epoch bumped,
    /// no funds moved, old owner powerless.
    function test_execute_threeOfFiveAfterDelay() public {
        assertEq(_reason(acct, _validAgentOp()), Reason.OK, "agent op valid before recovery");
        uint64 epoch = admin.attestEpoch();
        uint256 usdc0 = usdc.balanceOf(address(acct));
        uint256 eth0 = address(acct).balance;
        uint256 dep0 = admin.getDeposit();
        _threeOfFive();
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(true, true, false, false, address(acct));
        emit AccountCommon.OwnerChanged(owner, newOwner);
        vm.expectEmit(true, true, false, true, address(acct));
        emit AccountCommon.RecoveryApplied(owner, newOwner, epoch + 1);
        vm.prank(stranger);
        admin.executeRecovery();

        assertEq(admin.owner(), newOwner);
        assertEq(admin.attestEpoch(), epoch + 1, "attestEpoch bumped");
        (, Session memory s1) = admin.sessionOf(agent);
        (, Session memory s2) = admin.sessionOf(agent2);
        assertTrue(s1.revoked && s2.revoked, "every agent key revoked");
        assertEq(usdc.balanceOf(address(acct)), usdc0, "no USDC moved");
        assertEq(address(acct).balance, eth0, "no ETH moved");
        assertEq(admin.getDeposit(), dep0, "no deposit moved");
        (address[] memory gs,) = admin.guardians();
        assertEq(gs.length, 5, "guardians kept for the new owner");

        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(owner);
        admin.setRecipient(attacker, true);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(owner);
        admin.vetoRecovery();
    }

    /// After recovery the leaked agent key and the old owner key are dead on the UserOp path;
    /// the new owner acts through the normal owner path and can re-enable a key.
    function test_execute_killsOldKeysOnUserOpPath() public {
        PackedUserOperation memory oldOwnerOp = _ownerExecOp(acct, stranger, 0, "");
        _threeOfFive();
        vm.warp(block.timestamp + DELAY);
        admin.executeRecovery();

        PackedUserOperation memory agentOp = _validAgentOp();
        assertEq(_reason(acct, agentOp), Reason.REVOKED);
        _expectAA24(agentOp);
        _expectAA24(oldOwnerOp); // signed by the old owner before recovery, submitted after

        bytes memory cd = abi.encodeWithSelector(acct.execute.selector, stranger, 0, "");
        assertTrue(_handle(_signOwner(_op(address(acct), ep.getNonce(address(acct), 0), cd), NEW_OWNER_PK)));

        vm.prank(newOwner);
        admin.setPolicy(agent, _demoPolicy());
        assertEq(_reason(acct, _validAgentOp()), Reason.OK, "new owner re-enabled the key");
    }

    function test_execute_agentCannotDriveRecovery() public {
        _threeOfFive();
        vm.warp(block.timestamp + DELAY);
        _expectAA24(_agentOp(acct, AGENT_PK, address(acct), 0, abi.encodeCall(RecoveryModule.executeRecovery, ())));
        _expectAA24(_agentOp(acct, AGENT_PK, address(acct), 0, abi.encodeCall(RecoveryModule.vetoRecovery, ())));
        assertEq(admin.owner(), owner);
    }

    // ---------------------------------------------------------------- vetoRecovery

    function test_veto_ownerOnly() public {
        _propose(admin, 0, newOwner);
        address[3] memory who = [stranger, g[1], agent];
        for (uint256 i; i < who.length; ++i) {
            vm.expectRevert(AccountCommon.NotOwner.selector);
            vm.prank(who[i]);
            admin.vetoRecovery();
        }
    }

    function test_veto_cancelsPending() public {
        _propose(admin, 0, newOwner);
        _approve(admin, 1, 1);
        vm.expectEmit(true, false, false, false, address(acct));
        emit RecoveryModule.RecoveryVetoed(1);
        vm.prank(owner);
        admin.vetoRecovery();
        (uint64 id, address n,,, bool vetoed) = _pending();
        assertEq(id, 1);
        assertEq(n, address(0));
        assertTrue(vetoed);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        _approve(admin, 2, 1);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        admin.executeRecovery();
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        vm.prank(owner);
        admin.vetoRecovery();
        // the vetoing owner does not bar the proposer: a new proposal starts clean
        _propose(admin, 0, newOwner);
        (id,,,, vetoed) = _pending();
        assertEq(id, 2);
        assertFalse(vetoed);
    }

    /// The veto stays open after the 48 h delay, until someone executes.
    function test_veto_afterDelayBeforeExecution() public {
        _threeOfFive();
        vm.warp(block.timestamp + 3 days);
        vm.prank(owner);
        admin.vetoRecovery();
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        admin.executeRecovery();
        assertEq(admin.owner(), owner);
    }

    function test_veto_nothingPending() public {
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        vm.prank(owner);
        admin.vetoRecovery();
    }

    // ---------------------------------------------------------------- size

    function test_size_underEip170() public view {
        address adminLogic = acct.admin();
        assertLt(adminLogic.code.length, 24_577, "AgentAccountAdmin runtime <= 24,576 B");
    }
}
