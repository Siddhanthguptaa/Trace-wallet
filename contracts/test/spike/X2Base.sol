// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {NaiveAccount} from "../../src/baselines/NaiveAccount.sol";
import {OneDoorSpike} from "./OneDoorSpike.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
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
    Session,
    SIG1271_OWNER_PLUS_X402_VOUCHER
} from "../../src/lib/PolicyTypes.sol";

/// Minimal EIP-3009 surface shared by real USDC (FiatTokenV2_2) and MockUSDC3009.
interface IUSDC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function balanceOf(address account) external view returns (uint256);
    function version() external view returns (string memory);
}

/// @title X2Base: the ERC-1271 side-door spike (EXPERIMENTS.md X2, IDEA D1)
/// @notice A leaked agent key signs an EIP-3009 TransferWithAuthorization(from = account,
///         to = attacker, value = 100 USDC) and the attacker submits it straight to the token's
///         `bytes signature` overload. The token asks the account through ERC-1271, so no
///         EntryPoint and no UserOp is involved. Subclasses pick the chain (fork or local).
abstract contract X2Base is Test {
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// EntryPoint v0.8 UserOperationEvent. Counted over the whole attack window.
    bytes32 internal constant USER_OPERATION_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    uint256 internal constant AUTH_VALUE = 100e6; // 100 USDC, 6 decimals

    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xA6E47;

    address internal owner;
    address internal agent;
    address internal attacker;
    address internal shop;

    struct Outcome {
        uint256 lost;
        bytes4 sigResult;
        uint256 balanceBefore;
        uint256 balanceAfter;
        bool reverted;
    }

    function _token() internal view virtual returns (IUSDC3009);
    function _fund(address to, uint256 amount) internal virtual;
    function _fundedVia() internal view virtual returns (string memory);
    function _chainMode() internal pure virtual returns (string memory);
    function _forkBlock() internal view virtual returns (uint256);
    function _resultPath() internal pure virtual returns (string memory);

    /// EntryPoint the AgentAccount is bound to (local: a fresh v0.8; fork: the canonical one).
    function _entryPoint() internal virtual returns (IEntryPoint) {
        return IEntryPoint(address(new EntryPoint()));
    }

    /// A real AgentAccount (factory clone) whose agent key is LIVE: policy = USDC transfer to the
    /// shop only, 10 USDC per tx, 20 USDC/24 h. The leaked key is a working session key, not a stranger.
    function _newAgentAccount(uint256 salt, uint8 mode) internal returns (AgentAccount a) {
        IEntryPoint ep = _entryPoint();
        AgentAccountAdmin adminLogic = new AgentAccountAdmin(ep);
        AgentAccountFactory f = new AgentAccountFactory(new AgentAccount(ep, address(adminLogic)));
        a = f.createAccount(owner, salt);
        AgentAccountAdmin ad = AgentAccountAdmin(payable(address(a)));
        address token = address(_token());
        PolicyInput memory p;
        p.validAfter = uint48(block.timestamp - 1);
        p.validUntil = uint48(block.timestamp + 6 days);
        p.gas = GasPolicy(500_000, 300_000, 100_000, 1 gwei, 1e15);
        p.assets = new AssetInput[](1);
        p.assets[0] = AssetInput(token, 10e6, 10e6, 10e6);
        p.calls = new CallRuleInput[](1);
        ArgRule[] memory r = new ArgRule[](1);
        r[0] = ArgRule(0, RuleOp.IN_RECIPIENTS, 0);
        p.calls[0] = CallRuleInput(token, TRANSFER_SELECTOR, r);
        vm.startPrank(owner);
        ad.setGlobalCap(token, 10e6, 10e6);
        ad.setRecipient(shop, true);
        ad.setPolicy(agent, p);
        if (mode != 0) ad.setSig1271Mode(mode);
        vm.stopPrank();
        (uint64 sid, Session memory se) = ad.sessionOf(agent);
        require(sid != 0 && se.agentKey == agent && !se.revoked, "X2: agent key must be live");
    }

    bytes4 internal constant TRANSFER_SELECTOR = 0xa9059cbb;

    function _setUpActors() internal {
        owner = vm.addr(OWNER_PK);
        agent = vm.addr(AGENT_PK);
        attacker = makeAddr("attacker");
        shop = makeAddr("shop");
    }

    function _digest(address from, address to, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, uint256(0), validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", _token().DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sideDoor(address account, bytes32 nonce) internal returns (Outcome memory o) {
        IUSDC3009 t = _token();
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 digest = _digest(account, attacker, AUTH_VALUE, validBefore, nonce);
        bytes memory sig = _sign(AGENT_PK, digest);

        o.sigResult = IERC1271(account).isValidSignature(digest, sig);
        uint256 attackerBefore = t.balanceOf(attacker);
        o.balanceBefore = t.balanceOf(account);
        vm.prank(attacker);
        try t.transferWithAuthorization(account, attacker, AUTH_VALUE, 0, validBefore, nonce, sig) {}
        catch {
            o.reverted = true;
        }
        o.balanceAfter = t.balanceOf(account);
        o.lost = t.balanceOf(attacker) - attackerBefore;
    }

    function _countUserOps(Vm.Log[] memory logs) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == USER_OPERATION_EVENT) ++n;
        }
    }

    /// Main X2 run. Writes the result file first, then asserts the design target [X2].
    /// `oneDoor` = the real AgentAccount in its default OWNER_ONLY 1271 mode; `oneDoorVoucherMode` =
    /// the same account in OWNER_PLUS_X402_VOUCHER mode with no voucher registered for this nonce.
    function _runX2() internal {
        NaiveAccount naive = new NaiveAccount(owner, agent);
        AgentAccount oneDoor = _newAgentAccount(0, 0);
        AgentAccount voucherMode = _newAgentAccount(1, SIG1271_OWNER_PLUS_X402_VOUCHER);
        _fund(address(naive), AUTH_VALUE);
        _fund(address(oneDoor), AUTH_VALUE);
        _fund(address(voucherMode), AUTH_VALUE);

        vm.recordLogs();
        Outcome memory n = _sideDoor(address(naive), keccak256("x2/naive"));
        Outcome memory d = _sideDoor(address(oneDoor), keccak256("x2/oneDoor"));
        Outcome memory v = _sideDoor(address(voucherMode), keccak256("x2/voucherMode"));
        uint256 userOps = _countUserOps(vm.getRecordedLogs());

        _write(n, d, v, userOps);

        assertEq(n.sigResult, ERC1271_MAGIC, "naive: 1271 accepts the agent key");
        assertEq(n.lost, AUTH_VALUE, "naive: whole authorization lost");
        assertEq(d.sigResult, ERC1271_INVALID, "one door: 1271 refuses the agent key");
        assertTrue(d.reverted, "one door: token rejects the authorization");
        assertEq(d.lost, 0, "one door: nothing lost");
        assertEq(v.sigResult, ERC1271_INVALID, "voucher mode: unregistered voucher refused");
        assertTrue(v.reverted, "voucher mode: token rejects the authorization");
        assertEq(v.lost, 0, "voucher mode: nothing lost");
        assertEq(userOps, 0, "no UserOp ran");
    }

    /// Control: the one door still opens for the owner key.
    function _runOwnerControl() internal {
        OneDoorSpike oneDoor = new OneDoorSpike(owner);
        _fund(address(oneDoor), AUTH_VALUE);
        IUSDC3009 t = _token();
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("x2/ownerControl");
        bytes32 digest = _digest(address(oneDoor), shop, AUTH_VALUE, validBefore, nonce);
        bytes memory sig = _sign(OWNER_PK, digest);

        assertEq(IERC1271(address(oneDoor)).isValidSignature(digest, sig), ERC1271_MAGIC);
        uint256 shopBefore = t.balanceOf(shop);
        t.transferWithAuthorization(address(oneDoor), shop, AUTH_VALUE, 0, validBefore, nonce, sig);
        assertEq(t.balanceOf(shop) - shopBefore, AUTH_VALUE);
        assertTrue(t.authorizationState(address(oneDoor), nonce));
    }

    function _outcomeJson(string memory key, string memory name, Outcome memory o) internal returns (string memory) {
        vm.serializeString(key, "contract", name);
        vm.serializeUint(key, "balanceBefore", o.balanceBefore);
        vm.serializeUint(key, "balanceAfter", o.balanceAfter);
        vm.serializeBool(key, "attackReverted", o.reverted);
        vm.serializeString(key, "isValidSignature", vm.toString(abi.encodePacked(o.sigResult)));
        return vm.serializeUint(key, "lostBaseUnits", o.lost);
    }

    function _write(Outcome memory n, Outcome memory d, Outcome memory v, uint256 userOps) internal {
        string memory root = string.concat("x2.", _chainMode());
        string memory nj = _outcomeJson(string.concat(root, ".naive"), "NaiveAccount", n);
        vm.serializeString(string.concat(root, ".oneDoor"), "sig1271Mode", "OWNER_ONLY");
        string memory dj = _outcomeJson(string.concat(root, ".oneDoor"), "AgentAccount", d);
        vm.serializeString(string.concat(root, ".voucherMode"), "sig1271Mode", "OWNER_PLUS_X402_VOUCHER");
        string memory vj = _outcomeJson(string.concat(root, ".voucherMode"), "AgentAccount", v);
        vm.serializeString(root, "chainMode", _chainMode());
        vm.serializeUint(root, "forkBlock", _forkBlock());
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "asset", "USDC");
        vm.serializeAddress(root, "token", address(_token()));
        vm.serializeString(root, "tokenVersion", _token().version());
        vm.serializeString(root, "fundedVia", _fundedVia());
        vm.serializeBool(root, "agentKeyLive", true);
        vm.serializeUint(root, "authValue", AUTH_VALUE);
        vm.serializeString(root, "naive", nj);
        vm.serializeString(root, "oneDoor", dj);
        vm.serializeString(root, "oneDoorVoucherMode", vj);
        string memory out = vm.serializeUint(root, "userOps", userOps);
        vm.writeJson(out, _resultPath());
    }
}
