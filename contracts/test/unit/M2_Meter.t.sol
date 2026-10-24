// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {M1Fixture} from "./M1_Fixture.sol";
import {M2MeterHarness, M2QuietAccount, M2NoMeterAccount} from "./M2_Harness.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {Buckets} from "../../src/lib/Buckets.sol";
import {GreedyMerchant} from "../../src/mocks/GreedyMerchant.sol";
import {GroceryMerchant} from "../../src/mocks/GroceryMerchant.sol";
import {MockUSDC3009} from "../../src/mocks/MockUSDC3009.sol";
import {
    AgentCall,
    ArgRule,
    AssetInput,
    AssetLimit,
    Bucket,
    CallRuleInput,
    OpContext,
    OpKind,
    Outflow,
    PolicyInput,
    Reason,
    RuleOp,
    Tier,
    Track,
    NATIVE,
    ANY_TARGET,
    TARGET_ARG
} from "../../src/lib/PolicyTypes.sol";

/// Shop whose allowance can be pulled outside any agent op (`pullFrom`) and inside one (`order`).
contract M2PullShop {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable treasury;

    constructor(IERC20 token_, address treasury_) {
        token = token_;
        treasury = treasury_;
    }

    function order(uint256 amount, address) external {
        token.safeTransferFrom(msg.sender, treasury, amount);
    }

    function pullFrom(address from, uint256 amount) external {
        token.safeTransferFrom(from, treasury, amount);
    }
}

/// Common helpers for the M2 tests: run a UserOp and read Decision / PolicyBlocked.
abstract contract M2Base is M1Fixture {
    /// Demo fixture, then swap `acct` for an M2QuietAccount clone with the same demo config and funds.
    function _setUpQuiet() internal {
        _setUpFixture();
        AgentAccount impl = new M2QuietAccount(IEntryPoint(address(ep)), factory.accountImplementation().admin());
        acct = new AgentAccountFactory(impl).createAccount(owner, 0);
        admin = AgentAccountAdmin(payable(address(acct)));
        _configureDemo(acct, agent);
        usdc.mint(address(acct), 100e6);
        vm.deal(address(acct), 1 ether);
        vm.prank(owner);
        admin.addDeposit{value: 1 ether}();
    }

    struct Res {
        bool success;
        bool decided;
        bool blocked;
        bytes reason;
        Outflow[] outflows;
    }

    function _exec(PackedUserOperation memory op) internal returns (Res memory r) {
        vm.recordLogs();
        ep.handleOps(_one(op), bundler);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            if (logs[i].emitter == address(ep) && t0 == IEntryPoint.UserOperationEvent.selector) {
                (, r.success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            } else if (logs[i].emitter == op.sender && t0 == AccountCommon.Decision.selector) {
                r.decided = true;
                (,,,, r.outflows) = abi.decode(logs[i].data, (bytes4, address, Tier, Track, Outflow[]));
            } else if (logs[i].emitter == op.sender && t0 == AccountCommon.PolicyBlocked.selector) {
                r.blocked = true;
                (, r.reason) = abi.decode(logs[i].data, (bytes4, bytes));
            }
        }
    }

    function _pv(uint16 code) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AccountCommon.PolicyViolation.selector, code);
    }

    function _xfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TRANSFER, to, amount);
    }

    function _approve(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(APPROVE, spender, amount);
    }

    function _order(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(ORDER, amount, address(acct));
    }

    /// Agent `pk` pays `amount` USDC to `to` (one UserOp).
    function _pay(uint256 pk, address to, uint256 amount) internal returns (Res memory) {
        return _exec(_agentOp(acct, pk, address(usdc), 0, _xfer(to, amount)));
    }

    function _keyLevel(address key, address asset) internal view returns (uint256) {
        AssetLimit memory a = admin.keyAsset(key, asset);
        return Buckets.availableAt(a.bucket, block.timestamp);
    }

    function _globalLevel(address asset) internal view returns (uint256) {
        return Buckets.availableAt(admin.globalBucket(asset), block.timestamp);
    }

    function _exploreLevel(address asset) internal view returns (uint256) {
        return Buckets.availableAt(admin.exploreBucket(asset), block.timestamp);
    }

    function _withCall(PolicyInput memory p, CallRuleInput memory extra) internal pure returns (PolicyInput memory) {
        CallRuleInput[] memory c = new CallRuleInput[](p.calls.length + 1);
        for (uint256 i; i < p.calls.length; ++i) {
            c[i] = p.calls[i];
        }
        c[p.calls.length] = extra;
        p.calls = c;
        return p;
    }

    function _withAsset(PolicyInput memory p, AssetInput memory extra) internal pure returns (PolicyInput memory) {
        AssetInput[] memory a = new AssetInput[](p.assets.length + 1);
        for (uint256 i; i < p.assets.length; ++i) {
            a[i] = p.assets[i];
        }
        a[p.assets.length] = extra;
        p.assets = a;
        return p;
    }

    function _noRules() internal pure returns (ArgRule[] memory) {
        return new ArgRule[](0);
    }

    function _assertOutflow(Res memory r, address asset, uint256 amount) internal pure {
        assertTrue(r.success && r.decided && !r.blocked, "op executed");
        assertEq(r.outflows.length, 1, "one asset moved");
        assertEq(r.outflows[0].asset, asset, "outflow asset");
        assertEq(r.outflows[0].amount, amount, "outflow amount");
    }

    function _assertBlocked(Res memory r, uint16 code) internal pure {
        assertTrue(r.success, "sandbox: blocked op still lands success=true");
        assertTrue(r.blocked && !r.decided, "PolicyBlocked, no Decision");
        assertEq(r.reason, _pv(code), "block reason");
    }
}

