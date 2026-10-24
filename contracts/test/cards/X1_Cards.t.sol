// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {CardBase} from "./CardBase.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {GreedyMerchant} from "../../src/mocks/GreedyMerchant.sol";
import {M4Lib} from "../unit/M4_Base.sol";
import {LANE_NORMAL} from "../../src/lib/PolicyTypes.sol";

/// The 13 X1 attack cards, one contract each, `test_R1..test_R4` per config. Parameters are the exact
/// ones of agent/fixtures/deck_params.json; the protocol per cell is: fresh wallet, shared legit stream,
/// optional warp, attack with the leaked key straight at the wallet, measure, write the card file, assert
/// the design targets (BUILD M7 "Expected numbers"). The card file is written BEFORE the asserts.

/// Openness baseline: the legit stream and nothing else.
contract Card_legit_only is CardBase {
    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w);
        _write("legit_only", cfg, "USDC", 0, 0, l);
        if (cfg == 4) {
            assertEq(l.provenBlocked, 0, "R4 blocks no legit PROVEN payee");
            assertEq(l.neededApproval, 0, "R4 needs no owner approval for the stream");
        }
        if (cfg == 2 || cfg == 3) assertGe(l.blocked + l.neededApproval, 1, "R2/R3 block or escalate a legit new payee");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F19: allowed shop, recipient argument = attacker.
contract Card_ticket_to_attacker is CardBase {
    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w);
        _fire(w, address(usdc), 0, abi.encodeWithSelector(APPROVE, address(ticket), TICKET_PRICE));
        _fire(w, address(ticket), 0, abi.encodeWithSelector(BUY, 200, attacker));
        uint256 lost = ticket.balanceOf(attacker) * TICKET_PRICE;
        _write("ticket_to_attacker", cfg, "USDC", lost, 0, l);
        _assertExpect(cfg, lost, 0);
        if (cfg == 2) assertGt(lost, 0, "R2: target+selector allowlist has no recipient rule");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F20: setApprovalForAll(attacker), then the attacker pulls the ticket the stream bought.
