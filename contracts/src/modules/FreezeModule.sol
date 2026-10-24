// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentAccountBase, AccountCommon} from "../AgentAccountBase.sol";
import {AccountStorage} from "../lib/AccountStorage.sol";
import {AgentCall, OpContext, Outflow, Reason, Track, Bucket} from "../lib/PolicyTypes.sol";

/// @title FreezeStorage: ERC-7201 namespace "hypnexis.AgentAccount.freeze" (lane FRZ, M10).
/// @notice Tripwire windows use the "clock-hour pair": the current clock hour (timestamp / 3600)
///         plus the previous one. Every rolling 1 h window that ends now lies inside that pair, so
///         a window total never under-counts a rolling-1 h total (no rolling-1 h breach escapes);
///         it may over-count up to a 2 h span (the price of a 1-slot window).
library FreezeStorage {
    /// One clock-hour pair: `cur` = total in clock hour `hour`, `prev` = total in hour `hour - 1`.
    struct Window {
        uint32 hour;
        uint112 prev;
        uint112 cur;
    }

    /// @custom:storage-location erc7201:hypnexis.AgentAccount.freeze
    struct Layout {
        mapping(address => bool) frozen; // agentKey => frozen (validation refuses with FROZEN)
        mapping(address => uint256) strikes; // agentKey => blocked ops since the last unfreeze
        address watcher; // escalate-only role: may freeze, nothing else
        // ---- M10 (FRZ), append-only below.
        mapping(address => mapping(address => Window)) spend; // T1: agentKey => asset => outflow
        mapping(address => Window) newPayees; // T2: agentKey => distinct unproven payees counted
        mapping(address => mapping(address => uint32)) payeeHour; // T2: agentKey => payee => hour last counted
        mapping(address => Window) streak; // T3: agentKey => blocked ops
        /// Owner-set parameters, one mapping to keep the admin small (EIP-170):
        /// - canaryId(addr) (right-aligned address) -> != 0: T4 canary target / payee;
        /// - bytes32(selector) (left-aligned) -> != 0: T4 canary selector (key 0 = selector 0x00000000,
        ///   i.e. any plain native-value send);
        /// - P_VELOCITY_BPS / P_SPRAY_MAX / P_STRIKE_MAX -> threshold (0 = the documented default).
        mapping(bytes32 => uint256) param;
    }

    // keccak256(abi.encode(uint256(keccak256("hypnexis.AgentAccount.freeze")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xe8cb2d89f755fa565752f95bb5ba5c96f49d6b2bdd02c69424d7de9c7d817c00;

    /// Threshold keys of `param` (keccak ids: never a right-aligned address nor a left-aligned selector).
    bytes32 internal constant P_VELOCITY_BPS = keccak256("hypnexis.freeze.velocityBps");
    bytes32 internal constant P_SPRAY_MAX = keccak256("hypnexis.freeze.sprayMax");
    bytes32 internal constant P_STRIKE_MAX = keccak256("hypnexis.freeze.strikeMax");

    /// Documented defaults (placeholders until lane X1 fixes them on dev seeds 1-3, EXPERIMENTS X6).
    /// T1: trip if one asset's outflow in the clock-hour pair > velocityBps x (burst + ratePerDay) of its
    ///     global cap / 10_000. Demo policy (20 USDC / 24 h): above 8 USDC. >= 10_000 never trips.
    /// T2: trip if distinct unproven payees in the clock-hour pair > sprayMax (the 6th trips).
    /// T3: freeze when blocked ops in the clock-hour pair >= strikeMax (the 3rd freezes).
    /// T4: no default canaries.
    uint256 internal constant DEFAULT_VELOCITY_BPS = 4000;
    uint256 internal constant DEFAULT_SPRAY_MAX = 5;
    uint256 internal constant DEFAULT_STRIKE_MAX = 3;

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            l.slot := slot
        }
    }

    /// Effective threshold: the stored value, or `dflt` when unset (0).
    function threshold(Layout storage f, bytes32 key, uint256 dflt) internal view returns (uint256 v) {
        v = f.param[key];
        if (v == 0) v = dflt;
    }

    /// Canary id of an address (right-aligned); a selector's id is bytes32(selector) (left-aligned).
    function canaryId(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// Add `amount` to the window at the current clock hour (rolling it first) and return the
    /// clock-hour-pair total. Saturates at uint112 max; never reverts (used in the outer frame).
    function bump(Window storage w, uint256 amount) internal returns (uint256) {
        uint256 h = block.timestamp / 1 hours;
        uint256 wh = w.hour;
        uint256 prev = w.prev;
        uint256 cur = w.cur;
        if (wh != h) {
            prev = wh + 1 == h ? cur : 0;
            cur = 0;
        }
        cur = amount >= type(uint112).max - cur ? type(uint112).max : cur + amount;
        w.hour = uint32(h);
        w.prev = uint112(prev);
        w.cur = uint112(cur);
        return prev + cur;
    }
}