/// M2 unit tests: effect metering, bucket debits and the count-once allowance rule on the real
/// account through the EntryPoint (BUILD.md M2; docs/api.md sections 3.2 and 9).
contract M2MeterTest is M2Base {
    function setUp() public {
        _setUpQuiet();
    }

    // ================================================================ measured outflow

    function test_meter_transferDebitsKeyAndGlobal() public {
        Res memory r = _pay(AGENT_PK, address(api), 3e6);
        _assertOutflow(r, address(usdc), 3e6);
        assertEq(_keyLevel(agent, address(usdc)), 7e6, "key bucket debited");
        assertEq(_globalLevel(address(usdc)), 7e6, "global bucket debited");
    }

    function test_meter_approveGrowthDebitedPullCountedOnce() public {
        Res memory r = _exec(_agentOp(acct, AGENT_PK, address(usdc), 0, _approve(address(grocery), 5e6)));
        _assertOutflow(r, address(usdc), 5e6); // allowance growth is spend (F5)
        r = _exec(_agentOp(acct, AGENT_PK, address(grocery), 0, _order(5e6)));
        assertTrue(r.success && r.decided, "order executed");
        assertEq(r.outflows.length, 0, "pull of prepaid allowance counted once (at approve)");
        assertEq(usdc.balanceOf(groceryTreasury), 5e6);
        assertEq(_keyLevel(agent, address(usdc)), 5e6, "only the approve debited");
        assertEq(_globalLevel(address(usdc)), 5e6);
    }

    function test_meter_untrackedSpenderApproveMetered() public {
        // api is a recipient but not a tracked spender: the op's own spender is still metered.
        Res memory r = _exec(_agentOp(acct, AGENT_PK, address(usdc), 0, _approve(address(api), 4e6)));
        _assertOutflow(r, address(usdc), 4e6);
        assertEq(_globalLevel(address(usdc)), 6e6);
    }

    function test_meter_revokeGivesNoCredit() public {
        _exec(_agentOp(acct, AGENT_PK, address(usdc), 0, _approve(address(grocery), 5e6)));
        Res memory r = _exec(_agentOp(acct, AGENT_PK, address(usdc), 0, _approve(address(grocery), 0)));
        assertTrue(r.decided && r.outflows.length == 0, "revoke moves nothing");
        assertEq(_keyLevel(agent, address(usdc)), 5e6, "no credit back for a revoked allowance");
        // Re-granting is new exposure: charged again.
        r = _exec(_agentOp(acct, AGENT_PK, address(usdc), 0, _approve(address(grocery), 5e6)));
        _assertOutflow(r, address(usdc), 5e6);
        assertEq(_keyLevel(agent, address(usdc)), 0);
    }

    function test_meter_ownerAllowancePullCountsInFull() public {
        // Greedy merchant (allowed target) with a standing owner-granted allowance: buy() pulls 10x price.
        GreedyMerchant greedy = new GreedyMerchant(IERC20(address(usdc)), 2e6, attacker);
        vm.startPrank(owner);
        acct.execute(address(usdc), 0, _approve(address(greedy), 100e6));
        admin.setPolicy(agent, _withCall(_demoPolicy(), CallRuleInput(address(greedy), GreedyMerchant.buy.selector, _noRules())));
        vm.stopPrank();
        uint256 bal0 = usdc.balanceOf(address(acct));
        Res memory r = _exec(_agentOp(acct, AGENT_PK, address(greedy), 0, abi.encodeCall(GreedyMerchant.buy, ())));
        _assertBlocked(r, Reason.PER_TX); // 20 USDC measured > perTxCap 10, though nothing was decoded
        assertEq(usdc.balanceOf(attacker), 0, "pull undone");
        assertEq(usdc.balanceOf(address(acct)), bal0);
        assertEq(_keyLevel(agent, address(usdc)), 10e6, "nothing debited");
    }

    function test_meter_ownerAllowancePullDebitedWithinCaps() public {
        GreedyMerchant greedy = new GreedyMerchant(IERC20(address(usdc)), 0.5e6, attacker);
        vm.startPrank(owner);
        acct.execute(address(usdc), 0, _approve(address(greedy), 100e6));
        admin.setPolicy(agent, _withCall(_demoPolicy(), CallRuleInput(address(greedy), GreedyMerchant.buy.selector, _noRules())));
        vm.stopPrank();
        Res memory r = _exec(_agentOp(acct, AGENT_PK, address(greedy), 0, abi.encodeCall(GreedyMerchant.buy, ())));
        _assertOutflow(r, address(usdc), 5e6); // the 10x pull is charged, not free
        assertEq(_keyLevel(agent, address(usdc)), 5e6);
        r = _exec(_agentOp(acct, AGENT_PK, address(greedy), 0, abi.encodeCall(GreedyMerchant.buy, ())));
        _assertOutflow(r, address(usdc), 5e6);
        r = _exec(_agentOp(acct, AGENT_PK, address(greedy), 0, abi.encodeCall(GreedyMerchant.buy, ())));
        _assertBlocked(r, Reason.KEY_BUCKET);
        assertEq(usdc.balanceOf(attacker), 10e6, "loss stops at the bucket");
    }

    function test_meter_externalPullVoidsPrepaid() public {
        M2PullShop shop = new M2PullShop(IERC20(address(usdc)), makeAddr("shopTreasury"));
        vm.startPrank(owner);
        admin.setRecipient(address(shop), true);
        address[] memory sp = new address[](3);
        (sp[0], sp[1], sp[2]) = (address(ticket), address(grocery), address(shop));
        admin.setTrackedSpenders(sp);
        ArgRule[] memory rules = new ArgRule[](2);
        rules[0] = _rule(0, RuleOp.LTE, PER_TX);
        rules[1] = _rule(1, RuleOp.EQ_SELF, 0);
        admin.setPolicy(agent, _withCall(_demoPolicy(), CallRuleInput(address(shop), M2PullShop.order.selector, rules)));
        vm.stopPrank();

        _exec(_agentOp(acct, AGENT_PK, address(usdc), 0, _approve(address(shop), 5e6))); // paid 5
        shop.pullFrom(address(acct), 5e6); // the shop pulls outside any agent op (counted at approve)
        vm.prank(owner);
        acct.execute(address(usdc), 0, _approve(address(shop), 8e6)); // owner grant, not agent-paid
        vm.warp(block.timestamp + 1 days); // refill so the cap is not what decides
        Res memory r = _exec(_agentOp(acct, AGENT_PK, address(shop), 0, abi.encodeCall(M2PullShop.order, (8e6, address(acct)))));
        _assertOutflow(r, address(usdc), 8e6); // stale prepaid (5) excuses nothing
    }

    function test_meter_unenabledAssetBlocked() public {
        MockUSDC3009 tok = new MockUSDC3009();
        GroceryMerchant g2 = new GroceryMerchant(IERC20(address(tok)), groceryTreasury);
        tok.mint(address(acct), 50e6);
        vm.startPrank(owner);
        admin.setGlobalCap(address(tok), 10e6, 10e6); // tracked, but this key has no limit for it
        acct.execute(address(tok), 0, _approve(address(g2), 50e6));
        ArgRule[] memory rules = new ArgRule[](2);
        rules[0] = _rule(0, RuleOp.LTE, PER_TX);
        rules[1] = _rule(1, RuleOp.EQ_SELF, 0);
        admin.setPolicy(agent, _withCall(_demoPolicy(), CallRuleInput(address(g2), ORDER, rules)));
        vm.stopPrank();
        Res memory r = _exec(_agentOp(acct, AGENT_PK, address(g2), 0, _order(1e6)));
        _assertBlocked(r, Reason.ASSET);
        assertEq(tok.balanceOf(address(acct)), 50e6, "pull undone");
    }

    function test_meter_nativeValueMetered() public {
        address vendor = makeAddr("vendor");
        vm.startPrank(owner);
        admin.setRecipient(vendor, true);
        admin.setGlobalCap(NATIVE, 0.05 ether, 0.05 ether);
        ArgRule[] memory rules = new ArgRule[](1);
        rules[0] = _rule(TARGET_ARG, RuleOp.PAYEE, 0);
        PolicyInput memory p = _withAsset(_demoPolicy(), AssetInput(NATIVE, 0.05 ether, 0.05 ether, 0.05 ether));
        admin.setPolicy(agent, _withCall(p, CallRuleInput(ANY_TARGET, bytes4(0), rules)));
        vm.stopPrank();
        Res memory r = _exec(_agentOp(acct, AGENT_PK, vendor, 0.01 ether, ""));
        _assertOutflow(r, NATIVE, 0.01 ether);
        assertEq(_keyLevel(agent, NATIVE), 0.04 ether);
        assertEq(_globalLevel(NATIVE), 0.04 ether);
        r = _exec(_agentOp(acct, AGENT_PK, vendor, 0.045 ether, ""));
        _assertBlocked(r, Reason.KEY_BUCKET);
        assertEq(vendor.balance, 0.01 ether, "second send undone");
    }

    function test_meter_decisionCarriesOutflows() public {
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, _xfer(address(api), 1e6));
        Outflow[] memory o = new Outflow[](1);
        o[0] = Outflow(address(usdc), 1e6);
        vm.expectEmit(true, true, true, true, address(acct));
        emit AccountCommon.Decision(ep.getUserOpHash(op), agent, address(usdc), TRANSFER, address(api), Tier.PROVEN, Track.NORMAL, o);
        _handle(op);
    }

    // ================================================================ buckets on the account

    function test_bucket_keyBucketBlocksAndUndoes() public {
        _assertOutflow(_pay(AGENT_PK, address(api), 10e6), address(usdc), 10e6);
        _assertBlocked(_pay(AGENT_PK, address(api), 1), Reason.KEY_BUCKET);
        assertEq(usdc.balanceOf(address(api)), 10e6, "blocked spend undone");
    }

    function test_bucket_globalSharedAcrossKeys() public {
        // F21: a second key with its own full key bucket still shares the account-wide bucket.
        vm.prank(owner);
        admin.setPolicy(agent2, _demoPolicy());
        _assertOutflow(_pay(AGENT_PK, address(api), 10e6), address(usdc), 10e6);
        assertEq(_keyLevel(agent2, address(usdc)), 10e6, "agent2 key bucket untouched");
        _assertBlocked(_pay(AGENT2_PK, address(api), 1e6), Reason.GLOBAL_BUCKET);
        vm.warp(block.timestamp + 12 hours); // global refills 5
        _assertOutflow(_pay(AGENT2_PK, address(api), 5e6), address(usdc), 5e6);
        _assertBlocked(_pay(AGENT_PK, address(api), 1e6), Reason.GLOBAL_BUCKET);
    }

    function test_bucket_midnightNoDoubleSpend() public {
        // F3: a calendar-day cap allows 2x across midnight; the bucket does not.
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 60);
        _assertOutflow(_pay(AGENT_PK, address(api), 10e6), address(usdc), 10e6);
        vm.warp(midnight + 60);
        _assertBlocked(_pay(AGENT_PK, address(api), 10e6), Reason.KEY_BUCKET);
        uint256 refill = uint256(CAP_RATE) * 120 / 1 days; // what 120 s honestly refill
        _assertOutflow(_pay(AGENT_PK, address(api), refill), address(usdc), refill);
        _assertBlocked(_pay(AGENT_PK, address(api), 1), Reason.KEY_BUCKET);
    }

    function test_bucket_refillHalfDay() public {
        _pay(AGENT_PK, address(api), 10e6);
        vm.warp(block.timestamp + 12 hours);
        _assertOutflow(_pay(AGENT_PK, address(api), 5e6), address(usdc), 5e6);
        _assertBlocked(_pay(AGENT_PK, address(api), 1), Reason.KEY_BUCKET);
    }

    // ================================================================ exploration track (D3 tiers)

    function test_meter_exploreTrackDebitsExploreBucket() public {
        address newbie = makeAddr("newbie"); // not listed, not attested -> UNPROVEN -> EXPLORE
        Res memory r = _pay(AGENT_PK, newbie, 0.2e6);
        _assertOutflow(r, address(usdc), 0.2e6);
        assertEq(_exploreLevel(address(usdc)), 0.3e6, "explore bucket debited");
        assertEq(_keyLevel(agent, address(usdc)), 9.8e6, "key bucket debited too");
        assertEq(_globalLevel(address(usdc)), 9.8e6, "global bucket debited too (I8)");
        _assertOutflow(_pay(AGENT_PK, newbie, 0.2e6), address(usdc), 0.2e6);
        _assertBlocked(_pay(AGENT_PK, newbie, 0.2e6), Reason.EXPLORE_BUCKET);
        assertEq(usdc.balanceOf(newbie), 0.4e6, "exploration loss stops at exploreCap burst");
    }

    // ================================================================ fuzz: bucket bound on the account

    /// Any sequence of agent payments: total measured outflow in any 24 h window <= cap.
    function testFuzz_meterWindow(uint32[8] memory gaps, uint64[8] memory wants) public {
        uint256[8] memory ts;
        uint256[8] memory paid;
        for (uint256 i; i < 8; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 0, 16 hours)); // stays inside the 6-day policy
            uint256 want = bound(wants[i], 1, PER_TX);
            uint256 before = usdc.balanceOf(address(api));
            _pay(AGENT_PK, address(api), want);
            ts[i] = block.timestamp;
            paid[i] = usdc.balanceOf(address(api)) - before;
            assertTrue(paid[i] == 0 || paid[i] == want, "all or nothing");
        }
        for (uint256 i; i < 8; ++i) {
            uint256 sum;
            for (uint256 j = i; j < 8; ++j) {
                if (ts[j] <= ts[i] + 1 days) sum += paid[j];
            }
            assertLe(sum, uint256(CAP_BURST) + CAP_RATE, "24 h window <= cap");
        }
    }
}

