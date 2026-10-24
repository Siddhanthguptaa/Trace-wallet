// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {AgentPaymaster} from "../../src/paymaster/AgentPaymaster.sol";
import {Bucket} from "../../src/lib/PolicyTypes.sol";

/// Minimal EntryPoint v0.8 account for the paymaster tests (lane INT runs the real AgentAccount e2e).
contract M12Account is BaseAccount {
    IEntryPoint private immutable _ep;
    address public immutable owner;

    constructor(IEntryPoint ep_, address owner_) {
        _ep = ep_;
        owner = owner_;
    }

    function entryPoint() public view override returns (IEntryPoint) {
        return _ep;
    }

    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256)
    {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(userOpHash, userOp.signature);
        return (err == ECDSA.RecoverError.NoError && rec == owner) ? 0 : 1;
    }

    receive() external payable {}
}

/// Call targets: a cheap success, a revert and a gas burner (spends the whole call gas, then reverts).
contract M12Target {
    uint256 public hits;

    function ok() external {
        hits += 1;
    }

    function boom() external pure {
        revert("boom");
    }

    function burn() external pure {
        uint256 i;
        while (true) {
            unchecked {
                ++i;
            }
        }
    }
}

abstract contract M12PaymasterBase is Test {
    uint256 internal constant DAY = 86400;

    // Op gas (per field) and the caps the paymaster enforces.
    uint256 internal constant OP_VERIF = 150_000;
    uint256 internal constant OP_CALL = 300_000;
    uint256 internal constant OP_PVG = 50_000;
    uint256 internal constant OP_PM_VERIF = 80_000;
    uint256 internal constant OP_PM_POSTOP = 50_000;
    uint256 internal constant OP_FEE = 1 gwei;
    uint256 internal constant MAX_COST = (OP_VERIF + OP_CALL + OP_PVG + OP_PM_VERIF + OP_PM_POSTOP) * OP_FEE;

    uint64 internal constant CAP_FEE = 2 gwei;
    uint32 internal constant CAP_CALL = 1_000_000;
    uint32 internal constant CAP_VERIF = 500_000;
    uint32 internal constant CAP_PVG = 100_000;
    uint32 internal constant CAP_PM_VERIF = 150_000;
    uint32 internal constant CAP_PM_POSTOP = 100_000;

    // Quota per agent: burst + ratePerDay = 0.01 ETH per 24 h.
    uint128 internal constant BURST = 0.005 ether;
    uint128 internal constant RATE = 0.005 ether;

    uint256 internal constant PM_DEPOSIT = 1 ether;
    uint256 internal constant PM_STAKE = 0.1 ether;
    uint32 internal constant UNSTAKE_DELAY = 1 days;

    uint256 internal constant PK_A = 0xA11CE;
    uint256 internal constant PK_B = 0xB0B;
    uint256 internal constant PK_C = 0xC0C0;
    uint256 internal constant PK_SYBIL = 0x5B11;

    EntryPoint internal ep;
    AgentPaymaster internal pm;
    M12Target internal target;
    M12Account internal acctA;
    M12Account internal acctB;
    M12Account internal acctC;
    M12Account internal sybil;
    address payable internal bundler;
    address internal pmOwner;

    struct Gas {
        uint256 verif;
        uint256 call;
        uint256 pvg;
        uint256 pmVerif;
        uint256 pmPostOp;
        uint256 maxFee;
        uint256 prio;
    }

    struct OpResult {
        bool included;
        bool success;
        uint256 actualGasCost;
        uint256 actualGasUsed;
        uint256 reserved;
        uint256 charged;
        bool sponsoredEvent;
        bytes revertData;
    }

    function _setUpPaymaster() internal {
        vm.warp(1_800_000_000);
        bundler = payable(makeAddr("bundler"));
        pmOwner = makeAddr("pmOwner");
        ep = new EntryPoint();
        pm = new AgentPaymaster(IEntryPoint(address(ep)), pmOwner, _caps());
        target = new M12Target();
        acctA = new M12Account(IEntryPoint(address(ep)), vm.addr(PK_A));
        acctB = new M12Account(IEntryPoint(address(ep)), vm.addr(PK_B));
        acctC = new M12Account(IEntryPoint(address(ep)), vm.addr(PK_C));
        sybil = new M12Account(IEntryPoint(address(ep)), vm.addr(PK_SYBIL));

        vm.deal(pmOwner, 10 ether);
        vm.startPrank(pmOwner);
        pm.deposit{value: PM_DEPOSIT}();
        pm.addStake{value: PM_STAKE}(UNSTAKE_DELAY);
        pm.registerAgent(address(acctA), BURST, RATE);
        pm.registerAgent(address(acctB), BURST, RATE);
        vm.stopPrank();
    }

    function _caps() internal pure returns (AgentPaymaster.GasCaps memory c) {
        c = AgentPaymaster.GasCaps({
            maxFeePerGas: CAP_FEE,
            callGasLimit: CAP_CALL,
            verificationGasLimit: CAP_VERIF,
            preVerificationGas: CAP_PVG,
            paymasterVerificationGasLimit: CAP_PM_VERIF,
            paymasterPostOpGasLimit: CAP_PM_POSTOP
        });
    }

    function _gas() internal pure returns (Gas memory g) {
        g = Gas(OP_VERIF, OP_CALL, OP_PVG, OP_PM_VERIF, OP_PM_POSTOP, OP_FEE, OP_FEE);
    }

    function _pack(uint256 high, uint256 low) internal pure returns (bytes32) {
        return bytes32((high << 128) | low);
    }

    function _pmData(address paymaster, uint256 pmVerif, uint256 pmPostOp) internal pure returns (bytes memory) {
        return abi.encodePacked(paymaster, uint128(pmVerif), uint128(pmPostOp));
    }

    function _pkOf(M12Account a) internal view returns (uint256) {
        if (a == acctA) return PK_A;
        if (a == acctB) return PK_B;
        if (a == acctC) return PK_C;
        return PK_SYBIL;
    }

    function _opWith(M12Account a, bytes memory inner, Gas memory g) internal view returns (PackedUserOperation memory op) {
        op.sender = address(a);
        op.nonce = ep.getNonce(address(a), 0);
        op.callData = abi.encodeCall(BaseAccount.execute, (address(target), 0, inner));
        op.accountGasLimits = _pack(g.verif, g.call);
        op.preVerificationGas = g.pvg;
        op.gasFees = _pack(g.prio, g.maxFee);
        op.paymasterAndData = _pmData(address(pm), g.pmVerif, g.pmPostOp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_pkOf(a), ep.getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
    }

    /// Spam op: passes validation, burns the whole call gas, reverts in execution.
    function _burnOp(M12Account a) internal view returns (PackedUserOperation memory) {
        return _opWith(a, abi.encodeCall(M12Target.burn, ()), _gas());
    }

    function _okOp(M12Account a) internal view returns (PackedUserOperation memory) {
        return _opWith(a, abi.encodeCall(M12Target.ok, ()), _gas());
    }

    function _maxCost(Gas memory g) internal pure returns (uint256) {
        return (g.verif + g.call + g.pvg + g.pmVerif + g.pmPostOp) * g.maxFee;
    }

    /// handleOps on one op without reverting the test; decodes UserOperationEvent and GasSponsored.
    function _send(PackedUserOperation memory op) internal returns (OpResult memory r) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        (bool ok, bytes memory ret) = address(ep).call(abi.encodeCall(IEntryPoint.handleOps, (ops, bundler)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            r.revertData = ret;
            return r;
        }
        r.included = true;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == IEntryPoint.UserOperationEvent.selector) {
                (, r.success, r.actualGasCost, r.actualGasUsed) =
                    abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            } else if (logs[i].emitter == address(pm) && logs[i].topics[0] == AgentPaymaster.GasSponsored.selector) {
                (r.reserved, r.charged,) = abi.decode(logs[i].data, (uint256, uint256, bool));
                r.sponsoredEvent = true;
            }
        }
    }

    function _aa32() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA32 paymaster expired or not due");
    }

    function _aa33(bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA33 reverted", inner);
    }

    /// Hash of everything the paymaster stores for `account` (bucket, pending, registered).
    function _stateHash(address account) internal view returns (bytes32) {
        (bool reg, Bucket memory b, uint256 pending) = pm.agentOf(account);
        return keccak256(abi.encode(reg, b, pending));
    }

    function _bucket(address account) internal view returns (Bucket memory b) {
        (, b,) = pm.agentOf(account);
    }

    function _pending(address account) internal view returns (uint256 p) {
        (,, p) = pm.agentOf(account);
    }
}
