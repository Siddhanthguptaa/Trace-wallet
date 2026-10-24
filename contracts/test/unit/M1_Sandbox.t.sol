// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {AccountCommon, AgentAccountBase} from "../../src/AgentAccountBase.sol";
import {FreezeModule} from "../../src/modules/FreezeModule.sol";
import {MeterModule} from "../../src/modules/MeterModule.sol";
import {RecoveryModule} from "../../src/modules/RecoveryModule.sol";
import {AgentCall, OpContext, Outflow, Reason, Session} from "../../src/lib/PolicyTypes.sol";

/// Test-only account: switchable tripwires / meter breach, and a door to the recovery hook.
contract SandboxHarness is AgentAccount {
    struct Mode {
        bool tripPre;
        bool tripPost;
        bool breach;
    }

    bytes32 private constant MODE_SLOT = keccak256("hypnexis.test.SandboxHarness.mode");

    constructor(IEntryPoint ep_, address admin_) AgentAccount(ep_, admin_) {}

    function _mode() private pure returns (Mode storage m) {
        bytes32 slot = MODE_SLOT;
        assembly ("memory-safe") {
            m.slot := slot
        }
    }

    function setMode(bool tripPre, bool tripPost, bool breach) external {
        _mode().tripPre = tripPre;
        _mode().tripPost = tripPost;
        _mode().breach = breach;
    }

    function applyRecoveryForTest(address newOwner) external {
        _applyRecovery(newOwner);
    }

    function _preCallTripwire(OpContext memory ctx, AgentCall memory call)
        internal
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return _mode().tripPre || super._preCallTripwire(ctx, call);
    }

    function _postCallTripwire(OpContext memory ctx, AgentCall memory call, Outflow[] memory o)
        internal
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return _mode().tripPost || super._postCallTripwire(ctx, call, o);
    }

    function _meterAfter(OpContext memory ctx, AgentCall memory call, bytes memory snap)
        internal
        override(AgentAccountBase, MeterModule)
        returns (Outflow[] memory)
    {
        if (_mode().breach) revert PolicyViolation(Reason.KEY_BUCKET);
        return super._meterAfter(ctx, call, snap);
    }
}