/// Meter hooks alone (M2MeterHarness): declared debits / credits (voucher path), the approval
/// track default, the measured explorePerTxCap, prepaid bookkeeping, and the gas figure.
contract M2MeterHooksTest is M2Base {
    M2MeterHarness internal h;
    uint64 internal constant SID = 7;
    MockUSDC3009 internal t2;
    MockUSDC3009 internal t3;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function setUp() public {
        _setUpFixture();
        h = new M2MeterHarness(address(ep));
        h.setGlobal(address(usdc), CAP_BURST, CAP_RATE);
        h.setExplore(address(usdc), 0.5e6, 0.5e6, 0.2e6);
        h.setKeyAsset(SID, address(usdc), PER_TX, CAP_BURST, CAP_RATE);
        address[] memory sp = new address[](2);
        (sp[0], sp[1]) = (address(ticket), address(grocery));
        h.setSpenders(sp);
        usdc.mint(address(h), 100e6);
    }

    function _ctx(Track track) internal pure returns (OpContext memory c) {
        c.sessionId = SID;
        c.track = track;
    }

    function _call(address target, uint256 value, bytes memory data) internal pure returns (AgentCall memory c) {
        c.kind = OpKind.CALL;
        c.target = target;
        c.value = value;
        c.data = data;
        c.selector = data.length >= 4 ? bytes4(data) : bytes4(0);
    }

    function test_meter_declaredDebitAndCredit() public {
        h.debitDeclared(_ctx(Track.NORMAL), address(usdc), 3e6);
        assertEq(h.keyLevel(SID, address(usdc)), 7e6);
        assertEq(h.globalLevel(address(usdc)), 7e6);
        assertEq(h.exploreLevel(address(usdc)), 0.5e6, "normal track leaves explore alone");
        h.credit(SID, Track.NORMAL, address(usdc), 3e6);
        assertEq(h.keyLevel(SID, address(usdc)), 10e6);
        h.credit(SID, Track.NORMAL, address(usdc), 3e6);
        assertEq(h.keyLevel(SID, address(usdc)), 10e6, "credit never above burst");
        assertEq(h.globalLevel(address(usdc)), 10e6);
    }

    function test_meter_declaredExploreDebitAndCredit() public {
        h.debitDeclared(_ctx(Track.EXPLORE), address(usdc), 0.2e6);
        assertEq(h.exploreLevel(address(usdc)), 0.3e6);
        assertEq(h.keyLevel(SID, address(usdc)), 9.8e6);
        h.credit(SID, Track.EXPLORE, address(usdc), 0.2e6);
        assertEq(h.exploreLevel(address(usdc)), 0.5e6);
        assertEq(h.globalLevel(address(usdc)), 10e6);
    }

    function test_meter_declaredRefusals() public {
        vm.expectRevert(_pv(Reason.ASSET));
        h.debitDeclared(_ctx(Track.NORMAL), address(0xBEEF), 1);
        vm.expectRevert(_pv(Reason.PER_TX));
        h.debitDeclared(_ctx(Track.NORMAL), address(usdc), PER_TX + 1);
        vm.expectRevert(_pv(Reason.EXPLORE_PER_TX));
        h.debitDeclared(_ctx(Track.EXPLORE), address(usdc), 0.3e6); // measured/declared explorePerTxCap
        h.debitDeclared(_ctx(Track.EXPLORE), address(usdc), 0.2e6);
        h.debitDeclared(_ctx(Track.EXPLORE), address(usdc), 0.2e6);
        vm.expectRevert(_pv(Reason.EXPLORE_BUCKET));
        h.debitDeclared(_ctx(Track.EXPLORE), address(usdc), 0.2e6);
        h.debitDeclared(_ctx(Track.NORMAL), address(usdc), 9.6e6);
        vm.expectRevert(_pv(Reason.KEY_BUCKET));
        h.debitDeclared(_ctx(Track.NORMAL), address(usdc), 1);
    }

    function test_meter_globalBucketChecked() public {
        OpContext memory c = _ctx(Track.NORMAL);
        c.sessionId = SID + 1;
        h.setKeyAsset(c.sessionId, address(usdc), PER_TX, 50e6, 50e6); // key bucket larger than global
        h.debitDeclared(c, address(usdc), 10e6);
        vm.expectRevert(_pv(Reason.GLOBAL_BUCKET));
        h.debitDeclared(c, address(usdc), 1);
    }

    function test_meter_approvalTrackMeasuredNotCharged() public {
        Outflow[] memory o = h.run(_ctx(Track.APPROVAL), _call(address(usdc), 0, _xfer(attacker, 50e6)));
        assertEq(o.length, 1);
        assertEq(o[0].amount, 50e6, "measured for the owner's maxOutflow check");
        assertEq(h.keyLevel(SID, address(usdc)), 10e6, "no bucket debit on the approval track");
        assertEq(h.globalLevel(address(usdc)), 10e6);
        o = h.run(_ctx(Track.APPROVAL), _call(address(usdc), 0, _approve(address(grocery), 30e6)));
        assertEq(o[0].amount, 30e6, "growth measured");
        (uint256 paid,) = h.prepaidOf(address(usdc), address(grocery));
        assertEq(paid, 0, "owner-approved growth is not agent-prepaid");
        h.debitDeclared(_ctx(Track.APPROVAL), address(usdc), 1e9); // declared: also never charged
        h.credit(SID, Track.APPROVAL, address(usdc), 1e9);
        assertEq(h.keyLevel(SID, address(usdc)), 10e6);
    }

    /// APPC request: the approval track gets the same measured outflows as the other tracks, so the
    /// maxOutflow post-check always has something to check (an empty array would pass it vacuously).
    function test_meter_outflowsReturnedOnEveryTrack() public {
        Track[3] memory tracks = [Track.NORMAL, Track.EXPLORE, Track.APPROVAL];
        for (uint256 i; i < 3; ++i) {
            Outflow[] memory o = h.run(_ctx(tracks[i]), _call(address(usdc), 0, _xfer(attacker, 0.1e6)));
            assertEq(o.length, 1, "one outflow on every track");
            assertEq(o[0].asset, address(usdc));
            assertEq(o[0].amount, 0.1e6);
        }
        Outflow[] memory g = h.run(_ctx(Track.APPROVAL), _call(address(usdc), 0, _approve(attacker, 7e6)));
        assertEq(g.length, 1, "allowance growth reported on the approval track");
        assertEq(g[0].amount, 7e6);
        assertEq(h.keyLevel(SID, address(usdc)), 10e6 - 0.2e6, "only NORMAL and EXPLORE charged");
    }

    function test_meter_measuredCapsReverts() public {
        vm.expectRevert(_pv(Reason.PER_TX));
        h.run(_ctx(Track.NORMAL), _call(address(usdc), 0, _xfer(attacker, PER_TX + 1)));
        vm.expectRevert(_pv(Reason.EXPLORE_PER_TX));
        h.run(_ctx(Track.EXPLORE), _call(address(usdc), 0, _xfer(attacker, 0.2e6 + 1)));
        vm.expectRevert(_pv(Reason.PER_TX));
        h.run(_ctx(Track.NORMAL), _call(address(usdc), 0, _approve(address(grocery), type(uint256).max))); // F5
    }

    function test_meter_prepaidBookkeeping() public {
        h.run(_ctx(Track.NORMAL), _call(address(usdc), 0, _approve(address(grocery), 4e6)));
        (uint256 paid, uint256 seen) = h.prepaidOf(address(usdc), address(grocery));
        assertEq(paid, 4e6);
        assertEq(seen, 4e6);
        h.run(_ctx(Track.NORMAL), _call(address(usdc), 0, _approve(address(grocery), 1e6))); // lower: no credit
        (paid, seen) = h.prepaidOf(address(usdc), address(grocery));
        assertEq(paid, 1e6, "prepaid never above the allowance");
        assertEq(h.keyLevel(SID, address(usdc)), 6e6);
        Outflow[] memory o = h.run(_ctx(Track.NORMAL), _call(address(grocery), 0, abi.encodeWithSelector(ORDER, 1e6, address(h))));
        assertEq(o.length, 0, "pull of prepaid allowance is free");
        (paid, seen) = h.prepaidOf(address(usdc), address(grocery));
        assertEq(paid, 0);
        assertEq(seen, 0);
    }

    function test_meter_nativeIncludesDeposit() public {
        vm.deal(address(h), 1 ether);
        h.setGlobal(NATIVE, 1 ether, 1 ether);
        h.setKeyAsset(SID, NATIVE, 1 ether, 1 ether, 1 ether);
        // Moving ETH into the account's own EntryPoint deposit is not an outflow.
        Outflow[] memory o =
            h.run(_ctx(Track.NORMAL), _call(address(ep), 0.3 ether, abi.encodeCall(ep.depositTo, (address(h)))));
        assertEq(o.length, 0, "balance -> own deposit nets to zero");
        o = h.run(_ctx(Track.NORMAL), _call(attacker, 0.2 ether, ""));
        assertEq(o[0].asset, NATIVE);
        assertEq(o[0].amount, 0.2 ether);
        assertEq(h.keyLevel(SID, NATIVE), 0.8 ether);
    }
}