/// @title FreezeTripwires (lane FRZ, M10): the tripwire logic as an EXTERNAL linked library.
/// @notice Its functions run by DELEGATECALL from AgentAccount, so they read and write the account's
///         storage; Solidity's library call guard refuses a direct CALL. Kept out of the core to
///         save EIP-170 bytes (the core keeps only the FROZEN check and three short call sites).
///         Deployers link it (forge test / forge script do this automatically).
library FreezeTripwires {
    /// Inner frame, before the call: T4 canary, then T2 new-payee spray.
    function preCall(address agentKey, address target, bytes4 selector, address payee, bool hasPayee, bool explore)
        external
        returns (bool)
    {
        FreezeStorage.Layout storage f = FreezeStorage.layout();
        if (
            f.param[FreezeStorage.canaryId(target)] != 0 || f.param[bytes32(selector)] != 0
                || (hasPayee && f.param[FreezeStorage.canaryId(payee)] != 0)
        ) return true;
        if (!explore || !hasPayee) return false;
        uint32 h = uint32(block.timestamp / 1 hours);
        mapping(address => uint32) storage seen = f.payeeHour[agentKey];
        if (seen[payee] == h) return false; // already counted in this clock hour
        seen[payee] = h;
        return FreezeStorage.bump(f.newPayees[agentKey], 1)
            > FreezeStorage.threshold(f, FreezeStorage.P_SPRAY_MAX, FreezeStorage.DEFAULT_SPRAY_MAX);
    }

    /// Inner frame, after metering: T1 velocity on the measured outflows (callers skip Track.APPROVAL).
    function postCall(address agentKey, Outflow[] memory outflows) external returns (bool) {
        FreezeStorage.Layout storage f = FreezeStorage.layout();
        uint256 bps = FreezeStorage.threshold(f, FreezeStorage.P_VELOCITY_BPS, FreezeStorage.DEFAULT_VELOCITY_BPS);
        for (uint256 i; i < outflows.length; ++i) {
            Outflow memory o = outflows[i];
            if (o.amount == 0) continue;
            uint256 spent = FreezeStorage.bump(f.spend[agentKey][o.asset], o.amount);
            Bucket storage g = AccountStorage.layout().globalBucket[o.asset];
            uint256 cap = uint256(g.burst) + g.ratePerDay;
            if (bps < 10_000 && cap != 0 && spent * 10_000 > cap * bps) return true;
        }
        return false;
    }

    /// Outer frame: T3 strike streak; returns whether to freeze now. No reverting paths. The streak
    /// counts only strikes since the last unfreeze (min with `strikes`, which unfreeze zeroes).
    function onBlocked(address agentKey, bool tripped) external returns (bool) {
        FreezeStorage.Layout storage f = FreezeStorage.layout();
        uint256 total;
        unchecked {
            total = ++f.strikes[agentKey];
        }
        uint256 streak = FreezeStorage.bump(f.streak[agentKey], 1);
        if (total < streak) streak = total;
        return streak >= FreezeStorage.threshold(f, FreezeStorage.P_STRIKE_MAX, FreezeStorage.DEFAULT_STRIKE_MAX)
            || tripped;
    }
}

