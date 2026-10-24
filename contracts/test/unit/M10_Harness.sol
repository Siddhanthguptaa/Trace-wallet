// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountBase} from "../../src/AgentAccountBase.sol";
import {MeterModule} from "../../src/modules/MeterModule.sol";
import {PayeeTierModule} from "../../src/modules/PayeeTierModule.sol";
import {AccountStorage} from "../../src/lib/AccountStorage.sol";
import {AgentCall, OpContext, Outflow, Reason, Tier} from "../../src/lib/PolicyTypes.sol";

/// @title FrzHarness (lane FRZ, M10 tests): AgentAccount with the real FreezeModule, isolated from
///        the D2 / D3 fills so the tripwires can be tested on their own:
///        - meter: outflow = the decoded amount (call.payAsset, call.payAmount); `setBreach(true)`
///          makes it revert like a bucket breach (a strike);
///        - tier: listed -> PROVEN, flagged -> FLAGGED, else UNPROVEN with OK (Track.EXPLORE);
///        - x* functions expose the freeze hooks directly (test only).
contract FrzHarness is AgentAccount {
    bytes32 private constant BREACH_SLOT = keccak256("hypnexis.test.FrzHarness.breach");

    constructor(IEntryPoint ep_, address admin_) AgentAccount(ep_, admin_) {}

    function setBreach(bool on) external {
        bytes32 slot = BREACH_SLOT;
        assembly ("memory-safe") {
            sstore(slot, on)
        }
    }

    function _breach() private view returns (bool on) {
        bytes32 slot = BREACH_SLOT;
        assembly ("memory-safe") {
            on := sload(slot)
        }
    }

    function _meterBefore(OpContext memory, AgentCall memory)
        internal
        override(AgentAccountBase, MeterModule)
        returns (bytes memory)
    {
        return "";
    }

    function _meterAfter(OpContext memory, AgentCall memory call, bytes memory)
        internal
        override(AgentAccountBase, MeterModule)
        returns (Outflow[] memory o)
    {
        if (_breach()) revert PolicyViolation(Reason.KEY_BUCKET);
        if (call.payAmount == 0) return o;
        o = new Outflow[](1);
        o[0] = Outflow(call.payAsset, call.payAmount);
    }

    function _tierOf(OpContext memory, AgentCall memory call, bytes memory)
        internal
        view
        override(AgentAccountBase, PayeeTierModule)
        returns (Tier, uint16, uint48)
    {
        if (!call.hasPayee) return (Tier.NONE, Reason.OK, type(uint48).max);
        AccountStorage.Layout storage l = _l();
        if (l.flagged[call.payee]) return (Tier.FLAGGED, Reason.FLAGGED, type(uint48).max);
        if (l.recipients[call.payee]) return (Tier.PROVEN, Reason.OK, type(uint48).max);
        return (Tier.UNPROVEN, Reason.OK, type(uint48).max);
    }

    function xPre(OpContext memory ctx, AgentCall memory call) external returns (bool) {
        return _preCallTripwire(ctx, call);
    }

    function xPost(OpContext memory ctx, Outflow[] memory outflows) external returns (bool) {
        AgentCall memory call;
        return _postCallTripwire(ctx, call, outflows);
    }

    function xOnBlocked(address agentKey, bool tripped) external returns (bool) {
        OpContext memory ctx;
        ctx.agentKey = agentKey;
        return _onBlocked(ctx, "", tripped);
    }
}
