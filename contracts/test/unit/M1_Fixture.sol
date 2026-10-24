// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {
    PolicyInput,
    AssetInput,
    CallRuleInput,
    ArgRule,
    RuleOp,
    GasPolicy,
    NATIVE,
    LANE_NORMAL,
    LANE_APPROVAL
} from "../../src/lib/PolicyTypes.sol";
import {MockUSDC3009} from "../../src/mocks/MockUSDC3009.sol";
import {TicketNFT} from "../../src/mocks/TicketNFT.sol";
import {GroceryMerchant} from "../../src/mocks/GroceryMerchant.sol";
import {ApiSeller} from "../../src/mocks/ApiSeller.sol";
import {NaiveAccount} from "../../src/baselines/NaiveAccount.sol";

/// @title M1Fixture: shared test fixture (CORE-owned; other lanes may import it read-only).
/// @notice Local EntryPoint v0.8, the factory, the M0 mocks, one AgentAccount configured with the
///         announced demo policy (BUILD.md "Demo policy", docs/api.md section 11), and UserOp
///         helpers that go through the real EntryPoint `handleOps`.
abstract contract M1Fixture is Test {
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f;
    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant BUY = TicketNFT.buy.selector;
    bytes4 internal constant ORDER = GroceryMerchant.order.selector;

    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xA6E47;
    uint256 internal constant AGENT2_PK = 0xA6E48;
    uint256 internal constant ATTESTOR_PK = 0xA77E5;
    uint256 internal constant STRANGER_PK = 0xBAD;

    // Demo policy (USDC, 6 decimals).
    uint128 internal constant CAP_BURST = 10e6;
    uint128 internal constant CAP_RATE = 10e6;
    uint128 internal constant PER_TX = 10e6;
    uint256 internal constant TICKET_PRICE = 2e6;
    uint256 internal constant API_PRICE = 1e5;
    uint128 internal constant GAS_CREDIT = 1e15; // 0.001 ETH
    uint32 internal constant MAX_CALL_GAS = 500_000;
    uint32 internal constant MAX_VERIF_GAS = 300_000;
    uint32 internal constant MAX_PVG = 100_000;
    uint64 internal constant MAX_FEE = 1 gwei;
    uint256 internal constant POLICY_DAYS = 6 days;

    // Default UserOp gas (well inside the caps; 0.01 gwei fee like Base).
    uint256 internal constant OP_VERIF_GAS = 250_000;
    uint256 internal constant OP_CALL_GAS = 300_000;
    uint256 internal constant OP_PVG = 50_000;
    uint256 internal constant OP_FEE = 0.01 gwei;

    EntryPoint internal ep;
    AgentAccountFactory internal factory;
    AgentAccount internal acct;
    AgentAccountAdmin internal admin; // = the account address, admin ABI
    MockUSDC3009 internal usdc;
    TicketNFT internal ticket;
    GroceryMerchant internal grocery;
    ApiSeller internal api;

    address internal owner;
    address internal agent;
    address internal agent2;
    address internal attestorAddr;
    address internal stranger;
    address internal attacker;
    address payable internal bundler;
    address internal ticketTreasury;
    address internal groceryTreasury;

    function _setUpFixture() internal {
        vm.warp(1_800_000_000);
        owner = vm.addr(OWNER_PK);
        agent = vm.addr(AGENT_PK);
        agent2 = vm.addr(AGENT2_PK);
        attestorAddr = vm.addr(ATTESTOR_PK);
        stranger = vm.addr(STRANGER_PK);
        attacker = makeAddr("attacker");
        bundler = payable(makeAddr("bundler"));
        ticketTreasury = makeAddr("ticketTreasury");
        groceryTreasury = makeAddr("groceryTreasury");

        ep = new EntryPoint();
        factory = _deployFactory(IEntryPoint(address(ep)));
        usdc = new MockUSDC3009();
        ticket = new TicketNFT(IERC20(address(usdc)), TICKET_PRICE, ticketTreasury);
        grocery = new GroceryMerchant(IERC20(address(usdc)), groceryTreasury);
        api = new ApiSeller(address(usdc), API_PRICE, makeAddr("apiOwner"));

        acct = factory.createAccount(owner, 0);
        admin = AgentAccountAdmin(payable(address(acct)));
        _configureDemo(acct, agent);

        usdc.mint(address(acct), 100e6);
        vm.deal(address(acct), 1 ether);
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        admin.addDeposit{value: 1 ether}();
    }

    /// Deploy order: AgentAccountAdmin, AgentAccount implementation, AgentAccountFactory.
    function _deployFactory(IEntryPoint entryPoint_) internal returns (AgentAccountFactory) {
        AgentAccountAdmin adminLogic = new AgentAccountAdmin(entryPoint_);
        AgentAccount impl = new AgentAccount(entryPoint_, address(adminLogic));
        return new AgentAccountFactory(impl);
    }

    /// Owner config of the demo policy on `a` for session key `key`.
    function _configureDemo(AgentAccount a, address key) internal {
        AgentAccountAdmin ad = AgentAccountAdmin(payable(address(a)));
        vm.startPrank(owner);
        ad.setGlobalCap(address(usdc), CAP_BURST, CAP_RATE);
        ad.setRecipient(address(api), true);
        ad.setRecipient(address(ticket), true);
        ad.setRecipient(address(grocery), true);
        address[] memory spenders = new address[](2);
        spenders[0] = address(ticket);
        spenders[1] = address(grocery);
        ad.setTrackedSpenders(spenders);
        address[] memory nfts = new address[](1);
        nfts[0] = address(ticket);
        ad.setTrackedNFTs(nfts);
        ad.setPolicy(key, _demoPolicy());
        vm.stopPrank();
    }

    function _gas() internal pure returns (GasPolicy memory) {
        return GasPolicy(MAX_CALL_GAS, MAX_VERIF_GAS, MAX_PVG, MAX_FEE, GAS_CREDIT);
    }

    function _rule(uint8 argIndex, RuleOp op, uint256 bound) internal pure returns (ArgRule memory) {
        return ArgRule(argIndex, op, bound);
    }

    /// The R3 demo policy (docs/api.md section 11).
    function _demoPolicy() internal view returns (PolicyInput memory p) {
        p.validAfter = uint48(block.timestamp - 1); // EntryPoint v0.8: valid iff now > validAfter
        p.validUntil = uint48(block.timestamp + POLICY_DAYS);
        p.gas = _gas();
        p.assets = new AssetInput[](1);
        p.assets[0] = AssetInput(address(usdc), PER_TX, CAP_BURST, CAP_RATE);
        p.calls = new CallRuleInput[](5);
        ArgRule[] memory r;
        r = new ArgRule[](1);
        r[0] = _rule(0, RuleOp.PAYEE, 0);
        p.calls[0] = CallRuleInput(address(usdc), TRANSFER, r);
        r = new ArgRule[](2);
        r[0] = _rule(0, RuleOp.IN_RECIPIENTS, 0);
        r[1] = _rule(1, RuleOp.LTE, PER_TX);
        p.calls[1] = CallRuleInput(address(usdc), APPROVE, r);
        r = new ArgRule[](1);
        r[0] = _rule(1, RuleOp.EQ_SELF, 0);
        p.calls[2] = CallRuleInput(address(ticket), BUY, r);
        r = new ArgRule[](1);
        r[0] = _rule(0, RuleOp.IN_RECIPIENTS, 0);
        p.calls[3] = CallRuleInput(address(ticket), SET_APPROVAL_FOR_ALL, r);
        r = new ArgRule[](2);
        r[0] = _rule(0, RuleOp.LTE, PER_TX);
        r[1] = _rule(1, RuleOp.EQ_SELF, 0);
        p.calls[4] = CallRuleInput(address(grocery), ORDER, r);
    }

    // ---------------------------------------------------------------- R2 baseline

    uint256 internal constant R2_DAILY_CAP = 20e6;

    /// R2 (docs/api.md section 10): same (target, selector) pairs as R3 without argument rules,
    /// static recipients = the 3 shops, perTxCap 10 USDC, calendar-day cap 20 USDC. Funded like R3.
    function _deployR2(address key) internal returns (NaiveAccount n) {
        n = new NaiveAccount(owner, key);
        NaiveAccount.R2Config memory c;
        c.targets = new address[](5);
        c.selectors = new bytes4[](5);
        (c.targets[0], c.selectors[0]) = (address(usdc), TRANSFER);
        (c.targets[1], c.selectors[1]) = (address(usdc), APPROVE);
        (c.targets[2], c.selectors[2]) = (address(ticket), BUY);
        (c.targets[3], c.selectors[3]) = (address(ticket), SET_APPROVAL_FOR_ALL);
        (c.targets[4], c.selectors[4]) = (address(grocery), ORDER);
        c.recipients = new address[](3);
        (c.recipients[0], c.recipients[1], c.recipients[2]) = (address(api), address(ticket), address(grocery));
        c.tokens = new address[](1);
        c.tokens[0] = address(usdc);
        c.perTxCaps = new uint256[](1);
        c.perTxCaps[0] = PER_TX;
        c.dailyCaps = new uint256[](1);
        c.dailyCaps[0] = R2_DAILY_CAP;
        vm.prank(owner);
        n.configure(IEntryPoint(address(ep)), c);
        usdc.mint(address(n), 100e6);
        vm.deal(address(n), 1 ether);
        vm.deal(address(this), address(this).balance + 1 ether);
        n.addDeposit{value: 1 ether}();
    }

    function _r2Op(NaiveAccount n, uint256 pk, address target, uint256 value, bytes memory data)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes memory cd = abi.encodeCall(NaiveAccount.executeAgent, (target, value, data));
        op = _op(address(n), ep.getNonce(address(n), 0), cd);
        op.signature = _sign65(pk, ep.getUserOpHash(op));
    }

    // ---------------------------------------------------------------- UserOp helpers

    function _agentCall(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(EXECUTE_USER_OP, abi.encode(uint8(0), target, value, data));
    }

    function _agentOpKind(uint8 kind, address target, uint256 value, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(EXECUTE_USER_OP, abi.encode(kind, target, value, data));
    }

    function _packGas(uint256 high, uint256 low) internal pure returns (bytes32) {
        return bytes32((high << 128) | low);
    }

    function _op(address sender, uint256 nonce, bytes memory callData)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = nonce;
        op.callData = callData;
        op.accountGasLimits = _packGas(OP_VERIF_GAS, OP_CALL_GAS);
        op.preVerificationGas = OP_PVG;
        op.gasFees = _packGas(OP_FEE, OP_FEE);
    }

    function _nonceKey(AgentAccount a, address key, uint8 lane) internal view returns (uint192) {
        return AgentAccountAdmin(payable(address(a))).nonceKeyOf(key, lane);
    }

    function _agentNonce(AgentAccount a, address key) internal view returns (uint256) {
        return ep.getNonce(address(a), _nonceKey(a, key, LANE_NORMAL));
    }

    function _sign65(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signAgentWith(PackedUserOperation memory op, uint256 pk, bytes memory att, bytes memory appr)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes32 h = ep.getUserOpHash(op);
        op.signature = abi.encode(uint8(1), _sign65(pk, h), att, appr);
        return op;
    }

    function _signAgent(PackedUserOperation memory op, uint256 pk) internal view returns (PackedUserOperation memory) {
        return _signAgentWith(op, pk, "", "");
    }

    function _signOwner(PackedUserOperation memory op, uint256 pk) internal view returns (PackedUserOperation memory) {
        op.signature = _sign65(pk, ep.getUserOpHash(op));
        return op;
    }

    /// Agent op from `pk` on `a` with the next lane-0 nonce.
    function _agentOp(AgentAccount a, uint256 pk, address target, uint256 value, bytes memory data)
        internal
        view
        returns (PackedUserOperation memory)
    {
        return _signAgent(_op(address(a), _agentNonce(a, vm.addr(pk)), _agentCall(target, value, data)), pk);
    }

    function _ownerExecOp(AgentAccount a, address target, uint256 value, bytes memory data)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes memory cd = abi.encodeWithSelector(acct.execute.selector, target, value, data);
        return _signOwner(_op(address(a), ep.getNonce(address(a), 0), cd), OWNER_PK);
    }

    function _one(PackedUserOperation memory op) internal pure returns (PackedUserOperation[] memory ops) {
        ops = new PackedUserOperation[](1);
        ops[0] = op;
    }

    /// handleOps on one op; returns the UserOperationEvent success flag (reverts on validation failure).
    function _handle(PackedUserOperation memory op) internal returns (bool success) {
        return _handleMany(_one(op))[0];
    }

    function _handleMany(PackedUserOperation[] memory ops) internal returns (bool[] memory successes) {
        vm.recordLogs();
        ep.handleOps(ops, bundler);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        successes = new bool[](ops.length);
        uint256 k;
        bytes32 topic = IEntryPoint.UserOperationEvent.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ep) && logs[i].topics[0] == topic) {
                (, bool ok,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                successes[k++] = ok;
            }
        }
        require(k == ops.length, "fixture: missing UserOperationEvent");
    }

    /// Expect validation to refuse the op: EntryPoint FailedOp(0, "AA24 signature error").
    function _expectAA24(PackedUserOperation memory op) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        ep.handleOps(_one(op), bundler);
    }

    function _expectFailedOp(PackedUserOperation memory op, string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
        ep.handleOps(_one(op), bundler);
    }

    /// The account's own reason for the op (checkUserOp view).
    function _reason(AgentAccount a, PackedUserOperation memory op) internal view returns (uint16 reason) {
        (reason,,) = a.checkUserOp(op, ep.getUserOpHash(op));
    }
}
