// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, StdInvariant, console2} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {M1Fixture} from "../unit/M1_Fixture.sol";
import {M2QuietAccount} from "../unit/M2_Harness.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {PolicyInput, AssetInput, AssetLimit} from "../../src/lib/PolicyTypes.sol";
import {Buckets} from "../../src/lib/Buckets.sol";

/// Fuzzed agent traffic from two session keys over warped time: payments to listed shops and to an
/// unlisted payee (exploration track), approvals to shops (tracked and untracked spenders), shop
/// pulls (grocery order, ticket buy), and NFT move / approve attempts. The ghost measures every op
/// itself from balances and allowances (independent of the meter): exposure growth
/// R = allowance growth - balance change (net), attributed to the signing key at block.timestamp.
contract M2Handler is M1Fixture {
    struct Ev {
        uint256 t;
        uint8 key;
        uint256 amount;
    }

    uint256 internal constant KEY2_BURST = 3e6; // agent2: 6 USDC / 24 h, below the 20 USDC global cap
    uint256 internal constant KEY2_RATE = 3e6;

    Ev[] internal evs;
    address internal newbie;
    address[] internal watched; // spenders whose allowances the ghost sums
    uint256 internal start;
    uint256 internal nextTicket = 100;
    uint256[] internal ownedTickets;

    uint256 public submitted;
    uint256 public refused;
    uint256 public positive;
    bool public nftDropped;

    constructor() {
        _setUpFixture();
        // Same demo account, FRZ tripwires off (M2QuietAccount): the bound must hold on the meter alone.
        AgentAccount impl = new M2QuietAccount(IEntryPoint(address(ep)), factory.accountImplementation().admin());
        acct = new AgentAccountFactory(impl).createAccount(owner, 0);
        admin = AgentAccountAdmin(payable(address(acct)));
        _configureDemo(acct, agent);
        vm.deal(address(acct), 1 ether);
        vm.prank(owner);
        admin.addDeposit{value: 1 ether}();
        start = block.timestamp;
        newbie = makeAddr("newbie");
        PolicyInput memory p = _demoPolicy();
        p.assets[0] = AssetInput(address(usdc), PER_TX, uint128(KEY2_BURST), uint128(KEY2_RATE));
        vm.prank(owner);
        admin.setPolicy(agent2, p);
        usdc.mint(address(acct), 900e6);
        watched.push(address(ticket));
        watched.push(address(grocery));
        watched.push(address(api));
        watched.push(attacker);
        watched.push(newbie);
        // The account holds three tickets before the run (bought by a third party for it).
        usdc.mint(address(this), 10e6);
        usdc.approve(address(ticket), 10e6);
        for (uint256 id = 1; id <= 3; ++id) {
            ticket.buy(id, address(acct));
            ownedTickets.push(id);
        }
    }

    // ---------------------------------------------------------------- ghost

    function _exposure() internal view returns (uint256 bal, uint256 allow) {
        bal = usdc.balanceOf(address(acct));
        for (uint256 i; i < watched.length; ++i) {
            allow += usdc.allowance(address(acct), watched[i]);
        }
    }

    function _do(uint8 k, address target, uint256 value, bytes memory data) internal {
        k = k % 2;
        PackedUserOperation memory op = _agentOp(acct, k == 0 ? AGENT_PK : AGENT2_PK, target, value, data);
        (uint256 bal0, uint256 al0) = _exposure();
        uint256 nft0 = ticket.balanceOf(address(acct));
        try ep.handleOps(_one(op), bundler) {
            ++submitted;
        } catch {
            ++refused; // refused in validation
        }
        (uint256 bal1, uint256 al1) = _exposure();
        int256 r = int256(al1) - int256(al0) + int256(bal0) - int256(bal1);
        if (r > 0) {
            evs.push(Ev(block.timestamp, k, uint256(r)));
            ++positive;
        }
        if (ticket.balanceOf(address(acct)) < nft0) nftDropped = true;
    }

    // ---------------------------------------------------------------- actions

    function pay(uint8 k, uint8 who, uint256 amount) external {
        address[4] memory to = [address(api), address(grocery), address(ticket), newbie];
        address payee = to[who % 4];
        amount = payee == newbie ? bound(amount, 1, 0.25e6) : bound(amount, 1, 11e6);
        _do(k, address(usdc), 0, abi.encodeWithSelector(TRANSFER, payee, amount));
    }

    /// Greedy attacker: pay exactly what the key and global buckets allow now (or one unit more).
    function drain(uint8 k, bool plusOne, uint8 who) external {
        address key = k % 2 == 0 ? agent : agent2;
        AssetLimit memory a = admin.keyAsset(key, address(usdc));
        uint256 avail = Buckets.availableAt(a.bucket, block.timestamp);
        uint256 g = Buckets.availableAt(admin.globalBucket(address(usdc)), block.timestamp);
        if (g < avail) avail = g;
        if (avail > PER_TX) avail = PER_TX;
        if (plusOne) ++avail;
        if (avail == 0) return;
        address payee = who % 2 == 0 ? address(api) : address(grocery);
        _do(k, address(usdc), 0, abi.encodeWithSelector(TRANSFER, payee, avail));
    }

    function approveShop(uint8 k, uint8 who, uint256 amount) external {
        address[3] memory sp = [address(ticket), address(grocery), address(api)];
        _do(k, address(usdc), 0, abi.encodeWithSelector(APPROVE, sp[who % 3], bound(amount, 0, 10e6)));
    }

    function order(uint8 k, uint256 amount) external {
        _do(k, address(grocery), 0, abi.encodeWithSelector(ORDER, bound(amount, 1, 10e6), address(acct)));
    }

    function buyTicket(uint8 k) external {
        uint256 id = nextTicket++;
        _do(k, address(ticket), 0, abi.encodeWithSelector(BUY, id, address(acct)));
        if (ticket.balanceOf(address(acct)) > ownedTickets.length) ownedTickets.push(id);
    }

    /// I6 attempts: move or approve the account's tickets.
    function nftAttack(uint8 k, uint8 which, uint256 idx) external {
        uint256 id = ownedTickets[idx % ownedTickets.length];
        bytes memory data;
        which = which % 6;
        if (which == 0) data = abi.encodeWithSelector(TRANSFER_FROM, address(acct), attacker, id);
        else if (which == 1) data = abi.encodeWithSelector(bytes4(0x42842e0e), address(acct), attacker, id);
        else if (which == 2) data = abi.encodeWithSelector(APPROVE, attacker, id);
        else if (which == 3) data = abi.encodeWithSelector(SET_APPROVAL_FOR_ALL, attacker, true);
        else if (which == 4) data = abi.encodeWithSelector(TRANSFER_FROM, address(acct), address(grocery), id);
        else data = abi.encodeWithSelector(SET_APPROVAL_FOR_ALL, address(grocery), true); // allowed: listed shop
        _do(k, address(ticket), 0, data);
    }

    function warp(uint256 dt) external {
        dt = bound(dt, 0, 4 hours);
        if (block.timestamp + dt < start + 5 days) vm.warp(block.timestamp + dt); // policy runs 6 days
    }

    // ---------------------------------------------------------------- views for the invariants

    function evCount() external view returns (uint256) {
        return evs.length;
    }

    /// Max ghost outflow in any closed 24 h window, for one key (k < 2) or all keys (k = 2).
    function maxWindow(uint8 k) external view returns (uint256 maxSum) {
        uint256 n = evs.length;
        for (uint256 i; i < n; ++i) {
            if (k < 2 && evs[i].key != k) continue;
            uint256 sum;
            for (uint256 j = i; j < n; ++j) {
                if (evs[j].t > evs[i].t + 1 days) break; // evs are in time order
                if (k < 2 && evs[j].key != k) continue;
                sum += evs[j].amount;
            }
            if (sum > maxSum) maxSum = sum;
        }
    }

    function tickets() external view returns (uint256[] memory) {
        return ownedTickets;
    }

    function addrs() external view returns (address acct_, address ticket_, address attacker_, address grocery_) {
        return (address(acct), address(ticket), attacker, address(grocery));
    }
}

