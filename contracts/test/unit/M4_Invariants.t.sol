// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {M4Base, M4Lib} from "./M4_Base.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {Tier, Track, Reason, Session, PolicyInput, ERC1271_MAGIC} from "../../src/lib/PolicyTypes.sol";

// ==================================================================== I7 / I8 handler

/// Leaked agent key paying a pool of fresh (unproven) addresses and a listed shop over time.
/// Outflows are measured as balance deltas (independent of the account's own Decision events).
contract ExploreHandler is Test {
    IEntryPoint internal immutable ep;
    address internal immutable acct;
    address internal immutable token;
    address internal immutable listed;
    address payable internal immutable bundler;
    uint256 internal immutable agentPk;
    address[5] internal pool;

    uint256[] internal uTs; // unproven payee receipts: time, amount
    uint256[] internal uAmt;
    uint256[] internal aTs; // every outflow of the wallet: time, amount
    uint256[] internal aAmt;
    uint256 public attempts;
    uint256 public landed;

    constructor(IEntryPoint ep_, address acct_, address token_, address listed_, address payable bundler_, uint256 pk) {
        (ep, acct, token, listed, bundler, agentPk) = (ep_, acct_, token_, listed_, bundler_, pk);
        for (uint256 i; i < 5; ++i) {
            pool[i] = address(uint160(uint256(keccak256(abi.encode("sybil", i)))));
        }
    }

    function payUnproven(uint256 who, uint256 amount) external {
        _pay(pool[who % 5], bound(amount, 1, 0.3e6)); // around explorePerTxCap (0.2 USDC)
    }

    function payListed(uint256 amount) external {
        _pay(listed, bound(amount, 1, 10e6));
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 4 hours)); // depth 32 x 4 h < the 6-day session
    }

    function _pay(address p, uint256 amount) internal {
        ++attempts;
        uint256 pb = IERC20(token).balanceOf(p);
        uint256 ab = IERC20(token).balanceOf(acct);
        PackedUserOperation memory o = M4Lib.agentOp(ep, acct, agentPk, M4Lib.payCd(token, p, amount), "");
        try ep.handleOps(M4Lib.one(o), bundler) {} catch {}
        uint256 got = IERC20(token).balanceOf(p) - pb;
        uint256 out = ab - IERC20(token).balanceOf(acct);
        if (got > 0 && p != listed) {
            uTs.push(block.timestamp);
            uAmt.push(got);
        }
        if (out > 0) {
            ++landed;
            aTs.push(block.timestamp);
            aAmt.push(out);
        }
    }

    /// Largest sum over any window (t - 24 h, t] ending at a payment.
    function maxWindow(bool unprovenOnly) external view returns (uint256 m) {
        uint256[] storage ts = unprovenOnly ? uTs : aTs;
        uint256[] storage am = unprovenOnly ? uAmt : aAmt;
        for (uint256 i; i < ts.length; ++i) {
            uint256 s;
            for (uint256 j; j < ts.length; ++j) {
                if (ts[j] <= ts[i] && ts[j] + 86400 > ts[i]) s += am[j];
            }
            if (s > m) m = s;
        }
    }
}

/// Shared setup of the exploration campaigns (one invariant per contract so each is reported).
abstract contract ExploreCampaign is M4Base {
    ExploreHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new ExploreHandler(IEntryPoint(address(ep)), address(acct), address(usdc), address(grocery), bundler, AGENT_PK);
        bytes4[] memory s = new bytes4[](3);
        (s[0], s[1], s[2]) = (h.payUnproven.selector, h.payListed.selector, h.warp.selector);
        targetSelector(FuzzSelector(address(h), s));
        targetContract(address(h));
    }
}

/// I8: exploration spend also debits the global bucket, so total outflow <= globalCap in any 24 h window.
contract M4_I8_Test is ExploreCampaign {
    function invariant_I8() public view {
        assertLe(h.maxWindow(false), GLOBAL_CAP, "total outflow in a 24 h window > globalCap");
    }
}

