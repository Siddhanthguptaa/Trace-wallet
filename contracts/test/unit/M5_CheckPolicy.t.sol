// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {M5Fixture} from "./M5_Fixture.sol";
import {PolicyLens} from "../../src/lens/PolicyLens.sol";
import {MockUSDC3009} from "../../src/mocks/MockUSDC3009.sol";
import {TypedData} from "../../src/lib/TypedData.sol";
import {PolicyInput, AssetInput, Outflow, Reason, Track, Tier, Session, NATIVE} from "../../src/lib/PolicyTypes.sol";

/// M5 `checkPolicy` lens (src/lens/PolicyLens.sol): every IDEA 7.2 reason code (docs/api.md 7.1)
/// is produced by at least one test, on the demo policy.
contract M5CheckPolicyTest is M5Fixture {
    function setUp() public {
        _setUpM5();
    }

    function _check(bytes memory cd) internal view returns (bool ok, Track track, uint16 code) {
        return lens.checkPolicy(address(h), agent, cd, "");
    }

    function _expect(bytes memory cd, uint16 want) internal view {
        (bool ok,, uint16 code) = _check(cd);
        assertEq(code, want, "reason code");
        assertEq(ok, want == Reason.OK, "ok iff OK");
    }

    function _query(bytes memory cd) internal view returns (PolicyLens.Query memory q) {
        q.account = address(h);
        q.agentKey = agent;
        q.callData = cd;
    }

    // ------------------------------------------------------------------ OK baselines

    function test_checkPolicy_OK() public view {
        (bool ok, Track track, uint16 code) = _check(_payData(address(grocery), 1e6));
        assertTrue(ok);
        assertEq(uint8(track), uint8(Track.NORMAL));
        assertEq(code, Reason.OK);
        (ok, track, code) = _check(_payData(newShop, 0.1e6)); // unproven payee within the explore caps
        assertTrue(ok);
        assertEq(uint8(track), uint8(Track.EXPLORE));
        PolicyLens.Result memory r = lens.checkPolicyEx(_query(_payData(address(grocery), 1e6)));
        assertEq(uint8(r.tier), uint8(Tier.PROVEN));
        assertEq(r.outflows.length, 1);
        assertEq(r.outflows[0].asset, address(usdc));
        assertEq(r.outflows[0].amount, 1e6);
        assertEq(r.maxGasCost, (uint256(MAX_VERIF_GAS) + MAX_CALL_GAS + MAX_PVG) * MAX_FEE, "worst case at caps");
    }

    // ------------------------------------------------------------------ the 12 codes

    function test_checkPolicy_REVOKED() public {
        vm.prank(owner);
        hAdmin.revoke(agent);
        _expect(_payData(address(grocery), 1e6), Reason.REVOKED);
    }

    function test_checkPolicy_EXPIRED() public {
        // An approval's validUntil folds in (validation would return it to the EntryPoint).
        PolicyLens.Query memory q = _query(_payData(address(grocery), 15e6));
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), 15e6, 15e6, 1);
        a.validUntil = uint48(block.timestamp + 60);
        q.approval = _signAppr(OWNER_PK, a);
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.OK);
        vm.warp(block.timestamp + 61);
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.EXPIRED);
        // Session window: validAfter < now <= validUntil.
        (, Session memory s) = hAdmin.sessionOf(agent);
        vm.warp(s.validUntil);
        _expect(_payData(address(grocery), 1e6), Reason.OK);
        vm.warp(s.validUntil + 1);
        _expect(_payData(address(grocery), 1e6), Reason.EXPIRED);
        _expect(_agentCall(attacker, 0, ""), Reason.EXPIRED); // before rule codes (IDEA 7.2 order)
        // Not yet valid.
        PolicyInput memory p = _demoPolicy();
        p.validAfter = uint48(block.timestamp + 100);
        p.validUntil = uint48(block.timestamp + 1 days);
        vm.prank(owner);
        hAdmin.setPolicy(agent, p);
        _expect(_payData(address(grocery), 1e6), Reason.EXPIRED);
    }

    function test_checkPolicy_TARGET() public {
        MockUSDC3009 other = new MockUSDC3009();
        _expect(_agentCall(address(other), 0, abi.encodeWithSelector(TRANSFER, address(grocery), 1e6)), Reason.TARGET);
    }

    function test_checkPolicy_ARG_RULE() public view {
        // USDC approve rule 1: amount LTE 10 USDC.
        bytes memory cd = _agentCall(address(usdc), 0, abi.encodeWithSelector(APPROVE, address(grocery), 11e6));
        (bool ok,, uint16 code) = _check(cd);
        assertFalse(ok);
        assertEq(code, Reason.argRule(1));
        assertEq(Reason.code(code), Reason.ARG_RULE);
        assertEq(Reason.detail(code), 1);
    }

    function test_checkPolicy_RECIPIENT() public view {
        _expect(_agentCall(address(usdc), 0, abi.encodeWithSelector(APPROVE, attacker, 1e6)), Reason.RECIPIENT);
    }

    function test_checkPolicy_FLAGGED() public {
        vm.prank(owner);
        hAdmin.flag(address(grocery));
        _expect(_payData(address(grocery), 1e6), Reason.FLAGGED); // PAYEE tier
        (, , uint16 code) = _check(_agentCall(address(usdc), 0, abi.encodeWithSelector(APPROVE, address(grocery), 1e6)));
        assertEq(Reason.code(code), Reason.FLAGGED); // IN_RECIPIENTS rule
    }

    function test_checkPolicy_PER_TX() public view {
        _expect(_payData(address(grocery), PER_TX + 1), Reason.PER_TX);
        _expect(_payData(address(grocery), PER_TX), Reason.OK);
    }

    function test_checkPolicy_EXPLORE_PER_TX() public view {
        uint256 cap = hAdmin.explorePerTxCap(address(usdc)); // 1% of the 20 USDC global cap
        assertEq(cap, 0.2e6);
        (bool ok, Track track, uint16 code) = _check(_payData(newShop, cap + 1));
        assertFalse(ok);
        assertEq(uint8(track), uint8(Track.EXPLORE));
        assertEq(code, Reason.EXPLORE_PER_TX);
        _expect(_payData(newShop, cap), Reason.OK);
    }

    function test_checkPolicy_KEY_BUCKET() public {
        PolicyInput memory p = _demoPolicy();
        p.assets[0] = AssetInput(address(usdc), PER_TX, 5e6, 5e6); // key bucket below the global one
        vm.prank(owner);
        hAdmin.setPolicy(agent, p);
        _expect(_payData(address(grocery), 6e6), Reason.KEY_BUCKET);
        _expect(_payData(address(grocery), 5e6), Reason.OK);
    }

    function test_checkPolicy_GLOBAL_BUCKET() public {
        vm.startPrank(owner);
        hAdmin.setGlobalCap(address(usdc), 1e6, CAP_RATE); // level drops to 1 USDC
        hAdmin.setGlobalCap(address(usdc), CAP_BURST, CAP_RATE); // raising never refills instantly
        vm.stopPrank();
        _expect(_payData(address(grocery), 6e6), Reason.GLOBAL_BUCKET);
        _expect(_payData(address(grocery), 1e6), Reason.OK);
        // The lens reads time: 12 h refill 5 USDC -> 6 USDC available.
        vm.warp(block.timestamp + 12 hours);
        _expect(_payData(address(grocery), 6e6), Reason.OK);
        _expect(_payData(address(grocery), 6e6 + 1), Reason.GLOBAL_BUCKET);
    }

    function test_checkPolicy_EXPLORE_BUCKET() public {
        vm.prank(owner);
        hAdmin.setExploreCap(address(usdc), 0.1e6, 0.1e6);
        (bool ok, Track track, uint16 code) = _check(_payData(newShop, 0.15e6)); // <= explorePerTxCap 0.2
        assertFalse(ok);
        assertEq(uint8(track), uint8(Track.EXPLORE));
        assertEq(code, Reason.EXPLORE_BUCKET);
        _expect(_payData(address(grocery), 0.15e6), Reason.OK); // proven payee: no exploration bucket
    }

    function test_checkPolicy_GAS_CREDIT() public {
        uint256 opCost = (OP_VERIF_GAS + OP_CALL_GAS + OP_PVG) * OP_FEE;
        vm.prank(owner);
        hAdmin.setGasCredit(agent, uint128(opCost));
        bytes memory cd = _payData(address(grocery), 1e6);
        // Short form: worst case at the session caps (900k gas x 1 gwei) > credit.
        _expect(cd, Reason.GAS_CREDIT);
        // Full form with the op's real max cost.
        PolicyLens.Query memory q = _query(cd);
        q.maxGasCost = opCost;
        assertTrue(lens.checkPolicyEx(q).ok);
        assertEq(_reason(h, _agentOp(h, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(grocery), 1e6))), Reason.OK);
        q.maxGasCost = opCost + 1;
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.GAS_CREDIT);
        vm.prank(owner);
        hAdmin.setGasCredit(agent, 0);
        _expect(cd, Reason.GAS_CREDIT);
        assertEq(_reason(h, _agentOp(h, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(grocery), 1e6))), Reason.GAS_CREDIT);
    }

    // ------------------------------------------------------------------ other paths

    function test_checkPolicy_simulatedOutflowsSummed() public view {
        PolicyLens.Query memory q = _query(_agentCall(address(grocery), 0, abi.encodeWithSelector(ORDER, 6e6, address(h))));
        assertEq(lens.checkPolicyEx(q).outflows.length, 0, "order(): nothing decodable");
        q.outflows = new Outflow[](2);
        q.outflows[0] = Outflow(address(usdc), 6e6);
        q.outflows[1] = Outflow(address(usdc), 6e6);
        PolicyLens.Result memory r = lens.checkPolicyEx(q);
        assertEq(r.reasonCode, Reason.PER_TX, "summed per asset: 12 > 10");
        assertEq(r.outflows.length, 1);
        assertEq(r.outflows[0].amount, 12e6);
        q.outflows = _outs(address(usdc), 6e6);
        assertTrue(lens.checkPolicyEx(q).ok);
        q.outflows = _outs(NATIVE, 1);
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.ASSET, "native not enabled for this key");
    }

    function test_checkPolicy_approvalTrack() public view {
        bytes memory cd = _payData(address(grocery), 15e6);
        PolicyLens.Query memory q = _query(cd);
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.PER_TX);
        q.approval = _signAppr(OWNER_PK, _payAppr(address(grocery), 15e6, 15e6, 1));
        PolicyLens.Result memory r = lens.checkPolicyEx(q);
        assertTrue(r.ok);
        assertEq(uint8(r.track), uint8(Track.APPROVAL));
        q.outflows = _outs(address(usdc), 15e6 + 1); // simulation says more than the owner allowed
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.APPROVAL);
        delete q.outflows;
        q.approval = _signAppr(OWNER_PK, _payAppr(address(grocery), 15e6, 15e6 - 1, 1));
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.APPROVAL, "maxOutflow below decoded amount");
        q.approval = _signAppr(STRANGER_PK, _payAppr(address(grocery), 15e6, 15e6, 1));
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.APPROVAL, "not the owner");
        q.approval = hex"deadbeef";
        assertEq(lens.checkPolicyEx(q).reasonCode, Reason.APPROVAL, "malformed slot");
    }

    function test_checkPolicy_NO_SESSION_and_OP_SHAPE() public view {
        (bool ok,, uint16 code) = lens.checkPolicy(address(h), stranger, _payData(address(grocery), 1e6), "");
        assertFalse(ok);
        assertEq(code, Reason.NO_SESSION);
        _expect(hex"12345678", Reason.OP_SHAPE);
        _expect(abi.encodeWithSelector(h.execute.selector, address(usdc), 0, ""), Reason.OP_SHAPE);
    }
}
