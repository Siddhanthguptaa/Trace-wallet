// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {FrzHarness} from "./M10_Harness.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {FreezeAdmin, FreezeStorage} from "../../src/modules/FreezeModule.sol";
import {AgentCall, OpContext, Outflow, Reason, Track, Tier} from "../../src/lib/PolicyTypes.sol";

/// M10 (lane FRZ): FreezeModule tripwires T1-T4, freeze / unfreeze, watcher role, FROZEN in validation.
/// Most tests run on FrzHarness (real FreezeModule; meter = decoded amount, tier = listed / unproven)
/// so they do not depend on the D2 / D3 fills; the T4 canary tests also run on the real account.
contract M10FreezeTest is M1Fixture {
    FrzHarness internal h;
    AgentAccountAdmin internal hAdmin;
    address internal watcherAddr;

    // Demo policy: cap = 10e6 burst + 10e6 / day = 20e6; default T1 = 40% = 8e6 per clock-hour pair.
    uint256 internal constant T1_LIMIT = 8e6;

    function setUp() public {
        _setUpFixture();
        AgentAccount impl = new FrzHarness(IEntryPoint(address(ep)), factory.accountImplementation().admin());
        AgentAccountFactory hf = new AgentAccountFactory(impl);
        h = FrzHarness(payable(address(hf.createAccount(owner, 10))));
        hAdmin = AgentAccountAdmin(payable(address(h)));
        _configureDemo(h, agent);
        usdc.mint(address(h), 100e6);
        vm.prank(owner);
        hAdmin.addDeposit{value: 1 ether}();
        watcherAddr = makeAddr("watcher");
        vm.prank(owner);
        hAdmin.setWatcher(watcherAddr);
    }

    // ------------------------------------------------------------------ helpers

    function _payOp(AgentAccount a, address to, uint256 amount) internal view returns (PackedUserOperation memory) {
        return _agentOp(a, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, to, amount));
    }

    function _pay(address to, uint256 amount) internal returns (bool) {
        return _handle(_payOp(h, to, amount));
    }

    function _fresh(uint256 i) internal returns (address) {
        return makeAddr(string(abi.encodePacked("fresh", vm.toString(i))));
    }

    function _setParam(AgentAccountAdmin ad, bytes32 key, uint256 v) internal {
        vm.prank(owner);
        ad.setFreezeParam(key, v);
    }

    function _tripData(uint8 stage) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AccountCommon.TripwireTripped.selector, stage);
    }

    // ------------------------------------------------------------------ config

    function test_defaults_andParamKeys() public view {
        assertEq(FreezeStorage.DEFAULT_VELOCITY_BPS, 4000);
        assertEq(FreezeStorage.DEFAULT_SPRAY_MAX, 5);
        assertEq(FreezeStorage.DEFAULT_STRIKE_MAX, 3);
        assertEq(FreezeStorage.P_VELOCITY_BPS, keccak256("hypnexis.freeze.velocityBps"));
        assertEq(FreezeStorage.P_SPRAY_MAX, keccak256("hypnexis.freeze.sprayMax"));
        assertEq(FreezeStorage.P_STRIKE_MAX, keccak256("hypnexis.freeze.strikeMax"));
        assertEq(hAdmin.freezeParam(FreezeStorage.P_VELOCITY_BPS), 0, "unset = default");
        assertEq(FreezeStorage.canaryId(address(0xBEEF)), bytes32(uint256(0xBEEF)));
    }

    function test_setFreezeParam_ownerOnly() public {
        bytes32 k = FreezeStorage.P_STRIKE_MAX;
        vm.expectEmit(true, false, false, true, address(h));
        emit FreezeAdmin.FreezeParamSet(k, 7);
        _setParam(hAdmin, k, 7);
        assertEq(hAdmin.freezeParam(k), 7);
        address[3] memory notOwner = [watcherAddr, agent, stranger];
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(AccountCommon.NotOwner.selector);
            vm.prank(notOwner[i]);
            hAdmin.setFreezeParam(k, 0);
        }
        // An owner op (self-call through the EntryPoint) may set it too.
        bytes memory cd = abi.encodeCall(FreezeAdmin.setFreezeParam, (k, 9));
        assertTrue(_handle(_ownerExecOp(h, address(h), 0, cd)));
        assertEq(hAdmin.freezeParam(k), 9);
    }

    // ------------------------------------------------------------------ T1 velocity

    function test_T1_tripsAboveFractionOfDailyCap() public {
        assertTrue(_pay(address(grocery), 5e6));
        assertTrue(_pay(address(grocery), 3e6)); // exactly 40%: not above
        assertFalse(hAdmin.isFrozen(agent));
        PackedUserOperation memory op = _payOp(h, address(grocery), 1);
        bytes32 uoh = ep.getUserOpHash(op);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.AgentFrozen(agent, address(h), uoh);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.PolicyBlocked(uoh, agent, address(usdc), TRANSFER, _tripData(1));
        assertTrue(_handle(op), "outer frame returns normally");
        assertEq(usdc.balanceOf(address(grocery)), T1_LIMIT, "the tripping transfer is undone");
        assertTrue(hAdmin.isFrozen(agent));
        assertEq(hAdmin.strikes(agent), 1);
        PackedUserOperation memory next = _payOp(h, address(grocery), 1);
        assertEq(_reason(h, next), Reason.FROZEN);
        _expectAA24(next);
    }

    function test_T1_clockHourPair() public {
        assertTrue(_pay(address(grocery), 5e6));
        vm.warp(block.timestamp + 1 hours); // next clock hour: previous hour still counts
        assertTrue(_pay(address(grocery), 3e6));
        assertTrue(_pay(address(grocery), 1));
        assertTrue(hAdmin.isFrozen(agent), "5e6 + 3e6 + 1 in the pair > 8e6");
        assertEq(usdc.balanceOf(address(grocery)), 8e6);
    }

    function test_T1_windowAgesOut() public {
        assertTrue(_pay(address(grocery), 7e6));
        vm.warp(block.timestamp + 2 hours); // two clock hours later: the old hour is gone
        assertTrue(_pay(address(grocery), 3e6));
        assertFalse(hAdmin.isFrozen(agent));
        assertEq(usdc.balanceOf(address(grocery)), 10e6);
    }

    function test_T1_ownerThreshold() public {
        _setParam(hAdmin, FreezeStorage.P_VELOCITY_BPS, 1000); // 10% = 2e6
        assertTrue(_pay(address(grocery), 2e6));
        assertTrue(_pay(address(grocery), 1));
        assertTrue(hAdmin.isFrozen(agent));
        assertEq(usdc.balanceOf(address(grocery)), 2e6);
    }

    function test_T1_disabledAt10000Bps() public {
        _setParam(hAdmin, FreezeStorage.P_VELOCITY_BPS, 10_000);
        for (uint256 i; i < 2; ++i) {
            assertTrue(_pay(address(grocery), 10e6));
        }
        assertFalse(hAdmin.isFrozen(agent), "harness meter has no buckets; T1 off");
        assertEq(usdc.balanceOf(address(grocery)), 20e6);
        _setParam(hAdmin, FreezeStorage.P_VELOCITY_BPS, type(uint256).max); // no overflow either
        assertTrue(_pay(address(grocery), 10e6));
        assertFalse(hAdmin.isFrozen(agent));
    }

    function test_T1_skipsApprovalTrackAndUncappedAssets() public {
        OpContext memory ctx;
        ctx.agentKey = agent;
        Outflow[] memory o = new Outflow[](1);
        o[0] = Outflow(address(usdc), 15e6);
        ctx.track = Track.APPROVAL;
        assertFalse(h.xPost(ctx, o), "owner-approved outflow is not counted");
        ctx.track = Track.NORMAL;
        o[0] = Outflow(address(0xDEAD), 1e30);
        assertFalse(h.xPost(ctx, o), "asset without a global cap is ignored");
        o[0] = Outflow(address(usdc), 0);
        assertFalse(h.xPost(ctx, o));
        o[0] = Outflow(address(usdc), 15e6);
        assertTrue(h.xPost(ctx, o));
    }

    function test_T1_saturatesNoOverflow() public {
        OpContext memory ctx;
        ctx.agentKey = agent;
        Outflow[] memory o = new Outflow[](2);
        o[0] = Outflow(address(0xDEAD), type(uint256).max);
        o[1] = Outflow(address(0xDEAD), type(uint256).max);
        assertFalse(h.xPost(ctx, o)); // uncapped asset, window saturates at uint112 max
        o[0] = Outflow(address(usdc), type(uint256).max);
        assertTrue(h.xPost(ctx, o));
    }

    // ------------------------------------------------------------------ T2 new-payee spray

    function test_T2_sprayTripsOnSixthDistinctUnprovenPayee() public {
        for (uint256 i; i < 5; ++i) {
            assertTrue(_pay(_fresh(i), 1000));
            assertTrue(_pay(_fresh(i), 1000)); // repeat payee in the same hour: counted once
        }
        assertFalse(hAdmin.isFrozen(agent));
        address sixth = _fresh(5);
        PackedUserOperation memory op = _payOp(h, sixth, 1000);
        bytes32 uoh = ep.getUserOpHash(op);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.PolicyBlocked(uoh, agent, address(usdc), TRANSFER, _tripData(0));
        assertTrue(_handle(op));
        assertTrue(hAdmin.isFrozen(agent));
        assertEq(usdc.balanceOf(sixth), 0, "pre-call trip: no transfer");
    }

    function test_T2_provenPayeesNotCounted() public {
        for (uint256 i; i < 8; ++i) {
            assertTrue(_pay(address(grocery), 1000));
            assertTrue(_pay(address(api), 1000));
        }
        assertFalse(hAdmin.isFrozen(agent));
    }

    function test_T2_windowAgesOut() public {
        for (uint256 i; i < 5; ++i) {
            assertTrue(_pay(_fresh(i), 1000));
        }
        vm.warp(block.timestamp + 2 hours);
        for (uint256 i = 5; i < 10; ++i) {
            assertTrue(_pay(_fresh(i), 1000));
        }
        assertFalse(hAdmin.isFrozen(agent));
    }

    function test_T2_ownerThreshold() public {
        _setParam(hAdmin, FreezeStorage.P_SPRAY_MAX, 1);
        assertTrue(_pay(_fresh(0), 1000));
        assertTrue(_pay(_fresh(1), 1000));
        assertTrue(hAdmin.isFrozen(agent));
        assertEq(usdc.balanceOf(_fresh(1)), 0);
    }

    // ------------------------------------------------------------------ T3 strike streak

    function test_T3_thirdStrikeFreezes() public {
        h.setBreach(true);
        assertTrue(_pay(address(grocery), 1e6));
        assertTrue(_pay(address(grocery), 1e6));
        assertFalse(hAdmin.isFrozen(agent), "2 strikes: not yet");
        PackedUserOperation memory op = _payOp(h, address(grocery), 1e6);
        bytes32 uoh = ep.getUserOpHash(op);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.AgentFrozen(agent, address(h), uoh);
        assertTrue(_handle(op));
        assertTrue(hAdmin.isFrozen(agent));
        assertEq(hAdmin.strikes(agent), 3);
        assertEq(usdc.balanceOf(address(grocery)), 0);
    }

    function test_T3_streakWindowAndUnfreezeReset() public {
        h.setBreach(true);
        assertTrue(_pay(address(grocery), 1e6));
        assertTrue(_pay(address(grocery), 1e6));
        vm.warp(block.timestamp + 2 hours);
        assertTrue(_pay(address(grocery), 1e6));
        assertFalse(hAdmin.isFrozen(agent), "old strikes aged out");
        assertEq(hAdmin.strikes(agent), 3, "strikes() counts every block since the last unfreeze");
        assertTrue(_pay(address(grocery), 1e6));
        assertTrue(_pay(address(grocery), 1e6));
        assertTrue(hAdmin.isFrozen(agent), "3 in the pair");
        vm.prank(owner);
        hAdmin.unfreeze(agent);
        assertEq(hAdmin.strikes(agent), 0);
        assertTrue(_pay(address(grocery), 1e6));
        assertFalse(hAdmin.isFrozen(agent), "unfreeze resets the streak");
        assertEq(hAdmin.strikes(agent), 1);
    }

    function test_T3_ownerThreshold() public {
        _setParam(hAdmin, FreezeStorage.P_STRIKE_MAX, 1);
        h.setBreach(true);
        assertTrue(_pay(address(grocery), 1e6));
        assertTrue(hAdmin.isFrozen(agent));
    }

    function testFuzz_T3_onBlockedNeverReverts(uint32 dt, uint8 n, bool tripped) public {
        n = uint8(bound(n, 1, 40));
        for (uint256 i; i < n; ++i) {
            vm.warp(block.timestamp + bound(uint256(dt) * (i + 1), 0, 30 days));
            bool f = h.xOnBlocked(agent, tripped);
            if (tripped) assertTrue(f, "a tripwire always freezes");
        }
        assertEq(hAdmin.strikes(agent), n);
    }

    // ------------------------------------------------------------------ T4 canary

    function test_T4_canaryPayee() public {
        address honeypot = makeAddr("refundWallet");
        _setParam(hAdmin, FreezeStorage.canaryId(honeypot), 1);
        PackedUserOperation memory op = _payOp(h, honeypot, 1000);
        bytes32 uoh = ep.getUserOpHash(op);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.AgentFrozen(agent, address(h), uoh);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.PolicyBlocked(uoh, agent, address(usdc), TRANSFER, _tripData(0));
        assertTrue(_handle(op));
        assertEq(usdc.balanceOf(honeypot), 0);
        assertTrue(hAdmin.isFrozen(agent));
    }

    /// On the real AgentAccount (whatever the D2 / D3 fills are): the pre-call canary trips first.
    function test_T4_canarySelector_realAccount() public {
        _setParam(admin, bytes32(APPROVE), 1);
        assertTrue(_handle(_agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(APPROVE, address(ticket), 1e6))));
        assertEq(usdc.allowance(address(acct), address(ticket)), 0);
        assertTrue(admin.isFrozen(agent));
        assertEq(_reason(acct, _payOp(acct, address(grocery), 1e6)), Reason.FROZEN);
    }

    function test_T4_canaryTarget_realAccount() public {
        _setParam(admin, FreezeStorage.canaryId(address(ticket)), 1);
        bytes memory buy = abi.encodeWithSelector(BUY, uint256(1), address(acct));
        assertTrue(_handle(_agentOp(acct, AGENT_PK, address(ticket), 0, buy)));
        assertTrue(admin.isFrozen(agent));
        assertEq(ticket.balanceOf(address(acct)), 0);
        // Turning the canary off and unfreezing restores the key.
        _setParam(admin, FreezeStorage.canaryId(address(ticket)), 0);
        vm.prank(owner);
        admin.unfreeze(agent);
        assertEq(_reason(acct, _payOp(acct, address(grocery), 1e6)), Reason.OK);
    }

    function test_T4_keyZeroIsPlainValueSendCanary() public {
        OpContext memory ctx;
        ctx.agentKey = agent;
        AgentCall memory call;
        call.target = address(grocery);
        assertFalse(h.xPre(ctx, call));
        _setParam(hAdmin, bytes32(0), 1);
        assertTrue(h.xPre(ctx, call), "selector 0x00000000 canary");
        call.selector = TRANSFER;
        assertFalse(h.xPre(ctx, call));
    }

    // ------------------------------------------------------------------ freeze / unfreeze / watcher

    function test_watcher_escalateOnly() public {
        vm.expectEmit(true, true, false, true, address(h));
        emit AccountCommon.AgentFrozen(agent, watcherAddr, bytes32(0));
        vm.prank(watcherAddr);
        hAdmin.freeze(agent);
        assertTrue(hAdmin.isFrozen(agent));
        vm.startPrank(watcherAddr);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        hAdmin.unfreeze(agent);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        hAdmin.setFreezeParam(FreezeStorage.P_STRIKE_MAX, 1000);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        hAdmin.setWatcher(stranger);
        vm.stopPrank();
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(stranger);
        hAdmin.freeze(agent2);
        // Freezing twice is idempotent; still frozen.
        vm.prank(watcherAddr);
        hAdmin.freeze(agent);
        assertTrue(hAdmin.isFrozen(agent));
        // Removing the watcher removes the role.
        vm.prank(owner);
        hAdmin.setWatcher(address(0));
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(watcherAddr);
        hAdmin.freeze(agent2);
    }

    function test_unfreeze_ownerOpAndAgentCannot() public {
        vm.prank(watcherAddr);
        hAdmin.freeze(agent);
        bytes memory unf = abi.encodeCall(FreezeAdmin.unfreeze, (agent));
        // The frozen agent cannot reach unfreeze: agent ops may not target the account.
        PackedUserOperation memory self = _agentOp(h, AGENT_PK, address(h), 0, unf);
        assertEq(_reason(h, self), Reason.OP_SHAPE);
        _expectAA24(self);
        vm.expectEmit(true, false, false, false, address(h));
        emit AccountCommon.AgentUnfrozen(agent);
        assertTrue(_handle(_ownerExecOp(h, address(h), 0, unf)), "owner op unfreezes");
        assertFalse(hAdmin.isFrozen(agent));
        assertTrue(_pay(address(grocery), 1e6));
    }

    function test_frozen_refusedInValidationAndLens() public {
        vm.prank(watcherAddr);
        hAdmin.freeze(agent);
        PackedUserOperation memory op = _payOp(h, address(grocery), 1e6);
        assertEq(_reason(h, op), Reason.FROZEN);
        (uint16 r,,,) = h.policyCheck(agent, op.callData, "", "");
        assertEq(r, Reason.FROZEN);
        _expectAA24(op);
        // Another key on the same account is unaffected.
        vm.prank(owner);
        hAdmin.setPolicy(agent2, _demoPolicy());
        assertTrue(_handle(_agentOp(h, AGENT2_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(grocery), 1e6))));
        assertEq(usdc.balanceOf(address(grocery)), 1e6);
    }

    /// Two ops of one key in one bundle: both validate first; the first trips and freezes, the
    /// second is caught by the execution re-check (FROZEN) and moves nothing.
    function test_sameBundle_reCheckCatchesSecondOp() public {
        address honeypot = makeAddr("refundWallet");
        _setParam(hAdmin, FreezeStorage.canaryId(honeypot), 1);
        uint256 n = _agentNonce(h, agent);
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signAgent(_op(address(h), n, _agentCall(address(usdc), 0, abi.encodeWithSelector(TRANSFER, honeypot, 1000))), AGENT_PK);
        ops[1] = _signAgent(
            _op(address(h), n + 1, _agentCall(address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(grocery), 1e6))),
            AGENT_PK
        );
        bytes32 uoh2 = ep.getUserOpHash(ops[1]);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.PolicyBlocked(
            uoh2,
            agent,
            address(usdc),
            TRANSFER,
            abi.encodeWithSelector(AccountCommon.PolicyViolation.selector, Reason.FROZEN)
        );
        bool[] memory ok = _handleMany(ops);
        assertTrue(ok[0] && ok[1]);
        assertEq(usdc.balanceOf(honeypot), 0);
        assertEq(usdc.balanceOf(address(grocery)), 0);
        assertTrue(hAdmin.isFrozen(agent));
    }
}
