// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {PolicyInput, Session} from "../../src/lib/PolicyTypes.sol";

/// Fuzzed recovery actions by guardians, the owner, strangers and agent keys, with time warps,
/// guardian resets and owner transfers. A ghost model, built only from calls that succeeded,
/// checks I12 after every call: the owner changes only via the owner (transferOwnership) or via
/// executeRecovery with >= 3 distinct current-guardian approvals, >= 48 h after the proposal,
/// and no veto. It also checks one live proposal at a time and that recovery revokes every
/// agent key, bumps attestEpoch and moves no funds.
contract I12Handler is Test {
    uint256 internal constant DELAY = 48 hours;

    AgentAccountAdmin internal admin;
    address internal acct;
    address[] internal pool; // 8 guardian candidates
    address[] internal fresh; // 4 owner candidates
    address[] internal agents; // session keys
    address internal stranger;
    IERC20 internal token; // balance watched: recovery never moves funds

    // ghost model
    address public ghostOwner;
    uint64 public ghostEpoch;
    address[] internal ghostGuardians;
    bool public ghostLive;
    uint64 public ghostId;
    address public ghostPending;
    uint256 public ghostProposedAt;
    address[] internal ghostApprovers;

    uint256 public violations;
    string public lastViolation;
    uint256 public recoveries;
    uint256 public approvalsOk;
    uint256 public proposalsOk;
    uint256 public vetoes;

    constructor(
        AgentAccountAdmin admin_,
        address[] memory pool_,
        address[] memory fresh_,
        address[] memory agents_,
        address stranger_,
        IERC20 token_
    ) {
        admin = admin_;
        acct = address(admin_);
        pool = pool_;
        fresh = fresh_;
        agents = agents_;
        stranger = stranger_;
        token = token_;
        ghostOwner = admin_.owner();
        ghostEpoch = admin_.attestEpoch();
        (address[] memory gs,) = admin_.guardians();
        ghostGuardians = gs;
    }

    // ---------------------------------------------------------------- helpers

    function _fail(string memory why) internal {
        ++violations;
        lastViolation = why;
    }

    function _isGhostGuardian(address a) internal view returns (bool) {
        for (uint256 i; i < ghostGuardians.length; ++i) {
            if (ghostGuardians[i] == a) return true;
        }
        return false;
    }

    function _approved(address a) internal view returns (bool) {
        for (uint256 i; i < ghostApprovers.length; ++i) {
            if (ghostApprovers[i] == a) return true;
        }
        return false;
    }

    /// Index source independent of the low bits (fuzz seeds are often small).
    function _h(uint256 seed) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed)));
    }

    /// Mostly a current guardian (to reach executions), sometimes anyone.
    function _actor(uint256 seed) internal view returns (address) {
        uint256 k = seed % 16;
        seed = _h(seed);
        if (k < 10 && ghostGuardians.length != 0) return ghostGuardians[(seed >> 8) % ghostGuardians.length];
        if (k < 13) return pool[(seed >> 8) % pool.length]; // maybe a former guardian
        if (k == 13) return admin.owner();
        if (k == 14) return agents[(seed >> 8) % agents.length];
        return stranger;
    }

    /// A current guardian that has not approved the live proposal yet (guides the fuzzer to
    /// threshold; the other branch of `approve` still tries every kind of bad actor).
    function _freshApprover(uint256 seed) internal view returns (address) {
        uint256 n = ghostGuardians.length;
        if (n == 0) return stranger;
        uint256 start = _h(seed);
        for (uint256 i; i < n; ++i) {
            address a = ghostGuardians[(start + i) % n];
            if (!_approved(a)) return a;
        }
        return ghostGuardians[start % n];
    }

    function _target(uint256 seed) internal view returns (address) {
        uint256 k = seed % 10;
        seed = _h(seed);
        if (k < 6) return fresh[(seed >> 8) % fresh.length];
        if (k == 6) return pool[(seed >> 8) % pool.length];
        if (k == 7) return agents[(seed >> 8) % agents.length];
        if (k == 8) return admin.owner();
        return address(0);
    }

    function _ownerUnchanged(address before) internal {
        if (admin.owner() != before) _fail("owner changed outside transferOwnership/executeRecovery");
    }

    function _clearProposal() internal {
        ghostLive = false;
        delete ghostApprovers;
    }

    // ---------------------------------------------------------------- actions

    function propose(uint256 actorSeed, uint256 targetSeed) external {
        address before = admin.owner();
        address who = _actor(actorSeed);
        address n = _target(targetSeed);
        vm.prank(who);
        try admin.proposeRecovery(n) {
            ++proposalsOk;
            if (!_isGhostGuardian(who)) _fail("non-guardian proposed");
            if (ghostLive && (ghostApprovers.length >= 3 || block.timestamp < ghostProposedAt + DELAY)) {
                _fail("live proposal replaced");
            }
            _clearProposal();
            ghostLive = true;
            ++ghostId;
            ghostPending = n;
            ghostProposedAt = block.timestamp;
            ghostApprovers.push(who);
        } catch {}
        _ownerUnchanged(before);
    }

    function approve(uint256 actorSeed, uint256 idSeed) external {
        address before = admin.owner();
        address who = actorSeed % 16 < 10 ? _freshApprover(actorSeed) : _actor(actorSeed);
        uint64 id = idSeed % 5 == 4 ? uint64(_h(idSeed) % 4) : ghostId; // sometimes a stale / future id
        vm.prank(who);
        try admin.approveRecovery(id) {
            ++approvalsOk;
            if (!_isGhostGuardian(who)) _fail("non-guardian approved");
            if (!ghostLive || id != ghostId) _fail("approval of a dead or wrong proposal");
            if (_approved(who)) _fail("guardian approved twice");
            ghostApprovers.push(who);
        } catch {}
        _ownerUnchanged(before);
    }

    function execute(uint256 actorSeed) external {
        address before = admin.owner();
        uint256 tok0 = token.balanceOf(acct);
        uint256 eth0 = acct.balance;
        vm.prank(_actor(actorSeed));
        try admin.executeRecovery() {
            ++recoveries;
            uint256 distinct;
            for (uint256 i; i < ghostApprovers.length; ++i) {
                if (_isGhostGuardian(ghostApprovers[i])) ++distinct;
            }
            if (!ghostLive) _fail("executed without a live proposal");
            if (distinct < 3) _fail("executed with < 3 guardian approvals");
            if (block.timestamp < ghostProposedAt + DELAY) _fail("executed before 48 h");
            if (admin.owner() != ghostPending) _fail("installed an owner nobody proposed");
            if (admin.attestEpoch() != ghostEpoch + 1) _fail("attestEpoch not bumped");
            for (uint256 i; i < agents.length; ++i) {
                (uint64 sid, Session memory s) = admin.sessionOf(agents[i]);
                if (sid != 0 && !s.revoked) _fail("agent key survived recovery");
            }
            if (acct.balance != eth0) _fail("recovery moved ETH");
            if (token.balanceOf(acct) != tok0) _fail("recovery moved tokens");
            ghostOwner = admin.owner();
            ghostEpoch = admin.attestEpoch();
            _clearProposal();
        } catch {
            _ownerUnchanged(before);
        }
    }

    function veto(uint256 actorSeed) external {
        address before = admin.owner();
        address who = actorSeed % 6 == 0 ? admin.owner() : _actor(actorSeed);
        vm.prank(who);
        try admin.vetoRecovery() {
            ++vetoes;
            if (who != ghostOwner) _fail("non-owner vetoed");
            if (!ghostLive) _fail("veto without a live proposal");
            _clearProposal();
        } catch {}
        _ownerUnchanged(before);
    }

    function resetGuardians(uint256 seed) external {
        if (seed % 4 != 0) return; // rarer than the other actions
        address before = admin.owner();
        address[] memory s = new address[](5);
        uint256 off = _h(seed);
        for (uint256 i; i < 5; ++i) {
            s[i] = pool[(off + i) % pool.length];
        }
        address who = (seed >> 4) % 4 == 0 ? stranger : admin.owner();
        vm.prank(who);
        try admin.setGuardians(s, 3) {
            if (who != ghostOwner) _fail("non-owner set guardians");
            ghostGuardians = s;
            _clearProposal();
        } catch {}
        _ownerUnchanged(before);
    }

    /// The owner's own path: the only other legitimate owner change.
    function transferOwner(uint256 seed) external {
        if (seed % 4 != 0) return;
        address n = fresh[_h(seed) % fresh.length];
        address cur = admin.owner();
        vm.prank(cur);
        try admin.transferOwnership(n) {
            ghostOwner = n;
        } catch {
            _ownerUnchanged(cur);
        }
    }

    /// Strangers and agent keys try the owner path.
    function hijackOwner(uint256 seed) external {
        address before = admin.owner();
        address who = seed % 2 == 0 ? stranger : agents[_h(seed) % agents.length];
        vm.prank(who);
        try admin.transferOwnership(who) {
            _fail("non-owner transferred ownership");
        } catch {}
        _ownerUnchanged(before);
    }

    /// The current owner re-enables an agent key (recovery must revoke it again).
    function reEnableAgent(uint256 seed) external {
        address before = admin.owner();
        PolicyInput memory p;
        p.validAfter = uint48(block.timestamp - 1);
        p.validUntil = uint48(block.timestamp + 30 days);
        vm.prank(admin.owner());
        try admin.setPolicy(agents[seed % agents.length], p) {} catch {}
        _ownerUnchanged(before);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 72 hours));
    }

    function approverCount() external view returns (uint256) {
        return ghostApprovers.length;
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 96
contract M11I12Test is M1Fixture {
    I12Handler internal h;
    uint256 internal usdc0;
    uint256 internal eth0;
    uint256 internal dep0;

    function setUp() public {
        _setUpFixture();
        address[] memory pool = new address[](8);
        for (uint256 i; i < 8; ++i) {
            pool[i] = makeAddr(string(abi.encodePacked("i12guardian", vm.toString(i))));
        }
        address[] memory fresh = new address[](4);
        for (uint256 i; i < 4; ++i) {
            fresh[i] = makeAddr(string(abi.encodePacked("i12owner", vm.toString(i))));
        }
        address[] memory agents = new address[](2);
        agents[0] = agent;
        agents[1] = agent2;
        address[] memory first = new address[](5);
        for (uint256 i; i < 5; ++i) {
            first[i] = pool[i];
        }
        vm.startPrank(owner);
        admin.setPolicy(agent2, _demoPolicy());
        admin.setGuardians(first, 3);
        vm.stopPrank();

        h = new I12Handler(admin, pool, fresh, agents, stranger, IERC20(address(usdc)));
        usdc0 = usdc.balanceOf(address(acct));
        eth0 = address(acct).balance;
        dep0 = admin.getDeposit();

        bytes4[] memory sel = new bytes4[](9);
        sel[0] = I12Handler.propose.selector;
        sel[1] = I12Handler.approve.selector;
        sel[2] = I12Handler.execute.selector;
        sel[3] = I12Handler.veto.selector;
        sel[4] = I12Handler.resetGuardians.selector;
        sel[5] = I12Handler.transferOwner.selector;
        sel[6] = I12Handler.hijackOwner.selector;
        sel[7] = I12Handler.reEnableAgent.selector;
        sel[8] = I12Handler.warp.selector;
        targetContract(address(h));
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_I12_ownerChangesOnlyByOwnerOrRecovery() public view {
        assertEq(h.violations(), 0, h.lastViolation());
        assertEq(admin.owner(), h.ghostOwner(), "owner == ghost owner");
    }

    function invariant_I12_pendingMatchesGhost() public view {
        (uint64 id, address n,, uint256 bits,) = admin.pendingRecovery();
        assertEq(id, h.ghostId(), "proposal ids never reused or skipped");
        if (h.ghostLive()) {
            assertEq(n, h.ghostPending());
            uint256 count;
            for (; bits != 0; bits &= bits - 1) {
                ++count;
            }
            assertEq(count, h.approverCount(), "approval bitmap == distinct successful approvers");
        } else {
            assertEq(n, address(0), "no live proposal on chain when the ghost has none");
        }
    }

    function invariant_I12_recoveryMovesNoFunds() public view {
        assertEq(usdc.balanceOf(address(acct)), usdc0);
        assertEq(address(acct).balance, eth0);
        assertEq(admin.getDeposit(), dep0);
    }

    /// Coverage: one line per run (proposals approvals vetoes recoveries) appended to
    /// results/m11_i12_runs.txt; delete the file before a campaign to count only that campaign.
    function afterInvariant() public {
        console2.log("I12 run: proposals, approvals, vetoes, recoveries");
        console2.log(h.proposalsOk(), h.approvalsOk(), h.vetoes(), h.recoveries());
        vm.writeLine(
            "../results/m11_i12_runs.txt",
            string.concat(
                vm.toString(h.proposalsOk()), " ", vm.toString(h.approvalsOk()), " ",
                vm.toString(h.vetoes()), " ", vm.toString(h.recoveries())
            )
        );
    }
}
