// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {M1Fixture} from "../unit/M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {FreezeAdmin} from "../../src/modules/FreezeModule.sol";
import {RecoveryModule} from "../../src/modules/RecoveryModule.sol";
import {
    PolicyInput,
    AssetInput,
    CallRuleInput,
    ArgRule,
    RuleOp,
    Session,
    AssetLimit,
    RuleRef,
    Bucket,
    LANE_NORMAL,
    LANE_APPROVAL
} from "../../src/lib/PolicyTypes.sol";

/// Fuzzed agent ops of every shape: admin calls through self-call / execute / executeBatch /
/// unknown kinds / the EntryPoint / allowed targets, plus legit ops that do move buckets and credit.
contract I2Handler is Test {
    IEntryPoint internal ep;
    AgentAccount internal acct;
    uint256 internal agentPk;
    address internal agent;
    address internal attacker;
    address[] internal targets;
    address payable internal bundler;

    uint256 public attempts;
    uint256 public accepted;

    constructor(
        IEntryPoint ep_,
        AgentAccount acct_,
        uint256 agentPk_,
        address attacker_,
        address[] memory targets_
    ) {
        ep = ep_;
        acct = acct_;
        agentPk = agentPk_;
        agent = vm.addr(agentPk_);
        attacker = attacker_;
        targets = targets_;
        bundler = payable(makeAddr("i2bundler"));
    }

    function _adminCall(uint256 which) internal view returns (bytes memory) {
        which = which % 20;
        if (which == 0) return abi.encodeCall(AgentAccountAdmin.setRecipient, (attacker, true));
        if (which == 1) return abi.encodeCall(AgentAccountAdmin.transferOwnership, (attacker));
        if (which == 2) return abi.encodeCall(AgentAccountAdmin.setAttestor, (attacker));
        if (which == 3) return abi.encodeCall(AgentAccountAdmin.bumpEpoch, ());
        if (which == 4) return abi.encodeCall(AgentAccountAdmin.flag, (targets[1]));
        if (which == 5) return abi.encodeCall(AgentAccountAdmin.setSig1271Mode, (1));
        if (which == 6) return abi.encodeCall(AgentAccountAdmin.revoke, (agent));
        if (which == 7) return abi.encodeCall(AgentAccountAdmin.rotateKey, (agent, attacker));
        if (which == 8) return abi.encodeCall(AgentAccountAdmin.setGasCredit, (agent, type(uint128).max));
        if (which == 9) return abi.encodeCall(AgentAccountAdmin.setTrackedSpenders, (new address[](0)));
        if (which == 10) return abi.encodeCall(AgentAccountAdmin.setTrackedNFTs, (new address[](0)));
        if (which == 11) return abi.encodeCall(AgentAccountAdmin.setGlobalCap, (targets[0], type(uint128).max, 0));
        if (which == 12) return abi.encodeCall(AgentAccountAdmin.setExplorePerTxCap, (targets[0], type(uint128).max));
        if (which == 13) return abi.encodeCall(AgentAccount.initialize, (attacker));
        if (which == 14) return abi.encodeCall(AgentAccountAdmin.unflag, (targets[1]));
        if (which == 15) return abi.encodeCall(AgentAccountAdmin.setAgentPaymaster, (attacker));
        if (which == 16) return abi.encodeCall(FreezeAdmin.setWatcher, (attacker));
        if (which == 17) return abi.encodeCall(RecoveryModule.setGuardians, (new address[](0), 0));
        if (which == 18) return abi.encodeCall(RecoveryModule.executeRecovery, ());
        PolicyInput memory p;
        p.validAfter = 1;
        p.validUntil = type(uint48).max - 1;
        return abi.encodeCall(AgentAccountAdmin.setPolicy, (attacker, p));
    }

    function _submit(bytes memory callData, uint8 lane, bytes memory approval) internal {
        PackedUserOperation memory op;
        op.sender = address(acct);
        op.nonce = ep.getNonce(address(acct), AgentAccountAdmin(payable(address(acct))).nonceKeyOf(agent, lane));
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(250_000) << 128) | 300_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(0.01 gwei) << 128) | 0.01 gwei);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, ep.getUserOpHash(op));
        op.signature = abi.encode(uint8(1), abi.encodePacked(r, s, v), bytes(""), approval);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        ++attempts;
        try ep.handleOps(ops, bundler) {
            ++accepted;
        } catch {}
    }

    function _body(uint8 kind, address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes4(0x8dd7712f), abi.encode(kind, target, value, data));
    }

    /// An agent op that tries to change governed state, in one of 8 shapes.
    function agentAdminOp(uint256 which, uint8 shape, uint8 lane) external {
        bytes memory data = _adminCall(which);
        bytes memory cd;
        shape = shape % 8;
        if (shape == 0) {
            cd = _body(0, address(acct), 0, data); // self-call
        } else if (shape == 1) {
            cd = abi.encodeWithSelector(BaseAccount.execute.selector, address(acct), 0, data);
        } else if (shape == 2) {
            BaseAccount.Call[] memory calls = new BaseAccount.Call[](1);
            calls[0] = BaseAccount.Call(address(acct), 0, data);
            cd = abi.encodeWithSelector(BaseAccount.executeBatch.selector, calls);
        } else if (shape == 3) {
            cd = _body(uint8(bound(which, 1, 255)), address(acct), 0, data); // other op kinds
        } else if (shape == 4) {
            cd = _body(0, targets[which % targets.length], 0, data); // admin selector on an allowed target
        } else if (shape == 5) {
            cd = _body(0, address(ep), 0, abi.encodeCall(ep.withdrawTo, (payable(attacker), 1)));
        } else if (shape == 6) {
            cd = _body(0, address(acct), 0, abi.encodeWithSelector(BaseAccount.execute.selector, address(acct), 0, data));
        } else {
            cd = data; // raw admin selector as callData
        }
        _submit(cd, lane % 2 == 0 ? LANE_NORMAL : LANE_APPROVAL, lane % 4 == 3 ? bytes(hex"01") : bytes(""));
    }

    /// Legit agent ops (they may change bucket levels and gas credit, which I2 allows).
    function agentLegitOp(uint256 amount, uint8 which) external {
        amount = bound(amount, 1, 10e6);
        address usdc = targets[0];
        bytes memory data = which % 2 == 0
            ? abi.encodeWithSelector(bytes4(0xa9059cbb), targets[1], amount)
            : abi.encodeWithSelector(bytes4(0x095ea7b3), targets[2], amount);
        _submit(_body(0, usdc, 0, data), LANE_NORMAL, "");
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }
}