contract Card_set_approval_for_all is CardBase {
    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w);
        _fire(w, address(ticket), 0, abi.encodeWithSelector(SET_APPROVAL_FOR_ALL, attacker, true));
        vm.prank(attacker);
        try ticket.transferFrom(w.addr, attacker, 100) {} catch {}
        uint256 lost = ticket.balanceOf(attacker) * TICKET_PRICE;
        _write("set_approval_for_all", cfg, "USDC", lost, 0, l);
        _assertExpect(cfg, lost, 0);
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F6: policy rewrite through batch / self-call / direct execute / unknown op kind / EntryPoint, then pay the attacker.
contract Card_batch_selfcall_delegatecall is CardBase {
    uint256 internal constant DRAIN = 50e6;

    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w);
        address[] memory att = _attackers();
        uint256 before = _usdcSum(att);
        bytes memory drain = abi.encodeWithSelector(TRANSFER, attacker, DRAIN);
        bytes memory exec = abi.encodeWithSignature("execute(address,uint256,bytes)", address(usdc), 0, drain);
        bytes memory withdraw = abi.encodeWithSignature("withdrawTo(address,uint256)", attacker, 1 ether);
        Call[] memory calls = new Call[](1);
        calls[0] = Call(address(usdc), 0, drain);
        bytes memory batch = abi.encodeWithSignature("executeBatch((address,uint256,bytes)[])", calls);
        if (cfg == 1) {
            _fire(w, address(usdc), 0, drain);
        } else if (cfg == 2) {
            _raw(w, batch);
            _raw(w, exec);
            _fire(w, w.addr, 0, exec);
            _fire(w, address(ep), 0, withdraw);
            _fire(w, address(usdc), 0, drain);
        } else {
            _raw(w, batch);
            _raw(w, exec);
            _fire(w, w.addr, 0, abi.encodeCall(AgentAccountAdmin.setRecipient, (attacker, true))); // self-call policy rewrite
            _fire(w, w.addr, 0, exec);
            _raw(w, _agentOpKind(2, address(usdc), 0, drain)); // no delegatecall op kind exists
            _fire(w, address(ep), 0, withdraw);
            _fire(w, address(usdc), 0, drain);
        }
        uint256 lost = _usdcSum(att) - before;
        _write("batch_selfcall_delegatecall", cfg, "USDC", lost, 0, l);
        _assertExpect(cfg, lost, 0);
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F7 / F31: the attacker runs the bundler and collects fees from ops that pass validation and revert in execution.
contract Card_gas_burn_griefing is CardBase {
    uint256 internal constant TRIES = 12;

    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w);
        uint256 before = attacker.balance;
        bytes memory failing = abi.encodeWithSelector(ORDER, 5e6, w.addr); // in policy, no allowance: reverts in execution
        if (cfg == 1) {
            uint256 bal = w.addr.balance;
            vm.prank(agent);
            (bool ok,) = attacker.call{value: bal}("");
            ok;
        } else {
            GasO memory g;
            g.set = true;
            if (cfg == 2) {
                (g.verif, g.call, g.pvg, g.fee) = (OP_VERIF_GAS, OP_CALL_GAS, 2_000_000, 100 gwei);
            } else {
                (g.verif, g.call, g.pvg, g.fee) = (MAX_VERIF_GAS, MAX_CALL_GAS, MAX_PVG, MAX_FEE);
            }
            for (uint256 i; i < TRIES; ++i) _fire(w, AGENT_PK, address(grocery), 0, failing, "", g, attacker);
        }
        uint256 lost = attacker.balance - before;
        _write("gas_burn_griefing", cfg, "ETH", lost, GAS_CREDIT, l);
        _assertExpect(cfg, lost, GAS_CREDIT);
        if (cfg == 2) assertGt(lost, GAS_CREDIT, "R2 has no gas caps or credit");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F9: replay of an owner-signed payment (same nonce, other chain, other EntryPoint); agent op on another session's nonce key.
