// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AccountCommon} from "../../src/AgentAccountBase.sol";
import {OneDoorModule} from "../../src/modules/OneDoorModule.sol";
import {
    PolicyInput, CallRuleInput, ArgRule, AssetLimit, Voucher, Outflow, SIG1271_OWNER_PLUS_X402_VOUCHER
} from "../../src/lib/PolicyTypes.sol";

/// Agent-op target that asks the account for a 1271 answer while an agent op executes (I3 lock).
contract M3Probe {
    bytes4 public last;
    uint256 public calls;

    function probe(address account, bytes32 hash, bytes calldata sig) external {
        last = IERC1271(account).isValidSignature(hash, sig);
        ++calls;
    }
}

/// @title M3Base: shared helpers for the M3 (D1 one door) tests, card and invariants.
abstract contract M3Base is M1Fixture {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant INVALID = 0xffffffff;
    uint8 internal constant KIND_VOUCHER = 1;
    uint256 internal constant TTL = 600; // OneDoorModule.VOUCHER_MAX_TTL
    bytes32 internal constant TWA_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    M3Probe internal probe;

    /// Demo fixture + a probe; agent2 gets the demo policy plus probe and ApiSeller.settle entries.
    function _setUpM3() internal {
        _setUpFixture();
        probe = new M3Probe();
        PolicyInput memory p = _demoPolicy();
        CallRuleInput[] memory calls = new CallRuleInput[](p.calls.length + 2);
        for (uint256 i; i < p.calls.length; ++i) {
            calls[i] = p.calls[i];
        }
        calls[p.calls.length] = CallRuleInput(address(probe), M3Probe.probe.selector, new ArgRule[](0));
        calls[p.calls.length + 1] = CallRuleInput(address(api), api.settle.selector, new ArgRule[](0));
        p.calls = calls;
        vm.prank(owner);
        admin.setPolicy(agent2, p);
    }

    function _setMode(AgentAccount a, uint8 mode) internal {
        vm.prank(owner);
        AgentAccountAdmin(payable(address(a))).setSig1271Mode(mode);
    }

    function _voucherOn() internal {
        _setMode(acct, SIG1271_OWNER_PLUS_X402_VOUCHER);
    }

    // ---------------------------------------------------------------- vouchers

    function _voucherBody(address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(to, value, va, vb, nonce);
    }

    /// REGISTER_VOUCHER agent op on `a` signed by `pk` (token = the mock USDC unless `token` given).
    function _registerOpOn(AgentAccount a, uint256 pk, address token, bytes memory body)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes memory cd = _agentOpKind(KIND_VOUCHER, token, 0, body);
        return _signAgent(_op(address(a), _agentNonce(a, vm.addr(pk)), cd), pk);
    }

    function _registerOp(uint256 pk, address to, uint256 value, uint256 vb, bytes32 nonce)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return _registerOpOn(acct, pk, address(usdc), _voucherBody(to, value, 0, vb, nonce));
    }

    /// EIP-3009 TransferWithAuthorization digest in the mock USDC domain.
    function _twaDigest(address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 sh = keccak256(abi.encode(TWA_TYPEHASH, from, to, value, va, vb, nonce));
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
    }

    /// The x402 envelope (docs/api.md 4.6) for account `from`, agentSig by `pk` over the digest.
    function _envelopeFor(address from, uint256 pk, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes memory sig = _sign65(pk, _twaDigest(from, to, value, va, vb, nonce));
        return abi.encode(uint8(1), to, value, va, vb, nonce, sig);
    }

    function _envelope(uint256 pk, address to, uint256 value, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        return _envelopeFor(address(acct), pk, to, value, 0, vb, nonce);
    }

    function _voucher(bytes32 nonce) internal view returns (Voucher memory) {
        return admin.voucher(nonce);
    }

    function _keyLevel(address key) internal view returns (uint256) {
        AssetLimit memory a = admin.keyAsset(key, address(usdc));
        return a.bucket.level;
    }

    function _globalLevel() internal view returns (uint256) {
        return admin.globalBucket(address(usdc)).level;
    }

    /// True when the meter (D2) debits buckets: a 1-unit in-policy transfer moves the key bucket.
    function _meterLive() internal returns (bool live) {
        uint256 snap = vm.snapshotState();
        uint256 before = _keyLevel(agent);
        _handle(_agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(api), 1)));
        live = _keyLevel(agent) != before;
        vm.revertToState(snap);
    }

    // ---------------------------------------------------------------- submission with logs

    struct Res {
        bool validated; // passed validation (handleOps did not revert)
        bool success; // UserOperationEvent.success
        bool blocked; // PolicyBlocked emitted by the account
        bool registered; // VoucherRegistered emitted
        uint256 outflow; // Decision outflow amount (first entry)
    }

    function _submit(PackedUserOperation memory op) internal returns (Res memory r) {
        vm.recordLogs();
        try ep.handleOps(_one(op), bundler) {
            r.validated = true;
        } catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics.length > 0 ? logs[i].topics[0] : bytes32(0);
            if (logs[i].emitter == address(ep) && t0 == IEntryPoint.UserOperationEvent.selector) {
                (, r.success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            } else if (logs[i].emitter == op.sender) {
                if (t0 == AccountCommon.PolicyBlocked.selector) r.blocked = true;
                if (t0 == OneDoorModule.VoucherRegistered.selector) r.registered = true;
                if (t0 == AccountCommon.Decision.selector) {
                    (,,,, Outflow[] memory o) = abi.decode(logs[i].data, (bytes4, address, uint8, uint8, Outflow[]));
                    if (o.length > 0) r.outflow = o[0].amount;
                }
            }
        }
    }
}
