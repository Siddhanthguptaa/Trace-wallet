// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// TEST-ONLY stand-in for the real AgentAccount approval path (APPS / M5 e2e while APPC's
// ApprovalModule is not wired). It speaks the real account's ABI subset that the approval service
// uses (docs/api.md 2.2 / 2.3 / 4 / 7.2) and verifies OutcomeApprovals with CORE's TypedData.sol, so
// the service, the typed data and the relay are exercised against contract code. INT runs the same
// e2e against the real AgentAccount (E2E_TARGET_MODULE).
//
// Simplifications vs the real account (by design, documented in docs/api.md section 16):
// one agent key, every (target, selector) allowed unless the owner sets a rule, only approval-lane
// agent ops are accepted, the approval nonce is consumed in the outer execution frame.

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {TypedData} from "contracts/src/lib/TypedData.sol";

interface IEntryPointLike {
    function balanceOf(address) external view returns (uint256);
}

contract StubToken {
    string public constant name = "Stub USD";
    string public constant symbol = "sUSD";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) private {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
    }
}

/// A shop that pulls `price * qty` through the allowance; the shop owner can change the price at any
/// time (the e2e "tampered" case: price +1 base unit after the owner signed).
contract StubShop {
    StubToken public immutable token;
    address public immutable shopOwner;
    uint256 public price;

    constructor(StubToken t, uint256 p) {
        token = t;
        price = p;
        shopOwner = msg.sender;
    }

    function setPrice(uint256 p) external {
        require(msg.sender == shopOwner, "owner");
        price = p;
    }

    function order(uint256 qty) external {
        token.transferFrom(msg.sender, address(this), price * qty);
    }
}