/// I1 (per key), I5 (account-wide, all keys and both tracks) and I6 (replaced per FASTPLAN cuts:
/// no agent op moves an NFT or approves a non-listed operator under the demo rules). One invariant
/// per contract so each campaign is a separate entry in forge's JSON (tools/forge_summary.py).
abstract contract M2InvariantBase is StdInvariant, Test {
    M2Handler internal h;

    function setUp() public {
        h = new M2Handler();
        bytes4[] memory sels = new bytes4[](7);
        sels[0] = M2Handler.pay.selector;
        sels[1] = M2Handler.approveShop.selector;
        sels[2] = M2Handler.order.selector;
        sels[3] = M2Handler.buyTicket.selector;
        sels[4] = M2Handler.nftAttack.selector;
        sels[5] = M2Handler.warp.selector;
        sels[6] = M2Handler.drain.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
        targetContract(address(h));
    }

    /// Coverage line per run (forge test -vv): ops that executed, ops with outflow, peak windows.
    function afterInvariant() public view {
        console2.log("submitted/refused/positive", h.submitted(), h.refused(), h.positive());
        console2.log("peak window key1/key2/all", h.maxWindow(0), h.maxWindow(1), h.maxWindow(2));
    }
}

contract M2InvariantI1Test is M2InvariantBase {
    function invariant_I1_keyOutflowWindow() public view {
        assertLe(h.maxWindow(0), 20e6, "I1: key 1 outflow in a 24 h window > its 20 USDC cap");
        assertLe(h.maxWindow(1), 6e6, "I1: key 2 outflow in a 24 h window > its 6 USDC cap");
    }
}