/// I7: outflow to unproven payees per asset in any 24 h window <= exploreCap.
contract M4_I7_Test is ExploreCampaign {
    function invariant_I7() public view {
        assertLe(h.maxWindow(true), EXPLORE_CAP, "unproven outflow in a 24 h window > exploreCap");
    }

    /// The handler is not vacuous: a steady stream of max-size exploration payments lands, uses the
    /// refill, and the 24 h sum gets above the burst but never above exploreCap.
    function test_explore_I7HandlerNonVacuous() public {
        for (uint256 i; i < 48; ++i) {
            h.payUnproven(i, EXPLORE_PER_TX);
            h.warp(1 hours);
        }
        uint256 m = h.maxWindow(true);
        assertGt(m, EXPLORE_CAP / 2, "refill used: above the burst");
        assertLe(m, EXPLORE_CAP, "I7");
        assertGt(h.landed(), 5);
    }
}

// ==================================================================== I9 handler

/// Fuzzes attestations (signer, tier, epoch, chain, wallet, recipient, validUntil) and the owner /
/// attestor state (epoch bumps, attestor rotation, flags, listing), and checks every tier decision.
contract TierHandler is Test {
    AgentAccount internal immutable acct;
    AgentAccountAdmin internal immutable ad;
    address internal immutable otherWallet;
    address internal immutable token;
    address internal immutable owner;
    address internal immutable agent;
    uint256[4] internal pks; // attestor, attestor 2, agent, stranger
    address[4] internal pool;

    uint256 public violations;
    uint256 public missed;
    uint256 public probes;

    struct P {
        address payee;
        address recipient;
        uint256 pk;
        uint8 tier;
        uint64 epoch;
        uint256 chainId;
        address wallet;
        uint48 until;
        uint256 amount;
    }

    constructor(AgentAccount acct_, address other, address token_, address owner_, uint256[4] memory pks_) {
        acct = acct_;
        ad = AgentAccountAdmin(payable(address(acct_)));
        (otherWallet, token, owner, pks) = (other, token_, owner_, pks_);
        agent = vm.addr(pks_[2]);
        for (uint256 i; i < 4; ++i) {
            pool[i] = address(uint160(uint256(keccak256(abi.encode("payee", i)))));
        }
    }

    function probe(uint256 pi, uint8 sel, uint8 tier, uint8 untilSel, uint256 amount) external {
        P memory p;
        p.payee = pool[pi % 4];
        p.recipient = sel % 7 == 0 ? pool[(pi % 4 + 1) % 4] : p.payee;
        p.pk = pks[(sel / 7) % 4];
        p.tier = uint8(bound(tier, 0, 4));
        uint64 cur = ad.attestEpoch();
        uint256 e = (sel / 28) % 3;
        p.epoch = e == 0 ? cur : e == 1 ? cur - 1 : cur + 1;
        p.chainId = (sel / 84) % 2 == 0 ? block.chainid : 8453;
        p.wallet = (sel % 5 == 0) ? otherWallet : address(acct);
        uint256 u = untilSel % 3;
        p.until = u == 0 ? 0 : u == 1 ? uint48(block.timestamp + 1 hours) : type(uint48).max;
        p.amount = bound(amount, 0, 1e6);
        bytes memory a = M4Lib.att(p.pk, p.wallet, p.chainId, p.recipient, p.tier, p.until, p.epoch);
        address att = ad.attestor();
        bool attested = att != address(0) && vm.addr(p.pk) == att && p.tier == uint8(Tier.PROVEN) && p.epoch == cur
            && p.chainId == block.chainid && p.wallet == address(acct) && p.recipient == p.payee && p.until != 0;
        _judge(p, a, attested);
    }

    function probeJunk(bytes calldata junk, uint256 pi, uint256 amount) external {
        P memory p;
        p.payee = pool[pi % 4];
        p.amount = bound(amount, 0, 1e6);
        _judge(p, junk, false);
    }

    function _judge(P memory p, bytes memory a, bool attested) internal {
        ++probes;
        (uint16 reason, Tier t, Track track, uint48 vu) = acct.policyCheck(agent, M4Lib.payCd(token, p.payee, p.amount), a, "");
        (, Session memory s) = ad.sessionOf(agent);
        bool listed = ad.isRecipient(p.payee);
        if (ad.isFlagged(p.payee)) {
            if (t != Tier.FLAGGED || reason != Reason.FLAGGED) ++violations;
            return;
        }
        if (t == Tier.PROVEN && !(listed || attested)) ++violations; // I9
        if ((listed || attested) && t != Tier.PROVEN) ++missed;
        if (t == Tier.PROVEN) {
            uint48 exp = (!listed && p.until < s.validUntil) ? p.until : s.validUntil;
            if (vu != exp || track != Track.NORMAL) ++violations; // inside validUntil
        }
        if (t == Tier.UNPROVEN) {
            bool over = p.amount > ad.explorePerTxCap(token);
            if (track != Track.EXPLORE || vu != s.validUntil || over != (reason == Reason.EXPLORE_PER_TX)) ++violations;
        }
    }

    function bump() external {
        vm.prank(owner);
        ad.bumpEpoch();
    }

    function rotate(uint8 sel) external {
        uint256 k = sel % 3;
        vm.prank(owner);
        ad.setAttestor(k == 2 ? address(0) : vm.addr(pks[k]));
    }

    function flagIt(uint256 pi, bool byAttestor) external {
        address att = ad.attestor();
        vm.prank(byAttestor && att != address(0) ? att : owner);
        ad.flag(pool[pi % 4]);
    }

    function unflagIt(uint256 pi) external {
        vm.prank(owner);
        ad.unflag(pool[pi % 4]);
    }

    function listIt(uint256 pi, bool on) external {
        vm.prank(owner);
        ad.setRecipient(pool[pi % 4], on);
    }
}

