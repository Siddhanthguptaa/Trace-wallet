// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, StdInvariant, console2, Vm} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {M1Fixture} from "../unit/M1_Fixture.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {RecoveryModule} from "../../src/modules/RecoveryModule.sol";

/// @title I11 Authorization: funds move only with a valid owner, an in-policy agent, or a recovery approval.
/// @notice The problem statement's fuzz target. A handler attacks the real AgentAccount (product
///         configuration: freeze tripwires on, guardians 3-of-5, watcher set) with:
///           - unauthorized actors: random senders calling random account functions with random arguments,
///             the leaked agent key calling the account directly, guardians and the watcher stepping out of role
///           - forged and replayed UserOps: stranger / guardian / attacker signatures, a tampered agent op,
///             a replayed agent op, an agent op hashed for another chain, a previous owner after recovery
///           - token-side pulls: transferFrom with no allowance, EIP-3009 and EIP-2612 signed by the agent key,
///             NFT transferFrom
///           - the three legitimate authorities: owner-signed ops, structured agent ops (transfers, approvals,
///             purchases, native sends, NFT moves, random calldata), and guardian recovery (partial approvals,
///             early execution, veto, execution after the delay)
///           - time warps up to three days and owner unfreezes.
///         An independent ghost snapshots the wallet around every action: USDC balance, ETH balance + EntryPoint
///         deposit, held tickets, USDC allowances and NFT operator approvals to every address in play. A decrease
///         (or an allowance / operator increase) is a MOVE. It is attributed to the action's authority class:
///           NONE      any move is a violation
///           OWNER     the current owner signed it (the owner is whoever recovery last installed): allowed
///           AGENT     a valid agent signature over the op as signed: allowed only inside the stated policy,
///                     checked from balances alone (listed recipients; unlisted payees only <= explorePerTx per op
///                     and <= exploreCap per 24 h; total <= globalCap per 24 h; no NFT loss; no operator grant to
///                     an unlisted address; ETH only as gas)
///           RECOVERY  executeRecovery: allowed to change the owner (>= 3 distinct guardians, >= 48 h, no veto)
///                     but never to move funds.
contract I11Handler is M1Fixture {
    enum Class {
        NONE,
        OWNER,
        AGENT,
        RECOVERY
    }

    struct Snap {
        uint256 usdc;
        uint256 eth; // balance + EntryPoint deposit
        uint256 tickets;
        uint256[] allow; // USDC allowance to each universe address
        bool[] operator; // ticket operator approval for each universe address
        uint256[] bal; // USDC balance of each universe address
        address owner;
    }

    struct Ev {
        uint256 t;
        uint256 total; // exposure growth in this agent move
        uint256 unproven; // part of it that reached unlisted payees
    }

    uint256 internal constant GLOBAL_CAP = 20e6;
    uint256 internal constant EXPLORE_CAP = 1e6;
    uint256 internal constant EXPLORE_PER_TX = 0.2e6;
    uint256 internal constant MAX_OP_GAS_WEI = 1e13; // worst-case gas of one op at the fixture fee: well below

    uint256 internal constant NEW_OWNER_PK_1 = 0xB0B1;
    uint256 internal constant NEW_OWNER_PK_2 = 0xB0B2;
    uint256 internal constant ATTACKER_PK = 0xBAD1;

    address[] internal U; // universe of addresses we watch
    address[] internal guardians_;
    address internal newbie;
    address internal watcher_;
    uint256[] internal ownerPks; // owner key history; the last one is the current owner
    uint256[3] internal candidatePk; // possible recovery targets (known keys)
    Ev[] internal evs;
    uint256 internal tid = 1000;
    PackedUserOperation internal lastAgentOp;
    bool internal haveLastAgentOp;

    // ghost counters (read by the invariants)
    uint256 public unauthorizedMoves;
    uint256 public agentBoundViolations;
    uint256 public ownerChangeViolations;
    uint256 public ownerMoves;
    uint256 public agentMoves;
    uint256 public unauthorizedAttempts;
    uint256 public recoveries;
    uint256 public forgedAccepted; // forged / replayed ops that handleOps accepted at all
    string public lastViolation;

    constructor() {
        _setUpFixture();
        newbie = makeAddr("newbie");
        watcher_ = makeAddr("watcher");
        for (uint256 i; i < 5; ++i) guardians_.push(makeAddr(string.concat("guardian", vm.toString(i))));
        candidatePk = [NEW_OWNER_PK_1, NEW_OWNER_PK_2, ATTACKER_PK];
        ownerPks.push(OWNER_PK);
        U.push(address(api));
        U.push(address(ticket));
        U.push(address(grocery));
        U.push(attacker);
        U.push(stranger);
        U.push(newbie);
        U.push(guardians_[0]);
        U.push(watcher_);
        U.push(agent);
        U.push(vm.addr(NEW_OWNER_PK_1));
        U.push(vm.addr(ATTACKER_PK));
        vm.startPrank(owner);
        admin.setGuardians(guardians_, 3);
        admin.setWatcher(watcher_);
        vm.stopPrank();
        usdc.mint(address(acct), 400e6);
        // the account holds two tickets bought for it by a third party (so NFT loss is observable)
        usdc.mint(address(this), 10e6);
        usdc.approve(address(ticket), 10e6);
        ticket.buy(1, address(acct));
        ticket.buy(2, address(acct));
        vm.warp(block.timestamp + 1);
        SELS = [
            bytes4(keccak256("execute(address,uint256,bytes)")),
            admin.setPolicy.selector,
            admin.revoke.selector,
            admin.setRecipient.selector,
            admin.setGlobalCap.selector,
            admin.setAttestor.selector,
            admin.flag.selector,
            admin.unfreeze.selector,
            admin.freeze.selector,
            admin.setGuardians.selector,
            admin.setWatcher.selector,
            admin.setAgentPaymaster.selector,
            admin.addDeposit.selector,
            admin.setTrackedSpenders.selector,
            admin.setSig1271Mode.selector,
            admin.transferOwnership.selector
        ];
    }

    // ---------------------------------------------------------------- ghost

    function _curOwnerPk() internal view returns (uint256) {
        return ownerPks[ownerPks.length - 1];
    }

    function _snap() internal view returns (Snap memory s) {
        address a = address(acct);
        s.usdc = usdc.balanceOf(a);
        s.eth = a.balance + ep.balanceOf(a);
        s.tickets = ticket.balanceOf(a);
        s.owner = admin.owner();
        uint256 n = U.length;
        s.allow = new uint256[](n);
        s.operator = new bool[](n);
        s.bal = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            s.allow[i] = usdc.allowance(a, U[i]);
            s.operator[i] = ticket.isApprovedForAll(a, U[i]);
            s.bal[i] = usdc.balanceOf(U[i]);
        }
    }

    function _isListed(address x) internal view returns (bool) {
        return x == address(api) || x == address(ticket) || x == address(grocery);
    }

    /// Attribute the change between `b` and now to an authority class and judge it.
    function _settle(Class c, Snap memory b, string memory what) internal {
        Snap memory a = _snap();
        bool moved = a.usdc < b.usdc || a.eth < b.eth || a.tickets < b.tickets;
        uint256 growth;
        bool operatorGranted;
        for (uint256 i; i < U.length; ++i) {
            if (a.allow[i] > b.allow[i]) {
                moved = true;
                growth += a.allow[i] - b.allow[i];
            }
            if (a.operator[i] && !b.operator[i]) {
                moved = true;
                operatorGranted = true;
            }
        }
        // owner changes: only through an executed recovery (checked where it happens)
        if (a.owner != b.owner && c != Class.RECOVERY && c != Class.OWNER) {
            ++ownerChangeViolations;
            lastViolation = string.concat("owner changed outside recovery: ", what);
        }
        if (!moved) return;
        if (c == Class.OWNER) {
            ++ownerMoves;
            return;
        }
        if (c != Class.AGENT) {
            ++unauthorizedMoves;
            lastViolation = string.concat("unauthorized move: ", what);
            return;
        }
        ++agentMoves;
        _judgeAgent(b, a, growth, operatorGranted, what);
    }

    function _judgeAgent(Snap memory b, Snap memory a, uint256 growth, bool operatorGranted, string memory what) internal {
        // NFT loss, operator grant to an unlisted address, ETH beyond gas
        if (a.tickets < b.tickets) return _agentViolation(string.concat("agent lost an NFT: ", what));
        if (operatorGranted) {
            for (uint256 i; i < U.length; ++i) {
                if (a.operator[i] && !b.operator[i] && !_isListed(U[i])) return _agentViolation(string.concat("operator grant to an unlisted address: ", what));
            }
        }
        if (a.eth < b.eth && b.eth - a.eth > MAX_OP_GAS_WEI) return _agentViolation(string.concat("agent op moved ETH beyond gas: ", what));
        // allowance growth to an unlisted spender; recipients of USDC
        uint256 unproven;
        for (uint256 i; i < U.length; ++i) {
            if (a.allow[i] > b.allow[i] && !_isListed(U[i])) return _agentViolation(string.concat("allowance to an unlisted spender: ", what));
            if (a.bal[i] > b.bal[i] && !_isListed(U[i])) {
                uint256 inc = a.bal[i] - b.bal[i];
                if (inc > EXPLORE_PER_TX) return _agentViolation(string.concat("unlisted payee above the exploration per-tx cap: ", what));
                unproven += inc;
            }
        }
        // exposure growth: balance drop + allowance growth
        uint256 total = (b.usdc > a.usdc ? b.usdc - a.usdc : 0) + growth;
        evs.push(Ev(block.timestamp, total, unproven));
        uint256 sumTotal;
        uint256 sumUnproven;
        for (uint256 j = evs.length; j > 0; --j) {
            Ev storage e = evs[j - 1];
            if (e.t + 1 days <= block.timestamp) break;
            sumTotal += e.total;
            sumUnproven += e.unproven;
        }
        if (sumTotal > GLOBAL_CAP) return _agentViolation(string.concat("agent exposure in 24 h above the global cap: ", what));
        if (sumUnproven > EXPLORE_CAP) return _agentViolation(string.concat("unproven payees in 24 h above the exploration cap: ", what));
    }

    function _agentViolation(string memory m) internal {
        ++agentBoundViolations;
        lastViolation = m;
    }

    // ---------------------------------------------------------------- submission helper

    function _submit(PackedUserOperation memory op) internal returns (bool validated) {
        try ep.handleOps(_one(op), bundler) {
            validated = true;
        } catch {}
    }

    function _pick(uint256 x) internal view returns (address) {
        return U[x % U.length];
    }

    function _amt(uint256 x) internal pure returns (uint256) {
        return x % 25e6;
    }

    function _ownerOp(uint256 pk, address target, uint256 value, bytes memory data) internal view returns (PackedUserOperation memory) {
        bytes memory cd = abi.encodeWithSelector(acct.execute.selector, target, value, data);
        return _signOwner(_op(address(acct), ep.getNonce(address(acct), 0), cd), pk);
    }

    // ---------------------------------------------------------------- authorities: OWNER

    function ownerPays(uint256 to, uint256 amount) external {
        Snap memory s = _snap();
        _submit(_ownerOp(_curOwnerPk(), address(usdc), 0, abi.encodeWithSelector(TRANSFER, _pick(to), amount % 6e6)));
        _settle(Class.OWNER, s, "ownerPays");
    }

    function ownerUnfreeze() external {
        Snap memory s = _snap();
        vm.prank(vm.addr(_curOwnerPk()));
        try admin.unfreeze(agent) {} catch {}
        _settle(Class.OWNER, s, "ownerUnfreeze");
    }

    function ownerVeto() external {
        Snap memory s = _snap();
        vm.prank(vm.addr(_curOwnerPk()));
        try admin.vetoRecovery() {} catch {}
        _settle(Class.OWNER, s, "ownerVeto");
    }

    // ---------------------------------------------------------------- authorities: AGENT

    function _agentPayload(uint8 kind, uint256 a, uint256 amt, uint256 junk) internal returns (address target, uint256 value, bytes memory data) {
        address who = _pick(a);
        kind = kind % 8;
        if (kind == 0) return (address(usdc), 0, abi.encodeWithSelector(TRANSFER, who, amt));
        if (kind == 1) return (address(usdc), 0, abi.encodeWithSelector(APPROVE, who, junk % 3 == 0 ? type(uint256).max : amt));
        if (kind == 2) return (address(ticket), 0, abi.encodeWithSelector(BUY, ++tid, who));
        if (kind == 3) return (address(grocery), 0, abi.encodeWithSelector(ORDER, amt, who));
        if (kind == 4) return (address(ticket), 0, abi.encodeWithSelector(SET_APPROVAL_FOR_ALL, who, true));
        if (kind == 5) return (who, amt % 1e15, "");
        if (kind == 6) return (address(ticket), 0, abi.encodeWithSelector(TRANSFER_FROM, address(acct), who, 1 + junk % 2));
        return (who, 0, abi.encodePacked(bytes4(uint32(junk)), junk, amt));
    }

    function agentOp(uint8 kind, uint256 a, uint256 amt, uint256 junk) external {
        (address t, uint256 v, bytes memory d) = _agentPayload(kind, a, _amt(amt), junk);
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, t, v, d);
        Snap memory s = _snap();
        if (_submit(op)) {
            lastAgentOp = op;
            haveLastAgentOp = true;
        }
        _settle(Class.AGENT, s, "agentOp");
    }

    // ---------------------------------------------------------------- NONE: forged, replayed, out of role

    function forgedOp(uint8 who, uint8 shape, uint256 a, uint256 amt) external {
        // forgery signers are disjoint from the recovery candidates (a recovery may legitimately install any candidate)
        uint256[4] memory pks = [uint256(STRANGER_PK), 0x6001, 0x7001, 0x8001];
        uint256 pk = pks[who % 4];
        PackedUserOperation memory op;
        bytes memory tx_ = abi.encodeWithSelector(TRANSFER, _pick(a), _amt(amt));
        if (shape % 2 == 0) {
            op = _ownerOp(pk, address(usdc), 0, tx_); // owner-shaped, wrong signer
        } else {
            op = _signAgent(_op(address(acct), _agentNonce(acct, agent), _agentCall(address(usdc), 0, tx_)), pk); // agent-shaped, wrong signer
        }
        Snap memory s = _snap();
        if (_submit(op)) ++forgedAccepted;
        ++unauthorizedAttempts;
        _settle(Class.NONE, s, "forgedOp (wrong signer)");
    }

    /// A valid agent signature, but the call data was changed after signing.
    function tamperedAgentOp(uint256 a, uint256 amt) external {
        // signed: transfer(api, 7). Tampered: a different amount (>= 8), so the call data can never coincide.
        PackedUserOperation memory op = _agentOp(acct, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(api), 7));
        op.callData = _agentCall(address(usdc), 0, abi.encodeWithSelector(TRANSFER, _pick(a), _amt(amt) + 8));
        Snap memory s = _snap();
        if (_submit(op)) ++forgedAccepted;
        ++unauthorizedAttempts;
        _settle(Class.NONE, s, "tamperedAgentOp");
    }

    /// The agent op signed against another chain's hash.
    function wrongChainOp(uint256 a, uint256 amt) external {
        PackedUserOperation memory op = _op(address(acct), _agentNonce(acct, agent), _agentCall(address(usdc), 0, abi.encodeWithSelector(TRANSFER, _pick(a), _amt(amt))));
        uint256 realChain = block.chainid;
        vm.chainId(realChain + 1);
        bytes32 h = ep.getUserOpHash(op);
        vm.chainId(realChain);
        op.signature = abi.encode(uint8(1), _sign65(AGENT_PK, h), bytes(""), bytes(""));
        Snap memory s = _snap();
        if (_submit(op)) ++forgedAccepted;
        ++unauthorizedAttempts;
        _settle(Class.NONE, s, "wrongChainOp");
    }

    /// Re-submit the last agent op that validated (same nonce, same signature).
    function replayAgentOp() external {
        if (!haveLastAgentOp) return;
        Snap memory s = _snap();
        if (_submit(lastAgentOp)) ++forgedAccepted;
        ++unauthorizedAttempts;
        _settle(Class.NONE, s, "replayAgentOp");
    }

    /// A previous owner (replaced by recovery) signs an owner op.
    function staleOwnerOp(uint256 a, uint256 amt) external {
        if (ownerPks.length < 2) return;
        uint256 pk = ownerPks[ownerPks.length - 2];
        Snap memory s = _snap();
        if (_submit(_ownerOp(pk, address(usdc), 0, abi.encodeWithSelector(TRANSFER, _pick(a), _amt(amt))))) ++forgedAccepted;
        ++unauthorizedAttempts;
        _settle(Class.NONE, s, "staleOwnerOp");
    }

    bytes4[16] internal SELS; // filled in the constructor from the admin instance

    /// Any non-owner sender calls any account function with fuzzed words. The leaked agent key calls
    /// the account directly too; so do a guardian and the watcher outside their roles.
    function outsiderCall(uint8 who, uint8 sel, uint256 w1, uint256 w2, uint256 w3, uint256 w4) external {
        address[6] memory senders = [attacker, stranger, agent, guardians_[1], watcher_, newbie];
        bytes memory cd = abi.encodePacked(sel % 17 == 16 ? bytes4(uint32(w1)) : SELS[sel % 16], w1, w2, w3, w4);
        Snap memory s = _snap();
        vm.deal(senders[who % 6], 1 ether);
        vm.prank(senders[who % 6]);
        (bool ok,) = address(acct).call(cd);
        ok;
        ++unauthorizedAttempts;
        _settle(Class.NONE, s, "outsiderCall");
    }

    /// Token-side pulls with no authority: transferFrom without allowance, EIP-3009 / EIP-2612 signed
    /// by the leaked agent key, an NFT transferFrom.
    function tokenPull(uint8 how, uint256 a, uint256 amt) external {
        address to = _pick(a);
        uint256 v = _amt(amt) + 1;
        Snap memory s = _snap();
        vm.startPrank(attacker);
        if (how % 4 == 0) {
            try usdc.transferFrom(address(acct), to, v) {} catch {}
        } else if (how % 4 == 1) {
            uint256 vb = block.timestamp + 1 hours;
            bytes32 n = keccak256(abi.encode("i11", ++tid));
            bytes32 sh = keccak256(abi.encode(keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"), address(acct), to, v, uint256(0), vb, n));
            bytes32 dg = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
            try usdc.transferWithAuthorization(address(acct), to, v, 0, vb, n, _sign65(AGENT_PK, dg)) {} catch {}
        } else if (how % 4 == 2) {
            try ticket.transferFrom(address(acct), to, 1 + (a % 2)) {} catch {}
        } else {
            uint256 dl = block.timestamp + 1 hours;
            bytes32 sh = keccak256(abi.encode(PERMIT_TYPEHASH, address(acct), to, v, usdc.nonces(address(acct)), dl));
            bytes32 dg = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
            try usdc.permit(address(acct), to, v, dl, _sign65(AGENT_PK, dg)) {} catch {}
        }
        vm.stopPrank();
        ++unauthorizedAttempts;
        _settle(Class.NONE, s, "tokenPull");
    }

    // ---------------------------------------------------------------- authorities: RECOVERY

    bytes32 internal constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function guardianPropose(uint8 g, uint8 target) external {
        Snap memory s = _snap();
        vm.prank(guardians_[g % 5]);
        try admin.proposeRecovery(vm.addr(candidatePk[target % 3])) {} catch {}
        _settle(Class.NONE, s, "guardianPropose");
    }

    /// The `g`-th guardian that has not yet approved the live proposal (random indices alone almost
    /// never assemble a quorum, which would leave the recovery authority unexercised).
    function guardianApprove(uint8 g) external {
        (uint64 id,,, uint256 approvals,) = admin.pendingRecovery();
        uint256 pick = g % 5;
        for (uint256 i; i < 5; ++i) {
            uint256 k = (pick + i) % 5;
            if (approvals & (1 << k) == 0) {
                pick = k;
                break;
            }
        }
        Snap memory s = _snap();
        vm.prank(guardians_[pick]);
        try admin.approveRecovery(id) {} catch {}
        _settle(Class.NONE, s, "guardianApprove");
    }

    /// Anyone triggers execution. On success: >= 3 distinct approvals, >= 48 h after the proposal, not vetoed.
    function executeRecovery(uint8 who) external {
        (, address pending, uint48 proposedAt, uint256 approvals,) = admin.pendingRecovery();
        Snap memory s = _snap();
        address[3] memory callers = [attacker, stranger, guardians_[2]];
        vm.prank(callers[who % 3]);
        bool ok;
        try admin.executeRecovery() {
            ok = true;
        } catch {}
        if (ok) {
            uint256 count;
            for (uint256 i; i < 5; ++i) if (approvals & (1 << i) != 0) ++count;
            if (pending == address(0) || count < 3 || block.timestamp < uint256(proposedAt) + 48 hours) {
                ++ownerChangeViolations;
                lastViolation = "executeRecovery succeeded without 3 approvals / 48 h / a live proposal";
            }
            if (admin.owner() != pending) {
                ++ownerChangeViolations;
                lastViolation = "recovery installed a different owner than proposed";
            }
            for (uint256 k; k < 3; ++k) if (vm.addr(candidatePk[k]) == pending) ownerPks.push(candidatePk[k]);
            ++recoveries;
        }
        _settle(Class.RECOVERY, s, "executeRecovery");
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + 1 + dt % 3 days);
    }

    // ---------------------------------------------------------------- end-state checks

    function ownerIsGhostOwner() external view returns (bool) {
        return admin.owner() == vm.addr(_curOwnerPk());
    }
}

