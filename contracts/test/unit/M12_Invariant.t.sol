// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {AgentPaymaster} from "../../src/paymaster/AgentPaymaster.sol";
import {M12PaymasterBase, M12Account, M12Target} from "./M12_PaymasterBase.sol";

/// Fuzz handler: three registered agents send spam / legit ops, a Sybil and a fee inflater try, time warps.
/// It owns its own EntryPoint + AgentPaymaster world and records every deposit charge.
contract M12Handler is M12PaymasterBase {
    M12Account[3] internal agents;

    uint256 public dep0;
    uint256 public t0;
    uint256 public totalCost;
    uint256 public sponsoredOps;
    uint256 public sybilSponsored;
    bool public isolationBroken;
    bool public capBroken;
    bool public chargeBroken;

    mapping(uint256 => uint256[]) internal tsOf;
    mapping(uint256 => uint256[]) internal costOf;

    constructor() {
        _setUpPaymaster();
        vm.prank(pmOwner);
        pm.registerAgent(address(acctC), BURST, RATE);
        agents = [acctA, acctB, acctC];
        dep0 = pm.getDeposit();
        t0 = block.timestamp;
    }

    // ------------------------------------------------------------------ actions

    /// Agent `who` sends a reverting gas burner (spam) or a cheap successful op.
    function agentOp(uint256 who, bool spam) external {
        uint256 k = who % 3;
        bytes32[3] memory before;
        for (uint256 i; i < 3; ++i) {
            before[i] = _stateHash(address(agents[i]));
        }
        OpResult memory r = _send(spam ? _burnOp(agents[k]) : _okOp(agents[k]));
        for (uint256 i; i < 3; ++i) {
            if (i != k && _stateHash(address(agents[i])) != before[i]) isolationBroken = true;
        }
        if (!r.included) return;
        if (r.charged < r.actualGasCost) chargeBroken = true;
        tsOf[k].push(block.timestamp);
        costOf[k].push(r.actualGasCost);
        totalCost += r.actualGasCost;
        sponsoredOps += 1;
    }

    function sybilOp(bool spam) external {
        OpResult memory r = _send(spam ? _burnOp(sybil) : _okOp(sybil));
        if (r.included) sybilSponsored += 1;
    }

    /// An agent op with one gas field above its cap (field 0 = maxFeePerGas).
    function inflatedOp(uint256 who, uint8 field) external {
        field = field % 6;
        Gas memory g = _gas();
        if (field == 0) {
            g.maxFee = uint256(CAP_FEE) + 1 gwei;
            g.prio = g.maxFee;
        }
        if (field == 1) g.call = uint256(CAP_CALL) + 1;
        if (field == 2) g.verif = uint256(CAP_VERIF) + 1;
        if (field == 3) g.pvg = uint256(CAP_PVG) + 1;
        if (field == 4) g.pmVerif = uint256(CAP_PM_VERIF) + 1;
        if (field == 5) g.pmPostOp = uint256(CAP_PM_POSTOP) + 1;
        OpResult memory r = _send(_opWith(agents[who % 3], abi.encodeCall(M12Target.burn, ()), g));
        if (r.included) capBroken = true;
    }

    function warpTime(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 6 hours));
    }

    // ------------------------------------------------------------------ checks

    /// Per agent, every window [ts_i, ts_j]: sum of deposit charges <= burst + ratePerDay x len / DAY.
    function windowsHold() external view returns (bool) {
        for (uint256 k; k < 3; ++k) {
            uint256[] storage ts = tsOf[k];
            uint256[] storage cs = costOf[k];
            for (uint256 i; i < ts.length; ++i) {
                uint256 sum;
                for (uint256 j = i; j < ts.length; ++j) {
                    sum += cs[j];
                    if (sum * DAY > uint256(BURST) * DAY + uint256(RATE) * (ts[j] - ts[i])) return false;
                }
            }
        }
        return true;
    }

    function holdsReleased() external view returns (bool) {
        for (uint256 k; k < 3; ++k) {
            if (_pending(address(agents[k])) != 0) return false;
        }
        return true;
    }

    function paymaster() external view returns (AgentPaymaster) {
        return pm;
    }
}

/// I14 (EXPERIMENTS X5): sponsored gas per agent per window <= its quota; one agent's spam never lowers
/// another agent's available quota; the deposit drain <= the sum of the quotas; Sybils get nothing.
contract M12InvariantTest is StdInvariant, Test {
    M12Handler internal h;

    function setUp() public {
        h = new M12Handler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](4);
        sel[0] = M12Handler.agentOp.selector;
        sel[1] = M12Handler.sybilOp.selector;
        sel[2] = M12Handler.inflatedOp.selector;
        sel[3] = M12Handler.warpTime.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_I14_window_bound_per_agent() public view {
        assertTrue(h.windowsHold());
    }

    function invariant_I14_isolation() public view {
        assertFalse(h.isolationBroken());
    }

    function invariant_I14_deposit_drain_le_sum_of_quotas() public view {
        AgentPaymaster pm = h.paymaster();
        uint256 drained = h.dep0() - pm.getDeposit();
        assertEq(drained, h.totalCost());
        assertLe(drained, pm.maxSponsoredOver(block.timestamp - h.t0()));
    }

    function invariant_I14_sybil_never_sponsored() public view {
        assertEq(h.sybilSponsored(), 0);
    }

    function invariant_I14_gas_caps_hold() public view {
        assertFalse(h.capBroken());
    }

    function invariant_I14_charge_covers_deposit_cost() public view {
        assertFalse(h.chargeBroken());
    }

    function invariant_I14_holds_released_after_each_bundle() public view {
        assertTrue(h.holdsReleased());
    }
}
