// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {M3Base} from "./M3_Base.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {OneDoorModule} from "../../src/modules/OneDoorModule.sol";
import {FreezeAdmin} from "../../src/modules/FreezeModule.sol";
import {
    PolicyInput,
    CallRuleInput,
    ArgRule,
    RuleOp,
    Reason,
    Voucher,
    VoucherState,
    Session
} from "../../src/lib/PolicyTypes.sol";

/// M3 (D1 one door): ERC-1271 owner-only, the x402 voucher envelope, voucher registration,
/// reclaim and the execution lock. BUILD.md M3, docs/api.md 3.3 / 4.1 / 4.6.
contract M3_OneDoorTest is M3Base {
    bytes32 internal constant N1 = keccak256("m3/n1");
    bytes32 internal constant N2 = keccak256("m3/n2");
    uint256 internal constant AGENT3_PK = 0xA6E4A;
    uint256 internal constant NEWKEY_PK = 0xA6E4B;

    function setUp() public {
        _setUpM3();
    }

    function _vb() internal view returns (uint256) {
        return block.timestamp + 300;
    }

    function _digestApi(uint256 value, uint256 vb, bytes32 n) internal view returns (bytes32) {
        return _twaDigest(address(acct), address(api), value, 0, vb, n);
    }

    function _registerApi(bytes32 n, uint256 value, uint256 vb) internal returns (Res memory r) {
        r = _submit(_registerOp(AGENT_PK, address(api), value, vb, n));
    }

    function _voucherCd(bytes memory body) internal view returns (bytes memory) {
        return _agentOpKind(KIND_VOUCHER, address(usdc), 0, body);
    }

    function _check(address key, bytes memory cd) internal view returns (uint16 reason) {
        (reason,,,) = acct.policyCheck(key, cd, "", "");
    }

    function _sid(address key) internal view returns (uint64 sid) {
        (sid,) = admin.sessionOf(key);
    }

    // ================================================================ 1271 owner-only (default)

    function test_1271_ownerOnly_defaultMode() public view {
        assertEq(admin.sig1271Mode(), 0, "OWNER_ONLY by default");
    }

    function test_1271_ownerOnly_ownerSigAccepted() public view {
        bytes32 h = keccak256("any hash the owner signs");
        assertEq(acct.isValidSignature(h, _sign65(OWNER_PK, h)), MAGIC);
    }

    function test_1271_ownerOnly_agentAndStrangerRefused(bytes32 h) public view {
        assertEq(acct.isValidSignature(h, _sign65(AGENT_PK, h)), INVALID, "agent key");
        assertEq(acct.isValidSignature(h, _sign65(AGENT2_PK, h)), INVALID, "agent2 key");
        assertEq(acct.isValidSignature(h, _sign65(STRANGER_PK, h)), INVALID, "stranger");
    }

    function test_1271_ownerOnly_sideDoorRefused() public {
        uint256 vb = block.timestamp + 1 hours;
        bytes32 n = keccak256("side door");
        bytes32 d = _twaDigest(address(acct), attacker, 100e6, 0, vb, n);
        bytes memory sig = _sign65(AGENT_PK, d);
        assertEq(acct.isValidSignature(d, sig), INVALID);
        vm.expectRevert();
        vm.prank(attacker);
        usdc.transferWithAuthorization(address(acct), attacker, 100e6, 0, vb, n, sig);
        assertEq(usdc.balanceOf(attacker), 0, "nothing lost");
        assertEq(usdc.balanceOf(address(acct)), 100e6);
    }

    function test_1271_ownerOnly_permitRefused() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 sh = keccak256(
            abi.encode(PERMIT_TYPEHASH, address(acct), attacker, uint256(100e6), usdc.nonces(address(acct)), deadline)
        );
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
        bytes memory sig = _sign65(AGENT_PK, d);
        assertEq(acct.isValidSignature(d, sig), INVALID);
        vm.expectRevert();
        usdc.permit(address(acct), attacker, 100e6, deadline, sig);
        assertEq(usdc.allowance(address(acct), attacker), 0);
    }

    function test_1271_ownerOnly_envelopeAndRegistrationRefused() public {
        uint256 vb = _vb();
        PackedUserOperation memory op = _registerOp(AGENT_PK, address(api), API_PRICE, vb, N1);
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "no voucher ops in OWNER_ONLY");
        _expectAA24(op);
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb, N1), env), INVALID);
    }

    function test_1271_ownerOnly_modeOffKillsRegisteredVoucher() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        bytes32 d = _digestApi(API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(d, env), MAGIC);
        _setMode(acct, 0);
        assertEq(acct.isValidSignature(d, env), INVALID, "OWNER_ONLY again");
        vm.expectRevert();
        api.settle(address(acct), API_PRICE, 0, vb, N1, env, "r");
    }

    function test_1271_ownerOnly_junkNeverMagic(bytes memory junk, bytes32 h) public {
        _voucherOn();
        try acct.isValidSignature(h, junk) returns (bytes4 r) {
            assertEq(r, INVALID);
        } catch {}
        bytes memory tagged = bytes.concat(abi.encode(uint256(1)), junk);
        try acct.isValidSignature(h, tagged) returns (bytes4 r) {
            assertEq(r, INVALID);
        } catch {}
    }

    // ================================================================ voucher mode

    function test_1271_voucher_registerSettleOnceDebitOnce() public {
        _voucherOn();
        bool live = _meterLive();
        uint256 vb = _vb();
        uint256 k0 = _keyLevel(agent);
        uint256 g0 = _globalLevel();
        Res memory r = _registerApi(N1, API_PRICE, vb);
        assertTrue(r.validated && r.success && r.registered && !r.blocked, "registered");
        assertEq(r.outflow, API_PRICE, "Decision outflow = value");
        Voucher memory v = _voucher(N1);
        assertEq(uint8(v.state), uint8(VoucherState.Registered));
        assertEq(v.to, address(api));
        assertEq(v.value, API_PRICE);
        assertEq(v.validAfter, 0);
        assertEq(v.validBefore, vb);
        assertEq(v.token, address(usdc));
        assertEq(v.sessionId, _sid(agent));
        uint256 kd = k0 - _keyLevel(agent);
        uint256 gd = g0 - _globalLevel();
        assertEq(kd, live ? API_PRICE : 0, "key bucket debited once by value");
        assertEq(gd, live ? API_PRICE : 0, "global bucket debited once by value");

        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb, N1), env), MAGIC);
        uint256 b0 = usdc.balanceOf(address(acct));
        api.settle(address(acct), API_PRICE, 0, vb, N1, env, "weather");
        assertEq(b0 - usdc.balanceOf(address(acct)), API_PRICE, "settled once");
        assertEq(usdc.balanceOf(address(api)), API_PRICE);
        assertTrue(usdc.authorizationState(address(acct), N1));
        vm.expectRevert();
        api.settle(address(acct), API_PRICE, 0, vb, N1, env, "again");
        assertEq(usdc.balanceOf(address(api)), API_PRICE, "second use of the nonce fails");
        assertEq(k0 - _keyLevel(agent), kd, "settlement does not debit again");
        assertEq(g0 - _globalLevel(), gd);
    }

    function test_1271_voucher_fieldMismatchRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        address a = address(acct);
        // Each envelope is honestly signed by the agent over its own digest, but differs from the voucher.
        assertEq(acct.isValidSignature(_twaDigest(a, attacker, API_PRICE, 0, vb, N1), _envelope(AGENT_PK, attacker, API_PRICE, vb, N1)), INVALID, "to");
        assertEq(acct.isValidSignature(_digestApi(API_PRICE + 1, vb, N1), _envelope(AGENT_PK, address(api), API_PRICE + 1, vb, N1)), INVALID, "value");
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb + 1, N1), _envelope(AGENT_PK, address(api), API_PRICE, vb + 1, N1)), INVALID, "validBefore");
        assertEq(acct.isValidSignature(_twaDigest(a, address(api), API_PRICE, 1, vb, N1), _envelopeFor(a, AGENT_PK, address(api), API_PRICE, 1, vb, N1)), INVALID, "validAfter");
        // Right envelope, wrong hash (the token asks about a different transfer).
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(_twaDigest(a, attacker, API_PRICE, 0, vb, N1), env), INVALID, "hash");
        bytes memory envAttacker = _envelope(AGENT_PK, attacker, API_PRICE, vb, N1); // built before expectRevert
        vm.expectRevert();
        vm.prank(attacker);
        usdc.transferWithAuthorization(a, attacker, API_PRICE, 0, vb, N1, envAttacker);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_1271_voucher_unregisteredNonceRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N2);
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb, N2), env), INVALID);
        vm.expectRevert();
        api.settle(address(acct), API_PRICE, 0, vb, N2, env, "r");
    }

    function test_1271_voucher_wrongSignerRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        bytes32 d = _digestApi(API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(d, _envelope(STRANGER_PK, address(api), API_PRICE, vb, N1)), INVALID, "stranger");
        assertEq(acct.isValidSignature(d, _envelope(AGENT2_PK, address(api), API_PRICE, vb, N1)), INVALID, "other session");
        assertEq(acct.isValidSignature(d, _envelope(OWNER_PK, address(api), API_PRICE, vb, N1)), INVALID, "owner in envelope");
        assertEq(acct.isValidSignature(d, _envelope(AGENT_PK, address(api), API_PRICE, vb, N1)), MAGIC, "control");
    }

    function test_1271_voucher_revokedKeyRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        vm.prank(owner);
        admin.revoke(agent);
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb, N1), env), INVALID);
        vm.expectRevert();
        api.settle(address(acct), API_PRICE, 0, vb, N1, env, "r");
    }

    function test_1271_voucher_rotatedKey() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        vm.prank(owner);
        admin.rotateKey(agent, vm.addr(NEWKEY_PK));
        bytes32 d = _digestApi(API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(d, _envelope(AGENT_PK, address(api), API_PRICE, vb, N1)), INVALID, "old key dead");
        assertEq(acct.isValidSignature(d, _envelope(NEWKEY_PK, address(api), API_PRICE, vb, N1)), MAGIC, "session's key");
    }

    function test_1271_voucher_frozenKeyRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        vm.prank(owner);
        FreezeAdmin(address(acct)).freeze(agent);
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb, N1), _envelope(AGENT_PK, address(api), API_PRICE, vb, N1)), INVALID);
    }

    function test_1271_voucher_expiredSessionRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        (, Session memory s) = admin.sessionOf(agent);
        vm.warp(uint256(s.validUntil) + 1);
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb, N1), _envelope(AGENT_PK, address(api), API_PRICE, vb, N1)), INVALID);
    }

    function test_1271_voucher_otherAccountRefused() public {
        AgentAccount acct2 = factory.createAccount(owner, 7);
        _configureDemo(acct2, agent);
        _setMode(acct2, 1);
        _voucherOn();
        vm.prank(owner);
        AgentAccountAdmin(payable(address(acct2))).addDeposit{value: 1 ether}();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        assertTrue(_submit(_registerOpOn(acct2, AGENT_PK, address(usdc), _voucherBody(address(api), API_PRICE, 0, vb, N1))).registered);
        // The envelope and digest for acct (from = acct) are refused by acct2, and vice versa.
        bytes32 d1 = _digestApi(API_PRICE, vb, N1);
        bytes memory e1 = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(d1, e1), MAGIC);
        assertEq(acct2.isValidSignature(d1, e1), INVALID, "from = this binds the wallet");
    }

    function test_1271_voucher_permitDigestRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        bytes32 sh = keccak256(
            abi.encode(PERMIT_TYPEHASH, address(acct), attacker, uint256(100e6), usdc.nonces(address(acct)), vb)
        );
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
        bytes memory raw = _sign65(AGENT_PK, d);
        bytes memory wrapped = abi.encode(uint8(1), address(api), API_PRICE, uint256(0), vb, N1, raw);
        assertEq(acct.isValidSignature(d, raw), INVALID, "raw agent permit");
        assertEq(acct.isValidSignature(d, wrapped), INVALID, "permit digest inside a voucher envelope");
        vm.expectRevert();
        usdc.permit(address(acct), attacker, 100e6, vb, wrapped);
    }

    function test_1271_voucher_registrationPayeeRules() public {
        _voucherOn();
        uint256 vb = _vb();
        // Unlisted payee above any exploration per-tx cap: refused (RECIPIENT pre-M4, EXPLORE_PER_TX from M4).
        bytes memory cd = _voucherCd(_voucherBody(attacker, 1e6, 0, vb, N1));
        assertTrue(_check(agent, cd) != Reason.OK, "unlisted payee refused");
        _expectAA24(_registerOp(AGENT_PK, attacker, 1e6, vb, N1));
        // Flagged payee: FLAGGED.
        vm.prank(owner);
        admin.flag(address(api));
        assertEq(Reason.code(_check(agent, _voucherCd(_voucherBody(address(api), API_PRICE, 0, vb, N1)))), Reason.FLAGGED);
    }

    function test_1271_voucher_registrationPerTxCap() public {
        _voucherOn();
        bytes memory cd = _voucherCd(_voucherBody(address(api), uint256(PER_TX) + 1, 0, _vb(), N1));
        assertEq(_check(agent, cd), Reason.PER_TX);
        cd = _voucherCd(_voucherBody(address(api), PER_TX, 0, _vb(), N1));
        assertEq(_check(agent, cd), Reason.OK, "at the cap");
    }

    function test_1271_voucher_registrationNeedsTransferRule() public {
        _voucherOn();
        PolicyInput memory p = _demoPolicy();
        CallRuleInput[] memory calls = new CallRuleInput[](1);
        calls[0] = p.calls[1]; // USDC approve only, no transfer rule
        p.calls = calls;
        vm.prank(owner);
        admin.setPolicy(vm.addr(AGENT3_PK), p);
        bytes memory cd = _voucherCd(_voucherBody(address(api), API_PRICE, 0, _vb(), N1));
        assertEq(_check(vm.addr(AGENT3_PK), cd), Reason.TARGET);
        assertEq(_check(agent, cd), Reason.OK, "control: demo key has the transfer rule");
    }

    function test_1271_voucher_registrationArgRulesApply() public {
        _voucherOn();
        PolicyInput memory p = _demoPolicy();
        CallRuleInput[] memory calls = new CallRuleInput[](1);
        ArgRule[] memory r = new ArgRule[](2);
        r[0] = _rule(0, RuleOp.EQ, uint256(uint160(address(api))));
        r[1] = _rule(1, RuleOp.LTE, 5e4);
        calls[0] = CallRuleInput(address(usdc), TRANSFER, r);
        p.calls = calls;
        address k3 = vm.addr(AGENT3_PK);
        vm.prank(owner);
        admin.setPolicy(k3, p);
        uint256 vb = _vb();
        assertEq(_check(k3, _voucherCd(_voucherBody(address(api), 5e4, 0, vb, N1))), Reason.OK);
        assertEq(_check(k3, _voucherCd(_voucherBody(address(api), 5e4 + 1, 0, vb, N1))), Reason.argRule(1));
        assertEq(_check(k3, _voucherCd(_voucherBody(address(grocery), 5e4, 0, vb, N1))), Reason.argRule(0));
    }

    function test_1271_voucher_shapeRefused() public {
        uint256 vb = _vb();
        address a = address(api);
        bytes memory ok = _voucherBody(a, API_PRICE, 0, vb, N1);
        assertEq(_check(agent, _voucherCd(ok)), Reason.OP_SHAPE, "mode off");
        _voucherOn();
        assertEq(_check(agent, _voucherCd(ok)), Reason.OK, "control");
        assertEq(_check(agent, _voucherCd(_voucherBody(a, 0, 0, vb, N1))), Reason.OP_SHAPE, "value 0");
        assertEq(_check(agent, _voucherCd(_voucherBody(a, API_PRICE, vb, vb, N1))), Reason.OP_SHAPE, "validAfter >= validBefore");
        assertEq(_check(agent, _voucherCd(_voucherBody(a, uint256(type(uint128).max) + 1, 0, vb, N1))), Reason.OP_SHAPE, "value > uint128");
        assertEq(_check(agent, _voucherCd(_voucherBody(a, API_PRICE, 0, uint256(type(uint48).max) + 1, N1))), Reason.OP_SHAPE, "validBefore > uint48");
        bytes memory dirty = abi.encode(uint256(uint160(a)) | (uint256(1) << 200), API_PRICE, 0, vb, N1);
        assertEq(_check(agent, _voucherCd(dirty)), Reason.OP_SHAPE, "dirty to");
        assertEq(_check(agent, _voucherCd(bytes.concat(ok, bytes32(0)))), Reason.OP_SHAPE, "body length");
        assertEq(_check(agent, _agentOpKind(KIND_VOUCHER, address(usdc), 1, ok)), Reason.OP_SHAPE, "native value");
        assertEq(_check(agent, _agentOpKind(KIND_VOUCHER, address(0), 0, ok)), Reason.TARGET, "native token");
        assertEq(_check(agent, _agentOpKind(KIND_VOUCHER, address(acct), 0, ok)), Reason.TARGET, "account as token");
    }

    function test_1271_voucher_duplicateNonceRefused() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        PackedUserOperation memory op = _registerOp(AGENT_PK, address(api), 2 * API_PRICE, vb, N1);
        assertEq(_reason(acct, op), Reason.OP_SHAPE, "a nonce registers once (I4)");
        _expectAA24(op);
        assertEq(_voucher(N1).value, API_PRICE);
    }

    function test_1271_voucher_sameBundleDoubleRegistration() public {
        _voucherOn();
        bool live = _meterLive();
        uint256 vb = _vb();
        uint256 k0 = _keyLevel(agent);
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _registerOp(AGENT_PK, address(api), API_PRICE, vb, N1);
        bytes memory cd = _voucherCd(_voucherBody(address(api), 2 * API_PRICE, 0, vb, N1));
        ops[1] = _signAgent(_op(address(acct), _agentNonce(acct, agent) + 1, cd), AGENT_PK);
        vm.recordLogs();
        ep.handleOps(ops, bundler);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 registered;
        uint256 blocked;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(acct)) continue;
            if (logs[i].topics[0] == OneDoorModule.VoucherRegistered.selector) ++registered;
            if (logs[i].topics[0] == AccountCommon.PolicyBlocked.selector) ++blocked;
        }
        assertEq(registered, 1, "only the first registers");
        assertEq(blocked, 1, "the second is blocked by the execution re-check");
        assertEq(_voucher(N1).value, API_PRICE);
        assertEq(k0 - _keyLevel(agent), live ? API_PRICE : 0, "debited once");
    }

    function test_1271_voucher_ttlBound() public {
        _voucherOn();
        uint256 k0 = _keyLevel(agent);
        Res memory r = _registerApi(N1, API_PRICE, block.timestamp + TTL + 1);
        assertTrue(r.validated && r.success && r.blocked && !r.registered, "TTL too long: PolicyBlocked");
        assertEq(uint8(_voucher(N1).state), uint8(VoucherState.None));
        assertEq(_keyLevel(agent), k0, "no debit");
        r = _registerApi(N2, API_PRICE, block.timestamp + TTL);
        assertTrue(r.success && r.registered && !r.blocked, "TTL boundary registers");
    }

    function test_1271_voucher_expiredAtExecutionBlocked() public {
        _voucherOn();
        Res memory r = _registerApi(N1, API_PRICE, block.timestamp);
        assertTrue(r.validated && r.blocked && !r.registered, "validBefore <= now: PolicyBlocked");
        assertEq(uint8(_voucher(N1).state), uint8(VoucherState.None));
    }

    // ================================================================ reclaim

    function test_reclaim_unusedAfterExpiryCreditsOnce() public {
        _voucherOn();
        bool live = _meterLive();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        vm.warp(vb);
        vm.expectEmit(true, false, false, true, address(acct));
        emit OneDoorModule.VoucherReclaimed(N1, API_PRICE);
        acct.reclaim(N1);
        assertEq(uint8(_voucher(N1).state), uint8(VoucherState.Reclaimed));
        // burst - value + refill(300 s) + credit, capped at burst; without the credit it stays below burst.
        if (live) assertEq(_keyLevel(agent), CAP_BURST, "credited back");
        vm.expectRevert(abi.encodeWithSelector(OneDoorModule.VoucherNotReclaimable.selector, N1));
        acct.reclaim(N1);
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        assertEq(acct.isValidSignature(_digestApi(API_PRICE, vb, N1), env), INVALID, "reclaimed voucher is dead");
        vm.expectRevert();
        api.settle(address(acct), API_PRICE, 0, vb, N1, env, "late");
    }

    function test_reclaim_beforeExpiryReverts() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        vm.warp(vb - 1);
        vm.expectRevert(abi.encodeWithSelector(OneDoorModule.VoucherNotReclaimable.selector, N1));
        acct.reclaim(N1);
        assertEq(uint8(_voucher(N1).state), uint8(VoucherState.Registered));
    }

    function test_reclaim_usedMarksUsedNoCredit() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        api.settle(address(acct), API_PRICE, 0, vb, N1, _envelope(AGENT_PK, address(api), API_PRICE, vb, N1), "r");
        uint256 k1 = _keyLevel(agent);
        vm.recordLogs();
        acct.reclaim(N1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], OneDoorModule.VoucherUsed.selector);
        assertEq(uint8(_voucher(N1).state), uint8(VoucherState.Used));
        assertEq(_keyLevel(agent), k1, "no credit for a used voucher");
        vm.warp(vb + 1 days);
        vm.expectRevert(abi.encodeWithSelector(OneDoorModule.VoucherNotReclaimable.selector, N1));
        acct.reclaim(N1);
    }

    function test_reclaim_ownerCancelledNoCredit() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        bytes32 sh = keccak256(abi.encode(CANCEL_TYPEHASH, address(acct), N1));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
        usdc.cancelAuthorization(address(acct), N1, _sign65(OWNER_PK, d));
        vm.warp(vb);
        acct.reclaim(N1);
        assertEq(uint8(_voucher(N1).state), uint8(VoucherState.Used), "cancelled = never credited");
    }

    function test_reclaim_unknownNonceReverts() public {
        vm.expectRevert(abi.encodeWithSelector(OneDoorModule.VoucherNotReclaimable.selector, N2));
        acct.reclaim(N2);
    }

    function test_reclaim_permissionless() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        vm.warp(vb + 1);
        vm.prank(stranger);
        acct.reclaim(N1);
        assertEq(uint8(_voucher(N1).state), uint8(VoucherState.Reclaimed));
    }

    // ================================================================ execution lock (I3)

    function test_execLock_ownerSigRefusedDuringAgentOp() public {
        bytes32 h = keccak256("owner-signed during execution");
        bytes memory ownerSig = _sign65(OWNER_PK, h);
        bytes memory data = abi.encodeCall(probe.probe, (address(acct), h, ownerSig));
        assertTrue(_handle(_agentOp(acct, AGENT2_PK, address(probe), 0, data)), "probe op ran");
        assertEq(probe.calls(), 1);
        assertEq(probe.last(), INVALID, "0xffffffff while an agent op executes");
        assertEq(acct.isValidSignature(h, ownerSig), MAGIC, "lock cleared afterwards");
    }

    function test_execLock_voucherEnvelopeRefusedDuringAgentOp() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        bytes32 d = _digestApi(API_PRICE, vb, N1);
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        assertTrue(_handle(_agentOp(acct, AGENT2_PK, address(probe), 0, abi.encodeCall(probe.probe, (address(acct), d, env)))));
        assertEq(probe.last(), INVALID);
        assertEq(acct.isValidSignature(d, env), MAGIC);
    }

    function test_execLock_settleInsideAgentOpFails() public {
        _voucherOn();
        uint256 vb = _vb();
        assertTrue(_registerApi(N1, API_PRICE, vb).registered);
        bytes memory env = _envelope(AGENT_PK, address(api), API_PRICE, vb, N1);
        bytes memory data = abi.encodeCall(api.settle, (address(acct), API_PRICE, 0, vb, N1, env, "inside"));
        uint256 b0 = usdc.balanceOf(address(acct));
        Res memory r = _submit(_agentOp(acct, AGENT2_PK, address(api), 0, data));
        assertTrue(r.validated && !r.success, "target reverted: 1271 locked during execution");
        assertEq(usdc.balanceOf(address(acct)), b0);
        assertFalse(usdc.authorizationState(address(acct), N1));
        api.settle(address(acct), API_PRICE, 0, vb, N1, env, "outside");
        assertEq(b0 - usdc.balanceOf(address(acct)), API_PRICE, "settles outside execution");
    }
}
