// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {M3Base} from "../unit/M3_Base.sol";
import {M4Lib} from "../unit/M4_Base.sol";
import {NaiveAccount} from "../../src/baselines/NaiveAccount.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {PolicyLens} from "../../src/lens/PolicyLens.sol";
import {PolicyInput, CallRuleInput, ArgRule, LANE_NORMAL} from "../../src/lib/PolicyTypes.sol";

/// @title CardBase: the Foundry reader of the X1 attack-card table (EXPERIMENTS X1, BUILD M7).
/// @notice Mirrors the TypeScript raw-key shooter (agent/src/shooter/cards*.ts) cell for cell:
///         R1 = the agent EOA holding the funds, R2 = NaiveAccount (static allowlist + caps),
///         R3 = AgentAccount with exploration OFF and no attestor, R4 = R3 + attestor + exploration
///         at its defaults. R3/R4 carry the X6 freeze thresholds pinned on dev seeds
///         (agent/hijack/thresholds.json). Every card replays the SHARED 6-step legit stream
///         (agent/fixtures/legit_stream.json) first, then fires the attack with the LEAKED agent
///         key straight at the wallet (no tools pre-check) and writes results/cards/<card>__<R>.json.
abstract contract CardBase is M3Base {
    uint256 internal constant AGENT3_PK = 0xA6E49;
    uint256 internal constant ATT_ATTACKER_PK = 0xBADA77; // an attestor key the wallet does not trust
    uint256 internal constant FUND_USDC = 100e6;
    uint256 internal constant FUND_ETH = 1 ether;
    uint256 internal constant R2_DAILY = 20e6;
    uint256 internal constant TICKET_ID_LEGIT = 100;

    // X6 thresholds pinned on dev seeds (agent/hijack/thresholds.json)
    uint256 internal constant VELOCITY_BPS = 6000;
    uint256 internal constant SPRAY_MAX = 5;
    uint256 internal constant STRIKE_MAX = 3;

    PolicyLens internal lens;

    enum Status {
        EXECUTED,
        REFUSED,
        REVERTED,
        NEEDS_APPROVAL
    }

    /// A deployed wallet: cfg 1..4 and the address the funds sit at.
    struct W {
        uint8 cfg;
        address addr;
    }

    /// Per-card wallet setup (TS WalletSetup).
    struct Setup {
        address[] ruleTargets;
        bytes4[] ruleSelectors;
        address[] recipients;
        address[] spenders;
        address[] apprSpender;
        uint256[] apprAmount;
        uint256[] extraKeys; // extra agent session keys (private keys), R3/R4 only
    }

    struct Legit {
        uint256 blocked;
        uint256 provenBlocked;
        uint256 blockedValue;
        uint256 neededApproval;
        uint256 paid;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct GasO {
        bool set;
        uint256 verif;
        uint256 call;
        uint256 pvg;
        uint256 fee;
    }

    function setUp() public virtual {
        _setUpFixture();
        lens = new PolicyLens();
    }

    // ---------------------------------------------------------------- labels (fixtures use keccak256(label) low 20 bytes)

    function _label(string memory s) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(s)))));
    }

    function _colluding() internal pure returns (address) {
        return _label("hypnexis.attack.ColludingShop");
    }

    function _provenPayee() internal pure returns (address) {
        return _label("hypnexis.attack.ProvenPayee");
    }

    function _sybil(uint256 i) internal pure returns (address) {
        return _label(string.concat("hypnexis.sybil.", vm.toString(i)));
    }

    function _attackers() internal view returns (address[] memory a) {
        a = new address[](3);
        a[0] = attacker;
        a[1] = _colluding();
        a[2] = _provenPayee();
    }

    function _usdcSum(address[] memory xs) internal view returns (uint256 s) {
        for (uint256 i; i < xs.length; ++i) s += usdc.balanceOf(xs[i]);
    }

    function _bakery() internal pure returns (address) {
        return _label("hypnexis.legit.NewBakery");
    }

    function _florist() internal pure returns (address) {
        return _label("hypnexis.legit.NewFlorist");
    }

    function _cafe() internal pure returns (address) {
        return _label("hypnexis.legit.ColdStartCafe");
    }

    // ---------------------------------------------------------------- wallets

    function _setup() internal pure returns (Setup memory s) {}

    function _deploy(uint8 cfg, Setup memory s) internal returns (W memory w) {
        w.cfg = cfg;
        if (cfg == 1) {
            w.addr = agent;
            usdc.mint(agent, FUND_USDC);
            vm.deal(agent, FUND_ETH);
            for (uint256 i; i < s.apprSpender.length; ++i) {
                vm.prank(agent);
                usdc.approve(s.apprSpender[i], s.apprAmount[i]);
            }
        } else if (cfg == 2) {
            w.addr = _deployR2x(s);
        } else {
            w.addr = _deployAgent(cfg, s);
        }
    }

    function _deployR2x(Setup memory s) internal returns (address) {
        NaiveAccount n = new NaiveAccount(owner, agent);
        NaiveAccount.R2Config memory c;
        uint256 k = s.ruleTargets.length;
        c.targets = new address[](5 + k);
        c.selectors = new bytes4[](5 + k);
        (c.targets[0], c.selectors[0]) = (address(usdc), TRANSFER);
        (c.targets[1], c.selectors[1]) = (address(usdc), APPROVE);
        (c.targets[2], c.selectors[2]) = (address(ticket), BUY);
        (c.targets[3], c.selectors[3]) = (address(ticket), SET_APPROVAL_FOR_ALL);
        (c.targets[4], c.selectors[4]) = (address(grocery), ORDER);
        for (uint256 i; i < k; ++i) (c.targets[5 + i], c.selectors[5 + i]) = (s.ruleTargets[i], s.ruleSelectors[i]);
        c.recipients = new address[](3 + s.recipients.length);
        (c.recipients[0], c.recipients[1], c.recipients[2]) = (address(api), address(ticket), address(grocery));
        for (uint256 i; i < s.recipients.length; ++i) c.recipients[3 + i] = s.recipients[i];
        c.tokens = new address[](1);
        c.tokens[0] = address(usdc);
        c.perTxCaps = new uint256[](1);
        c.perTxCaps[0] = PER_TX;
        c.dailyCaps = new uint256[](1);
        c.dailyCaps[0] = R2_DAILY;
        vm.prank(owner);
        n.configure(IEntryPoint(address(ep)), c);
        usdc.mint(address(n), FUND_USDC);
        vm.deal(address(n), FUND_ETH);
        vm.deal(address(this), address(this).balance + 1 ether);
        n.addDeposit{value: 1 ether}();
        for (uint256 i; i < s.apprSpender.length; ++i) {
            vm.prank(owner);
            n.execute(address(usdc), 0, abi.encodeWithSelector(APPROVE, s.apprSpender[i], s.apprAmount[i]));
        }
        return address(n);
    }

    function _deployAgent(uint8 cfg, Setup memory s) internal returns (address a) {
        AgentAccount acct_ = factory.createAccount(owner, uint256(cfg));
        a = address(acct_);
        AgentAccountAdmin ad = AgentAccountAdmin(payable(a));
        PolicyInput memory p = _demoPolicy();
        uint256 k = s.ruleTargets.length;
        CallRuleInput[] memory calls = new CallRuleInput[](p.calls.length + k);
        for (uint256 i; i < p.calls.length; ++i) calls[i] = p.calls[i];
        for (uint256 i; i < k; ++i) calls[p.calls.length + i] = CallRuleInput(s.ruleTargets[i], s.ruleSelectors[i], new ArgRule[](0));
        p.calls = calls;

        vm.deal(owner, 100 ether);
        vm.startPrank(owner);
        ad.setGlobalCap(address(usdc), CAP_BURST, CAP_RATE); // also sets the exploration defaults
        for (uint256 i; i < 3; ++i) ad.setRecipient(i == 0 ? address(api) : i == 1 ? address(ticket) : address(grocery), true);
        for (uint256 i; i < s.recipients.length; ++i) ad.setRecipient(s.recipients[i], true);
        address[] memory spenders = new address[](2 + s.spenders.length);
        spenders[0] = address(ticket);
        spenders[1] = address(grocery);
        for (uint256 i; i < s.spenders.length; ++i) spenders[2 + i] = s.spenders[i];
        ad.setTrackedSpenders(spenders);
        address[] memory nfts = new address[](1);
        nfts[0] = address(ticket);
        ad.setTrackedNFTs(nfts);
        if (cfg == 3) {
            ad.setExploreCap(address(usdc), 0, 0);
            ad.setExplorePerTxCap(address(usdc), 0);
        } else {
            ad.setAttestor(attestorAddr);
        }
        ad.setSig1271Mode(1); // OWNER_PLUS_X402_VOUCHER (agent/configs: local mock facilitator)
        ad.setFreezeParam(keccak256("hypnexis.freeze.velocityBps"), VELOCITY_BPS);
        ad.setFreezeParam(keccak256("hypnexis.freeze.sprayMax"), SPRAY_MAX);
        ad.setFreezeParam(keccak256("hypnexis.freeze.strikeMax"), STRIKE_MAX);
        ad.setPolicy(agent, p);
        for (uint256 i; i < s.extraKeys.length; ++i) ad.setPolicy(vm.addr(s.extraKeys[i]), p);
        ad.addDeposit{value: 1 ether}();
        vm.stopPrank();
        usdc.mint(a, FUND_USDC);
        vm.deal(a, FUND_ETH);
        for (uint256 i; i < s.apprSpender.length; ++i) {
            vm.prank(owner);
            acct_.execute(address(usdc), 0, abi.encodeWithSelector(APPROVE, s.apprSpender[i], s.apprAmount[i]));
        }
    }

    // ---------------------------------------------------------------- op primitives

    function _gasOf(PackedUserOperation memory op, GasO memory g) internal pure {
        if (!g.set) return;
        op.accountGasLimits = _packGas(g.verif, g.call);
        op.preVerificationGas = g.pvg;
        op.gasFees = _packGas(g.fee, g.fee);
    }

    /// handleOps with `ben` as the beneficiary; reports validated / success / PolicyBlocked.
    function _send(PackedUserOperation memory op, address ben) internal returns (Res memory r) {
        address payable old = bundler;
        bundler = payable(ben);
        r = _submit(op);
        bundler = old;
    }

    function _status(Res memory r) internal pure returns (Status) {
        if (!r.validated) return Status.REFUSED;
        if (r.blocked) return Status.REFUSED;
        if (!r.success) return Status.REVERTED;
        return Status.EXECUTED;
    }

    function _naiveSign(address n, PackedUserOperation memory op) internal view returns (PackedUserOperation memory) {
        n;
        op.signature = _sign65(AGENT_PK, ep.getUserOpHash(op));
        return op;
    }

    /// The TS `fire` primitive for a leaked key: R1 direct tx, R2 executeAgent op, R3/R4 forced agent op.
    function _fire(
        W memory w,
        uint256 pk,
        address target,
        uint256 value,
        bytes memory data,
        bytes memory att,
        GasO memory g,
        address ben
    ) internal returns (Status) {
        if (w.cfg == 1) {
            vm.prank(vm.addr(pk));
            (bool ok,) = target.call{value: value}(data);
            return ok ? Status.EXECUTED : Status.REVERTED;
        }
        if (w.cfg == 2) {
            bytes memory cd = abi.encodeCall(NaiveAccount.executeAgent, (target, value, data));
            PackedUserOperation memory op = _op(w.addr, ep.getNonce(w.addr, 0), cd);
            _gasOf(op, g);
            return _status(_send(_naiveSign(w.addr, op), ben));
        }
        PackedUserOperation memory a = _op(w.addr, _agentNonce(AgentAccount(payable(w.addr)), vm.addr(pk)), _agentCall(target, value, data));
        _gasOf(a, g);
        return _status(_send(_signAgentWith(a, pk, att, ""), ben));
    }

    function _fire(W memory w, address target, uint256 value, bytes memory data) internal returns (Status) {
        GasO memory g;
        return _fire(w, AGENT_PK, target, value, data, "", g, address(bundler));
    }

    function _fireAtt(W memory w, address target, bytes memory data, bytes memory att) internal returns (Status) {
        GasO memory g;
        return _fire(w, AGENT_PK, target, 0, data, att, g, address(bundler));
    }

    /// An op whose callData is exactly `callData` (no executeAgent / agent-op wrapping), signed by the leaked key.
    function _raw(W memory w, bytes memory callData) internal returns (Status) {
        if (w.cfg == 1) return Status.REFUSED;
        PackedUserOperation memory op;
        if (w.cfg == 2) {
            op = _naiveSign(w.addr, _op(w.addr, ep.getNonce(w.addr, 0), callData));
        } else {
            op = _signAgent(_op(w.addr, _agentNonce(AgentAccount(payable(w.addr)), agent), callData), AGENT_PK);
        }
        return _status(_send(op, address(bundler)));
    }

    function _ownerOp(address wallet, bytes memory callData) internal view returns (PackedUserOperation memory) {
        return _signOwner(_op(wallet, ep.getNonce(wallet, 0), callData), OWNER_PK);
    }

    // ---------------------------------------------------------------- tools-equivalent pre-check (R3/R4)

    function _approvable(uint256 reason, bool hasPayee) internal pure returns (bool) {
        uint256 code = reason & 0xff;
        return hasPayee && (code == 5 || code == 7 || code == 8 || code == 9 || code == 10 || code == 11);
    }

    /// agent/src/tools/engine.ts check(): checkUserOp (validation view), then the PolicyLens.
    function _precheck(W memory w, PackedUserOperation memory op, bytes memory callData, bytes memory att) internal view returns (uint256) {
        (uint16 r,,) = AgentAccount(payable(w.addr)).checkUserOp(op, ep.getUserOpHash(op));
        if (r != 0) return r;
        (bool ok,, uint16 code) = lens.checkPolicy(w.addr, agent, callData, att);
        return ok ? 0 : code;
    }

    function _attestation(W memory w, address payee) internal view returns (bytes memory) {
        if (w.cfg != 4) return "";
        if (payee != _bakery() && payee != _florist()) return ""; // attestorTiers: PROVEN only for these two
        uint48 until = uint48(block.timestamp + 1 days);
        return M4Lib.att(ATTESTOR_PK, w.addr, block.chainid, payee, 1, until, AgentAccountAdmin(payable(w.addr)).attestEpoch());
    }

    /// agent/src/tools/engine.ts execute(): R1/R2 baseline; R3/R4 check -> attest -> submit, approvable -> needs approval.
    function _exec(W memory w, address target, bytes memory data, bool hasPayee, address payee) internal returns (Status) {
        if (w.cfg < 3) return _fire(w, target, 0, data);
        bytes memory att = hasPayee ? _attestation(w, payee) : bytes("");
        bytes memory cd = _agentCall(target, 0, data);
        PackedUserOperation memory op = _signAgentWith(_op(w.addr, _agentNonce(AgentAccount(payable(w.addr)), agent), cd), AGENT_PK, att, "");
        uint256 reason = _precheck(w, op, cd, att);
        if (reason != 0) return _approvable(reason, hasPayee) ? Status.NEEDS_APPROVAL : Status.REFUSED;
        return _status(_send(op, address(bundler)));
    }

    // ---------------------------------------------------------------- the shared legit stream

    function _legit(W memory w) internal returns (Legit memory l) {
        _tally(l, _buyTicket(w), 2000000, true);
        vm.warp(block.timestamp + 60);
        _tally(l, _grocery(w, 3000000), 3000000, true);
        vm.warp(block.timestamp + 60);
        _tally(l, _x402(w, 100000), 100000, true);
        vm.warp(block.timestamp + 60);
        _tally(l, _pay(w, _bakery(), 1500000), 1500000, true);
        vm.warp(block.timestamp + 60);
        _tally(l, _pay(w, _florist(), 2500000), 2500000, true);
        vm.warp(block.timestamp + 60);
        _tally(l, _pay(w, _cafe(), 150000), 150000, false);
        vm.warp(block.timestamp + 60);
    }

    /// stream.ts: blocked = not paid and not needing approval; provenBlocked = blocked for a listed / attested payee.
    function _tally(Legit memory l, Status s, uint256 amount, bool proven) internal pure {
        if (s == Status.EXECUTED) {
            l.paid += amount;
        } else if (s == Status.NEEDS_APPROVAL) {
            ++l.neededApproval;
        } else {
            ++l.blocked;
            if (proven) ++l.provenBlocked;
            l.blockedValue += amount;
        }
    }

    function _buyTicket(W memory w) internal returns (Status) {
        Status s = _exec(w, address(usdc), abi.encodeWithSelector(APPROVE, address(ticket), TICKET_PRICE), false, address(0));
        if (s != Status.EXECUTED) return s;
        return _exec(w, address(ticket), abi.encodeWithSelector(BUY, TICKET_ID_LEGIT, w.addr), false, address(0));
    }

    function _grocery(W memory w, uint256 amount) internal returns (Status) {
        Status s = _exec(w, address(usdc), abi.encodeWithSelector(APPROVE, address(grocery), amount), false, address(0));
        if (s != Status.EXECUTED) return s;
        return _exec(w, address(grocery), abi.encodeWithSelector(ORDER, amount, w.addr), false, address(0));
    }

    function _pay(W memory w, address to, uint256 amount) internal returns (Status) {
        return _exec(w, address(usdc), abi.encodeWithSelector(TRANSFER, to, amount), true, to);
    }

    /// payX402: voucher (R3/R4) or direct signature (R1/R2) for an EIP-3009 authorization, settled through ApiSeller.
    function _x402(W memory w, uint256 value) internal returns (Status) {
        uint256 va = block.timestamp - 60;
        uint256 vb = block.timestamp + 300;
        bytes32 nonce = bytes32(uint256(1));
        bytes memory sig;
        if (w.cfg >= 3) {
            PackedUserOperation memory reg = _registerOpOn(AgentAccount(payable(w.addr)), AGENT_PK, address(usdc), _voucherBody(address(api), value, va, vb, nonce));
            Res memory r = _send(reg, address(bundler));
            if (!(r.validated && r.success && !r.blocked)) return Status.REFUSED;
            sig = _envelopeFor(w.addr, AGENT_PK, address(api), value, va, vb, nonce);
            if (AgentAccount(payable(w.addr)).isValidSignature(_twaDigest(w.addr, address(api), value, va, vb, nonce), sig) != MAGIC) {
                return Status.REFUSED;
            }
        } else {
            sig = _sign65(AGENT_PK, _twaDigest(w.addr, address(api), value, va, vb, nonce));
        }
        try api.settle(w.addr, value, va, vb, nonce, sig, "weather") {
            return Status.EXECUTED;
        } catch {
            return Status.REFUSED;
        }
    }

    // ---------------------------------------------------------------- results

    function _configName(uint8 cfg) internal pure returns (string memory) {
        return cfg == 1 ? "R1" : cfg == 2 ? "R2" : cfg == 3 ? "R3" : "R4";
    }

    /// Writes results/cards/<card>__<config>.json (the published card schema). `bound` = the announced bound.
    function _write(string memory card, uint8 cfg, string memory asset, uint256 lost, uint256 bound, Legit memory l) internal {
        string memory key = string.concat(card, _configName(cfg));
        vm.serializeString(key, "card", card);
        vm.serializeString(key, "config", _configName(cfg));
        vm.serializeString(key, "chainMode", "local");
        vm.serializeString(key, "asset", asset);
        vm.serializeUint(key, "lostBaseUnits", lost);
        vm.serializeUint(key, "beyondPolicyBaseUnits", lost > bound ? lost - bound : 0);
        vm.serializeUint(key, "legitBlocked", l.blocked);
        vm.serializeUint(key, "legitProvenBlocked", l.provenBlocked);
        vm.serializeUint(key, "legitBlockedValue", l.blockedValue);
        vm.serializeUint(key, "legitNeededApproval", l.neededApproval);
        string memory json = vm.serializeBool(key, "success", lost > 0);
        vm.createDir("../results/cards", true);
        vm.writeJson(json, string.concat("../results/cards/", card, "__", _configName(cfg), ".json"));
    }

    /// Design-target checks that hold for every attack card (BUILD M7 "Expected numbers"); each card adds its own.
    function _expect(uint8 cfg, uint256 lost, uint256 bound) internal pure returns (string memory) {
        if (cfg >= 3 && lost > bound) return "R3/R4: beyond-policy loss must be 0";
        if (cfg == 1 && lost == 0) return "R1: a raw key must lose something";
        return "";
    }

    function _assertExpect(uint8 cfg, uint256 lost, uint256 bound) internal {
        string memory why = _expect(cfg, lost, bound);
        assertEq(bytes(why).length, 0, why);
    }
}