/// I2: no agent op changes owner, policy, recipients, attestor, epoch, flags, mode, modules or code.
contract M1_I2Invariant is M1Fixture {
    I2Handler internal handler;
    bytes32 internal fingerprint0;
    address[] internal watched;

    function setUp() public {
        _setUpFixture();
        vm.startPrank(owner);
        admin.setAttestor(attestorAddr);
        admin.setPolicy(agent2, _demoPolicy());
        vm.stopPrank();
        address[] memory t = new address[](4);
        (t[0], t[1], t[2], t[3]) = (address(usdc), address(grocery), address(ticket), address(api));
        handler = new I2Handler(IEntryPoint(address(ep)), acct, AGENT_PK, attacker, t);
        address[8] memory w = [address(api), address(ticket), address(grocery), attacker, stranger, owner, agent, agent2];
        for (uint256 i; i < w.length; ++i) {
            watched.push(w[i]);
        }
        fingerprint0 = _fingerprint();
        targetContract(address(handler));
    }

    function _sessionHash(address key) internal view returns (bytes32 h) {
        (uint64 sid, Session memory s) = admin.sessionOf(key);
        h = keccak256(
            abi.encode(
                sid,
                s.agentKey,
                s.validAfter,
                s.validUntil,
                s.revoked,
                s.gen,
                s.nonceKey,
                s.gas.maxCallGas,
                s.gas.maxVerificationGas,
                s.gas.maxPreVerificationGas,
                s.gas.maxFeePerGas
            )
        );
        RuleRef[] memory refs = admin.rulesOf(key);
        for (uint256 i; i < refs.length; ++i) {
            (bool allowed, ArgRule[] memory rules) = admin.ruleOf(key, refs[i].target, refs[i].selector);
            h = keccak256(abi.encode(h, refs[i].target, refs[i].selector, allowed, rules));
        }
        address[] memory assets = admin.keyAssets(key);
        for (uint256 i; i < assets.length; ++i) {
            AssetLimit memory a = admin.keyAsset(key, assets[i]);
            h = keccak256(abi.encode(h, assets[i], a.enabled, a.perTxCap, a.bucket.burst, a.bucket.ratePerDay));
        }
    }

    /// Everything I2 protects. Excludes what the agent path may legitimately change: bucket levels,
    /// gas credit, token balances, EntryPoint deposit and nonces.
    function _fingerprint() internal view returns (bytes32 h) {
        h = keccak256(
            abi.encode(
                admin.owner(),
                admin.attestor(),
                admin.attestEpoch(),
                admin.sig1271Mode(),
                admin.recipientList(),
                admin.trackedSpenders(),
                admin.trackedNFTs(),
                admin.trackedAssets(),
                address(acct).codehash,
                acct.admin(),
                address(acct.entryPoint())
            )
        );
        (address[] memory guardians, uint8 threshold) = admin.guardians();
        h = keccak256(abi.encode(h, admin.agentPaymaster(), admin.watcher(), guardians, threshold));
        for (uint256 i; i < watched.length; ++i) {
            address a = watched[i];
            h = keccak256(abi.encode(h, a, admin.isRecipient(a), admin.isFlagged(a), _sessionHash(a)));
        }
        Bucket memory g = admin.globalBucket(address(usdc));
        Bucket memory e = admin.exploreBucket(address(usdc));
        h = keccak256(
            abi.encode(h, g.burst, g.ratePerDay, e.burst, e.ratePerDay, admin.explorePerTxCap(address(usdc)))
        );
    }

    function invariant_I2_agentCannotChangeGovernance() public view {
        assertEq(_fingerprint(), fingerprint0, "I2: governed state changed by an agent op");
    }

    function invariant_I2_ownerAndModeFixed() public view {
        assertEq(admin.owner(), owner);
        assertEq(admin.sig1271Mode(), 0);
        assertFalse(admin.isRecipient(attacker));
        (uint64 sid,) = admin.sessionOf(attacker);
        assertEq(sid, 0, "attacker never became a session key");
    }

    function afterInvariant() external view {
        assertGt(handler.attempts(), 0);
    }
}
