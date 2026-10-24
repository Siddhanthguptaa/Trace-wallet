// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentAccountBase} from "../AgentAccountBase.sol";
import {AccountStorage} from "../lib/AccountStorage.sol";
import {ArgRules} from "../lib/ArgRules.sol";
import {Buckets} from "../lib/Buckets.sol";
import {AgentCall, AssetLimit, Bucket, OpContext, Outflow, Reason, Track, NATIVE} from "../lib/PolicyTypes.sol";

/// @title MeterModule (D2, lane D2 / M2): effect metering and honest bucket debits.
/// @notice Thin hook layer; the logic lives in the external library `MeterLib` below (EIP-170: the
///         core's byte budget for D2 is 3.0 KB), reached by DELEGATECALL, so it runs on the account's
///         storage and balance. Deployers must deploy MeterLib and link it (forge test / forge script
///         do this automatically; viem deploys must replace the library placeholder in the bytecode).
///         Semantics: see MeterLib. Runs in the sandbox's inner frame only (execution, time =
///         block.timestamp [E2]); a breach reverts PolicyViolation(code), which the outer frame turns
///         into PolicyBlocked with the spend undone.
abstract contract MeterModule is AgentAccountBase {
    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.meter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant METER_SLOT = 0x23af9bb09907b1ce8bb1c7e70f746ecc4f9229c49fe6393b5af38222e721e500;

    /// @dev Layout: MeterLib.MeterStorage at METER_SLOT (erc7201:hypnexis.AgentAccount.meter).
    function _meterStorage() internal pure returns (MeterLib.MeterStorage storage) {
        return MeterLib.meterStorage();
    }

    function _meterBefore(OpContext memory, AgentCall memory call) internal virtual override returns (bytes memory) {
        return MeterLib.snapshot(_entryPointAddress(), call.target, _meterSpender(call));
    }

    function _meterAfter(OpContext memory ctx, AgentCall memory call, bytes memory snapshot)
        internal
        virtual
        override
        returns (Outflow[] memory)
    {
        return MeterLib.settle(_entryPointAddress(), ctx.sessionId, ctx.track, call.target, _meterSpender(call), snapshot);
    }

    function _meterDebitDeclared(OpContext memory ctx, address asset, uint256 amount) internal virtual override {
        if (amount != 0) MeterLib.charge(ctx.sessionId, ctx.track, asset, amount);
    }

    function _meterCredit(uint64 sessionId, Track track, address asset, uint256 amount) internal virtual override {
        if (amount != 0) MeterLib.credit(sessionId, track, asset, amount);
    }

    /// The spender an approve / increaseAllowance op grants (0 otherwise).
    function _meterSpender(AgentCall memory call) private pure returns (address x) {
        if (call.selector == ArgRules.APPROVE || call.selector == ArgRules.INCREASE_ALLOWANCE) {
            (, uint256 w) = ArgRules.word(call.data, 0);
            x = address(uint160(w));
        }
    }
}

