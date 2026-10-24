// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, StdInvariant, console2, Vm} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {M3Base, M3Probe} from "./M3_Base.sol";
import {OneDoorModule} from "../../src/modules/OneDoorModule.sol";
import {Voucher, VoucherState} from "../../src/lib/PolicyTypes.sol";

/// Fuzzed x402 voucher traffic on the demo account in OWNER_PLUS_X402_VOUCHER mode: two agent keys
/// register vouchers (a small nonce pool, so duplicates and reuse happen), the attacker and the
/// payee try to settle them with real, tampered and never-registered envelopes, agent ops ask the
/// account for a 1271 answer mid-execution, anyone reclaims, time warps past validBefore, and the
/// owner revokes one key mid-run. The ghost checks every 1271 answer and every reclaim itself.
contract M3Handler is M3Base {
    uint256 internal constant POOL = 12;
    mapping(bytes32 => uint256) internal regPk; // key that registered each nonce

    uint256 public magicAnswers; // 1271 magic answers to agent envelopes seen
    uint256 public settled;
    uint256 public registered;
    uint256 public reclaimedCount;
    uint256 public i3Violations;
    uint256 public i4Violations;
    mapping(bytes32 => uint256) public credits;
    bool internal key2Revoked;

    constructor() {
        _setUpM3();
        _voucherOn();
        usdc.mint(address(acct), 900e6);
    }

    function _nonce(uint256 seed) internal pure returns (bytes32) {
        return keccak256(abi.encode("m3/i3i4", seed % POOL));
    }

    function _pk(uint256 seed) internal pure returns (uint256) {
        return seed % 2 == 0 ? AGENT_PK : AGENT2_PK;
    }

    /// I3 check of one 1271 answer to an agent envelope for (to, value, va, vb, nonce).
    function _checkAnswer(bytes4 r, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce, bool executing)
        internal
    {
        if (r != MAGIC) return;
        ++magicAnswers;
        Voucher memory v = _voucher(nonce);
        bool matches = v.state == VoucherState.Registered && v.to == to && v.value == value
            && v.validAfter == va && v.validBefore == vb && v.token == address(usdc);
        if (!matches || executing) ++i3Violations;
    }

    // ---------------------------------------------------------------- actions

    function register(uint256 seed, uint256 value, uint256 ttl) external {
        value = bound(value, 1, 1e6);
        ttl = bound(ttl, 1, TTL);
        uint256 pk = _pk(seed);
        bytes32 n = _nonce(seed >> 8);
        for (uint256 i; i < POOL && _voucher(n).state != VoucherState.None; ++i) {
            n = _nonce((seed >> 8) + i + 1); // prefer a free nonce; duplicates still happen when the pool is full
        }
        PackedUserOperation memory op = _registerOp(pk, address(api), value, block.timestamp + ttl, n);
        if (_submit(op).registered) {
            ++registered;
            regPk[n] = pk;
        }
    }

    /// Settle through the token with the stored fields (or tampered ones), signed by either key.
    function settle(uint256 seed, uint8 tamper) external {
        bytes32 n = _nonce(seed);
        Voucher memory v = _voucher(n);
        address to = tamper % 4 == 1 ? attacker : (v.to == address(0) ? address(api) : v.to);
        uint256 value = tamper % 4 == 2 ? uint256(v.value) + 1 : (v.value == 0 ? 1e5 : v.value);
        uint256 vb = v.validBefore == 0 ? block.timestamp + 100 : v.validBefore;
        uint256 pk = tamper % 4 == 3 ? STRANGER_PK : (regPk[n] != 0 ? regPk[n] : _pk(seed >> 8));
        bytes memory env = _envelope(pk, to, value, vb, n);
        bytes32 digest = _twaDigest(address(acct), to, value, 0, vb, n);
        _checkAnswer(acct.isValidSignature(digest, env), to, value, 0, vb, n, false);
        vm.prank(tamper % 2 == 0 ? attacker : address(api));
        try usdc.transferWithAuthorization(address(acct), to, value, 0, vb, n, env) {
            ++settled;
            if (!(v.state == VoucherState.Registered && v.to == to && v.value == value)) ++i3Violations;
        } catch {}
    }

    /// An agent op that asks the account for a 1271 answer on a (possibly valid) envelope mid-execution.
    function probeExec(uint256 seed) external {
        bytes32 n = _nonce(seed);
        Voucher memory v = _voucher(n);
        if (v.state != VoucherState.Registered) return;
        bytes memory env = _envelope(regPk[n] != 0 ? regPk[n] : AGENT2_PK, v.to, v.value, v.validBefore, n);
        bytes32 digest = _twaDigest(address(acct), v.to, v.value, 0, v.validBefore, n);
        uint256 before = probe.calls();
        _submit(_agentOp(acct, AGENT2_PK, address(probe), 0, abi.encodeCall(M3Probe.probe, (address(acct), digest, env))));
        if (probe.calls() != before) _checkAnswer(probe.last(), v.to, v.value, 0, v.validBefore, n, true);
    }

    function reclaim(uint256 seed) external {
        bytes32 n = _nonce(seed);
        VoucherState s0 = _voucher(n).state;
        bool usedOnToken = usdc.authorizationState(address(acct), n);
        vm.recordLogs();
        try acct.reclaim(n) {
            if (s0 != VoucherState.Registered) ++i4Violations; // closed twice
        } catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(acct) && logs[i].topics[0] == OneDoorModule.VoucherReclaimed.selector) {
                ++reclaimedCount;
                if (++credits[n] > 1 || usedOnToken) ++i4Violations;
            }
        }
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, TTL));
    }

    function revokeKey2() external {
        if (key2Revoked) return;
        key2Revoked = true;
        vm.prank(owner);
        admin.revoke(agent2);
    }
}

abstract contract M3InvariantBase is StdInvariant, Test {
    M3Handler internal h;

    function setUp() public {
        h = new M3Handler();
        bytes4[] memory sels = new bytes4[](12);
        sels[0] = M3Handler.register.selector;
        sels[1] = M3Handler.register.selector;
        sels[2] = M3Handler.register.selector;
        sels[3] = M3Handler.settle.selector;
        sels[4] = M3Handler.settle.selector;
        sels[5] = M3Handler.probeExec.selector;
        sels[6] = M3Handler.reclaim.selector;
        sels[7] = M3Handler.reclaim.selector;
        sels[8] = M3Handler.reclaim.selector;
        sels[9] = M3Handler.warp.selector;
        sels[10] = M3Handler.warp.selector;
        sels[11] = M3Handler.revokeKey2.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
        targetContract(address(h));
    }

    /// Coverage line per run (forge test -vv): the campaign must really register, settle and reclaim.
    function afterInvariant() public view {
        console2.log("registered/settled/reclaimed", h.registered(), h.settled(), h.reclaimedCount());
        console2.log("magic answers to agent envelopes", h.magicAnswers());
    }

}

contract M3InvariantI3Test is M3InvariantBase {
    function invariant_I3_oneDoorNeverOpensWithoutVoucher() public view {
        assertEq(h.i3Violations(), 0, "I3: 1271 magic / settlement without a matching Registered voucher, or mid-execution");
    }
}

contract M3InvariantI4Test is M3InvariantBase {
    function invariant_I4_reclaimCreditsAtMostOnce() public view {
        assertEq(h.i4Violations(), 0, "I4: reclaim credited twice, credited a Used voucher, or closed a voucher twice");
    }
}