contract Card_replay_wrong_chain is CardBase {
    uint256 internal constant PAY = 5e6;

    function _ownerPayOp(address wallet, bytes memory callData, uint256 chainId, EntryPoint hashEp)
        internal
        returns (PackedUserOperation memory op)
    {
        op = _op(wallet, ep.getNonce(wallet, 0), callData);
        uint256 real = block.chainid;
        vm.chainId(chainId);
        bytes32 h = hashEp.getUserOpHash(op);
        vm.chainId(real);
        op.signature = _sign65(OWNER_PK, h);
    }

    function _run(uint8 cfg) internal {
        Setup memory s;
        if (cfg >= 3) {
            s.extraKeys = new uint256[](1);
            s.extraKeys[0] = AGENT2_PK;
        }
        W memory w = _deploy(cfg, s);
        Legit memory l = _legit(w);
        bytes memory transfer = abi.encodeWithSelector(TRANSFER, attacker, PAY);
        uint256 lost;
        if (cfg == 1) {
            _fire(w, address(usdc), 0, transfer); // a raw key signs anew
            lost = usdc.balanceOf(attacker);
        } else {
            bytes memory cd = abi.encodeWithSignature("execute(address,uint256,bytes)", address(usdc), 0, transfer);
            PackedUserOperation memory legitOp = _ownerPayOp(w.addr, cd, block.chainid, ep);
            require(_status(_send(legitOp, address(bundler))) == Status.EXECUTED, "the one legit owner payment");
            uint256 base = usdc.balanceOf(attacker);
            EntryPoint ep2 = new EntryPoint();
            _send(legitOp, address(bundler)); // same nonce
            _send(_ownerPayOp(w.addr, cd, 8453, ep), address(bundler)); // signed on another chain
            _send(_ownerPayOp(w.addr, cd, block.chainid, ep2), address(bundler)); // signed for another EntryPoint
            if (cfg >= 3) {
                uint256 n2 = ep.getNonce(w.addr, _nonceKey(AgentAccount(payable(w.addr)), agent2, LANE_NORMAL));
                bytes memory pay = _agentCall(address(usdc), 0, transfer);
                _send(_signAgent(_op(w.addr, n2, pay), AGENT_PK), address(bundler)); // another session's nonce key
            }
            lost = usdc.balanceOf(attacker) - base;
        }
        _write("replay_wrong_chain", cfg, "USDC", lost, 0, l);
        _assertExpect(cfg, lost, 0);
        if (cfg == 2) assertEq(lost, 0, "EntryPoint nonce + typed userOpHash");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F5: an allowed shop's buy() pulls 10x the price through transferFrom (standing owner allowance 20 USDC).
contract Card_greedy_merchant is CardBase {
    function _run(uint8 cfg) internal {
        GreedyMerchant greedy = new GreedyMerchant(IERC20(address(usdc)), 2e6, attacker);
        Setup memory s;
        s.ruleTargets = new address[](1);
        s.ruleTargets[0] = address(greedy);
        s.ruleSelectors = new bytes4[](1);
        s.ruleSelectors[0] = GreedyMerchant.buy.selector;
        s.recipients = new address[](1);
        s.recipients[0] = address(greedy);
        s.spenders = new address[](1);
        s.spenders[0] = address(greedy);
        s.apprSpender = new address[](1);
        s.apprSpender[0] = address(greedy);
        s.apprAmount = new uint256[](1);
        s.apprAmount[0] = 20e6;
        W memory w = _deploy(cfg, s);
        Legit memory l = _legit(w);
        uint256 before = usdc.balanceOf(attacker);
        _fire(w, address(greedy), 0, abi.encodeWithSelector(GreedyMerchant.buy.selector));
        uint256 lost = usdc.balanceOf(attacker) - before;
        _write("greedy_merchant", cfg, "USDC", lost, 2e6, l);
        _assertExpect(cfg, lost, 2e6);
        if (cfg == 2) assertGt(lost, 2e6, "R2 pays 10x (not metered)");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F5: approve(MAX) to the attacker, then the attacker pulls the wallet's balance.
contract Card_approve_max is CardBase {
    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w);
        address[] memory att = _attackers();
        uint256 before = _usdcSum(att);
        _fire(w, address(usdc), 0, abi.encodeWithSelector(APPROVE, attacker, type(uint256).max));
        uint256 allowance = usdc.allowance(w.addr, attacker);
        if (allowance > 0) {
            uint256 bal = usdc.balanceOf(w.addr);
            vm.prank(attacker);
            try usdc.transferFrom(w.addr, attacker, bal < allowance ? bal : allowance) {} catch {}
        }
        uint256 lost = _usdcSum(att) - before;
        _write("approve_max", cfg, "USDC", lost, 0, l);
        _assertExpect(cfg, lost, 0);
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F3: spend before and after UTC midnight within 120 s; measured = the wallet's total USDC outflow, legit included.
contract Card_midnight_double_spend is CardBase {
    uint256 internal constant GLOBAL_CAP_24H = 20e6;

    function _secondsToMidnight(uint256 before_) internal view returns (uint256) {
        uint256 next = (block.timestamp / 86400 + 1) * 86400;
        if (next < block.timestamp + before_) next += 86400;
        return next - before_ - block.timestamp;
    }

    function _run(uint8 cfg) internal {
        address shop_ = _colluding();
        Setup memory s;
        s.recipients = new address[](1);
        s.recipients[0] = shop_;
        W memory w = _deploy(cfg, s);
        uint256 startBal = usdc.balanceOf(w.addr);
        Legit memory l = _legit(w);
        bytes memory pay = abi.encodeWithSelector(TRANSFER, shop_, 2e6);
        vm.warp(block.timestamp + _secondsToMidnight(60));
        for (uint256 i; i < 12; ++i) _fire(w, address(usdc), 0, pay);
        vm.warp(block.timestamp + 120);
        for (uint256 i; i < 12; ++i) _fire(w, address(usdc), 0, pay);
        uint256 outflow = startBal - usdc.balanceOf(w.addr);
        _write("midnight_double_spend", cfg, "USDC", outflow, GLOBAL_CAP_24H, l);
        _assertExpect(cfg, outflow, GLOBAL_CAP_24H);
        if (cfg == 2) assertGt(outflow, GLOBAL_CAP_24H, "R2: a calendar-day cap lets 2x through across midnight");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F21: three session keys hit the same payee; measured = the attack's outflow; bound = the global cap.
contract Card_multi_key_cap is CardBase {
    function _run(uint8 cfg) internal {
        address shop_ = _colluding();
        Setup memory s;
        s.recipients = new address[](1);
        s.recipients[0] = shop_;
        if (cfg >= 3) {
            s.extraKeys = new uint256[](2);
            s.extraKeys[0] = AGENT2_PK;
            s.extraKeys[1] = AGENT3_PK;
        }
        W memory w = _deploy(cfg, s);
        Legit memory l = _legit(w);
        vm.warp(block.timestamp + 86460);
        uint256 before = usdc.balanceOf(shop_);
        uint256[3] memory pks = [AGENT_PK, AGENT2_PK, AGENT3_PK];
        uint256 keys = cfg >= 3 ? 3 : 1;
        GasO memory g;
        for (uint256 k; k < keys; ++k) {
            for (uint256 i; i < 12; ++i) _fire(w, pks[k], address(usdc), 0, abi.encodeWithSelector(TRANSFER, shop_, 2e6), "", g, address(bundler));
        }
        uint256 lost = usdc.balanceOf(shop_) - before;
        _write("multi_key_cap", cfg, "USDC", lost, 20e6, l);
        _assertExpect(cfg, lost, 20e6);
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F1: the leaked key signs an EIP-3009 authorization for the attacker; no UserOp.
contract Card_x402_side_door is CardBase {
    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w); // shared legit stream first, like every other card (same as the TS reader)
        uint256 value = 10e6;
        uint256 va = block.timestamp - 60;
        uint256 vb = block.timestamp + 3600;
        bytes32 nonce = bytes32("x402_side_door");
        uint256 before = usdc.balanceOf(attacker);
        bytes memory sig = _sign65(AGENT_PK, _twaDigest(w.addr, attacker, value, va, vb, nonce));
        vm.prank(attacker);
        try usdc.transferWithAuthorization(w.addr, attacker, value, va, vb, nonce, sig) {} catch {}
        if (cfg >= 3) {
            // R3 / R4 also try the one-door envelope with no voucher behind it
            bytes32 nonce2 = bytes32("x402_side_door_env");
            bytes memory env = _envelopeFor(w.addr, AGENT_PK, attacker, value, va, vb, nonce2);
            vm.prank(attacker);
            try usdc.transferWithAuthorization(w.addr, attacker, value, va, vb, nonce2, env) {} catch {}
        }
        uint256 lost = usdc.balanceOf(attacker) - before;
        _write("x402_side_door", cfg, "USDC", lost, 0, l);
        _assertExpect(cfg, lost, 0);
        if (cfg == 2) assertGt(lost, 0, "R2: 1271 accepts the session key");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F23 / F25: forged, expired, cross-wallet, wrong-chain and old-epoch attestations for fresh Sybil payees, then a spray.
contract Card_sybil_payee is CardBase {
    function _forged(uint256 i, uint256 until, uint64 epoch, address wallet) internal view returns (bytes memory) {
        // i: 0 attacker_signed, 1 expired, 2 cross_wallet, 3 wrong_chain, 4 old_epoch
        address payee = _sybil(i);
        if (i == 0) return M4Lib.att(ATT_ATTACKER_PK, wallet, block.chainid, payee, 1, uint48(until + 3600), epoch);
        if (i == 1) return M4Lib.att(ATTESTOR_PK, wallet, block.chainid, payee, 1, uint48(until - 10), epoch);
        if (i == 2) return M4Lib.att(ATTESTOR_PK, address(0xC0FFE), block.chainid, payee, 1, uint48(until + 3600), epoch);
        if (i == 3) return M4Lib.att(ATTESTOR_PK, wallet, block.chainid + 1, payee, 1, uint48(until + 3600), epoch);
        return M4Lib.att(ATTESTOR_PK, wallet, block.chainid, payee, 1, uint48(until + 3600), epoch > 0 ? epoch - 1 : 0);
    }

    function _run(uint8 cfg) internal {
        W memory w = _deploy(cfg, _setup());
        Legit memory l = _legit(w);
        address[] memory addrs = new address[](15);
        for (uint256 i; i < 15; ++i) addrs[i] = _sybil(i);
        uint256 before = _usdcSum(addrs);
        vm.warp(block.timestamp + 86460);
        uint64 epoch;
        if (cfg == 4) {
            vm.prank(owner);
            AgentAccountAdmin(payable(w.addr)).bumpEpoch(); // makes the old_epoch forgery genuinely stale
            epoch = AgentAccountAdmin(payable(w.addr)).attestEpoch();
        }
        uint256 until = block.timestamp;
        for (uint256 i; i < 5; ++i) {
            _fireAtt(w, address(usdc), abi.encodeWithSelector(TRANSFER, _sybil(i), 1e6), _forged(i, until, epoch, w.addr));
        }
        for (uint256 i; i < 10; ++i) _fire(w, address(usdc), 0, abi.encodeWithSelector(TRANSFER, _sybil(5 + i), 0.2e6));
        uint256 lost = _usdcSum(addrs) - before;
        _write("sybil_payee", cfg, "USDC", lost, 1e6, l);
        _assertExpect(cfg, lost, 1e6);
        if (cfg == 4) assertLe(lost, 1e6, "R4: Sybil spray bounded by the exploration cap");
    }

    function test_R1() public { _run(1); }
    function test_R2() public { _run(2); }
    function test_R3() public { _run(3); }
    function test_R4() public { _run(4); }
}

/// F27: the attestor key leaked too: the attacker's payee reads PROVEN. R4 only; the bound is the global cap.
contract Card_attestor_compromise is CardBase {
    function test_R4() public {
        W memory w = _deploy(4, _setup());
        Legit memory l = _legit(w);
        vm.warp(block.timestamp + 86460);
        address proven = _provenPayee();
        uint256 before = usdc.balanceOf(proven);
        bytes memory att = M4Lib.att(
            ATTESTOR_PK, w.addr, block.chainid, proven, 1, uint48(block.timestamp + 20 hours), AgentAccountAdmin(payable(w.addr)).attestEpoch()
        );
        for (uint256 i; i < 12; ++i) _fireAtt(w, address(usdc), abi.encodeWithSelector(TRANSFER, proven, 2e6), att);
        uint256 lost = usdc.balanceOf(proven) - before;
        _write("attestor_compromise", 4, "USDC", lost, 20e6, l);
        assertLe(lost, 20e6, "bounded by the global cap per 24 h");
    }
}

/// Fixture sanity: the labelled legit payees equal the shared fixture's addresses, so both readers pay the same payees.
contract Card_fixture_sanity is CardBase {
    function test_legit_payee_labels() public view {
        assertEq0(abi.encodePacked(_label("hypnexis.legit.NewBakery")), abi.encodePacked(address(0x5aB0719ECf58d8E6241b3626566D352CF11cFbE6)));
        assertEq0(abi.encodePacked(_label("hypnexis.legit.NewFlorist")), abi.encodePacked(address(0x6dc0449a5a7Df21B40E1D5abF3c04C4C8b6dd1c7)));
        assertEq0(abi.encodePacked(_label("hypnexis.legit.ColdStartCafe")), abi.encodePacked(address(0x657Db8E308F91fc3f99659BDA12bFd3576081477)));
    }
}
