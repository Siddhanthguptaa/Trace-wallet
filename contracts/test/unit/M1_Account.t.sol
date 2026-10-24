// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {ArgRules} from "../../src/lib/ArgRules.sol";
import {
    PolicyInput,
    AssetInput,
    CallRuleInput,
    ArgRule,
    RuleOp,
    Reason,
    Session,
    Outflow,
    Tier,
    Track,
    NATIVE,
    ANY_TARGET,
    TARGET_ARG,
    LANE_NORMAL,
    LANE_APPROVAL,
    ERC1271_MAGIC,
    ERC1271_INVALID
} from "../../src/lib/PolicyTypes.sol";
import {MockUSDC3009} from "../../src/mocks/MockUSDC3009.sol";

/// Unit tests for M1: one test per policy clause (requirement R12), UserOp-level replay tests (R11).
contract M1AccountTest is M1Fixture {
    function setUp() public {
        _setUpFixture();
    }

    function _usdcTransfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TRANSFER, to, amount);
    }

    function _buy(uint256 id, address recipient) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(BUY, id, recipient);
    }

    function _setPolicy(address key, PolicyInput memory p) internal {
        vm.prank(owner);
        admin.setPolicy(key, p);
    }

    function _expectSetPolicyRevert(address key, PolicyInput memory p, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(owner);
        admin.setPolicy(key, p);
    }

    function _withCalls(CallRuleInput[] memory calls) internal view returns (PolicyInput memory p) {
        p = _demoPolicy();
        p.calls = calls;
    }

    function _one(address target, bytes4 sel, ArgRule[] memory rules) internal pure returns (CallRuleInput[] memory c) {
        c = new CallRuleInput[](1);
        c[0] = CallRuleInput(target, sel, rules);
    }

    function _rules1(uint8 i, RuleOp op, uint256 bound) internal pure returns (ArgRule[] memory r) {
        r = new ArgRule[](1);
        r[0] = ArgRule(i, op, bound);
    }

    // ================================================================ owner

    function test_owner_userOpExecutes() public {
        uint256 before = usdc.balanceOf(stranger);
        assertTrue(_handle(_ownerExecOp(acct, address(usdc), 0, _usdcTransfer(stranger, 50e6))));
        assertEq(usdc.balanceOf(stranger) - before, 50e6, "owner moves any amount anywhere");
    }

    function test_owner_adminViaUserOp() public {
        bytes memory cd = abi.encodeCall(AgentAccountAdmin.setRecipient, (stranger, true));
        assertTrue(_handle(_ownerExecOp(acct, address(acct), 0, cd)));
        assertTrue(admin.isRecipient(stranger), "owner op reaches the admin through a self-call");
    }

    function test_owner_envelopeRoleOwner() public {
        PackedUserOperation memory op =
            _op(address(acct), ep.getNonce(address(acct), 7), _agentCall(address(usdc), 0, _usdcTransfer(stranger, 1e6)));
        op.signature = abi.encode(uint8(0), _sign65(OWNER_PK, ep.getUserOpHash(op)), bytes(""), bytes(""));
        assertTrue(_handle(op), "owner via executeUserOp encoding, any nonce key");
        assertEq(usdc.balanceOf(stranger), 1e6);
    }

    function test_owner_wrongSignerRejected() public {
        PackedUserOperation memory op = _op(
            address(acct),
            ep.getNonce(address(acct), 0),
            abi.encodeWithSelector(acct.execute.selector, address(usdc), 0, _usdcTransfer(attacker, 1e6))
        );
        op = _signOwner(op, STRANGER_PK);
        _expectAA24(op);
        op = _signOwner(op, AGENT_PK); // agent key cannot use the owner role
        _expectAA24(op);
    }

    function test_owner_directAdminOnly() public {
        vm.expectRevert(AccountCommon.NotOwner.selector);
        admin.setRecipient(attacker, true);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(agent);
        admin.transferOwnership(agent);
        vm.prank(owner);
        admin.transferOwnership(stranger);
        assertEq(admin.owner(), stranger);
    }

    function test_owner_initializeOnce() public {
        vm.expectRevert(AccountCommon.AlreadyInitialized.selector);
        acct.initialize(attacker);
        AgentAccount impl = factory.accountImplementation();
        vm.expectRevert(AccountCommon.AlreadyInitialized.selector);
        impl.initialize(attacker);
        assertEq(factory.getAddress(owner, 0), address(acct), "CREATE2 address binds the owner");
        assertEq(address(factory.createAccount(owner, 0)), address(acct), "idempotent");
    }

    // ================================================================ agent

    function test_agent_legitTicketBuy() public {
        assertTrue(_handle(_agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(APPROVE, address(ticket), TICKET_PRICE))));
        vm.expectEmit(false, true, true, false, address(acct));
        emit AccountCommon.Decision(bytes32(0), agent, address(ticket), BUY, address(0), Tier.NONE, Track.NORMAL, new Outflow[](0));
        assertTrue(_handle(_agentOp(acct, AGENT_PK, address(ticket), 0, _buy(1, address(acct)))));
        assertEq(ticket.ownerOf(1), address(acct), "ticket to self");
        assertEq(usdc.balanceOf(ticketTreasury), TICKET_PRICE);
    }

    function test_agent_payListedRecipient() public {
        assertTrue(_handle(_agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 3e6))));
        assertEq(usdc.balanceOf(address(grocery)), 3e6);
    }

    function test_agent_unlistedPayeeRefused() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(attacker, 1e6));
        assertEq(_reason(acct, op), Reason.EXPLORE_PER_TX, "unlisted payee: unproven, over the exploration per-tx cap");
        _expectAA24(op);
    }

    function test_agent_unknownSignerRefused() public {
        PackedUserOperation memory op = _agentOp(acct, STRANGER_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        assertEq(_reason(acct, op), Reason.NO_SESSION);
        _expectAA24(op);
    }

    function test_agent_executeSelectorRefused() public {
        bytes memory cd = abi.encodeWithSelector(acct.execute.selector, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        PackedUserOperation memory op = _signAgent(_op(address(acct), _agentNonce(acct, agent), cd), AGENT_PK);
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "agent ops must use executeUserOp");
        _expectAA24(op);
        BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
        calls[0] = BaseAccount.Call(address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        cd = abi.encodeWithSelector(acct.executeBatch.selector, calls);
        op = _signAgent(_op(address(acct), _agentNonce(acct, agent), cd), AGENT_PK);
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "no batch");
        _expectAA24(op);
    }

    function test_agent_selfAndEntryPointTargetRefused() public {
        bytes memory setRec = abi.encodeCall(AgentAccountAdmin.setRecipient, (attacker, true));
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(acct), 0, setRec);
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "no self-call");
        _expectAA24(op);
        bytes memory wd = abi.encodeCall(IEntryPoint(address(ep)).withdrawTo, (payable(attacker), 1 ether));
        op = _agentOp(acct, AGENT_PK, address(ep), 0, wd);
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "no EntryPoint call (deposit drain)");
        _expectAA24(op);
    }

    function test_agent_opKindRefused() public {
        bytes memory body = abi.encode(address(api), uint256(1e5), uint256(0), uint256(1), bytes32("n"));
        PackedUserOperation memory op = _signAgent(
            _op(address(acct), _agentNonce(acct, agent), _agentOpKind(1, address(usdc), 0, body)), AGENT_PK
        );
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "voucher ops off before M3");
        op = _signAgent(_op(address(acct), _agentNonce(acct, agent), _agentOpKind(2, address(usdc), 0, "")), AGENT_PK);
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "unknown kind (no delegatecall kind exists)");
        _expectAA24(op);
    }

    function test_agent_noRuleIsTarget() public {
        PackedUserOperation memory op =
            _agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER_FROM, address(acct), attacker, 1));
        assertEq(_reason(acct, op), Reason.TARGET);
        _expectAA24(op);
    }

    function test_agent_perTxEarlyReject() public {
        PackedUserOperation memory op =
            _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), uint256(PER_TX) + 1));
        assertEq(_reason(acct, op), Reason.PER_TX);
        _expectAA24(op);
    }

    function test_agent_nativeValueNeedsAsset() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(ticket), 1, _buy(9, address(acct)));
        assertEq(_reason(acct, op), Reason.ASSET, "native asset not enabled for this key");
        _expectAA24(op);
    }

    function test_agent_paymasterOnlyOwnerSet() public {
        address pm = makeAddr("agentPaymaster");
        PackedUserOperation memory op =
            _op(address(acct), _agentNonce(acct, agent), _agentCall(address(usdc), 0, _usdcTransfer(address(grocery), 1)));
        op.paymasterAndData = abi.encodePacked(pm, uint128(100_000), uint128(50_000));
        op = _signAgent(op, AGENT_PK);
        assertEq(_reason(acct, op), Reason.PAYMASTER, "no paymaster configured");
        vm.prank(owner);
        admin.setAgentPaymaster(makeAddr("otherPaymaster"));
        assertEq(_reason(acct, op), Reason.PAYMASTER, "not the owner-set paymaster");
        vm.prank(owner);
        admin.setAgentPaymaster(pm);
        assertEq(admin.agentPaymaster(), pm);
        assertEq(_reason(acct, op), Reason.OK, "owner-set paymaster accepted (its gas counts against the credit)");
        op.paymasterAndData = abi.encodePacked(pm, uint128(1_000_000), uint128(1_000_000));
        op = _signAgent(op, AGENT_PK);
        assertEq(_reason(acct, op), Reason.GAS_CAP, "paymaster gas capped");
    }

    /// A malformed approval slot never validates (ApprovalModule reverts on undecodable bytes -> AA23).
    function test_agent_malformedApprovalSlotRefused() public {
        PackedUserOperation memory op = _op(
            address(acct),
            ep.getNonce(address(acct), _nonceKey(acct, agent, LANE_APPROVAL)),
            _agentCall(address(usdc), 0, _usdcTransfer(attacker, 1e6))
        );
        op = _signAgentWith(op, AGENT_PK, "", hex"01");
        vm.expectRevert();
        ep.handleOps(_one(op), bundler);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_agent_executionRevertLandsOnChain() public {
        // Passes validation (order <= 10 USDC to self) but no allowance: reverts in execution.
        PackedUserOperation memory op =
            _agentOp(acct, AGENT_PK, address(grocery), 0, abi.encodeWithSelector(ORDER, 5e6, address(acct)));
        assertFalse(_handle(op), "success = false on-chain");
        assertEq(usdc.balanceOf(groceryTreasury), 0);
    }

    function test_agent_policyCheckView() public view {
        bytes memory cd = _agentCall(address(usdc), 0, _usdcTransfer(address(api), 1e5));
        (uint16 reason, Tier tier, Track track, uint48 until) = acct.policyCheck(agent, cd, "", "");
        assertEq(reason, Reason.OK);
        assertEq(uint8(tier), uint8(Tier.PROVEN));
        assertEq(uint8(track), uint8(Track.NORMAL));
        (, Session memory s) = admin.sessionOf(agent);
        assertEq(until, s.validUntil);
    }

    function test_agent_1271OwnerOnly() public view {
        bytes32 h = keccak256("permit or order digest");
        assertEq(acct.isValidSignature(h, _sign65(OWNER_PK, h)), ERC1271_MAGIC);
        assertEq(acct.isValidSignature(h, _sign65(AGENT_PK, h)), ERC1271_INVALID, "one door: agent key refused");
    }

    // ================================================================ setPolicy hard rules

    function test_setPolicy_openEndedRefused() public {
        PolicyInput memory p = _demoPolicy();
        p.validUntil = 0;
        _expectSetPolicyRevert(agent2, p, abi.encodeWithSelector(AccountCommon.OpenEndedKey.selector, p.validAfter, 0));
        p.validUntil = type(uint48).max;
        _expectSetPolicyRevert(agent2, p, abi.encodeWithSelector(AccountCommon.OpenEndedKey.selector, p.validAfter, p.validUntil));
        p.validUntil = p.validAfter;
        _expectSetPolicyRevert(agent2, p, abi.encodeWithSelector(AccountCommon.OpenEndedKey.selector, p.validAfter, p.validUntil));
    }

    function test_setPolicy_badKeysRefused() public {
        PolicyInput memory p = _demoPolicy();
        _expectSetPolicyRevert(owner, p, abi.encodeWithSelector(AccountCommon.BadAddress.selector, owner));
        _expectSetPolicyRevert(address(acct), p, abi.encodeWithSelector(AccountCommon.BadAddress.selector, address(acct)));
        _expectSetPolicyRevert(address(0), p, abi.encodeWithSelector(AccountCommon.BadAddress.selector, address(0)));
        vm.prank(owner);
        admin.setAttestor(attestorAddr);
        _expectSetPolicyRevert(attestorAddr, p, abi.encodeWithSelector(AccountCommon.BadAddress.selector, attestorAddr));
    }

    function test_setPolicy_onlyOwner() public {
        PolicyInput memory p = _demoPolicy();
        vm.expectRevert(AccountCommon.NotOwner.selector);
        vm.prank(agent);
        admin.setPolicy(agent, p);
    }

    function test_setPolicy_assetNeedsGlobalCap() public {
        PolicyInput memory p = _demoPolicy();
        MockUSDC3009 other = new MockUSDC3009();
        p.assets[0].asset = address(other);
        _expectSetPolicyRevert(agent2, p, abi.encodeWithSelector(AccountCommon.AssetNoGlobalCap.selector, address(other)));
    }

    function test_setPolicy_bareMovingSelectorRefused() public {
        bytes4[6] memory sels = [TRANSFER, APPROVE, SET_APPROVAL_FOR_ALL, TRANSFER_FROM, bytes4(0x42842e0e), bytes4(0x87517c45)];
        for (uint256 i; i < sels.length; ++i) {
            _expectSetPolicyRevert(
                agent2,
                _withCalls(_one(address(usdc), sels[i], new ArgRule[](0))),
                abi.encodeWithSelector(ArgRules.RuleUnbound.selector, address(usdc), sels[i])
            );
        }
        // LTE on the amount does not bind the recipient.
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(usdc), TRANSFER, _rules1(1, RuleOp.LTE, 5e6))),
            abi.encodeWithSelector(ArgRules.RuleUnbound.selector, address(usdc), TRANSFER)
        );
    }

    function test_setPolicy_payeeSlotsOnly() public {
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(usdc), APPROVE, _rules1(0, RuleOp.PAYEE, 0))),
            abi.encodeWithSelector(ArgRules.RulePayeeSlot.selector, 0)
        );
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(ticket), TRANSFER_FROM, _rules1(1, RuleOp.PAYEE, 0))),
            abi.encodeWithSelector(ArgRules.RulePayeeSlot.selector, 0)
        );
        ArgRule[] memory two = new ArgRule[](2);
        two[0] = ArgRule(0, RuleOp.PAYEE, 0);
        two[1] = ArgRule(0, RuleOp.PAYEE, 0);
        _expectSetPolicyRevert(
            agent2, _withCalls(_one(address(usdc), TRANSFER, two)), abi.encodeWithSelector(ArgRules.RulePayeeSlot.selector, 1)
        );
        // Native value payee on the target pseudo-argument is fine.
        _setPolicy(agent2, _withCalls(_one(address(grocery), bytes4(0), _rules1(TARGET_ARG, RuleOp.PAYEE, 0))));
    }

    function test_setPolicy_dynamicArgRefused() public {
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(ticket), bytes4(0xb88d4fde), _rules1(3, RuleOp.LTE, 1))),
            abi.encodeWithSelector(ArgRules.RuleDynamicArg.selector, 0, 3)
        );
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(usdc), TRANSFER, _rules1(2, RuleOp.LTE, 1))),
            abi.encodeWithSelector(ArgRules.RuleArgIndex.selector, 0, 2)
        );
    }

    function test_setPolicy_forbiddenTargetsAndSelectors() public {
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(acct), bytes4(0x12345678), new ArgRule[](0))),
            abi.encodeWithSelector(ArgRules.RuleTargetForbidden.selector, address(acct))
        );
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(ep), bytes4(0x205c2878), new ArgRule[](0))),
            abi.encodeWithSelector(ArgRules.RuleTargetForbidden.selector, address(ep))
        );
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(grocery), acct.execute.selector, new ArgRule[](0))),
            abi.encodeWithSelector(ArgRules.RuleSelectorForbidden.selector, acct.execute.selector)
        );
    }

    function test_setPolicy_wildcardNeedsPayee() public {
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(ANY_TARGET, bytes4(0), new ArgRule[](0))),
            abi.encodeWithSelector(ArgRules.RuleWildcard.selector)
        );
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(ANY_TARGET, TRANSFER, _rules1(0, RuleOp.PAYEE, 0))),
            abi.encodeWithSelector(ArgRules.RuleWildcard.selector)
        );
        _setPolicy(agent2, _withCalls(_one(ANY_TARGET, bytes4(0), _rules1(TARGET_ARG, RuleOp.PAYEE, 0))));
    }

    function test_setPolicy_tooManyAndDuplicate() public {
        ArgRule[] memory nine = new ArgRule[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = ArgRule(0, RuleOp.IN_RECIPIENTS, 0);
        }
        _expectSetPolicyRevert(
            agent2, _withCalls(_one(address(usdc), TRANSFER, nine)), abi.encodeWithSelector(ArgRules.RuleTooMany.selector, 9)
        );
        CallRuleInput[] memory dup = new CallRuleInput[](2);
        dup[0] = CallRuleInput(address(usdc), TRANSFER, _rules1(0, RuleOp.PAYEE, 0));
        dup[1] = dup[0];
        _expectSetPolicyRevert(agent2, _withCalls(dup), abi.encodeWithSelector(AccountCommon.DuplicateEntry.selector));
    }

    function test_setPolicy_resetClearsOldRulesAndNonceKey() public {
        PackedUserOperation memory oldOp = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        uint192 oldKey = _nonceKey(acct, agent, LANE_NORMAL);
        // New policy for the same key without the USDC transfer rule.
        CallRuleInput[] memory c = _one(address(ticket), BUY, _rules1(1, RuleOp.EQ_SELF, 0));
        _setPolicy(agent, _withCalls(c));
        assertTrue(_nonceKey(acct, agent, LANE_NORMAL) != oldKey, "fresh nonce key");
        assertEq(_reason(acct, oldOp), Reason.NONCE_KEY, "op signed under the old policy is dead");
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        assertEq(_reason(acct, op), Reason.TARGET, "old rule gone");
        (bool allowed,) = admin.ruleOf(agent, address(usdc), TRANSFER);
        assertFalse(allowed);
        assertEq(admin.rulesOf(agent).length, 1);
    }

    // ================================================================ argument rules

    function test_argRule_eqSelf() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(ticket), 0, _buy(1, attacker));
        assertEq(_reason(acct, op), Reason.argRule(0), "buy recipient must be this account");
        _expectAA24(op);
    }

    function test_argRule_inRecipients() public {
        PackedUserOperation memory op =
            _agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(APPROVE, attacker, 1e6));
        assertEq(_reason(acct, op), Reason.RECIPIENT, "spender must be listed (rule 0)");
        _expectAA24(op);
    }

    function test_argRule_lte() public {
        PackedUserOperation memory op =
            _agentOp(acct, AGENT_PK, address(grocery), 0, abi.encodeWithSelector(ORDER, uint256(PER_TX) + 1, address(acct)));
        assertEq(_reason(acct, op), Reason.argRule(0));
        op = _agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(APPROVE, address(ticket), type(uint256).max));
        assertEq(_reason(acct, op), Reason.argRule(1), "approve MAX refused by the amount rule");
    }

    function test_argRule_eq() public {
        CallRuleInput[] memory c = _one(address(grocery), ORDER, new ArgRule[](2));
        c[0].rules[0] = ArgRule(0, RuleOp.EQ, 3e6);
        c[0].rules[1] = ArgRule(1, RuleOp.EQ_SELF, 0);
        _setPolicy(agent2, _withCalls(c));
        PackedUserOperation memory op =
            _agentOp(acct, AGENT2_PK, address(grocery), 0, abi.encodeWithSelector(ORDER, 4e6, address(acct)));
        assertEq(_reason(acct, op), Reason.argRule(0));
        op = _agentOp(acct, AGENT2_PK, address(grocery), 0, abi.encodeWithSelector(ORDER, 3e6, address(acct)));
        assertEq(_reason(acct, op), Reason.OK);
    }

    function test_argRule_payeeListedAndFlagged() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(api), 1e5));
        assertEq(_reason(acct, op), Reason.OK);
        vm.prank(owner);
        admin.flag(address(api));
        assertEq(_reason(acct, op), Reason.FLAGGED, "flagged payee refused");
        op = _agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(APPROVE, address(api), 1e5));
        assertEq(_reason(acct, op), Reason.FLAGGED, "IN_RECIPIENTS also fails on a flag");
    }

    function test_argRule_shortCalldataAndDirtyAddress() public {
        PackedUserOperation memory op =
            _agentOp(acct, AGENT_PK, address(ticket), 0, abi.encodePacked(BUY, uint256(1)));
        assertEq(_reason(acct, op), Reason.argRule(0), "missing argument word");
        bytes memory dirty = abi.encodePacked(BUY, uint256(1), (uint256(1) << 200) | uint256(uint160(address(acct))));
        op = _agentOp(acct, AGENT_PK, address(ticket), 0, dirty);
        assertEq(_reason(acct, op), Reason.argRule(0), "address word with dirty upper bits");
    }

    function test_argRule_nativePayeeWildcard() public {
        PolicyInput memory p = _withCalls(_one(ANY_TARGET, bytes4(0), _rules1(TARGET_ARG, RuleOp.PAYEE, 0)));
        vm.startPrank(owner);
        admin.setGlobalCap(NATIVE, 0.01 ether, 0.01 ether);
        admin.setRecipient(stranger, true);
        vm.stopPrank();
        p.assets = new AssetInput[](1);
        p.assets[0] = AssetInput(NATIVE, 0.005 ether, 0.01 ether, 0.01 ether);
        _setPolicy(agent2, p);
        PackedUserOperation memory op = _agentOp(acct, AGENT2_PK, stranger, 0.001 ether, "");
        assertEq(_reason(acct, op), Reason.OK, "listed payee via value send");
        op = _agentOp(acct, AGENT2_PK, attacker, 0.001 ether, "");
        assertEq(_reason(acct, op), Reason.EXPLORE_PER_TX, "unlisted native payee: unproven, over the exploration per-tx cap");
        op = _agentOp(acct, AGENT2_PK, stranger, 0.006 ether, "");
        assertEq(_reason(acct, op), Reason.PER_TX);
        uint256 before = stranger.balance;
        assertTrue(_handle(_agentOp(acct, AGENT2_PK, stranger, 0.001 ether, "")));
        assertEq(stranger.balance - before, 0.001 ether);
    }

    // ================================================================ NFTs

    function test_nft_setApprovalForAllLocked() public {
        PackedUserOperation memory op =
            _agentOp(acct, AGENT_PK, address(ticket), 0, abi.encodeWithSelector(SET_APPROVAL_FOR_ALL, attacker, true));
        assertEq(_reason(acct, op), Reason.RECIPIENT, "operator must be listed");
        _expectAA24(op);
    }

    function test_nft_transferNeedsRule() public {
        PackedUserOperation memory op = _agentOp(
            acct, AGENT_PK, address(ticket), 0, abi.encodeWithSelector(bytes4(0x42842e0e), address(acct), attacker, 1)
        );
        assertEq(_reason(acct, op), Reason.TARGET, "no NFT move without a rule");
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(ticket), bytes4(0x42842e0e), _rules1(0, RuleOp.EQ_SELF, 0))),
            abi.encodeWithSelector(ArgRules.RuleUnbound.selector, address(ticket), bytes4(0x42842e0e))
        );
        _expectSetPolicyRevert(
            agent2,
            _withCalls(_one(address(ticket), bytes4(0x42842e0e), _rules1(1, RuleOp.EQ, uint256(uint160(attacker))))),
            abi.encodeWithSelector(ArgRules.RuleUnbound.selector, address(ticket), bytes4(0x42842e0e))
        );
    }

    // ================================================================ gas

    function test_gas_capsRefused() public {
        PackedUserOperation memory op =
            _op(address(acct), _agentNonce(acct, agent), _agentCall(address(usdc), 0, _usdcTransfer(address(grocery), 1)));
        op.accountGasLimits = _packGas(OP_VERIF_GAS, uint256(MAX_CALL_GAS) + 1);
        assertEq(_reason(acct, _signAgent(op, AGENT_PK)), Reason.GAS_CAP, "callGasLimit");
        op.accountGasLimits = _packGas(uint256(MAX_VERIF_GAS) + 1, OP_CALL_GAS);
        assertEq(_reason(acct, _signAgent(op, AGENT_PK)), Reason.GAS_CAP, "verificationGasLimit");
        op.accountGasLimits = _packGas(OP_VERIF_GAS, OP_CALL_GAS);
        op.preVerificationGas = uint256(MAX_PVG) + 1;
        assertEq(_reason(acct, _signAgent(op, AGENT_PK)), Reason.GAS_CAP, "preVerificationGas");
        op.preVerificationGas = OP_PVG;
        op.gasFees = _packGas(MAX_FEE, uint256(MAX_FEE) + 1);
        op = _signAgent(op, AGENT_PK);
        assertEq(_reason(acct, op), Reason.GAS_CAP, "maxFeePerGas");
        _expectAA24(op);
    }

    function test_gas_creditDebitedByMaxCost() public {
        (, Session memory s0) = admin.sessionOf(agent);
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        assertTrue(_handle(op));
        (, Session memory s1) = admin.sessionOf(agent);
        uint256 maxCost = (OP_VERIF_GAS + OP_CALL_GAS + OP_PVG) * OP_FEE;
        assertEq(s0.gas.gasCredit - s1.gas.gasCredit, maxCost, "credit debited by the op's max cost");
    }

    function test_gas_failingOpsStillCostCreditThenStop() public {
        vm.prank(owner);
        admin.setGasCredit(agent, uint128((OP_VERIF_GAS + OP_CALL_GAS + OP_PVG) * OP_FEE * 2));
        bytes memory failing = abi.encodeWithSelector(ORDER, 5e6, address(acct)); // no allowance: reverts in execution
        assertFalse(_handle(_agentOp(acct, AGENT_PK, address(grocery), 0, failing)));
        assertFalse(_handle(_agentOp(acct, AGENT_PK, address(grocery), 0, failing)));
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(grocery), 0, failing);
        assertEq(_reason(acct, op), Reason.GAS_CREDIT, "credit exhausted: liveness stop, not theft");
        _expectAA24(op);
        vm.prank(owner);
        admin.setGasCredit(agent, GAS_CREDIT);
        assertEq(_reason(acct, op), Reason.OK, "owner refill");
    }

    // ================================================================ expiry

    function test_expiry_validationDataWindow() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        (uint16 reason, uint48 va, uint48 vu) = acct.checkUserOp(op, ep.getUserOpHash(op));
        (, Session memory s) = admin.sessionOf(agent);
        assertEq(reason, Reason.OK);
        assertEq(va, s.validAfter);
        assertEq(vu, s.validUntil);
        vm.warp(uint256(s.validUntil) + 1);
        _expectFailedOp(op, "AA22 expired or not due");
    }

    function test_expiry_notYetValid() public {
        PolicyInput memory p = _demoPolicy();
        p.validAfter = uint48(block.timestamp + 1 days);
        p.validUntil = uint48(block.timestamp + 2 days);
        _setPolicy(agent2, p);
        PackedUserOperation memory op = _agentOp(acct, AGENT2_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        _expectFailedOp(op, "AA22 expired or not due");
        vm.warp(block.timestamp + 1 days + 1);
        assertTrue(_handle(op));
    }

    // ================================================================ revoke

    function test_revoke_killSwitch() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        vm.prank(owner);
        admin.revoke(agent);
        assertEq(_reason(acct, op), Reason.REVOKED);
        _expectAA24(op);
        vm.expectRevert(AccountCommon.NotOwner.selector);
        admin.revoke(agent2);
    }

    function test_revoke_inSameBundleStopsExecution() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _ownerExecOp(acct, address(acct), 0, abi.encodeCall(AgentAccountAdmin.revoke, (agent)));
        ops[1] = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        bytes32 uoh = ep.getUserOpHash(ops[1]);
        vm.expectEmit(true, true, true, true, address(acct));
        emit AccountCommon.PolicyBlocked(
            uoh,
            agent,
            address(usdc),
            TRANSFER,
            abi.encodeWithSelector(AccountCommon.PolicyViolation.selector, Reason.REVOKED)
        );
        bool[] memory ok = _handleMany(ops);
        assertTrue(ok[0], "owner revoke executed");
        assertTrue(ok[1], "blocked in execution by the sandbox: returns normally, nothing moved");
        assertEq(usdc.balanceOf(address(grocery)), 0);
    }

    // ================================================================ rotate

    function test_rotate_movesSession() public {
        (uint64 sid,) = admin.sessionOf(agent);
        vm.prank(owner);
        admin.rotateKey(agent, agent2);
        (uint64 sid2, Session memory s) = admin.sessionOf(agent2);
        assertEq(sid2, sid, "same session");
        assertEq(s.agentKey, agent2);
        (uint64 none,) = admin.sessionOf(agent);
        assertEq(none, 0, "old key unmapped");
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        assertEq(_reason(acct, op), Reason.NO_SESSION, "old key dead");
        assertTrue(_handle(_agentOp(acct, AGENT2_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6))));
    }

    function test_rotate_refusals() public {
        vm.startPrank(owner);
        admin.setPolicy(agent2, _demoPolicy());
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.KeyInUse.selector, agent2));
        admin.rotateKey(agent, agent2);
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.UnknownKey.selector, stranger));
        admin.rotateKey(stranger, attacker);
        vm.expectRevert(abi.encodeWithSelector(AccountCommon.BadAddress.selector, owner));
        admin.rotateKey(agent, owner);
        vm.stopPrank();
    }

    // ================================================================ replay (R11)

    function test_wrongChain_agentOpRefused() public {
        uint256 realChain = block.chainid;
        PackedUserOperation memory op =
            _op(address(acct), _agentNonce(acct, agent), _agentCall(address(usdc), 0, _usdcTransfer(address(grocery), 1e6)));
        vm.chainId(8453);
        bytes32 foreign = ep.getUserOpHash(op);
        vm.chainId(realChain);
        op.signature = abi.encode(uint8(1), _sign65(AGENT_PK, foreign), bytes(""), bytes(""));
        assertEq(_reason(acct, op), Reason.NO_SESSION, "signature over another chain's hash recovers a stranger");
        _expectAA24(op);
    }

    function test_wrongChain_ownerOpRefused() public {
        uint256 realChain = block.chainid;
        PackedUserOperation memory op = _op(
            address(acct),
            ep.getNonce(address(acct), 0),
            abi.encodeWithSelector(acct.execute.selector, address(usdc), 0, _usdcTransfer(attacker, 1e6))
        );
        vm.chainId(84532);
        bytes32 foreign = ep.getUserOpHash(op);
        vm.chainId(realChain);
        op.signature = _sign65(OWNER_PK, foreign);
        _expectAA24(op);
    }

    function test_wrongEntryPoint_hashAndCaller() public {
        EntryPoint ep2 = new EntryPoint();
        PackedUserOperation memory op =
            _op(address(acct), _agentNonce(acct, agent), _agentCall(address(usdc), 0, _usdcTransfer(address(grocery), 1e6)));
        op.signature = abi.encode(uint8(1), _sign65(AGENT_PK, ep2.getUserOpHash(op)), bytes(""), bytes(""));
        _expectAA24(op); // signed for another EntryPoint
        op = _signAgent(op, AGENT_PK); // signed for ours, submitted to another EntryPoint
        vm.expectRevert();
        ep2.handleOps(_one(op), bundler);
        bytes32 h = ep.getUserOpHash(op);
        vm.expectRevert(bytes("account: not from EntryPoint"));
        acct.validateUserOp(op, h, 0);
    }

    function test_replayedNonce_refused() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        assertTrue(_handle(op));
        _expectFailedOp(op, "AA25 invalid account nonce");
        assertEq(usdc.balanceOf(address(grocery)), 1e6, "paid once");
    }

    function test_nonceKey_otherSessionAndLane() public {
        vm.prank(owner);
        admin.setPolicy(agent2, _demoPolicy());
        bytes memory cd = _agentCall(address(usdc), 0, _usdcTransfer(address(grocery), 1e6));
        uint256 otherNonce = ep.getNonce(address(acct), _nonceKey(acct, agent2, LANE_NORMAL));
        PackedUserOperation memory op = _signAgent(_op(address(acct), otherNonce, cd), AGENT_PK);
        assertEq(_reason(acct, op), Reason.NONCE_KEY, "another session's nonce key");
        _expectAA24(op);
        op = _signAgent(_op(address(acct), ep.getNonce(address(acct), 0), cd), AGENT_PK);
        assertEq(_reason(acct, op), Reason.NONCE_KEY, "owner lane 0");
        op = _signAgent(_op(address(acct), ep.getNonce(address(acct), _nonceKey(acct, agent, LANE_APPROVAL)), cd), AGENT_PK);
        assertEq(_reason(acct, op), Reason.NONCE_KEY, "approval lane without an approval");
    }
}
