// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {M1Fixture} from "./M1_Fixture.sol";
import {FrzHarness} from "./M10_Harness.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {FreezeAdmin, FreezeStorage} from "../../src/modules/FreezeModule.sol";
import {Reason, LANE_NORMAL} from "../../src/lib/PolicyTypes.sol";

/// I13 handler: the agent fires ops of every kind (listed shop, fresh unproven payees, the canary,
/// self-calls to unfreeze), meter breaches come and go, the watcher freezes, non-owners try to
/// unfreeze, the owner unfreezes and retunes thresholds, and time moves.
contract I13Handler is Test {
    IEntryPoint internal ep;
    FrzHarness internal acct;
    AgentAccountAdmin internal ad;
    address internal usdc;
    address internal shop;
    address internal canary;
    address internal owner;
    address internal watcherAddr;
    uint256 internal agentPk;
    address internal agent;
    address payable internal bundler;

    /// Agent ops that passed validation while the key was frozen (must stay 0).
    uint256 public frozenValidated;
    /// Unfreezes by anyone but the owner that did not revert (must stay 0).
    uint256 public badUnfreezes;
    /// Once frozen, the key must stay frozen until the owner unfreezes it.
    bool public mustBeFrozen;
    uint256 public ops;
    uint256 public freezesSeen;
    uint256 public unfreezes;

    constructor(
        IEntryPoint ep_,
        FrzHarness acct_,
        address usdc_,
        address shop_,
        address canary_,
        address owner_,
        address watcher_,
        uint256 agentPk_
    ) {
        ep = ep_;
        acct = acct_;
        ad = AgentAccountAdmin(payable(address(acct_)));
        usdc = usdc_;
        shop = shop_;
        canary = canary_;
        owner = owner_;
        watcherAddr = watcher_;
        agentPk = agentPk_;
        agent = vm.addr(agentPk_);
        bundler = payable(makeAddr("i13bundler"));
    }

    modifier track() {
        _;
        if (ad.isFrozen(agent)) {
            if (!mustBeFrozen) ++freezesSeen;
            mustBeFrozen = true;
        }
    }

    function _submit(address target, bytes memory data) internal {
        bool frozenBefore = ad.isFrozen(agent);
        PackedUserOperation memory op;
        op.sender = address(acct);
        op.nonce = ep.getNonce(address(acct), ad.nonceKeyOf(agent, LANE_NORMAL));
        op.callData = abi.encodePacked(bytes4(0x8dd7712f), abi.encode(uint8(0), target, uint256(0), data));
        op.accountGasLimits = bytes32((uint256(250_000) << 128) | 400_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(0.01 gwei) << 128) | 0.01 gwei);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, ep.getUserOpHash(op));
        op.signature = abi.encode(uint8(1), abi.encodePacked(r, s, v), bytes(""), bytes(""));
        PackedUserOperation[] memory one = new PackedUserOperation[](1);
        one[0] = op;
        ++ops;
        try ep.handleOps(one, bundler) {
            if (frozenBefore) ++frozenValidated;
        } catch {}
    }

    function pay(uint256 seed, uint256 amount) external track {
        amount = bound(amount, 1, 10e6);
        uint256 k = seed % 10;
        address to = k < 4 ? shop : k < 9 ? address(uint160(uint256(keccak256(abi.encode("p", seed % 64))))) : canary;
        _submit(usdc, abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount));
    }

    function agentSelfUnfreeze() external track {
        _submit(address(acct), abi.encodeCall(FreezeAdmin.unfreeze, (agent)));
    }

    function setBreach(bool on) external track {
        acct.setBreach(on);
    }

    function watcherFreeze() external track {
        vm.prank(watcherAddr);
        ad.freeze(agent);
    }

    function badUnfreeze(uint8 who) external track {
        address caller = who % 3 == 0 ? watcherAddr : who % 3 == 1 ? agent : address(uint160(uint256(who) + 1000));
        vm.prank(caller);
        try ad.unfreeze(agent) {
            ++badUnfreezes;
        } catch {}
    }

    function ownerUnfreeze() external track {
        vm.prank(owner);
        ad.unfreeze(agent);
        mustBeFrozen = false;
        ++unfreezes;
    }

    function ownerSetParam(uint8 which, uint16 value) external track {
        bytes32 key = which % 3 == 0
            ? FreezeStorage.P_VELOCITY_BPS
            : which % 3 == 1 ? FreezeStorage.P_SPRAY_MAX : FreezeStorage.P_STRIKE_MAX;
        vm.prank(owner);
        ad.setFreezeParam(key, value);
    }

    function warp(uint256 dt) external track {
        vm.warp(block.timestamp + bound(dt, 1, 3 hours));
    }
}

/// I13 (EXPERIMENTS X5 additions): while an agent key is frozen, no agent op from it validates
/// until the owner unfreezes it. Fuzzed on FrzHarness (real FreezeModule + tripwires).
contract M10I13Invariant is M1Fixture {
    I13Handler internal handler;
    FrzHarness internal h;
    address internal watcherAddr;

    function setUp() public {
        _setUpFixture();
        AgentAccount impl = new FrzHarness(IEntryPoint(address(ep)), factory.accountImplementation().admin());
        AgentAccountFactory hf = new AgentAccountFactory(impl);
        h = FrzHarness(payable(address(hf.createAccount(owner, 13))));
        AgentAccountAdmin hAdmin = AgentAccountAdmin(payable(address(h)));
        _configureDemo(h, agent);
        usdc.mint(address(h), 1_000_000e6);
        vm.prank(owner);
        hAdmin.addDeposit{value: 1 ether}();
        watcherAddr = makeAddr("watcher");
        address canaryAddr = makeAddr("canary");
        vm.startPrank(owner);
        hAdmin.setWatcher(watcherAddr);
        hAdmin.setFreezeParam(FreezeStorage.canaryId(canaryAddr), 1);
        hAdmin.setGasCredit(agent, type(uint128).max);
        vm.stopPrank();
        handler =
            new I13Handler(IEntryPoint(address(ep)), h, address(usdc), address(grocery), canaryAddr, owner, watcherAddr, AGENT_PK);
        targetContract(address(handler));
    }

    function invariant_I13_frozenKeyNeverValidates() public view {
        assertEq(handler.frozenValidated(), 0);
    }

    function invariant_I13_onlyOwnerUnfreezes() public view {
        assertEq(handler.badUnfreezes(), 0);
        if (handler.mustBeFrozen()) assertTrue(AgentAccountAdmin(payable(address(h))).isFrozen(agent));
    }

    /// The account's own reason for a fresh legit op of a frozen key is FROZEN.
    function invariant_I13_checkUserOpSaysFrozen() public view {
        if (!AgentAccountAdmin(payable(address(h))).isFrozen(agent)) return;
        PackedUserOperation memory op =
            _agentOp(h, AGENT_PK, address(usdc), 0, abi.encodeWithSelector(TRANSFER, address(grocery), 1e6));
        assertEq(_reason(h, op), Reason.FROZEN);
    }
}