/// I9: a payee is proven only if owner-listed or attested PROVEN for this chainId, wallet and
/// epoch by the current attestor, and then only inside the attestation's validUntil.
contract M4_I9_Test is M4Base {
    TierHandler internal h;

    function setUp() public override {
        super.setUp();
        AgentAccount other = factory.createAccount(owner, 7);
        h = new TierHandler(acct, address(other), address(usdc), owner, [ATTESTOR_PK, ATTESTOR2_PK, AGENT_PK, STRANGER_PK]);
        bytes4[] memory s = new bytes4[](7);
        (s[0], s[1], s[2], s[3]) = (h.probe.selector, h.probeJunk.selector, h.bump.selector, h.rotate.selector);
        (s[4], s[5], s[6]) = (h.flagIt.selector, h.unflagIt.selector, h.listIt.selector);
        targetSelector(FuzzSelector(address(h), s));
        targetContract(address(h));
    }

    function invariant_I9() public view {
        assertEq(h.violations(), 0, "tier decision outside I9");
        assertEq(h.missed(), 0, "valid proof refused");
    }
}

// ==================================================================== I10 handler

/// The attestor key (compromised) tries every entry point, UserOps and the 1271 door.
contract AttestorHandler is Test {
    AgentAccount internal immutable acct;
    IEntryPoint internal immutable ep;
    address internal immutable token;
    address internal immutable owner;
    address internal immutable agent;
    address payable internal immutable bundler;
    uint256 internal immutable attestorPk;
    address internal immutable attestor;
    address[4] internal pool;
    mapping(address => bool) internal mustFlag;

    uint256 public violations;
    uint256 public tries;

    constructor(AgentAccount acct_, IEntryPoint ep_, address token_, address owner_, address agent_, address payable b, uint256 pk) {
        (acct, ep, token, owner, agent, bundler, attestorPk) = (acct_, ep_, token_, owner_, agent_, b, pk);
        attestor = vm.addr(pk);
        for (uint256 i; i < 4; ++i) {
            pool[i] = address(uint160(uint256(keccak256(abi.encode("flagged", i)))));
        }
    }

    function watched() external view returns (address[] memory w) {
        w = new address[](5);
        for (uint256 i; i < 4; ++i) {
            w[i] = pool[i];
        }
        w[4] = attestor;
    }

    function attestorFlag(uint256 i) external {
        address p = pool[i % 4];
        vm.prank(attestor);
        AgentAccountAdmin(payable(address(acct))).flag(p);
        mustFlag[p] = true;
    }

    function ownerUnflag(uint256 i) external {
        address p = pool[i % 4];
        vm.prank(owner);
        AgentAccountAdmin(payable(address(acct))).unflag(p);
        mustFlag[p] = false;
    }

    function attestorCall(uint256 k, uint256 x, bool self) external {
        ++tries;
        PolicyInput memory p;
        p.validAfter = uint48(block.timestamp);
        p.validUntil = uint48(block.timestamp + 1 days);
        address a = self ? attestor : pool[x % 4];
        bytes[] memory c = M4Lib.ownerOnlyCalls(token, agent, a, bound(x, 0, 1e18), p);
        vm.prank(attestor);
        (bool ok,) = address(acct).call(c[k % c.length]);
        if (ok) ++violations;
    }

    function attestorModuleCall(uint256 k, bool self) external {
        ++tries;
        bytes[] memory c = M4Lib.moduleCalls(agent, self ? attestor : pool[k % 4]);
        vm.prank(attestor);
        (bool ok,) = address(acct).call(c[k % c.length]);
        ok; // judged by the state snapshot
    }

    function attestorUserOp(uint256 amount, bool asOwnerRole) external {
        ++tries;
        bytes memory cd = M4Lib.payCd(token, attestor, bound(amount, 1, 10e6));
        PackedUserOperation memory o;
        if (asOwnerRole) {
            o = M4Lib.op(address(acct), ep.getNonce(address(acct), 0), cd);
            o.signature = M4Lib.sign65(attestorPk, ep.getUserOpHash(o));
        } else {
            o = M4Lib.agentOp(ep, address(acct), attestorPk, cd, "");
        }
        try ep.handleOps(M4Lib.one(o), bundler) {
            ++violations;
        } catch {}
    }

    function attestor1271(bytes32 hash) external {
        ++tries;
        if (acct.isValidSignature(hash, M4Lib.sign65(attestorPk, hash)) == ERC1271_MAGIC) ++violations;
    }

    function flagsHeld() external view returns (bool) {
        for (uint256 i; i < 4; ++i) {
            if (mustFlag[pool[i]] && !AgentAccountAdmin(payable(address(acct))).isFlagged(pool[i])) return false;
        }
        return true;
    }
}

/// I10: attestor-only calls can set flags and nothing else (escalate-only: only the owner clears).
contract M4_I10_Test is M4Base {
    AttestorHandler internal h;
    bytes32 internal snap0;

    function setUp() public override {
        super.setUp();
        h = new AttestorHandler(acct, ep, address(usdc), owner, agent, bundler, ATTESTOR_PK);
        snap0 = M4Lib.snapshot(address(acct), address(usdc), agent, h.watched());
        bytes4[] memory s = new bytes4[](6);
        (s[0], s[1], s[2]) = (h.attestorFlag.selector, h.ownerUnflag.selector, h.attestorCall.selector);
        (s[3], s[4], s[5]) = (h.attestorModuleCall.selector, h.attestorUserOp.selector, h.attestor1271.selector);
        targetSelector(FuzzSelector(address(h), s));
        targetContract(address(h));
    }

    function invariant_I10() public view {
        assertEq(h.violations(), 0, "attestor passed an owner-only entry point");
        assertTrue(h.flagsHeld(), "a flag was cleared without the owner");
        assertEq(M4Lib.snapshot(address(acct), address(usdc), agent, h.watched()), snap0, "attestor changed non-flag state");
    }
}