/// @title MeterLib: D2 effect meter (external library, DELEGATECALLed by MeterModule).
/// @notice Snapshot before the one call, re-read after it:
///           - NATIVE: balance + EntryPoint deposit (one pool; agent ops cannot target the EntryPoint);
///           - every tracked ERC-20 (`trackedAssets`): balanceOf(account) and allowance(account, s) for
///             every `trackedSpenders` s (Permit2 included) plus the spender the op itself approves on
///             that token, so an approve to an untracked spender is still metered.
///         Measured outflow per asset = balance drop + allowance growth, each unit counted once
///         (docs/api.md section 9): allowance growth is charged when granted and remembered as
///         `prepaid[asset][spender]`; a later pull that consumes prepaid allowance excuses the same
///         amount of balance drop. A pull from allowance the agent never paid for (owner-granted)
///         counts in full. Prepaid is void once the allowance moved outside agent ops
///         (seen != allowance before) and never exceeds the allowance.
///         Charge per asset with outflow (Track NORMAL / EXPLORE): key asset enabled (ASSET), per-tx
///         cap (PER_TX); on EXPLORE explorePerTxCap (EXPLORE_PER_TX) and the exploration bucket
///         (EXPLORE_BUCKET); key bucket (KEY_BUCKET); global bucket (GLOBAL_BUCKET). Track APPROVAL:
///         measured and returned, never charged (the owner's maxOutflow replaces the caps; APPC
///         enforces it) and never prepaid. Credits (voucher reclaim) never exceed burst and skip
///         unconfigured buckets. The tracked-NFT balance meter is cut (FASTPLAN); NFT moves stay
///         locked by the M1 selector rules.
library MeterLib {
    using AccountStorage for AccountStorage.Layout;
    using Buckets for Bucket;

    error PolicyViolation(uint16 reason); // same selector as AccountCommon.PolicyViolation

    /// Allowance the agent already paid for, and the allowance value seen when it was written.
    struct Prepaid {
        uint256 amount;
        uint256 seen;
    }

    /// @custom:storage-location erc7201:hypnexis.AgentAccount.meter
    struct MeterStorage {
        uint256 version;
        mapping(address asset => mapping(address spender => Prepaid)) prepaid;
        mapping(address asset => uint256) live; // spenders (current set) with nonzero prepaid
    }

    bytes32 internal constant METER_SLOT = 0x23af9bb09907b1ce8bb1c7e70f746ecc4f9229c49fe6393b5af38222e721e500;

    function meterStorage() internal pure returns (MeterStorage storage $) {
        bytes32 slot = METER_SLOT;
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    // ---------------------------------------------------------------- entry points

    function snapshot(address ep, address target, address extra) external view returns (bytes memory) {
        return abi.encode(_read(ep, AccountStorage.layout().trackedAssets, _spenders(extra), target));
    }

    function settle(address ep, uint64 sid, Track track, address target, address extra, bytes memory snap)
        external
        returns (Outflow[] memory outflows)
    {
        uint256[] memory b = abi.decode(snap, (uint256[]));
        address[] memory assets = AccountStorage.layout().trackedAssets;
        address[] memory sp = _spenders(extra);
        uint256[] memory a = _read(ep, assets, sp, target);
        outflows = new Outflow[](assets.length + 1);
        uint256 n;
        uint256 out = b[0] > a[0] ? b[0] - a[0] : 0;
        if (out != 0) outflows[n++] = Outflow(NATIVE, out);
        uint256 k = 1;
        for (uint256 i; i < assets.length; ++i) {
            if (assets[i] != NATIVE) {
                out = _asset(track != Track.APPROVAL, assets[i], sp, b, a, k);
                if (out != 0) outflows[n++] = Outflow(assets[i], out);
            }
            k += 1 + sp.length;
        }
        assembly ("memory-safe") {
            mstore(outflows, n)
        }
        for (uint256 i; i < n; ++i) {
            _charge(sid, track, outflows[i].asset, outflows[i].amount);
        }
    }

    function charge(uint64 sid, Track track, address asset, uint256 amount) external {
        _charge(sid, track, asset, amount);
    }

    function credit(uint64 sid, Track track, address asset, uint256 amount) external {
        if (track == Track.APPROVAL) return;
        AccountStorage.Layout storage l = AccountStorage.layout();
        AssetLimit storage k = l.keyAsset(sid, asset);
        if (k.enabled) _creditB(k.bucket, amount);
        _creditB(l.globalBucket[asset], amount);
        if (track == Track.EXPLORE) _creditB(l.exploreBucket[asset], amount);
    }

    // ---------------------------------------------------------------- internals

    /// trackedSpenders + `extra` (dropped if already tracked) in the last slot.
    function _spenders(address extra) private view returns (address[] memory sp) {
        address[] storage t = AccountStorage.layout().trackedSpenders;
        uint256 n = t.length;
        sp = new address[](n + 1);
        for (uint256 j; j < n; ++j) {
            sp[j] = t[j];
            if (sp[j] == extra) extra = address(0);
        }
        sp[n] = extra;
    }

    /// [native + deposit] ++ per tracked asset [balance, allowance(sp[0]), ..., allowance(sp[m-1])].
    /// Allowances are read on the op's target token (the only token whose allowance the account
    /// itself can grow: approve / increaseAllowance; 1271 permits are refused during execution) and
    /// on tokens with live prepaid allowance (whose pulls may be excused); elsewhere a pull only
    /// lowers an allowance nobody prepaid, which excuses nothing, so it is skipped (gas). The last
    /// spender slot (the op's own spender) is read only on the target token.
    function _read(address ep, address[] memory assets, address[] memory sp, address target)
        private
        view
        returns (uint256[] memory v)
    {
        uint256 m = sp.length;
        v = new uint256[](1 + assets.length * (1 + m));
        v[0] = address(this).balance + IEntryPoint(ep).balanceOf(address(this));
        uint256 k = 1;
        for (uint256 i; i < assets.length; ++i) {
            address a = assets[i];
            if (a != NATIVE) {
                v[k] = IERC20(a).balanceOf(address(this));
                uint256 mm = a == target || meterStorage().live[a] != 0 ? m : 0;
                for (uint256 j; j < mm; ++j) {
                    address s = sp[j];
                    if (s != address(0) && (j + 1 < m || a == target)) {
                        v[k + 1 + j] = IERC20(a).allowance(address(this), s);
                    }
                }
            }
            k += 1 + m;
        }
    }

    /// Outflow of one ERC-20 (before b, after a, at offset k); updates prepaid allowances.
    function _asset(bool charged, address asset, address[] memory sp, uint256[] memory b, uint256[] memory a, uint256 k)
        private
        returns (uint256)
    {
        MeterStorage storage ms = meterStorage();
        (uint256 excused, uint256 growth, bool touched) = _allowances(charged, ms.prepaid[asset], sp, b, a, k);
        if (touched) {
            uint256 c;
            for (uint256 j; j < sp.length; ++j) {
                if (ms.prepaid[asset][sp[j]].amount != 0) ++c;
            }
            ms.live[asset] = c;
        }
        uint256 drop = b[k] > a[k] ? b[k] - a[k] : 0;
        if (excused > drop) excused = drop;
        return _sat(drop - excused, growth);
    }

    /// Prepaid consumed by allowance decreases, total allowance growth, and whether any moved.
    function _allowances(
        bool charged,
        mapping(address => Prepaid) storage pp,
        address[] memory sp,
        uint256[] memory b,
        uint256[] memory a,
        uint256 k
    ) private returns (uint256 excused, uint256 growth, bool touched) {
        for (uint256 j; j < sp.length; ++j) {
            uint256 x = k + 1 + j;
            if (b[x] == a[x]) continue;
            touched = true;
            uint256 r = _prepaid(pp[sp[j]], b[x], a[x], charged);
            if (a[x] < b[x]) excused = _sat(excused, r);
            else growth = _sat(growth, r);
        }
    }

    /// One spender's allowance moved al0 -> al1 (al0 != al1). A decrease consumes prepaid and returns
    /// the prepaid used; an increase returns the growth, which becomes prepaid if `charged`.
    function _prepaid(Prepaid storage p, uint256 al0, uint256 al1, bool charged) private returns (uint256 r) {
        uint256 paid = p.seen == al0 ? p.amount : 0;
        if (al1 < al0) {
            r = al0 - al1;
            if (r > paid) r = paid;
            paid -= r;
        } else {
            r = al1 - al0;
            if (charged) paid = _sat(paid, r);
        }
        p.amount = paid > al1 ? al1 : paid;
        p.seen = al1;
    }

    /// Per-tx caps and bucket debits for one asset (NORMAL / EXPLORE); revert PolicyViolation on breach.
    function _charge(uint64 sid, Track track, address asset, uint256 amount) private {
        if (track == Track.APPROVAL) return;
        AccountStorage.Layout storage l = AccountStorage.layout();
        AssetLimit storage k = l.keyAsset(sid, asset);
        if (!k.enabled) revert PolicyViolation(Reason.ASSET);
        if (amount > k.perTxCap) revert PolicyViolation(Reason.PER_TX);
        if (track == Track.EXPLORE) {
            if (amount > l.explorePerTxCap[asset]) revert PolicyViolation(Reason.EXPLORE_PER_TX);
            _debit(l.exploreBucket[asset], amount, Reason.EXPLORE_BUCKET);
        }
        _debit(k.bucket, amount, Reason.KEY_BUCKET);
        _debit(l.globalBucket[asset], amount, Reason.GLOBAL_BUCKET);
    }

    function _debit(Bucket storage b, uint256 amount, uint16 reason) private {
        if (!b.tryDebit(amount, block.timestamp)) revert PolicyViolation(reason);
    }

    /// Credit back (never above burst); an unconfigured bucket stays unconfigured.
    function _creditB(Bucket storage b, uint256 amount) private {
        if (b.lastRefill != 0) b.credit(amount, block.timestamp);
    }

    function _sat(uint256 x, uint256 y) private pure returns (uint256 z) {
        unchecked {
            z = x + y;
            if (z < x) z = type(uint256).max;
        }
    }
}