contract M2InvariantI5Test is M2InvariantBase {
    function invariant_I5_globalOutflowWindow() public view {
        assertLe(h.maxWindow(2), 20e6, "I5: total outflow in a 24 h window > globalCap");
    }
}

contract M2InvariantI6Test is M2InvariantBase {
    function invariant_I6_noAgentNftMoveOrApprove() public view {
        assertFalse(h.nftDropped(), "I6: an agent op lowered the NFT balance");
        (address acct, address ticketAddr, address attacker, address grocery) = h.addrs();
        IERC721View t = IERC721View(ticketAddr);
        assertFalse(t.isApprovedForAll(acct, attacker), "I6: non-listed operator approved");
        uint256[] memory ids = h.tickets();
        for (uint256 i; i < ids.length; ++i) {
            assertEq(t.ownerOf(ids[i]), acct, "I6: ticket left the account");
            address a = t.getApproved(ids[i]);
            assertTrue(a == address(0) || a == grocery, "I6: ticket approved to a non-listed address");
        }
    }
}

/// Fixed sequence through the handler: the campaign really executes and blocks ops.
contract M2HandlerSmokeTest is Test {
    function test_meter_handlerSmoke() public {
        M2Handler h = new M2Handler();
        h.pay(0, 0, 9e6);
        h.pay(1, 0, 5e6);
        h.pay(1, 0, 5e6); // key 2 bucket (3) blocks in execution
        h.approveShop(0, 1, 5e6);
        h.order(0, 5e6);
        h.pay(0, 3, 0.2e6); // exploration track
        h.nftAttack(0, 0, 0);
        h.nftAttack(0, 5, 0);
        h.warp(9 hours);
        h.pay(0, 1, 11e6); // refused in validation (per-tx)
        assertGt(h.submitted(), 0);
        assertGt(h.refused(), 0);
        assertGt(h.positive(), 0);
        assertLe(h.maxWindow(2), 20e6);
        assertLe(h.maxWindow(1), 6e6);
        assertFalse(h.nftDropped());
    }
}

/// Greedy drain every hour for 30 h: the ghost's peak 24 h window reaches the cap (the bound is
/// tight, not loose) and never passes it; every "available + 1" attempt is blocked.
contract M2DrainTest is Test {
    function test_bucket_drainReachesCapNeverBeyond() public {
        M2Handler h = new M2Handler();
        for (uint256 i; i < 30; ++i) {
            h.drain(0, false, uint8(i));
            uint256 before = h.positive();
            h.drain(0, true, uint8(i));
            assertEq(h.positive(), before, "available + 1 moved value");
            h.warp(1 hours);
        }
        uint256 peak = h.maxWindow(2);
        assertLe(peak, 20e6, "I5 bound");
        assertGe(peak, 19.9e6, "the drain reaches the 20 USDC/24 h cap (minus refill rounding)");
        assertEq(h.maxWindow(0), peak, "key 1 alone");
    }
}

interface IERC721View {
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function ownerOf(uint256 id) external view returns (address);
    function getApproved(uint256 id) external view returns (address);
}
