// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {M1Fixture} from "./M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {AgentAccountBase} from "../../src/AgentAccountBase.sol";
import {MeterModule} from "../../src/modules/MeterModule.sol";
import {PayeeTierModule} from "../../src/modules/PayeeTierModule.sol";
import {FreezeModule} from "../../src/modules/FreezeModule.sol";
import {PolicyLens} from "../../src/lens/PolicyLens.sol";
import {TypedData} from "../../src/lib/TypedData.sol";
import {AgentCall, OpContext, Outflow, Reason, Tier, NATIVE, LANE_APPROVAL} from "../../src/lib/PolicyTypes.sol";

/// Test-only account for the M5 unit tests. The approval path, sandbox and policy checks are the
/// real AgentAccount code; only hooks owned by lanes still in flight in wave 2 are pinned to their
/// documented contracts (docs/api.md section 9), so these tests do not move with D2 / D3 / FRZ:
/// - meter: measured outflow = native balance drop + drop of every tracked ERC-20; no bucket debits
///   (D2's default for Track.APPROVAL);
/// - tier (D3 contract): listed and not flagged -> PROVEN; flagged -> FLAGGED refused; else
///   UNPROVEN on the exploration track (reason OK; the lens adds EXPLORE_PER_TX);
/// - tripwires never trip and no strike freezes (FRZ stub behaviour).
/// INT reruns the approval / lens flow on the integrated account.
contract M5Harness is AgentAccount {
    constructor(IEntryPoint ep_, address admin_) AgentAccount(ep_, admin_) {}

    function _meterBefore(OpContext memory, AgentCall memory)
        internal
        view
        override(AgentAccountBase, MeterModule)
        returns (bytes memory)
    {
        address[] memory assets = _l().trackedAssets;
        uint256[] memory bal = new uint256[](assets.length + 1);
        bal[0] = address(this).balance;
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i] != NATIVE) bal[i + 1] = IERC20(assets[i]).balanceOf(address(this));
        }
        return abi.encode(bal);
    }

    function _meterAfter(OpContext memory, AgentCall memory, bytes memory snap)
        internal
        view
        override(AgentAccountBase, MeterModule)
        returns (Outflow[] memory out)
    {
        uint256[] memory bal = abi.decode(snap, (uint256[]));
        address[] memory assets = _l().trackedAssets;
        out = new Outflow[](assets.length + 1);
        uint256 n;
        if (address(this).balance < bal[0]) out[n++] = Outflow(NATIVE, bal[0] - address(this).balance);
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i] == NATIVE) continue;
            uint256 b = IERC20(assets[i]).balanceOf(address(this));
            if (b < bal[i + 1]) out[n++] = Outflow(assets[i], bal[i + 1] - b);
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    function _tierOf(OpContext memory, AgentCall memory call, bytes memory)
        internal
        view
        override(AgentAccountBase, PayeeTierModule)
        returns (Tier, uint16, uint48)
    {
        uint48 until = type(uint48).max;
        if (!call.hasPayee) return (Tier.NONE, Reason.OK, until);
        if (_l().flagged[call.payee]) return (Tier.FLAGGED, Reason.FLAGGED, until);
        if (_l().recipients[call.payee]) return (Tier.PROVEN, Reason.OK, until);
        return (Tier.UNPROVEN, Reason.OK, until);
    }

    function _preCallTripwire(OpContext memory, AgentCall memory)
        internal
        pure
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return false;
    }

    function _postCallTripwire(OpContext memory, AgentCall memory, Outflow[] memory)
        internal
        pure
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return false;
    }

    function _onBlocked(OpContext memory, bytes memory, bool)
        internal
        pure
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return false;
    }
}

/// Shared M5 fixture: the M1 demo policy on an M5Harness account `h`, the PolicyLens, and
/// OutcomeApproval helpers.
abstract contract M5Fixture is M1Fixture {
    M5Harness internal h;
    AgentAccountAdmin internal hAdmin;
    AgentAccountFactory internal hFactory;
    PolicyLens internal lens;
    address internal newShop; // an honest payee the owner never listed

    function _setUpM5() internal {
        _setUpFixture();
        AgentAccount impl = new M5Harness(IEntryPoint(address(ep)), factory.accountImplementation().admin());
        hFactory = new AgentAccountFactory(impl);
        h = M5Harness(payable(address(hFactory.createAccount(owner, 1))));
        hAdmin = AgentAccountAdmin(payable(address(h)));
        _configureDemo(h, agent);
        usdc.mint(address(h), 100e6);
        vm.deal(address(h), 1 ether);
        vm.prank(owner);
        hAdmin.addDeposit{value: 1 ether}();
        lens = new PolicyLens();
        newShop = makeAddr("newShop");
    }

    function _payData(address to, uint256 amount) internal view returns (bytes memory) {
        return _agentCall(address(usdc), 0, abi.encodeWithSelector(TRANSFER, to, amount));
    }

    function _outs(address asset, uint256 amount) internal pure returns (Outflow[] memory o) {
        o = new Outflow[](1);
        o[0] = Outflow(asset, amount);
    }

    /// OutcomeApproval for `callData` on account `a`, one maxOutflow entry, valid 1 h.
    function _appr(
        address a,
        bytes memory callData,
        address target,
        bytes4 sel,
        address payee,
        address asset,
        uint256 maxAmount,
        uint256 nonce
    ) internal view returns (TypedData.OutcomeApproval memory x) {
        x.account = a;
        x.chainId = block.chainid;
        x.nonce = nonce;
        x.target = target;
        x.selector = sel;
        x.payee = payee;
        x.maxOutflow = new TypedData.AssetAmount[](1);
        x.maxOutflow[0] = TypedData.AssetAmount(asset, maxAmount);
        x.callDataHash = keccak256(callData);
        x.validUntil = uint48(block.timestamp + 1 hours);
    }

    /// USDC transfer approval on `h` for `callData = _payData(to, amount)`.
    function _payAppr(address to, uint256 amount, uint256 maxAmount, uint256 nonce)
        internal
        view
        returns (TypedData.OutcomeApproval memory)
    {
        return _appr(address(h), _payData(to, amount), address(usdc), TRANSFER, to, address(usdc), maxAmount, nonce);
    }

    /// Approval slot bytes signed by `pk` in the domain of `domainAccount` on the current chain.
    function _signApprIn(uint256 pk, TypedData.OutcomeApproval memory x, address domainAccount)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = TypedData.digest(TypedData.domainSeparator(block.chainid, domainAccount), TypedData.hashOutcomeApproval(x));
        return abi.encode(x, _sign65(pk, d));
    }

    /// Approval slot bytes signed by `pk` over the lens digest (domain = x.account, x.chainId).
    function _signAppr(uint256 pk, TypedData.OutcomeApproval memory x) internal view returns (bytes memory) {
        return abi.encode(x, _sign65(pk, lens.outcomeApprovalDigest(x)));
    }

    function _apprNonce(AgentAccount a, address key) internal view returns (uint256) {
        return ep.getNonce(address(a), _nonceKey(a, key, LANE_APPROVAL));
    }

    /// Agent op on lane 1 carrying `appr`.
    function _apprOp(AgentAccount a, uint256 pk, bytes memory callData, bytes memory appr)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return _signAgentWith(_op(address(a), _apprNonce(a, vm.addr(pk)), callData), pk, "", appr);
    }
}
