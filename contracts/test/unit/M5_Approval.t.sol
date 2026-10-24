// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {M5Fixture, M5Harness} from "./M5_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {ApprovalModule, ApprovalLib} from "../../src/modules/ApprovalModule.sol";
import {GreedyMerchant} from "../../src/mocks/GreedyMerchant.sol";
import {TypedData} from "../../src/lib/TypedData.sol";
import {
    PolicyInput, CallRuleInput, ArgRule, Outflow, Reason, NATIVE, LANE_NORMAL
} from "../../src/lib/PolicyTypes.sol";

/// M5 contract part: owner OutcomeApprovals (ApprovalModule + ApprovalLib) through the real
/// EntryPoint and the execution sandbox. A breach in execution lands as success = true +
/// PolicyBlocked with the spend undone (docs/api.md 3.2).
contract M5ApprovalTest is M5Fixture {
    uint256 internal constant BIG = 15e6; // above the 10 USDC per-tx cap: needs an owner approval

    function setUp() public {
        _setUpM5();
    }

    function _blockedEmit(PackedUserOperation memory op, address target, bytes4 sel, bytes memory reason) internal {
        bytes32 uoh = ep.getUserOpHash(op);
        vm.expectEmit(true, true, true, true, address(h));
        emit AccountCommon.PolicyBlocked(uoh, agent, target, sel, reason);
    }

    // ------------------------------------------------------------------ happy path

    function test_approval_withinMax() public {
        bytes memory cd = _payData(address(grocery), BIG);
        // Normal lane refuses (per-tx cap).
        assertEq(_reason(h, _signAgent(_op(address(h), _agentNonce(h, agent), cd), AGENT_PK)), Reason.PER_TX);

        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), BIG, BIG, 1);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        (uint16 r,, uint48 until) = h.checkUserOp(op, ep.getUserOpHash(op));
        assertEq(r, Reason.OK);
        assertEq(until, a.validUntil, "approval validUntil folded into validationData");

        uint256 before = usdc.balanceOf(address(grocery));
        bytes32 digest = lens.outcomeApprovalDigest(a);
        vm.expectEmit(true, true, false, true, address(h));
        emit ApprovalModule.ApprovedExecuted(digest, address(grocery), _outs(address(usdc), BIG));
        assertTrue(_handle(op));
        assertEq(usdc.balanceOf(address(grocery)) - before, BIG);
        assertTrue(h.approvalNonceUsed(1));
    }

    function test_flagged_needsApproval() public {
        vm.prank(owner);
        hAdmin.flag(address(grocery));
        bytes memory cd = _payData(address(grocery), 1e6);
        assertEq(_reason(h, _signAgent(_op(address(h), _agentNonce(h, agent), cd), AGENT_PK)), Reason.FLAGGED);

        bytes memory appr = _signAppr(OWNER_PK, _payAppr(address(grocery), 1e6, 1e6, 2));
        uint256 before = usdc.balanceOf(address(grocery));
        assertTrue(_handle(_apprOp(h, AGENT_PK, cd, appr)));
        assertEq(usdc.balanceOf(address(grocery)) - before, 1e6);
    }

    function test_unknownPayee_approvalAboveExplore() public {
        bytes memory cd = _payData(newShop, 3e6); // unproven payee, above explorePerTxCap 0.2 USDC
        (bool ok,, uint16 code) = lens.checkPolicy(address(h), agent, cd, "");
        assertFalse(ok);
        assertEq(code, Reason.EXPLORE_PER_TX);
        assertTrue(_handle(_apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, _payAppr(newShop, 3e6, 3e6, 3)))));
        assertEq(usdc.balanceOf(newShop), 3e6);
    }

    // ------------------------------------------------------------------ maxOutflow post-check

    function test_approval_overMaxOutflowByOneUnit() public {
        bytes memory cd = _payData(address(grocery), BIG);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, _payAppr(address(grocery), BIG, BIG - 1, 4)));
        assertEq(_reason(h, op), Reason.OK, "validation cannot see the outflow");
        uint256 before = usdc.balanceOf(address(h));
        _blockedEmit(
            op,
            address(usdc),
            TRANSFER,
            abi.encodeWithSelector(ApprovalLib.ApprovalOutflowExceeded.selector, address(usdc), BIG, BIG - 1)
        );
        assertTrue(_handle(op), "sandbox: breach = success + PolicyBlocked");
        assertEq(usdc.balanceOf(address(h)), before, "spend undone");
        assertFalse(h.approvalNonceUsed(4), "nonce use undone with the spend");
    }

    function test_approval_tamperedRevertsInExecution() public {
        // The owner approves a buy at the advertised price; the merchant pulls 10x at execution.
        GreedyMerchant greedy = new GreedyMerchant(IERC20(address(usdc)), 1e6, makeAddr("greedyTreasury"));
        PolicyInput memory p = _demoPolicy();
        CallRuleInput[] memory calls = new CallRuleInput[](p.calls.length + 1);
        for (uint256 i; i < p.calls.length; ++i) {
            calls[i] = p.calls[i];
        }
        calls[p.calls.length] = CallRuleInput(address(greedy), GreedyMerchant.buy.selector, new ArgRule[](0));
        p.calls = calls;
        vm.prank(owner);
        hAdmin.setPolicy(agent, p);
        vm.prank(address(h));
        usdc.approve(address(greedy), 50e6); // standing allowance (e.g. set by an earlier owner op)

        bytes memory cd = _agentCall(address(greedy), 0, abi.encodeWithSelector(GreedyMerchant.buy.selector));
        TypedData.OutcomeApproval memory a =
            _appr(address(h), cd, address(greedy), GreedyMerchant.buy.selector, address(0), address(usdc), 1e6, 5);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        uint256 before = usdc.balanceOf(address(h));
        _blockedEmit(
            op,
            address(greedy),
            GreedyMerchant.buy.selector,
            abi.encodeWithSelector(ApprovalLib.ApprovalOutflowExceeded.selector, address(usdc), 10e6, 1e6)
        );
        assertTrue(_handle(op));
        assertEq(usdc.balanceOf(address(h)), before, "greedy pull undone");
        assertEq(usdc.balanceOf(makeAddr("greedyTreasury")), 0);
    }

    function test_approval_missingAssetMeansZero() public {
        bytes memory cd = _payData(address(grocery), 1e6);
        // maxOutflow lists only native ETH: any USDC outflow is above its (implicit) 0.
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), 1e6, 0, 6);
        a.maxOutflow[0] = TypedData.AssetAmount(NATIVE, 1 ether);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        _blockedEmit(
            op,
            address(usdc),
            TRANSFER,
            abi.encodeWithSelector(ApprovalLib.ApprovalOutflowExceeded.selector, address(usdc), 1e6, 0)
        );
        assertTrue(_handle(op));
        assertEq(usdc.balanceOf(address(grocery)), 0);
    }

    function test_approval_duplicateEntriesSmallestCounts() public {
        bytes memory cd = _payData(address(grocery), 5e6);
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), 5e6, 0, 7);
        a.maxOutflow = new TypedData.AssetAmount[](2);
        a.maxOutflow[0] = TypedData.AssetAmount(address(usdc), 50e6);
        a.maxOutflow[1] = TypedData.AssetAmount(address(usdc), 4e6);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        _blockedEmit(
            op,
            address(usdc),
            TRANSFER,
            abi.encodeWithSelector(ApprovalLib.ApprovalOutflowExceeded.selector, address(usdc), 5e6, 4e6)
        );
        assertTrue(_handle(op));
    }

    // ------------------------------------------------------------------ binding: chain, wallet, nonce, time

    function test_approval_wrongChain() public {
        bytes memory cd = _payData(address(grocery), BIG);
        // (a) chainId field of another chain, signed in this domain.
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), BIG, BIG, 8);
        a.chainId = block.chainid + 1;
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        assertEq(_reason(h, op), Reason.APPROVAL);
        // (b) a valid approval signed on this chain, replayed on another chain (same account address).
        bytes memory appr = _signAppr(OWNER_PK, _payAppr(address(grocery), BIG, BIG, 9));
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, appr)), Reason.OK);
        vm.chainId(block.chainid + 8452);
        op = _apprOp(h, AGENT_PK, cd, appr); // the leaked agent key re-signs for the new chain
        assertEq(_reason(h, op), Reason.APPROVAL);
        _expectAA24(op);
    }

    function test_approval_wrongWallet() public {
        AgentAccount other = hFactory.createAccount(owner, 2); // same owner, another wallet
        bytes memory cd = _payData(address(grocery), BIG);
        // (a) approval made for the other wallet (field + domain).
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), BIG, BIG, 10);
        a.account = address(other);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        assertEq(_reason(h, op), Reason.APPROVAL);
        _expectAA24(op);
        // (b) account field = this wallet but signed in the other wallet's domain.
        a.account = address(h);
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signApprIn(OWNER_PK, a, address(other)))), Reason.APPROVAL);
    }

    function test_approval_replay() public {
        bytes memory cd = _payData(address(grocery), BIG);
        bytes memory appr = _signAppr(OWNER_PK, _payAppr(address(grocery), BIG, BIG, 11));
        assertTrue(_handle(_apprOp(h, AGENT_PK, cd, appr)));
        // Same approval, same callData, next lane-1 EntryPoint nonce.
        PackedUserOperation memory again = _apprOp(h, AGENT_PK, cd, appr);
        assertEq(_reason(h, again), Reason.APPROVAL);
        _expectAA24(again);
        assertEq(usdc.balanceOf(address(grocery)), BIG, "moved once");
    }

    function test_approval_replaySameBundle() public {
        bytes memory cd = _payData(address(grocery), BIG);
        bytes memory appr = _signAppr(OWNER_PK, _payAppr(address(grocery), BIG, BIG, 12));
        uint256 n0 = _apprNonce(h, agent);
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _signAgentWith(_op(address(h), n0, cd), AGENT_PK, "", appr);
        ops[1] = _signAgentWith(_op(address(h), n0 + 1, cd), AGENT_PK, "", appr);
        // Both pass validation (nonce unused then); the execution re-check blocks the second.
        _blockedEmit(ops[1], address(usdc), TRANSFER, abi.encodeWithSelector(AccountCommon.PolicyViolation.selector, Reason.APPROVAL));
        bool[] memory s = _handleMany(ops);
        assertTrue(s[0] && s[1]);
        assertEq(usdc.balanceOf(address(grocery)), BIG, "moved once");
    }

    function test_approval_expired() public {
        bytes memory cd = _payData(address(grocery), BIG);
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), BIG, BIG, 13);
        a.validUntil = uint48(block.timestamp - 1);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        (uint16 r,, uint48 until) = h.checkUserOp(op, ep.getUserOpHash(op));
        assertEq(r, Reason.OK);
        assertEq(until, a.validUntil);
        _expectFailedOp(op, "AA22 expired or not due");
        // validUntil 0 would mean "no expiry" in validationData: refused outright.
        a.validUntil = 0;
        op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        assertEq(_reason(h, op), Reason.APPROVAL);
        _expectAA24(op);
        // A live approval stops at its validUntil.
        a.validUntil = uint48(block.timestamp + 60);
        op = _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a));
        vm.warp(block.timestamp + 61);
        _expectFailedOp(op, "AA22 expired or not due");
    }

    // ------------------------------------------------------------------ binding: calldata

    function test_approval_mismatch() public {
        bytes memory cd = _payData(address(grocery), BIG);
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), BIG, BIG, 14);
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a))), Reason.OK);

        TypedData.OutcomeApproval memory x = _payAppr(address(grocery), BIG, BIG, 14);
        x.payee = attacker; // payee mismatch (callDataHash still matches)
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, x))), Reason.APPROVAL, "payee");
        x = _payAppr(address(grocery), BIG, BIG, 14);
        x.target = address(ticket);
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, x))), Reason.APPROVAL, "target");
        x = _payAppr(address(grocery), BIG, BIG, 14);
        x.selector = APPROVE;
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, x))), Reason.APPROVAL, "selector");

        // The agent swaps the calldata after the owner signed (payee or amount).
        bytes memory appr = _signAppr(OWNER_PK, a);
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, _payData(attacker, BIG), appr);
        assertEq(_reason(h, op), Reason.APPROVAL, "payee swapped");
        _expectAA24(op);
        assertEq(_reason(h, _apprOp(h, AGENT_PK, _payData(address(grocery), BIG + 1), appr)), Reason.APPROVAL, "amount");
    }

    function test_approval_wrongSigner() public view {
        bytes memory cd = _payData(address(grocery), BIG);
        TypedData.OutcomeApproval memory a = _payAppr(address(grocery), BIG, BIG, 15);
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(AGENT_PK, a))), Reason.APPROVAL, "agent self-approval");
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(STRANGER_PK, a))), Reason.APPROVAL, "stranger");
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, abi.encode(a, new bytes(65)))), Reason.APPROVAL, "bad sig");
    }

    function test_approval_laneEnforced() public {
        bytes memory cd = _payData(address(grocery), BIG);
        bytes memory appr = _signAppr(OWNER_PK, _payAppr(address(grocery), BIG, BIG, 16));
        // Approval op on the normal lane.
        PackedUserOperation memory op = _signAgentWith(_op(address(h), _agentNonce(h, agent), cd), AGENT_PK, "", appr);
        assertEq(_reason(h, op), Reason.NONCE_KEY);
        // Normal op on the approval lane.
        op = _signAgent(_op(address(h), _apprNonce(h, agent), _payData(address(grocery), 1e6)), AGENT_PK);
        assertEq(_reason(h, op), Reason.NONCE_KEY);
        // A pending approval op never consumes lane 0.
        assertEq(_agentNonce(h, agent) & type(uint64).max, 0);
        assertTrue(_handle(_apprOp(h, AGENT_PK, cd, appr)));
        assertEq(_agentNonce(h, agent) & type(uint64).max, 0);
        assertTrue(_handle(_agentOp(h, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(grocery), 1e6))));
    }

    function test_approval_doesNotWaiveRules() public {
        // Argument rule (approve spender IN_RECIPIENTS) still applies.
        bytes memory cd = _agentCall(address(usdc), 0, abi.encodeWithSelector(APPROVE, attacker, 1e6));
        TypedData.OutcomeApproval memory a = _appr(address(h), cd, address(usdc), APPROVE, address(0), address(usdc), 1e6, 17);
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a))) & 0xff, Reason.RECIPIENT);
        // Target rule still applies.
        cd = _agentCall(attacker, 0, abi.encodeWithSelector(TRANSFER, attacker, 1e6));
        a = _appr(address(h), cd, attacker, TRANSFER, attacker, address(usdc), 1e6, 17);
        assertEq(_reason(h, _apprOp(h, AGENT_PK, cd, _signAppr(OWNER_PK, a))), Reason.TARGET);
        // A revoked key stays revoked.
        cd = _payData(address(grocery), BIG);
        bytes memory appr = _signAppr(OWNER_PK, _payAppr(address(grocery), BIG, BIG, 17));
        PackedUserOperation memory op = _apprOp(h, AGENT_PK, cd, appr);
        vm.prank(owner);
        hAdmin.revoke(agent);
        assertEq(_reason(h, op), Reason.REVOKED);
        _expectAA24(op);
    }

    function test_approval_cancel() public {
        bytes memory cd = _payData(address(grocery), BIG);
        bytes memory appr = _signAppr(OWNER_PK, _payAppr(address(grocery), BIG, BIG, 18));
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(agent);
        h.cancelApproval(18);
        vm.expectEmit(true, false, false, false, address(h));
        emit ApprovalModule.ApprovalCancelled(18);
        vm.prank(owner);
        h.cancelApproval(18);
        assertTrue(h.approvalNonceUsed(18));
        _expectAA24(_apprOp(h, AGENT_PK, cd, appr));
    }

    // ------------------------------------------------------------------ typed data

    function test_approval_lensDigestEqualsVector() public view {
        // results/m1_typed_data_vectors.json (outcomeApproval), digests computed by the contract code.
        TypedData.OutcomeApproval memory a;
        a.account = 0x95e6B4D9D3f8360e66048eD484302099c7A3f545;
        a.chainId = 31337;
        a.nonce = 7;
        a.target = 0x2222222222222222222222222222222222222222;
        a.selector = 0xa9059cbb;
        a.payee = 0x3333333333333333333333333333333333333333;
        a.maxOutflow = new TypedData.AssetAmount[](2);
        a.maxOutflow[0] = TypedData.AssetAmount(0x4444444444444444444444444444444444444444, 40000000);
        a.maxOutflow[1] = TypedData.AssetAmount(address(0), 1000000000000000);
        a.callDataHash = 0xd9cf3a094ddae18dd0aac61fd356b5dad49e4f684a604ecb3f4ea846fc6bd354;
        a.validUntil = 1800518400;
        assertEq(lens.outcomeApprovalDigest(a), 0xb7c777f611dab7b65e404fbf8445d731fb53d4e7e4f7f4597cfee0d18c6a8b29);
        // On-chain domain of `h` == lens domain for h.
        a.account = address(h);
        a.chainId = block.chainid;
        assertEq(
            lens.outcomeApprovalDigest(a),
            TypedData.digest(hAdmin.domainSeparator(), TypedData.hashOutcomeApproval(a))
        );
        assertEq(lens.encodeApproval(a, hex"01"), abi.encode(a, hex"01"));
    }
}