contract ApprovalAccountStub {
    // ---- real-account shapes (lib/PolicyTypes.sol)
    enum RuleOp { EQ_SELF, IN_RECIPIENTS, PAYEE, LTE, EQ }
    struct ArgRule { uint8 argIndex; RuleOp op; uint256 bound; }
    struct GasPolicy { uint32 maxCallGas; uint32 maxVerificationGas; uint32 maxPreVerificationGas; uint64 maxFeePerGas; uint128 gasCredit; }
    struct Session { address agentKey; uint48 validAfter; uint48 validUntil; bool revoked; uint32 gen; uint192 nonceKey; GasPolicy gas; }
    struct Outflow { address asset; uint256 amount; }

    uint16 constant OK = 0;
    uint16 constant TARGET = 3;
    uint16 constant RECIPIENT = 5;
    uint16 constant NO_SESSION = 13;
    uint16 constant NONCE_KEY = 14;
    uint16 constant OP_SHAPE = 15;
    uint16 constant APPROVAL = 17;
    uint8 constant TARGET_ARG = 0xFF;
    bytes4 constant EXECUTE_USER_OP = 0x8dd7712f;

    event Decision(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, address payee, uint8 tier, uint8 track, Outflow[] outflows);
    event PolicyBlocked(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, bytes reason);
    event ApprovedExecuted(bytes32 indexed approvalHash, address indexed payee, Outflow[] outflow);

    error NotEntryPoint();
    error NotOwner();
    error NotSelf();
    error CallFailed(bytes returnData);
    error OutflowAboveApproval(address asset, uint256 amount, uint256 maxAmount);

    address public immutable entryPointAddr;
    address public immutable owner;
    address public immutable agentKey;
    uint48 public immutable sessionValidUntil;
    uint192 private immutable baseNonceKey;
    address[] private _tokens;
    address[] private _spenders;
    mapping(uint256 => bool) public approvalNonceUsed;
    mapping(bytes32 => ArgRule[]) private _rules; // key = keccak(target, selector); empty = allowed, no rules
    mapping(bytes32 => bool) private _denied;

    struct Call { uint256 kind; address target; uint256 value; bytes data; bytes4 selector; address payee; }

    constructor(address ep, address owner_, address agent_, address[] memory tokens_, address[] memory spenders_, uint48 validUntil_) {
        entryPointAddr = ep;
        owner = owner_;
        agentKey = agent_;
        sessionValidUntil = validUntil_;
        baseNonceKey = (uint192(uint160(agent_)) << 32) | (uint192(0xA11CE) << 8);
        _tokens = tokens_;
        _spenders = spenders_;
    }

    receive() external payable {}

    // ---- owner setup (EOA)
    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, bytes memory r) = target.call{value: value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(r, 32), mload(r)) }
    }

    function setPayeeRule(address target, bytes4 selector, uint8 argIndex) external {
        if (msg.sender != owner) revert NotOwner();
        bytes32 k = keccak256(abi.encode(target, selector));
        delete _rules[k];
        _rules[k].push(ArgRule(argIndex, RuleOp.PAYEE, 0));
    }

    function deny(address target, bytes4 selector) external {
        if (msg.sender != owner) revert NotOwner();
        _denied[keccak256(abi.encode(target, selector))] = true;
    }

    // ---- real-account views used by the approval service
    function entryPoint() external view returns (address) { return entryPointAddr; }
    function trackedAssets() external view returns (address[] memory) { return _tokens; }
    function trackedSpenders() external view returns (address[] memory) { return _spenders; }
    function trackedNFTs() external pure returns (address[] memory a) { return a; }

    function nonceKeyOf(address key, uint8 lane) external view returns (uint192) {
        return key == agentKey ? baseNonceKey | lane : 0;
    }

    function sessionOf(address key) external view returns (uint64 sid, Session memory s) {
        if (key != agentKey) return (0, s);
        s.agentKey = key;
        s.validUntil = sessionValidUntil;
        s.nonceKey = baseNonceKey;
        s.gas = GasPolicy(500_000, 300_000, 100_000, 1 gwei, 1e15);
        return (1, s);
    }

    function ruleOf(address, address target, bytes4 selector) external view returns (bool allowed, ArgRule[] memory rules) {
        bytes32 k = keccak256(abi.encode(target, selector));
        return (!_denied[k], _rules[k]);
    }

    function domainSeparator() public view returns (bytes32) {
        return TypedData.domainSeparator(block.chainid, address(this));
    }

    /// EIP-712 digest by CORE's TypedData.sol, for any chain / account (EIP-712 vector checks).
    function approvalDigestFor(uint256 chainId, address verifyingContract, TypedData.OutcomeApproval memory a)
        external
        pure
        returns (bytes32 domainSep, bytes32 structHash, bytes32 digest)
    {
        domainSep = TypedData.domainSeparator(chainId, verifyingContract);
        structHash = TypedData.hashOutcomeApproval(a);
        digest = TypedData.digest(domainSep, structHash);
    }

    // ---- policy (subset)
    function _decodeCall(bytes calldata cd) internal view returns (uint16 r, Call memory c) {
        if (cd.length < 4 + 128 || bytes4(cd[:4]) != EXECUTE_USER_OP) return (OP_SHAPE, c);
        (c.kind, c.target, c.value, c.data) = abi.decode(cd[4:], (uint256, address, uint256, bytes));
        if (c.kind != 0) return (OP_SHAPE, c);
        if (c.data.length >= 4) c.selector = bytes4(c.data);
        else if (c.data.length != 0) return (OP_SHAPE, c);
        bytes32 k = keccak256(abi.encode(c.target, c.selector));
        if (_denied[k]) return (TARGET, c);
        ArgRule[] storage rs = _rules[k];
        for (uint256 i; i < rs.length; ++i) {
            if (rs[i].op != RuleOp.PAYEE) continue;
            if (rs[i].argIndex == TARGET_ARG) c.payee = c.target;
            else {
                uint256 at = 4 + 32 * uint256(rs[i].argIndex);
                if (c.data.length < at + 32) return (OP_SHAPE, c);
                bytes memory d = c.data;
                uint256 w;
                assembly ("memory-safe") { w := mload(add(add(d, 32), at)) }
                c.payee = address(uint160(w));
            }
        }
        return (OK, c);
    }

    function _approvalOk(Call memory c, bytes32 callDataHash, bytes memory approval)
        internal
        view
        returns (uint16 r, uint48 validUntil, TypedData.OutcomeApproval memory a, bytes32 digest)
    {
        bytes memory sig;
        (a, sig) = abi.decode(approval, (TypedData.OutcomeApproval, bytes));
        digest = TypedData.digest(domainSeparator(), TypedData.hashOutcomeApproval(a));
        if (_recover(digest, sig) != owner) return (APPROVAL, 0, a, digest);
        if (approvalNonceUsed[a.nonce] || a.account != address(this) || a.chainId != block.chainid) return (APPROVAL, 0, a, digest);
        if (a.target != c.target || a.selector != c.selector || a.payee != c.payee || a.callDataHash != callDataHash) {
            return (APPROVAL, 0, a, digest);
        }
        return (OK, a.validUntil, a, digest);
    }

    function _decodeSig(bytes calldata s) internal pure returns (uint256 role, bytes memory sig, bytes memory att, bytes memory appr) {
        if (s.length == 65) return (0, s, att, appr);
        (role, sig, att, appr) = abi.decode(s, (uint256, bytes, bytes, bytes));
    }

    function _recover(bytes32 h, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(h, v, r, s);
    }

    /// Same shape as AgentAccount.policyCheck. Without an approval the stub answers RECIPIENT
    /// ("needs the owner"), so the approval lane is the only agent path.
    function policyCheck(address key, bytes calldata callData, bytes calldata, bytes calldata approval)
        external
        view
        returns (uint16 reason, uint8 tier, uint8 track, uint48 validUntil)
    {
        if (key != agentKey) return (NO_SESSION, 0, 0, 0);
        Call memory c;
        (reason, c) = _decodeCall(callData);
        if (reason != OK) return (reason, 0, 0, 0);
        if (approval.length == 0) return (RECIPIENT, 2, 0, 0);
        (reason, validUntil,,) = _approvalOk(c, keccak256(callData), approval);
        return (reason, 2, 2, validUntil < sessionValidUntil ? validUntil : sessionValidUntil);
    }

    function _validate(PackedUserOperation calldata op, bytes32 opHash) internal view returns (uint16 reason, uint48 until) {
        (uint256 role, bytes memory sig, , bytes memory appr) = _decodeSig(op.signature);
        if (role == 0) return (_recover(opHash, sig) == owner ? OK : NO_SESSION, 0);
        if (role != 1 || _recover(opHash, sig) != agentKey) return (NO_SESSION, 0);
        if (appr.length == 0) return (RECIPIENT, 0);
        if (uint192(op.nonce >> 64) != (baseNonceKey | 1)) return (NONCE_KEY, 0);
        Call memory c;
        (reason, c) = _decodeCall(op.callData);
        if (reason != OK) return (reason, 0);
        (reason, until,,) = _approvalOk(c, keccak256(op.callData), appr);
        if (until > sessionValidUntil) until = sessionValidUntil;
    }

    function checkUserOp(PackedUserOperation calldata op, bytes32 opHash) external view returns (uint16 reason, uint48 validAfter, uint48 validUntil) {
        (reason, validUntil) = _validate(op, opHash);
        return (reason, 0, validUntil);
    }

    // ---- ERC-4337
    function validateUserOp(PackedUserOperation calldata op, bytes32 opHash, uint256 missingFunds) external returns (uint256) {
        if (msg.sender != entryPointAddr) revert NotEntryPoint();
        (uint16 reason, uint48 until) = _validate(op, opHash);
        if (missingFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingFunds}("");
            ok;
        }
        if (reason != OK) return 1;
        return uint256(until) << 160;
    }

    function executeUserOp(PackedUserOperation calldata op, bytes32 opHash) external {
        if (msg.sender != entryPointAddr) revert NotEntryPoint();
        (uint256 role,,, bytes memory appr) = _decodeSig(op.signature);
        (, Call memory c) = _decodeCall(op.callData);
        if (role == 0) {
            (bool ok, bytes memory r) = c.target.call{value: c.value}(c.data);
            if (!ok) assembly ("memory-safe") { revert(add(r, 32), mload(r)) }
            return;
        }
        (uint16 reason,, TypedData.OutcomeApproval memory a, bytes32 digest) = _approvalOk(c, keccak256(op.callData), appr);
        if (reason != OK) {
            emit PolicyBlocked(opHash, agentKey, c.target, c.selector, abi.encodeWithSignature("PolicyViolation(uint16)", reason));
            return;
        }
        approvalNonceUsed[a.nonce] = true; // consumed even if the inner frame is blocked (stub choice)
        try this.inner(c.target, c.value, c.data, a.maxOutflow) returns (Outflow[] memory outs) {
            emit Decision(opHash, agentKey, c.target, c.selector, c.payee, 2, 2, outs);
            emit ApprovedExecuted(digest, c.payee, outs);
        } catch (bytes memory err) {
            if (bytes4(err) == CallFailed.selector) {
                assembly ("memory-safe") { revert(add(err, 0x64), mload(add(err, 0x44))) }
            }
            emit PolicyBlocked(opHash, agentKey, c.target, c.selector, err);
        }
    }

    /// Sandbox inner frame: call, measure (balance drop + allowance growth of tracked spenders), cap.
    function inner(address target, uint256 value, bytes calldata data, TypedData.AssetAmount[] calldata maxOut)
        external
        returns (Outflow[] memory outs)
    {
        if (msg.sender != address(this)) revert NotSelf();
        uint256 n = _tokens.length;
        uint256[] memory beforeV = _measure();
        (bool ok, bytes memory r) = target.call{value: value}(data);
        if (!ok) revert CallFailed(r);
        uint256[] memory afterV = _measure();
        outs = new Outflow[](n + 1);
        for (uint256 i; i <= n; ++i) {
            address asset = i < n ? _tokens[i] : address(0);
            uint256 out;
            if (i < n) {
                out = beforeV[i] > afterV[i] ? beforeV[i] - afterV[i] : 0;
                for (uint256 j; j < _spenders.length; ++j) {
                    uint256 k = n + 1 + i * _spenders.length + j;
                    if (afterV[k] > beforeV[k]) out += afterV[k] - beforeV[k];
                }
            } else {
                out = beforeV[n] > afterV[n] ? beforeV[n] - afterV[n] : 0;
            }
            uint256 cap;
            for (uint256 m; m < maxOut.length; ++m) if (maxOut[m].asset == asset) cap = maxOut[m].amount;
            if (out > cap) revert OutflowAboveApproval(asset, out, cap);
            outs[i] = Outflow(asset, out);
        }
    }

    /// [token balances..., native (+deposit), allowances (token x spender)...]
    function _measure() internal view returns (uint256[] memory v) {
        uint256 n = _tokens.length;
        uint256 s = _spenders.length;
        v = new uint256[](n + 1 + n * s);
        for (uint256 i; i < n; ++i) {
            v[i] = StubToken(_tokens[i]).balanceOf(address(this));
            for (uint256 j; j < s; ++j) v[n + 1 + i * s + j] = StubToken(_tokens[i]).allowance(address(this), _spenders[j]);
        }
        v[n] = address(this).balance + IEntryPointLike(entryPointAddr).balanceOf(address(this));
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}