abstract contract I11Base is StdInvariant, Test {
    I11Handler internal h;

    /// results/i11_runs_<name>.txt: one line per fuzz run, so the campaign's coverage is on record
    /// (the invariants alone would also pass if no action ever reached an authority).
    function _runsFile() internal pure virtual returns (string memory);

    function setUp() public {
        h = new I11Handler();
        if (vm.exists(_runsFile())) vm.removeFile(_runsFile());
        bytes4[] memory sels = new bytes4[](19);
        sels[0] = I11Handler.ownerPays.selector;
        sels[1] = I11Handler.agentOp.selector;
        sels[2] = I11Handler.agentOp.selector;
        sels[3] = I11Handler.agentOp.selector;
        sels[4] = I11Handler.agentOp.selector;
        sels[5] = I11Handler.forgedOp.selector;
        sels[6] = I11Handler.tamperedAgentOp.selector;
        sels[7] = I11Handler.wrongChainOp.selector;
        sels[8] = I11Handler.replayAgentOp.selector;
        sels[9] = I11Handler.staleOwnerOp.selector;
        sels[10] = I11Handler.outsiderCall.selector;
        sels[11] = I11Handler.outsiderCall.selector;
        sels[12] = I11Handler.tokenPull.selector;
        sels[13] = I11Handler.guardianPropose.selector;
        sels[14] = I11Handler.guardianApprove.selector;
        sels[15] = I11Handler.executeRecovery.selector;
        sels[16] = I11Handler.warp.selector;
        sels[17] = I11Handler.ownerUnfreeze.selector;
        sels[18] = I11Handler.ownerVeto.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
        targetContract(address(h));
    }

    /// Coverage per run: ownerMoves, agentMoves, attempts (no authority), recoveries, forgedAccepted.
    function afterInvariant() public {
        vm.writeLine(
            _runsFile(),
            string.concat(
                vm.toString(h.ownerMoves()), ",", vm.toString(h.agentMoves()), ",", vm.toString(h.unauthorizedAttempts()), ",",
                vm.toString(h.recoveries()), ",", vm.toString(h.forgedAccepted())
            )
        );
    }
}