/// results/gas_m2.json (BUILD M2 gas row): 3 tracked tokens, 4 tracked spenders (Permit2 included),
/// one USDC transfer to a listed shop.
///  - meterOverheadGas: in place, through EntryPoint.handleOps, metered account minus an identical
///    account with the meter hooks stubbed, every account / token / spender cooled first (fresh-tx
///    access costs; validation warms what it reads, as on chain);
///  - meterHooksGasAllCold: gas inside _meterBefore + _meterAfter in the harness with all storage
///    cold (upper bound).
contract M2GasTest is M2Base {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    MockUSDC3009 internal t2;
    MockUSDC3009 internal t3;

    function setUp() public {
        _setUpFixture();
        t2 = new MockUSDC3009();
        t3 = new MockUSDC3009();
    }

    function _account(AgentAccount impl, uint256 salt) internal returns (AgentAccount a) {
        a = new AgentAccountFactory(impl).createAccount(owner, salt);
        AgentAccountAdmin ad = AgentAccountAdmin(payable(address(a)));
        _configureDemo(a, agent);
        vm.startPrank(owner);
        ad.setGlobalCap(address(t2), CAP_BURST, CAP_RATE);
        ad.setGlobalCap(address(t3), CAP_BURST, CAP_RATE);
        address[] memory sp = new address[](4);
        (sp[0], sp[1], sp[2], sp[3]) = (address(ticket), address(grocery), address(api), PERMIT2);
        ad.setTrackedSpenders(sp);
        ad.addDeposit{value: 1 ether}();
        vm.stopPrank();
        usdc.mint(address(a), 100e6);
        t2.mint(address(a), 100e6);
        t3.mint(address(a), 100e6);
    }

    function _coolAll(address a) internal {
        address[9] memory xs =
            [a, address(usdc), address(t2), address(t3), address(api), address(ticket), address(grocery), PERMIT2, address(ep)];
        for (uint256 i; i < xs.length; ++i) {
            vm.cool(xs[i]);
        }
    }

    function _opGas(AgentAccount a) internal returns (uint256 used) {
        PackedUserOperation memory op = _agentOp(a, AGENT_PK, address(usdc), 0, _xfer(address(api), 1e6));
        _coolAll(address(a));
        uint256 g = gasleft();
        ep.handleOps(_one(op), bundler);
        used = g - gasleft();
        assertEq(usdc.balanceOf(address(api)) % 1e6, 0);
    }

    function test_meter_gasOverhead() public {
        address adminLogic = factory.accountImplementation().admin();
        vm.deal(owner, 10 ether);
        AgentAccount metered = _account(new M2QuietAccount(IEntryPoint(address(ep)), adminLogic), 11);
        AgentAccount bare = _account(new M2NoMeterAccount(IEntryPoint(address(ep)), adminLogic), 12);
        uint256 gMetered = _opGas(metered); // first agent op of the test: MeterLib is cold too
        uint256 gBare = _opGas(bare);
        assertEq(usdc.balanceOf(address(api)), 2e6, "both ops paid");
        uint256 overhead = gMetered - gBare;

        M2MeterHarness h = new M2MeterHarness(address(ep));
        h.setGlobal(address(usdc), CAP_BURST, CAP_RATE);
        h.setGlobal(address(t2), CAP_BURST, CAP_RATE);
        h.setGlobal(address(t3), CAP_BURST, CAP_RATE);
        h.setKeyAsset(1, address(usdc), PER_TX, CAP_BURST, CAP_RATE);
        address[] memory sp = new address[](4);
        (sp[0], sp[1], sp[2], sp[3]) = (address(ticket), address(grocery), address(api), PERMIT2);
        h.setSpenders(sp);
        usdc.mint(address(h), 10e6);
        _coolAll(address(h));
        OpContext memory c;
        c.sessionId = 1;
        AgentCall memory call;
        call.target = address(usdc);
        call.data = _xfer(address(api), 1e6);
        call.selector = TRANSFER;
        h.run(c, call);
        uint256 allCold = h.lastMeterGas();

        string memory j = "gas";
        vm.serializeString(j, "chainMode", "local");
        vm.serializeString(j, "case", "agent USDC transfer to a listed shop via EntryPoint.handleOps");
        vm.serializeUint(j, "trackedTokens", 3);
        vm.serializeUint(j, "trackedSpenders", 4);
        vm.serializeUint(j, "opGasMetered", gMetered);
        vm.serializeUint(j, "opGasNoMeter", gBare);
        vm.serializeUint(j, "meterHooksGasAllCold", allCold);
        string memory out = vm.serializeUint(j, "meterOverheadGas", overhead);
        vm.writeJson(out, "../results/gas_m2.json");
        assertGt(overhead, 0);
    }
}
