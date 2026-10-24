// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {TypedData} from "../../src/lib/TypedData.sol";
import {Tier, Track, Outflow, PolicyInput, Session, LANE_NORMAL} from "../../src/lib/PolicyTypes.sol";

/// @title M4Lib: stateless helpers shared by the M4 tests and the light invariant handlers
///        (handlers do not inherit the fixture, so their bytecode stays small).
library M4Lib {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f;
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    // Same UserOp gas as M1Fixture (well inside the demo caps, 0.01 gwei fee).
    uint256 internal constant OP_VERIF_GAS = 250_000;
    uint256 internal constant OP_CALL_GAS = 300_000;
    uint256 internal constant OP_PVG = 50_000;
    uint256 internal constant OP_FEE = 0.01 gwei;
    uint256 internal constant MAX_COST = (OP_VERIF_GAS + OP_CALL_GAS + OP_PVG) * OP_FEE;

    function sign65(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// docs/api.md 4.3: abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes attestorSig),
    /// the signature over ScoreAttestation{recipient, tier, validUntil, epoch} in {AgentAccount, 1, chainId, wallet}.
    function att(uint256 pk, address wallet, uint256 chainId, address recipient, uint8 tier, uint48 until, uint64 epoch)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 digest = TypedData.digest(
            TypedData.domainSeparator(chainId, wallet),
            TypedData.hashScoreAttestation(TypedData.ScoreAttestation(recipient, tier, until, epoch))
        );
        return abi.encode(tier, until, epoch, sign65(pk, digest));
    }

    function agentCall(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(EXECUTE_USER_OP, abi.encode(uint8(0), target, value, data));
    }

    function payCd(address token, address payee, uint256 amount) internal pure returns (bytes memory) {
        return agentCall(token, 0, abi.encodeWithSelector(TRANSFER, payee, amount));
    }

    function op(address sender, uint256 nonce, bytes memory callData) internal pure returns (PackedUserOperation memory o) {
        o.sender = sender;
        o.nonce = nonce;
        o.callData = callData;
        o.accountGasLimits = bytes32((OP_VERIF_GAS << 128) | OP_CALL_GAS);
        o.preVerificationGas = OP_PVG;
        o.gasFees = bytes32((OP_FEE << 128) | OP_FEE);
    }

    function agentNonce(IEntryPoint ep, address account, address key) internal view returns (uint256) {
        return ep.getNonce(account, AgentAccountAdmin(payable(account)).nonceKeyOf(key, LANE_NORMAL));
    }

    /// Agent-role op (lane 0) from `pk` carrying `attestation`.
    function agentOp(IEntryPoint ep, address account, uint256 pk, bytes memory callData, bytes memory attestation)
        internal
        view
        returns (PackedUserOperation memory o)
    {
        o = op(account, agentNonce(ep, account, vm.addr(pk)), callData);
        o.signature = abi.encode(uint8(1), sign65(pk, ep.getUserOpHash(o)), attestation, bytes(""));
    }

    function one(PackedUserOperation memory o) internal pure returns (PackedUserOperation[] memory ops) {
        ops = new PackedUserOperation[](1);
        ops[0] = o;
    }

    function arr(address a) internal pure returns (address[] memory xs) {
        xs = new address[](1);
        xs[0] = a;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// CORE owner-only entry points (the attestor must be refused on every one; I10).
    function ownerOnlyCalls(address token, address agent, address a, uint256 x, PolicyInput memory p)
        internal
        pure
        returns (bytes[] memory c)
    {
        Call[] memory batch = new Call[](1);
        batch[0] = Call(token, 0, abi.encodeWithSelector(TRANSFER, a, x));
        c = new bytes[](20);
        c[0] = abi.encodeWithSignature("transferOwnership(address)", a);
        c[1] = abi.encodeWithSignature("revoke(address)", agent);
        c[2] = abi.encodeWithSignature("rotateKey(address,address)", agent, a);
        c[3] = abi.encodeWithSignature("setGasCredit(address,uint128)", agent, uint128(x));
        c[4] = abi.encodeWithSignature("setRecipient(address,bool)", a, true);
        c[5] = abi.encodeWithSignature("setGlobalCap(address,uint128,uint128)", token, uint128(x), uint128(x));
        c[6] = abi.encodeWithSignature("setExploreCap(address,uint128,uint128)", token, uint128(x), uint128(x));
        c[7] = abi.encodeWithSignature("setExplorePerTxCap(address,uint128)", token, uint128(x));
        c[8] = abi.encodeWithSignature("setSig1271Mode(uint8)", uint8(x % 2));
        c[9] = abi.encodeWithSignature("setAttestor(address)", a);
        c[10] = abi.encodeWithSignature("bumpEpoch()");
        c[11] = abi.encodeWithSignature("unflag(address)", a);
        c[12] = abi.encodeWithSignature("setAgentPaymaster(address)", a);
        c[13] = abi.encodeWithSignature("setTrackedSpenders(address[])", arr(a));
        c[14] = abi.encodeWithSignature("setTrackedNFTs(address[])", arr(a));
        c[15] = abi.encodeWithSignature("withdrawDepositTo(address,uint256)", a, x);
        c[16] = abi.encodeWithSignature("execute(address,uint256,bytes)", token, 0, batch[0].data);
        c[17] = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", batch);
        c[18] = abi.encodeWithSignature("initialize(address)", a);
        c[19] = abi.encodeCall(AgentAccountAdmin.setPolicy, (a, p));
    }

    /// FRZ / REC entry points (lanes still filling them): judged by the I10 state snapshot only.
    function moduleCalls(address agent, address a) internal pure returns (bytes[] memory c) {
        c = new bytes[](8);
        c[0] = abi.encodeWithSignature("freeze(address)", agent);
        c[1] = abi.encodeWithSignature("unfreeze(address)", agent);
        c[2] = abi.encodeWithSignature("setWatcher(address)", a);
        c[3] = abi.encodeWithSignature("setGuardians(address[],uint8)", arr(a), uint8(1));
        c[4] = abi.encodeWithSignature("vetoRecovery()");
        c[5] = abi.encodeWithSignature("proposeRecovery(address)", a);
        c[6] = abi.encodeWithSignature("approveRecovery(uint64)", uint64(1));
        c[7] = abi.encodeWithSignature("executeRecovery()");
    }

    function staticOr(address target, bytes memory data) internal view returns (bytes memory) {
        (bool ok, bytes memory ret) = target.staticcall(data);
        return abi.encode(ok, ret);
    }

    /// Hash of every policy field an attestor must never change (everything except `flagged`).
    function snapshot(address account, address token, address agent, address[] memory payees)
        internal
        view
        returns (bytes32)
    {
        AgentAccountAdmin ad = AgentAccountAdmin(payable(account));
        bytes memory listed;
        for (uint256 i; i < payees.length; ++i) {
            listed = abi.encodePacked(listed, ad.isRecipient(payees[i]));
        }
        (uint64 sid, ) = ad.sessionOf(agent);
        bytes memory a = abi.encode(
            ad.owner(), ad.attestor(), ad.attestEpoch(), ad.sig1271Mode(), ad.agentPaymaster(), listed, sid
        );
        bytes memory b = abi.encode(
            ad.globalBucket(token), ad.exploreBucket(token), ad.explorePerTxCap(token), ad.keyAsset(agent, token)
        );
        bytes memory c = abi.encode(
            ad.trackedSpenders(), ad.trackedNFTs(), ad.trackedAssets(), ad.getDeposit(), account.balance
        );
        return keccak256(abi.encode(a, b, c, _moduleState(account, token, agent)));
    }

    function _moduleState(address account, address token, address agent) private view returns (bytes32 h) {
        h = keccak256(staticOr(account, abi.encodeWithSignature("sessionOf(address)", agent)));
        h = keccak256(abi.encode(h, staticOr(account, abi.encodeWithSignature("isFrozen(address)", agent))));
        h = keccak256(abi.encode(h, staticOr(account, abi.encodeWithSignature("watcher()"))));
        h = keccak256(abi.encode(h, staticOr(account, abi.encodeWithSignature("guardians()"))));
        h = keccak256(abi.encode(h, staticOr(account, abi.encodeWithSignature("pendingRecovery()"))));
        h = keccak256(abi.encode(h, staticOr(token, abi.encodeWithSignature("balanceOf(address)", account))));
    }
}

/// @title M4Base: the M1 demo fixture plus an attestor and D3 helpers.
abstract contract M4Base is M1Fixture {
    uint256 internal constant ATTESTOR2_PK = 0xA77E6;
    uint256 internal constant EXPLORE_PER_TX = 0.2e6; // setGlobalCap default: 1% of 20 USDC
    uint256 internal constant EXPLORE_CAP = 1e6; // default: 5% of 20 USDC (0.5 burst + 0.5 / day)
    uint256 internal constant GLOBAL_CAP = 20e6;

    address internal shop; // a legit new shop: not owner-listed, attested PROVEN by the attestor

    function setUp() public virtual {
        _setUpFixture();
        shop = makeAddr("newShop");
        vm.prank(owner);
        admin.setAttestor(attestorAddr);
    }

    function _xfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TRANSFER, to, amount);
    }

    function _until() internal view returns (uint48) {
        return uint48(block.timestamp + 1 days);
    }

    function _attFor(uint256 pk, address wallet, uint256 chainId, address recipient, uint8 tier, uint48 until, uint64 epoch)
        internal
        pure
        returns (bytes memory)
    {
        return M4Lib.att(pk, wallet, chainId, recipient, tier, until, epoch);
    }

    /// A valid PROVEN attestation for `recipient` on `acct` (current chain and epoch, valid 1 day).
    function _att(address recipient) internal view returns (bytes memory) {
        return _attFor(ATTESTOR_PK, address(acct), block.chainid, recipient, uint8(Tier.PROVEN), _until(), admin.attestEpoch());
    }

    function _payCd(address payee, uint256 amount) internal view returns (bytes memory) {
        return _agentCall(address(usdc), 0, _xfer(payee, amount));
    }

    function _check(address payee, uint256 amount, bytes memory a)
        internal
        view
        returns (uint16 reason, Tier tier, Track track, uint48 until)
    {
        return acct.policyCheck(agent, _payCd(payee, amount), a, "");
    }

    function _payOp(address payee, uint256 amount, bytes memory a) internal view returns (PackedUserOperation memory) {
        return _signAgentWith(_op(address(acct), _agentNonce(acct, agent), _payCd(payee, amount)), AGENT_PK, a, "");
    }

    function _sessionUntil() internal view returns (uint48) {
        (, Session memory s) = _session();
        return s.validUntil;
    }

    function _session() internal view returns (uint64 sid, Session memory s) {
        (sid, s) = admin.sessionOf(agent);
    }

    function _ownerAdminOp(bytes memory adminCall) internal view returns (PackedUserOperation memory) {
        return _ownerExecOp(acct, address(acct), 0, adminCall);
    }

    function _pair(PackedUserOperation memory a, PackedUserOperation memory b)
        internal
        pure
        returns (PackedUserOperation[] memory ops)
    {
        ops = new PackedUserOperation[](2);
        ops[0] = a;
        ops[1] = b;
    }

    function _run(PackedUserOperation[] memory ops) internal returns (Vm.Log[] memory logs) {
        vm.recordLogs();
        ep.handleOps(ops, bundler);
        logs = vm.getRecordedLogs();
    }

    /// (found, success, actualGasCost) of the UserOperationEvent for `h`.
    function _opResult(Vm.Log[] memory logs, bytes32 h) internal view returns (bool found, bool success, uint256 cost) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(ep) && logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector
                    && logs[i].topics[1] == h
            ) {
                (, success, cost,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                return (true, success, cost);
            }
        }
    }

    function _decision(Vm.Log[] memory logs) internal view returns (bool found, Tier tier, Track track) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(acct) && logs[i].topics[0] == AccountCommon.Decision.selector) {
                (,, tier, track,) = abi.decode(logs[i].data, (bytes4, address, Tier, Track, Outflow[]));
                return (true, tier, track);
            }
        }
    }

    function _blockedWhy(Vm.Log[] memory logs) internal view returns (bool found, bytes memory why) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(acct) && logs[i].topics[0] == AccountCommon.PolicyBlocked.selector) {
                (, why) = abi.decode(logs[i].data, (bytes4, bytes));
                return (true, why);
            }
        }
    }

    function _violation(uint16 reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(AccountCommon.PolicyViolation.selector, reason);
    }
}