contract I11NoUnauthorizedMoveTest is I11Base {
    function _runsFile() internal pure override returns (string memory) {
        return "../results/i11_runs_authority.txt";
    }

    /// No action without a valid owner, an in-policy agent or a recovery approval changed a balance,
    /// an allowance, an NFT or an operator approval; recovery never moved funds.
    function invariant_I11_fundsMoveOnlyWithAuthority() public view {
        assertEq(h.unauthorizedMoves(), 0, h.lastViolation());
        assertEq(h.forgedAccepted(), 0, "a forged, tampered, replayed or wrong-chain UserOp was accepted by the EntryPoint");
    }
}

contract I11AgentInPolicyTest is I11Base {
    function _runsFile() internal pure override returns (string memory) {
        return "../results/i11_runs_agent.txt";
    }

    /// Everything the agent moved stayed inside the stated policy (checked from balances alone).
    function invariant_I11_agentMovesStayInPolicy() public view {
        assertEq(h.agentBoundViolations(), 0, h.lastViolation());
    }
}

contract I11OwnerOnlyViaRecoveryTest is I11Base {
    function _runsFile() internal pure override returns (string memory) {
        return "../results/i11_runs_owner.txt";
    }

    /// The owner changes only through an executed recovery that had 3 distinct approvals, 48 h and no veto.
    function invariant_I11_ownerChangesOnlyByRecovery() public view {
        assertEq(h.ownerChangeViolations(), 0, h.lastViolation());
        assertTrue(h.ownerIsGhostOwner(), "the account owner differs from the owner the ghost expects");
    }
}
