// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgentAccountBase} from "../AgentAccountBase.sol";
import {AccountStorage} from "../lib/AccountStorage.sol";
import {PolicyCheck} from "../lib/PolicyCheck.sol";
import {ArgRules} from "../lib/ArgRules.sol";
import {
    AgentCall,
    OpContext,
    OpKind,
    Reason,
    RuleSet,
    Session,
    Track,
    Voucher,
    VoucherState,
    ERC1271_MAGIC,
    ERC1271_INVALID,
    SIG1271_OWNER_PLUS_X402_VOUCHER
} from "../lib/PolicyTypes.sol";

/// EIP-3009 surface the one door needs from the voucher token (USDC FiatTokenV2_2, MockUSDC3009).
interface IERC3009Token {
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @title OneDoorModule (D1, lane D1 / M3): ERC-1271 one door + pre-paid x402 vouchers.
/// @notice IDEA D1, docs/api.md sections 3.3, 4.1, 4.6. Thin hook layer; the logic lives in the
///         external library `OneDoorLib` below (EIP-170: the core's byte budget for D1 is 2.0 KB),
///         reached by DELEGATECALL, so it runs on the account's storage and `address(this)` is the
///         account. forge test / forge script link it automatically; viem deploys must deploy
///         OneDoorLib and replace its placeholder in the AgentAccount bytecode.
///   - `isValidSignature` (the core refuses everything while an agent op executes, I3):
///     owner signature -> magic. OWNER_ONLY (default): anything else -> 0xffffffff.
///     OWNER_PLUS_X402_VOUCHER: also the envelope
///     abi.encode(uint8 MODE_X402 = 1, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes agentSig)
///     iff the voucher `nonce` is Registered with exactly these fields, the rebuilt EIP-3009
///     TransferWithAuthorization(from = this, ...) digest in the voucher token's domain equals `hash`,
///     and `agentSig` (over `hash`) recovers the voucher session's current key, which is live
///     (not revoked, not frozen, inside its validAfter / validUntil).
///   - REGISTER_VOUCHER agent op (kind 1, target = token, value = 0,
///     data = abi.encode(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)):
///     a voucher is a deferred `token.transfer(to, value)`, so it must pass that key's
///     (token, transfer) rule and its argument rules (PAYEE -> D3 tier, IN_RECIPIENTS, EQ, LTE);
///     the core then runs the tier hook and the per-tx cap, and in execution debits `value`
///     through `_meterDebitDeclared` (key + global, + exploration on the EXPLORE track).
///     Execution also bounds validBefore to (now, now + VOUCHER_MAX_TTL], so settlement trails the
///     debit by at most VOUCHER_MAX_TTL. State: None -> Registered -> Used | Reclaimed (I4).
///   - `reclaim(nonce)` (anyone): token says the authorization is used (or cancelled) -> Used, no
///     credit; else, once `now >= validBefore` (the token refuses it from then on) -> Reclaimed and
///     `value` credited back once through `_meterCredit`.
abstract contract OneDoorModule is AgentAccountBase {
    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.onedoor")) - 1)) & ~bytes32(uint256(0xff))
    // Reserved namespace (erc7201:hypnexis.AgentAccount.onedoor); vouchers live in AccountStorage.vouchers (IDEA 7.1).
    bytes32 internal constant ONEDOOR_SLOT = 0xd5016249e50e970ecf897ca25846607d42a56b9e88833c1dd505575f59184f00;

    // Declared here for the account ABI; emitted / thrown by OneDoorLib (same signatures).
    event VoucherRegistered(
        bytes32 indexed nonce, address indexed token, address indexed to, uint256 value, uint256 validBefore
    );
    event VoucherUsed(bytes32 indexed nonce);
    event VoucherReclaimed(bytes32 indexed nonce, uint256 value);

    /// reclaim: the voucher is not Registered, or it is unused and still settleable (now < validBefore).
    error VoucherNotReclaimable(bytes32 nonce);

    function _door1271(bytes32 hash, bytes calldata signature) internal view virtual override returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && signer != address(0) && signer == _l().owner) return ERC1271_MAGIC;
        OpContext memory ctx;
        (ctx.agentKey, ctx.sessionId) = OneDoorLib.envelopeSigner(hash, signature);
        if (ctx.agentKey != address(0) && _freezeReason(ctx) == Reason.OK) return ERC1271_MAGIC;
        return ERC1271_INVALID;
    }

    function _doorDecodeOp(OpContext memory ctx, AgentCall memory call)
        internal
        view
        virtual
        override
        returns (uint16 reason)
    {
        (reason, call.hasPayee) = OneDoorLib.decodeVoucher(ctx.sessionId, call.target, call.value, call.data);
        if (reason == Reason.OK) {
            (call.payee, call.payAmount) = abi.decode(call.data, (address, uint256));
            call.payAsset = call.target;
        }
    }

    function _doorExecuteOp(OpContext memory ctx, AgentCall memory call) internal virtual override {
        OneDoorLib.register(ctx.sessionId, ctx.track, call.target, call.data);
    }

    /// Close a Registered voucher: Used if the token reports the authorization used (or cancelled),
    /// else (only once it can no longer settle) Reclaimed with one credit of `value`. Anyone may call.
    function reclaim(bytes32 nonce) external {
        (uint64 sid, Track track, address token, uint256 value) = OneDoorLib.close(nonce);
        if (value != 0) _meterCredit(sid, track, token, value);
    }
}

