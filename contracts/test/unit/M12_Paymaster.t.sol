// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {IPaymaster} from "account-abstraction/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AgentPaymaster} from "../../src/paymaster/AgentPaymaster.sol";
import {Bucket} from "../../src/lib/PolicyTypes.sol";
import {Buckets} from "../../src/lib/Buckets.sol";
import {M12PaymasterBase, M12Account, M12Target} from "./M12_PaymasterBase.sol";

/// Test-only access to the per-agent state, for the admission fuzz and the TS vectors.
contract M12PaymasterHarness is AgentPaymaster {
    constructor(IEntryPoint ep_, address owner_, GasCaps memory caps_) AgentPaymaster(ep_, owner_, caps_) {}

    function setState(address account, Bucket calldata q, uint128 pending) external {
        AgentQuota storage a = _agents[account];
        a.quota = q;
        a.pending = pending;
        a.registered = true;
    }
}

/// M12 (lane PM): AgentPaymaster unit tests. R21 / I14: spam drains only its own agent's quota.
contract M12PaymasterTest is M12PaymasterBase {
    using Buckets for Bucket;

    Bucket internal refB; // lib/Buckets reference model of agent B's quota

    mapping(uint256 => uint256[]) internal tsOf;
    mapping(uint256 => uint256[]) internal costOf;

    function setUp() public {
        _setUpPaymaster();
        refB.configure(BURST, RATE, block.timestamp);
    }

    // ------------------------------------------------------------------ setup, roles

    function test_staked_owned_funded() public view {
        assertTrue(pm.isStaked());
        IStakeManager.DepositInfo memory info = ep.getDepositInfo(address(pm));
        assertEq(info.stake, PM_STAKE);
        assertEq(info.unstakeDelaySec, UNSTAKE_DELAY);
        assertEq(pm.getDeposit(), PM_DEPOSIT);
        assertEq(pm.owner(), pmOwner);
        assertEq(pm.agentCount(), 2);
        assertEq(pm.totalBurst(), 2 * uint256(BURST));
        assertEq(pm.totalRatePerDay(), 2 * uint256(RATE));
        assertEq(pm.maxSponsoredOver(DAY), 2 * uint256(BURST) + 2 * uint256(RATE));
        assertEq(pm.available(address(acctA)), BURST);
    }

    function test_owner_only_admin() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(err);
        pm.registerAgent(address(sybil), BURST, RATE);
        vm.expectRevert(err);
        pm.deregisterAgent(address(acctA));
        vm.expectRevert(err);
        pm.setGasCaps(_caps());
        vm.expectRevert(err);
        pm.withdrawTo(payable(address(this)), 1);
        vm.expectRevert(err);
        pm.unlockStake();
    }

    function test_hooks_only_from_entryPoint() public {
        PackedUserOperation memory op = _okOp(acctA);
        vm.expectRevert(bytes("Sender not EntryPoint"));
        pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        vm.expectRevert(bytes("Sender not EntryPoint"));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, abi.encode(address(acctA), bytes32(0), MAX_COST, 0), 0, 0);
    }

    // ------------------------------------------------------------------ Sybil

    function test_sybil_unregistered_rejected() public {
        uint256 dep = pm.getDeposit();
        bytes32 hA = _stateHash(address(acctA));
        bytes32 hB = _stateHash(address(acctB));
        bytes memory want = _aa33(abi.encodeWithSelector(AgentPaymaster.NotRegistered.selector, address(sybil)));

        OpResult memory r = _send(_burnOp(sybil));
        assertFalse(r.included);
        assertEq(r.revertData, want);
        r = _send(_okOp(sybil));
        assertFalse(r.included);
        assertEq(r.revertData, want);

        assertEq(pm.getDeposit(), dep);
        assertEq(_stateHash(address(acctA)), hA);
        assertEq(_stateHash(address(acctB)), hB);
        assertEq(pm.available(address(sybil)), 0);
        assertEq(target.hits(), 0);
    }

    // ------------------------------------------------------------------ spam

    /// Ops that pass validation and revert in execution are charged to the spammer's own quota only.
    function test_spam_reverting_ops_exhaust_only_own_quota() public {
        uint256 dep0 = pm.getDeposit();
        bytes32 hB = _stateHash(address(acctB));
        uint256 availB = pm.available(address(acctB));
        uint256 spent;
        uint256 charged;
        uint256 n;
        for (uint256 i; i < 100; ++i) {
            OpResult memory r = _send(_burnOp(acctA));
            if (!r.included) {
                assertEq(r.revertData, _aa32(), "exhausted quota -> not due");
                break;
            }
            assertFalse(r.success, "passed validation, reverted in execution");
            assertTrue(r.sponsoredEvent);
            assertEq(r.reserved, MAX_COST);
            assertGe(r.charged, r.actualGasCost, "quota debit covers the deposit charge");
            spent += r.actualGasCost;
            charged += r.charged;
            n += 1;
            assertEq(_stateHash(address(acctB)), hB, "B untouched");
        }
        assertGt(n, 3);
        assertLt(n, 100);
        assertEq(dep0 - pm.getDeposit(), spent, "deposit drained only by A's ops");
        assertLe(charged, BURST, "0 s window: <= burst");
        assertEq(BURST - _bucket(address(acctA)).level, charged, "A debited exactly the charges");
        assertEq(_pending(address(acctA)), 0);
        assertLt(pm.available(address(acctA)), MAX_COST, "A exhausted");
        assertEq(pm.available(address(acctB)), availB, "B unaffected");

        OpResult memory rb = _send(_okOp(acctB));
        assertTrue(rb.included && rb.success, "B still sponsored");
        assertEq(target.hits(), 1);
    }

    /// Interleaved spam over time: B's stored state changes only on B's own ops, and equals a
    /// lib/Buckets reference bucket debited with B's charges at the same times.
    function test_second_agent_quota_unaffected() public {
        for (uint256 i; i < 24; ++i) {
            bytes32 hB = _stateHash(address(acctB));
            uint256 availB = pm.available(address(acctB));
            _send(_burnOp(acctA));
            assertEq(_stateHash(address(acctB)), hB);
            assertEq(pm.available(address(acctB)), availB);

            if (i % 4 == 0) {
                bytes32 hA = _stateHash(address(acctA));
                OpResult memory rb = _send(_okOp(acctB));
                assertTrue(rb.included && rb.success);
                assertEq(_stateHash(address(acctA)), hA);
                assertTrue(refB.tryDebit(rb.charged, block.timestamp));
            }
            Bucket memory b = _bucket(address(acctB));
            assertEq(Buckets.availableAt(b, block.timestamp), Buckets.availableAt(refB, block.timestamp));
            vm.warp(block.timestamp + 20 minutes);
        }
        assertLt(pm.available(address(acctA)), BURST);
    }

    // ------------------------------------------------------------------ gas caps

    function test_gasPrice_inflation_capped() public {
        bytes32 hA = _stateHash(address(acctA));
        uint256 dep = pm.getDeposit();
        Gas memory g = _gas();
        g.maxFee = uint256(CAP_FEE) + 1;
        g.prio = uint256(CAP_FEE) + 1;
        OpResult memory r = _send(_opWith(acctA, abi.encodeCall(M12Target.ok, ()), g));
        assertFalse(r.included);
        assertEq(
            r.revertData,
            _aa33(
                abi.encodeWithSelector(
                    AgentPaymaster.GasFieldAboveCap.selector, pm.F_MAX_FEE_PER_GAS(), uint256(CAP_FEE) + 1, CAP_FEE
                )
            )
        );
        assertEq(_stateHash(address(acctA)), hA);
        assertEq(pm.getDeposit(), dep);

        // A colluding bundler at the cap (priority = maxFee = cap, any basefee): price <= cap, and the
        // spam is still bounded by A's burst.
        vm.fee(30 gwei);
        g.maxFee = CAP_FEE;
        g.prio = CAP_FEE;
        uint256 charged;
        for (uint256 i; i < 50; ++i) {
            r = _send(_opWith(acctA, abi.encodeCall(M12Target.burn, ()), g));
            if (!r.included) {
                assertEq(r.revertData, _aa32());
                break;
            }
            assertEq(r.reserved, _maxCost(g));
            assertLe(r.actualGasCost, r.actualGasUsed * CAP_FEE, "price capped");
            assertGe(r.charged, r.actualGasCost);
            charged += r.charged;
        }
        assertLe(charged, BURST);
        assertLe(dep - pm.getDeposit(), charged);
    }

    function test_gas_limits_capped() public {
        uint256[5] memory caps = [uint256(CAP_CALL), CAP_VERIF, CAP_PVG, CAP_PM_VERIF, CAP_PM_POSTOP];
        for (uint8 f = 1; f <= 5; ++f) {
            Gas memory g = _gas();
            uint256 v = caps[f - 1] + 1;
            if (f == 1) g.call = v;
            if (f == 2) g.verif = v;
            if (f == 3) g.pvg = v;
            if (f == 4) g.pmVerif = v;
            if (f == 5) g.pmPostOp = v;
            OpResult memory r = _send(_opWith(acctA, abi.encodeCall(M12Target.ok, ()), g));
            assertFalse(r.included);
            assertEq(
                r.revertData,
                _aa33(abi.encodeWithSelector(AgentPaymaster.GasFieldAboveCap.selector, f, v, caps[f - 1]))
            );
        }
        assertEq(pm.available(address(acctA)), BURST);
    }

    function test_postOp_gas_floor() public {
        Gas memory g = _gas();
        uint256 minGas = pm.MIN_POSTOP_GAS();
        g.pmPostOp = minGas - 1;
        OpResult memory r = _send(_opWith(acctA, abi.encodeCall(M12Target.ok, ()), g));
        assertEq(r.revertData, _aa33(abi.encodeWithSelector(AgentPaymaster.PostOpGasTooLow.selector, minGas - 1, minGas)));
        // At the floor postOp still runs (no postOpReverted): the hold is released and the event fires.
        g.pmPostOp = minGas;
        r = _send(_opWith(acctA, abi.encodeCall(M12Target.ok, ()), g));
        assertTrue(r.included && r.success && r.sponsoredEvent);
        assertEq(_pending(address(acctA)), 0);
        r = _send(_opWith(acctA, abi.encodeCall(M12Target.burn, ()), g));
        assertTrue(r.included && !r.success && r.sponsoredEvent);
        assertEq(_pending(address(acctA)), 0);
        // caps below the floor are refused
        AgentPaymaster.GasCaps memory c = _caps();
        c.paymasterPostOpGasLimit = uint32(minGas - 1);
        vm.prank(pmOwner);
        vm.expectRevert(abi.encodeWithSelector(AgentPaymaster.PostOpGasTooLow.selector, minGas - 1, minGas));
        pm.setGasCaps(c);
    }

    // ------------------------------------------------------------------ reserve / refund / refill

    function test_postOp_refunds_unused() public {
        uint256 lvl0 = _bucket(address(acctA)).level;
        uint256 dep0 = pm.getDeposit();
        OpResult memory r = _send(_okOp(acctA));
        assertTrue(r.included && r.success && r.sponsoredEvent);
        assertEq(r.reserved, MAX_COST);
        assertGe(r.charged, r.actualGasCost);
        assertLt(r.charged, r.reserved);
        assertGt(r.reserved - r.charged, r.reserved / 2, "most of the hold is refunded");
        assertEq(_bucket(address(acctA)).level, lvl0 - r.charged);
        assertEq(_pending(address(acctA)), 0);
        assertEq(dep0 - pm.getDeposit(), r.actualGasCost);
    }

    function test_exhausted_not_due_until_refill() public {
        while (_send(_burnOp(acctA)).included) {}
        Bucket memory b = _bucket(address(acctA));
        uint48 va = pm.previewValidAfter(address(acctA), MAX_COST);
        uint256 readyAt = uint256(b.lastRefill) + ((MAX_COST - b.level) * DAY + RATE - 1) / RATE;
        assertEq(uint256(va), readyAt - 1);
        assertGe(uint256(va), block.timestamp);
        assertLt(Buckets.availableAt(b, readyAt - 1), MAX_COST);
        assertGe(Buckets.availableAt(b, readyAt), MAX_COST);

        vm.warp(va);
        assertEq(_send(_burnOp(acctA)).revertData, _aa32());
        vm.warp(uint256(va) + 1);
        OpResult memory r = _send(_burnOp(acctA));
        assertTrue(r.included && !r.success);

        // refill stops at burst
        vm.warp(block.timestamp + 30 days);
        assertEq(pm.available(address(acctA)), BURST);
    }

    function test_maxCost_above_burst_rejected() public {
        uint128 tiny = uint128(MAX_COST - 1);
        vm.prank(pmOwner);
        pm.registerAgent(address(acctC), tiny, RATE);
        OpResult memory r = _send(_okOp(acctC));
        assertEq(
            r.revertData,
            _aa33(abi.encodeWithSelector(AgentPaymaster.QuotaExceeded.selector, address(acctC), MAX_COST, tiny))
        );
        // no refill configured and not enough level: never valid
        vm.prank(pmOwner);
        pm.registerAgent(address(acctC), BURST, 0);
        while (_send(_burnOp(acctC)).included) {}
        r = _send(_burnOp(acctC));
        assertEq(bytes4(_innerOf(r.revertData)), AgentPaymaster.QuotaExceeded.selector);
    }

    function test_deregister_then_reregister_keeps_spent() public {
        while (_send(_burnOp(acctA)).included) {}
        uint256 lvl = _bucket(address(acctA)).level;
        vm.prank(pmOwner);
        pm.deregisterAgent(address(acctA));
        assertEq(pm.agentCount(), 1);
        assertEq(pm.totalBurst(), BURST);
        OpResult memory r = _send(_okOp(acctA));
        assertEq(r.revertData, _aa33(abi.encodeWithSelector(AgentPaymaster.NotRegistered.selector, address(acctA))));
        vm.prank(pmOwner);
        pm.registerAgent(address(acctA), BURST, RATE);
        assertEq(_bucket(address(acctA)).level, lvl, "no free refill");
        assertEq(_send(_burnOp(acctA)).revertData, _aa32());
        vm.prank(pmOwner);
        vm.expectRevert(abi.encodeWithSelector(AgentPaymaster.NotRegistered.selector, address(sybil)));
        pm.deregisterAgent(address(sybil));
    }

    // ------------------------------------------------------------------ ERC-7562 shape

    /// Validation writes only the sender's mapping entry, touches no other contract's storage and gives
    /// the same answer at any block time (no TIMESTAMP dependence).
    function test_validation_storage_keyed_by_sender_and_time_free() public {
        while (_send(_burnOp(acctA)).included) {} // exhausted: validation now answers a non-zero validAfter
        PackedUserOperation memory op = _burnOp(acctA);
        bytes32 h = ep.getUserOpHash(op);
        uint256 snap = vm.snapshotState();

        vm.startStateDiffRecording();
        vm.prank(address(ep));
        (bytes memory ctx1, uint256 vd1) = pm.validatePaymasterUserOp(op, h, MAX_COST);
        Vm.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        uint256 writes;
        for (uint256 i; i < acc.length; ++i) {
            for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
                Vm.StorageAccess memory sa = acc[i].storageAccesses[j];
                assertEq(sa.account, address(pm), "only the paymaster's own storage");
                if (sa.isWrite) {
                    writes += 1;
                    assertTrue(_associated(sa.slot, address(acctA)), "writes keyed by the sender");
                }
            }
        }
        assertGt(writes, 0);

        vm.revertToState(snap);
        vm.warp(block.timestamp + 12_345);
        vm.prank(address(ep));
        (bytes memory ctx2, uint256 vd2) = pm.validatePaymasterUserOp(op, h, MAX_COST);
        assertGt(vd1 >> 208, 0);
        assertEq(vd1, vd2);
        assertEq(ctx1, ctx2);
    }

    // ------------------------------------------------------------------ admission == lib/Buckets

    /// The validAfter rule is exactly the first second at which lib/Buckets holds pending + maxCost.
    function testFuzz_admission_matches_buckets(
        uint128 burst,
        uint128 rate,
        uint128 level,
        uint48 lastRefill,
        uint128 pending,
        uint128 maxCost
    ) public {
        burst = uint128(bound(burst, 1, 1e22));
        rate = uint128(bound(rate, 1, 1e22));
        level = uint128(bound(level, 0, burst));
        lastRefill = uint48(bound(lastRefill, 1_000_000_000, 2_000_000_000));
        pending = uint128(bound(pending, 0, burst));
        maxCost = uint128(bound(maxCost, 1, 1e22));
        M12PaymasterHarness hz = new M12PaymasterHarness(IEntryPoint(address(ep)), address(this), _caps());
        Bucket memory b = Bucket(burst, rate, level, lastRefill);
        hz.setState(address(acctA), b, pending);
        uint256 needed = uint256(pending) + maxCost;
        if (needed > burst) {
            vm.expectRevert(
                abi.encodeWithSelector(AgentPaymaster.QuotaExceeded.selector, address(acctA), needed, burst)
            );
            hz.previewValidAfter(address(acctA), maxCost);
            return;
        }
        uint48 va = hz.previewValidAfter(address(acctA), maxCost);
        if (needed <= level) {
            assertEq(va, 0);
            return;
        }
        if (va == type(uint48).max) {
            assertLt(Buckets.availableAt(b, type(uint48).max), needed);
            return;
        }
        uint256 readyAt = uint256(va) + 1;
        assertGe(Buckets.availableAt(b, readyAt), needed);
        assertLt(Buckets.availableAt(b, readyAt - 1), needed);
    }

    // ------------------------------------------------------------------ deposit bound (I14), results

    /// Three agents spam reverting ops every hour for 3 days, a Sybil tries every hour. The deposit drain
    /// stays <= the sum of the quotas, and every agent's sponsored gas in every window stays within its
    /// bucket bound. Writes results/m12_paymaster.json.
    function test_depositDrain_bounded_by_sum_of_quotas() public {
        vm.prank(pmOwner);
        pm.registerAgent(address(acctC), BURST, RATE);
        M12Account[3] memory agents = [acctA, acctB, acctC];
        uint256 t0 = block.timestamp;
        uint256 dep0 = pm.getDeposit();
        uint256 total;
        uint256 ops;
        uint256 sybilTries;
        uint256 minMargin = type(uint256).max;
        for (uint256 hr; hr < 72; ++hr) {
            for (uint256 k; k < 3; ++k) {
                for (uint256 j; j < 12; ++j) {
                    OpResult memory r = _send(_burnOp(agents[k]));
                    if (!r.included) {
                        assertEq(r.revertData, _aa32());
                        break;
                    }
                    assertFalse(r.success);
                    assertGe(r.charged, r.actualGasCost);
                    if (r.charged - r.actualGasCost < minMargin) minMargin = r.charged - r.actualGasCost;
                    tsOf[k].push(block.timestamp);
                    costOf[k].push(r.actualGasCost);
                    total += r.actualGasCost;
                    ops += 1;
                }
            }
            OpResult memory s = _send(_burnOp(sybil));
            assertFalse(s.included);
            sybilTries += 1;
            vm.warp(block.timestamp + 1 hours);
        }
        uint256 elapsed = block.timestamp - t0;
        uint256 drained = dep0 - pm.getDeposit();
        uint256 boundWei = pm.maxSponsoredOver(elapsed);
        assertEq(drained, total, "drain == sum of per-agent charges");
        assertLe(drained, boundWei, "I14: drain <= sum of quotas");

        uint256 worst24h;
        for (uint256 k; k < 3; ++k) {
            uint256 w = _checkWindows(k);
            if (w > worst24h) worst24h = w;
        }
        assertLe(worst24h, uint256(BURST) + RATE);

        string memory o = "m12";
        vm.serializeString(o, "lane", "PM");
        vm.serializeString(o, "test", "M12PaymasterTest::test_depositDrain_bounded_by_sum_of_quotas");
        vm.serializeUint(o, "agents", 3);
        vm.serializeUint(o, "burstWei", BURST);
        vm.serializeUint(o, "ratePerDayWei", RATE);
        vm.serializeUint(o, "elapsedSec", elapsed);
        vm.serializeUint(o, "sponsoredOps", ops);
        vm.serializeUint(o, "depositDrainedWei", drained);
        vm.serializeUint(o, "sumOfQuotasBoundWei", boundWei);
        vm.serializeUint(o, "worstAgent24hWindowWei", worst24h);
        vm.serializeUint(o, "agentCap24hWei", uint256(BURST) + RATE);
        vm.serializeUint(o, "minChargeMarginWei", minMargin);
        vm.serializeUint(o, "sybilAttempts", sybilTries);
        string memory json = vm.serializeUint(o, "sybilSponsored", 0);
        vm.writeJson(json, "../results/m12_paymaster.json");
    }

    /// Per agent k, every window [ts_i, ts_j]: sum of deposit charges <= burst + rate x len / DAY.
    /// Returns the largest sum over windows shorter than 24 h.
    function _checkWindows(uint256 k) internal view returns (uint256 worst) {
        uint256[] storage ts = tsOf[k];
        uint256[] storage cs = costOf[k];
        for (uint256 i; i < ts.length; ++i) {
            uint256 sum;
            for (uint256 j = i; j < ts.length; ++j) {
                sum += cs[j];
                uint256 len = ts[j] - ts[i];
                assertLe(sum * DAY, uint256(BURST) * DAY + uint256(RATE) * len, "I14 window bound");
                if (len < DAY && sum > worst) worst = sum;
            }
        }
    }

    /// Cross-language vectors for packages/shared/src/paymaster (results/m12_paymaster_vectors.json).
    function test_write_vectors_for_ts_helper() public {
        M12PaymasterHarness hz = new M12PaymasterHarness(IEntryPoint(address(ep)), address(this), _caps());
        Bucket memory b = Bucket(BURST, RATE, uint128(1e14), uint48(1_800_000_000));
        hz.setState(address(acctA), b, 0);
        uint48 va = hz.previewValidAfter(address(acctA), MAX_COST);
        bytes memory pmd = _pmData(address(hz), OP_PM_VERIF, OP_PM_POSTOP);

        string memory o = "m12v";
        vm.serializeAddress(o, "paymaster", address(hz));
        vm.serializeUint(o, "paymasterVerificationGasLimit", OP_PM_VERIF);
        vm.serializeUint(o, "paymasterPostOpGasLimit", OP_PM_POSTOP);
        vm.serializeBytes(o, "paymasterAndData", pmd);
        vm.serializeUint(o, "verificationGasLimit", OP_VERIF);
        vm.serializeUint(o, "callGasLimit", OP_CALL);
        vm.serializeUint(o, "preVerificationGas", OP_PVG);
        vm.serializeUint(o, "maxFeePerGas", OP_FEE);
        vm.serializeUint(o, "maxCost", MAX_COST);
        vm.serializeUint(o, "burst", b.burst);
        vm.serializeUint(o, "ratePerDay", b.ratePerDay);
        vm.serializeUint(o, "level", b.level);
        vm.serializeUint(o, "lastRefill", b.lastRefill);
        vm.serializeUint(o, "pending", 0);
        string memory json = vm.serializeUint(o, "validAfter", va);
        vm.writeJson(json, "../results/m12_paymaster_vectors.json");
        assertGt(va, 0);
    }

    // ------------------------------------------------------------------ helpers

    /// slot == keccak256(abi.encode(account, p)) + n for a small mapping slot p and member offset n.
    function _associated(bytes32 slot, address account) internal pure returns (bool) {
        for (uint256 p; p < 16; ++p) {
            uint256 base = uint256(keccak256(abi.encode(account, p)));
            if (uint256(slot) >= base && uint256(slot) < base + 4) return true;
        }
        return false;
    }

    /// The paymaster's revert data inside FailedOpWithRevert(opIndex, reason, inner).
    function _innerOf(bytes memory revertData) internal pure returns (bytes memory inner) {
        bytes memory args = new bytes(revertData.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = revertData[i + 4];
        }
        (,, inner) = abi.decode(args, (uint256, string, bytes));
    }
}