/// Phase 2 core hooks: execution sandbox (outer persists, inner reverts), FreezeModule,
/// RecoveryModule hook, owner-set paymaster (tested in M1_Account).
contract M1SandboxTest is M1Fixture {
    SandboxHarness internal h;
    AgentAccountAdmin internal hAdmin;

    function setUp() public {
        _setUpFixture();
        AgentAccount impl = new SandboxHarness(IEntryPoint(address(ep)), factory.accountImplementation().admin());
        AgentAccountFactory hf = new AgentAccountFactory(impl);
        h = SandboxHarness(payable(address(hf.createAccount(owner, 1))));
        hAdmin = AgentAccountAdmin(payable(address(h)));
        _configureDemo(h, agent);
        usdc.mint(address(h), 100e6);
        vm.prank(owner);
        hAdmin.addDeposit{value: 1 ether}();
    }

    function _pay(AgentAccount a, uint256 amount) internal view returns (PackedUserOperation memory) {
        return _agentOp(a, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(grocery), amount));
    }

    function test_sandbox_postTripwireUndoesAndFreezes() public {
        h.setMode(false, true, false);
        PackedUserOperation memory op = _pay(h, 1e6);
        bytes32 uoh = ep.getUserOpHash(op);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.AgentFrozen(agent, address(h), uoh);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.PolicyBlocked(
            uoh, agent, address(usdc), TRANSFER, abi.encodeWithSelector(AccountCommon.TripwireTripped.selector, uint8(1))
        );
        assertTrue(_handle(op), "outer frame returns normally so the freeze persists");
        assertEq(usdc.balanceOf(address(grocery)), 0, "inner frame reverted: the transfer is undone");
        assertTrue(hAdmin.isFrozen(agent));
        assertEq(hAdmin.strikes(agent), 1);
        h.setMode(false, false, false);
        PackedUserOperation memory next = _pay(h, 1e6);
        assertEq(_reason(h, next), Reason.FROZEN);
        _expectAA24(next);
    }

    function test_sandbox_preTripwire() public {
        h.setMode(true, false, false);
        assertTrue(_handle(_pay(h, 1e6)));
        assertEq(usdc.balanceOf(address(grocery)), 0);
        assertTrue(hAdmin.isFrozen(agent));
    }

    function test_sandbox_policyBreachStrikeNoFreeze() public {
        h.setMode(false, false, true);
        PackedUserOperation memory op = _pay(h, 2e6);
        bytes32 uoh = ep.getUserOpHash(op);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.PolicyBlocked(
            uoh,
            agent,
            address(usdc),
            TRANSFER,
            abi.encodeWithSelector(AccountCommon.PolicyViolation.selector, Reason.KEY_BUCKET)
        );
        assertTrue(_handle(op));
        assertEq(usdc.balanceOf(address(grocery)), 0, "meter breach undone");
        assertEq(hAdmin.strikes(agent), 1, "strike recorded in the outer frame");
        assertFalse(hAdmin.isFrozen(agent), "stub: strikes alone do not freeze");
        h.setMode(false, false, false);
        assertTrue(_handle(_pay(h, 2e6)));
        assertEq(usdc.balanceOf(address(grocery)), 2e6);
    }

    function test_sandbox_targetRevertBubbles() public {
        bytes memory failing = abi.encodeWithSelector(ORDER, 5e6, address(acct)); // no allowance
        assertFalse(_handle(_agentOp(acct, AGENT_PK, address(grocery), 0, failing)), "success = false");
        assertEq(admin.strikes(agent), 0, "an honest target revert is not a strike");
        assertFalse(admin.isFrozen(agent));
    }

    function test_sandbox_innerOnlySelfAndArmed() public {
        OpContext memory ctx;
        AgentCall memory call;
        call.target = address(usdc);
        call.data = abi.encodeWithSelector(TRANSFER, attacker, 1e6);
        vm.expectRevert(AccountCommon.NotSelf.selector);
        acct.agentInnerExecute(ctx, call, "");
        // An owner op calling the inner frame through a self-call is not armed.
        bytes memory inner = abi.encodeCall(AgentAccount.agentInnerExecute, (ctx, call, bytes("")));
        assertFalse(_handle(_ownerExecOp(acct, address(acct), 0, inner)), "InnerNotArmed");
        assertEq(usdc.balanceOf(attacker), 0);
        // The agent can never reach it: self target is refused in validation.
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(acct), 0, inner);
        assertEq(_reason(acct, op), Reason.OP_SHAPE);
    }

    function test_freeze_ownerAndWatcher() public {
        PackedUserOperation memory op = _pay(acct, 1e6);
        vm.prank(owner);
        admin.freeze(agent);
        assertEq(_reason(acct, op), Reason.FROZEN);
        vm.prank(owner);
        admin.unfreeze(agent);
        assertEq(_reason(acct, op), Reason.OK);

        address w = makeAddr("watcher");
        vm.prank(owner);
        admin.setWatcher(w);
        assertEq(admin.watcher(), w);
        vm.prank(w);
        admin.freeze(agent);
        assertTrue(admin.isFrozen(agent), "watcher may freeze");
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(w);
        admin.unfreeze(agent);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(stranger);
        admin.freeze(agent2);
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.AgentKeyActive.selector, agent));
        vm.prank(owner);
        admin.setWatcher(agent);
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.BadAddress.selector, w));
        vm.prank(owner);
        admin.setPolicy(w, _demoPolicy());
    }

    function test_recovery_applyRevokesAllAndBumpsEpoch() public {
        vm.prank(owner);
        hAdmin.setPolicy(agent2, _demoPolicy());
        uint64 epoch = hAdmin.attestEpoch();
        address newOwner = makeAddr("recoveredOwner");
        h.applyRecoveryForTest(newOwner);
        assertEq(hAdmin.owner(), newOwner);
        assertEq(hAdmin.attestEpoch(), epoch + 1);
        (, Session memory s1) = hAdmin.sessionOf(agent);
        (, Session memory s2) = hAdmin.sessionOf(agent2);
        assertTrue(s1.revoked && s2.revoked, "every agent key revoked");
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(owner);
        hAdmin.setRecipient(attacker, true);
    }

    /// Guardian setup and the access gates around the real RecoveryModule (flows: M11_Recovery.t.sol).
    function test_recovery_gates() public {
        address[] memory g = new address[](5);
        for (uint256 i; i < 5; ++i) {
            g[i] = makeAddr(string(abi.encodePacked("guardian", i)));
        }
        vm.expectRevert(AccountCommon.NotOwner.selector);
        admin.setGuardians(g, 3);
        vm.prank(owner);
        admin.setGuardians(g, 3);
        (address[] memory got, uint8 thr) = admin.guardians();
        assertEq(got.length, 5);
        assertEq(thr, 3);
        vm.expectRevert(RecoveryModule.NotGuardian.selector);
        vm.prank(stranger);
        admin.proposeRecovery(stranger);
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        admin.executeRecovery();
        vm.expectRevert(AccountCommon.NotOwner.selector);
        admin.vetoRecovery();
        vm.prank(g[0]);
        admin.proposeRecovery(makeAddr("newOwner"));
        vm.prank(owner);
        admin.vetoRecovery();
        vm.expectRevert(RecoveryModule.NoRecovery.selector);
        admin.executeRecovery();
    }
}