/// @title OneDoorLib: the D1 logic, an EXTERNAL linked library (EIP-170 budget).
/// @notice Reached only by DELEGATECALL from the account, so `address(this)` is the account and
///         storage is the account's AccountStorage. Validation-path functions never read TIMESTAMP.
library OneDoorLib {
    /// Envelope tag (first word of the 1271 signature) for an x402 voucher.
    uint256 internal constant MODE_X402 = 1;
    /// Max voucher lifetime at registration (seconds): validBefore <= registration time + this.
    uint256 internal constant VOUCHER_MAX_TTL = 600;
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    event VoucherRegistered(
        bytes32 indexed nonce, address indexed token, address indexed to, uint256 value, uint256 validBefore
    );
    event VoucherUsed(bytes32 indexed nonce);
    event VoucherReclaimed(bytes32 indexed nonce, uint256 value);

    error VoucherNotReclaimable(bytes32 nonce);
    error PolicyViolation(uint16 reason); // same selector as AccountCommon.PolicyViolation

    // ---------------------------------------------------------------- ERC-1271 envelope (docs/api.md 4.6)

    /// The voucher session's current key and session id if the envelope passes every check except
    /// the freeze check (done by the account's FreezeModule hook); (0, 0) otherwise. 1271 is not
    /// validation, so TIMESTAMP is fine here. May revert on a malformed envelope (= refused).
    function envelopeSigner(bytes32 hash, bytes calldata e) external view returns (address key, uint64 sid) {
        AccountStorage.Layout storage l = AccountStorage.layout();
        if (l.sig1271Mode != SIG1271_OWNER_PLUS_X402_VOUCHER || e.length <= 224) return (address(0), 0);
        if (uint256(bytes32(e[:32])) != MODE_X402) return (address(0), 0);
        bytes32 nonce = bytes32(e[160:192]);
        Voucher storage v = l.vouchers[nonce];
        if (v.state != VoucherState.Registered) return (address(0), 0);
        // Envelope words (to, value, validAfter, validBefore, nonce) == the Registered voucher.
        bytes memory fields = abi.encode(v.to, v.value, v.validAfter, v.validBefore, nonce);
        if (keccak256(e[32:192]) != keccak256(fields)) return (address(0), 0);
        // Rebuilt EIP-3009 digest with from = this (the account), in the voucher token's domain, == hash.
        bytes32 structHash =
            keccak256(abi.encodePacked(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, uint256(uint160(address(this))), fields));
        if (keccak256(abi.encodePacked(hex"1901", IERC3009Token(v.token).DOMAIN_SEPARATOR(), structHash)) != hash) {
            return (address(0), 0);
        }
        (,,,,,, bytes memory agentSig) = abi.decode(e, (uint256, address, uint256, uint256, uint256, bytes32, bytes));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, agentSig);
        sid = v.sessionId;
        Session storage s = l.sessions[sid];
        if (
            err != ECDSA.RecoverError.NoError || l.keyToSession[signer] != sid || s.revoked
                || block.timestamp <= s.validAfter || block.timestamp > s.validUntil
        ) return (address(0), 0);
        return (signer, sid);
    }

    // ---------------------------------------------------------------- REGISTER_VOUCHER agent op

    /// Validation + execution re-check (view, no TIMESTAMP). reason OK iff voucher mode is on, the
    /// body is well formed, the nonce was never registered, and the key's (token, transfer) rule
    /// with all its argument rules allows `token.transfer(to, value)`. hasPayee = a PAYEE rule matched.
    function decodeVoucher(uint64 sid, address token, uint256 callValue, bytes calldata data)
        external
        view
        returns (uint16 reason, bool hasPayee)
    {
        AccountStorage.Layout storage l = AccountStorage.layout();
        if (l.sig1271Mode != SIG1271_OWNER_PLUS_X402_VOUCHER || callValue != 0 || data.length != 160) {
            return (Reason.OP_SHAPE, false);
        }
        (uint256 toWord, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce) =
            abi.decode(data, (uint256, uint256, uint256, uint256, bytes32));
        if (
            toWord >> 160 != 0 || value == 0 || value > type(uint128).max || validBefore > type(uint48).max
                || validAfter >= validBefore || l.vouchers[nonce].state != VoucherState.None
        ) return (Reason.OP_SHAPE, false);
        // A voucher is a deferred token.transfer(to, value): the key's transfer rule must allow it.
        RuleSet storage rs = AccountStorage.ruleSet(l, sid, token, ArgRules.TRANSFER);
        if (!rs.allowed) return (Reason.TARGET, false);
        AgentCall memory t;
        t.kind = OpKind.CALL;
        t.target = token;
        t.data = abi.encodeWithSelector(ArgRules.TRANSFER, toWord, value);
        t.selector = ArgRules.TRANSFER;
        reason = PolicyCheck.evalRules(l, rs, t, address(this));
        hasPayee = t.hasPayee;
    }

    /// Execution (sandbox inner frame): register the voucher (the core debits `value` next).
    /// Reverts PolicyViolation(EXPIRED) unless now < validBefore <= now + VOUCHER_MAX_TTL.
    function register(uint64 sid, Track track, address token, bytes calldata data) external {
        (address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce) =
            abi.decode(data, (address, uint256, uint256, uint256, bytes32));
        if (validBefore <= block.timestamp || validBefore > block.timestamp + VOUCHER_MAX_TTL) {
            revert PolicyViolation(Reason.EXPIRED);
        }
        AccountStorage.layout().vouchers[nonce] = Voucher(
            to, uint128(value), VoucherState.Registered, uint48(validAfter), uint48(validBefore), sid, track, token
        );
        emit VoucherRegistered(nonce, token, to, value, validBefore);
    }

    // ---------------------------------------------------------------- reclaim

    /// Close a Registered voucher. Returns value = 0 when nothing is to be credited (Used).
    function close(bytes32 nonce) external returns (uint64 sid, Track track, address token, uint256 value) {
        Voucher storage v = AccountStorage.layout().vouchers[nonce];
        if (v.state != VoucherState.Registered) revert VoucherNotReclaimable(nonce);
        if (IERC3009Token(v.token).authorizationState(address(this), nonce)) {
            v.state = VoucherState.Used;
            emit VoucherUsed(nonce);
            return (0, Track.NORMAL, address(0), 0);
        }
        if (block.timestamp < v.validBefore) revert VoucherNotReclaimable(nonce);
        v.state = VoucherState.Reclaimed;
        emit VoucherReclaimed(nonce, v.value);
        return (v.sessionId, v.track, v.token, v.value);
    }
}