/// @title FreezeModule (lane FRZ, M10): the validation check and the execution tripwires (core side).
/// @notice Validation and the execution re-check refuse a frozen key with FROZEN (I13). In the
///         sandbox's inner frame a tripped tripwire reverts the op (the spend is undone) and the
///         outer frame freezes the key (logic in FreezeTripwires):
///         - T4 canary (pre-call): the op's target, payee or selector is an owner-planted canary.
///         - T2 new-payee spray (pre-call): distinct unproven payees (Track.EXPLORE) in the clock-hour
///           pair > sprayMax.
///         - T1 velocity (post-call): measured outflow of an asset in the clock-hour pair >
///           velocityBps of that asset's 24 h global cap (burst + ratePerDay).
///         - T3 strike streak (outer frame): blocked ops (policy breach or tripwire) in the clock-hour
///           pair >= strikeMax.
///         Owner-approved ops (Track.APPROVAL) are not counted by T1 / T2: the owner signed their outflow.
///         A canary fires only on ops that pass validation: plant canary payees reachable through a
///         PAYEE rule (e.g. a fake "refund wallet" in the agent's context) or canary selectors the
///         policy allows but legit flows never use.
abstract contract FreezeModule is AgentAccountBase {
    function _freezeReason(OpContext memory ctx) internal view virtual override returns (uint16) {
        return FreezeStorage.layout().frozen[ctx.agentKey] ? Reason.FROZEN : Reason.OK;
    }

    function _preCallTripwire(OpContext memory ctx, AgentCall memory call) internal virtual override returns (bool) {
        return FreezeTripwires.preCall(
            ctx.agentKey, call.target, call.selector, call.payee, call.hasPayee, ctx.track == Track.EXPLORE
        );
    }

    function _postCallTripwire(OpContext memory ctx, AgentCall memory, Outflow[] memory outflows)
        internal
        virtual
        override
        returns (bool)
    {
        return ctx.track != Track.APPROVAL && outflows.length != 0 && FreezeTripwires.postCall(ctx.agentKey, outflows);
    }

    function _onBlocked(OpContext memory ctx, bytes memory, bool tripped) internal virtual override returns (bool) {
        return FreezeTripwires.onBlocked(ctx.agentKey, tripped);
    }

    function _freezeKey(address agentKey) internal virtual override {
        FreezeStorage.layout().frozen[agentKey] = true;
    }
}

/// @title FreezeAdmin (lane FRZ, M10): owner / watcher functions, compiled into AgentAccountAdmin
///        (reached through the account's fallback, so they run on the account's storage).
/// @notice freeze: owner or watcher (escalate-only, like the attestor's flag). unfreeze,
///         setWatcher and setFreezeParam: owner only. The watcher can never be a live
///         agent key, and setPolicy refuses the watcher as a key. Canaries and thresholds share one
///         setter (setFreezeParam) to keep AgentAccountAdmin under EIP-170.
abstract contract FreezeAdmin is AccountCommon {
    /// key: a canary id (canaryId(addr) or bytes32(selector); value != 0 = on) or a threshold key.
    event FreezeParamSet(bytes32 indexed key, uint256 value);

    function freeze(address agentKey) external {
        FreezeStorage.Layout storage f = FreezeStorage.layout();
        if (!(_isOwnerCaller() || (msg.sender == f.watcher && msg.sender != address(0)))) revert NotOwner();
        f.frozen[agentKey] = true;
        emit AgentFrozen(agentKey, msg.sender, bytes32(0));
    }

    /// Owner only: clears the freeze and the strikes, which also resets the T3 streak (T1 / T2
    /// windows age out within 2 h).
    function unfreeze(address agentKey) external {
        if (!_isOwnerCaller()) revert NotOwner();
        FreezeStorage.Layout storage f = FreezeStorage.layout();
        f.frozen[agentKey] = false;
        f.strikes[agentKey] = 0;
        emit AgentUnfrozen(agentKey);
    }

    function setWatcher(address watcher_) external {
        if (!_isOwnerCaller()) revert NotOwner();
        if (watcher_ == address(this) || (watcher_ != address(0) && _l().keyToSession[watcher_] != 0)) {
            revert AgentKeyActive(watcher_);
        }
        FreezeStorage.layout().watcher = watcher_;
        emit WatcherSet(watcher_);
    }

    /// Owner only: T4 canaries (value != 0 = on) and T1-T3 thresholds (0 = default); see FreezeStorage.param.
    function setFreezeParam(bytes32 key, uint256 value) external {
        if (!_isOwnerCaller()) revert NotOwner();
        FreezeStorage.layout().param[key] = value;
        emit FreezeParamSet(key, value);
    }

    function isFrozen(address agentKey) external view returns (bool) {
        return FreezeStorage.layout().frozen[agentKey];
    }

    function strikes(address agentKey) external view returns (uint256) {
        return FreezeStorage.layout().strikes[agentKey];
    }

    function watcher() external view returns (address) {
        return FreezeStorage.layout().watcher;
    }

    /// Raw parameter (0 = unset: thresholds then use the FreezeStorage defaults).
    function freezeParam(bytes32 key) external view returns (uint256) {
        return FreezeStorage.layout().param[key];
    }
}
