// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountBase} from "../../src/AgentAccountBase.sol";
import {FreezeModule} from "../../src/modules/FreezeModule.sol";
import {MeterModule, MeterLib} from "../../src/modules/MeterModule.sol";
import {AccountStorage} from "../../src/lib/AccountStorage.sol";
import {Buckets} from "../../src/lib/Buckets.sol";
import {AgentCall, AssetLimit, OpContext, Outflow, Tier, Track} from "../../src/lib/PolicyTypes.sol";

/// Test-only host for MeterModule alone: the other hooks are inert stubs, storage is written
/// directly. Decouples the meter's unit tests and gas measurement from the other W2 modules.
contract M2MeterHarness is MeterModule {
    using AccountStorage for AccountStorage.Layout;
    using Buckets for *;

    address internal immutable EP;
    uint256 public lastMeterGas;

    constructor(address ep) {
        EP = ep;
    }

    receive() external payable {}

    function _entryPointAddress() internal view override returns (address) {
        return EP;
    }

    // ---- storage setup (owner-side state the meter reads)

    function setGlobal(address asset, uint128 burst, uint128 rate) external {
        AccountStorage.Layout storage l = _l();
        l.globalBucket[asset].configure(burst, rate, block.timestamp);
        if (!l.isTrackedAsset[asset]) {
            l.isTrackedAsset[asset] = true;
            l.trackedAssets.push(asset);
        }
    }

    function setExplore(address asset, uint128 burst, uint128 rate, uint128 perTx) external {
        AccountStorage.Layout storage l = _l();
        l.exploreBucket[asset].configure(burst, rate, block.timestamp);
        l.explorePerTxCap[asset] = perTx;
    }

    function setKeyAsset(uint64 sid, address asset, uint128 perTx, uint128 burst, uint128 rate) external {
        AssetLimit storage a = _l().keyAsset(sid, asset);
        a.enabled = true;
        a.perTxCap = perTx;
        a.bucket.configure(burst, rate, block.timestamp);
    }

    function setSpenders(address[] calldata s) external {
        _l().trackedSpenders = s;
    }

    // ---- views

    function keyLevel(uint64 sid, address asset) external view returns (uint256) {
        return _l().keyAsset(sid, asset).bucket.availableAt(block.timestamp);
    }

    function globalLevel(address asset) external view returns (uint256) {
        return _l().globalBucket[asset].availableAt(block.timestamp);
    }

    function exploreLevel(address asset) external view returns (uint256) {
        return _l().exploreBucket[asset].availableAt(block.timestamp);
    }

    function prepaidOf(address asset, address spender) external view returns (uint256 amount, uint256 seen) {
        MeterLib.Prepaid storage p = _meterStorage().prepaid[asset][spender];
        return (p.amount, p.seen);
    }

    // ---- hook drivers (what the sandbox inner frame does around the one call)

    function run(OpContext memory ctx, AgentCall memory call) external returns (Outflow[] memory outflows) {
        uint256 g0 = gasleft();
        bytes memory snap = _meterBefore(ctx, call);
        uint256 g1 = gasleft();
        (bool ok, bytes memory ret) = call.target.call{value: call.value}(call.data);
        if (!ok) revert CallFailed(ret);
        uint256 g2 = gasleft();
        outflows = _meterAfter(ctx, call, snap);
        lastMeterGas = (g0 - g1) + (g2 - gasleft());
    }

    function debitDeclared(OpContext memory ctx, address asset, uint256 amount) external {
        _meterDebitDeclared(ctx, asset, amount);
    }

    function credit(uint64 sid, Track track, address asset, uint256 amount) external {
        _meterCredit(sid, track, asset, amount);
    }

    // ---- inert stubs for the other modules' hooks

    function _tierOf(OpContext memory, AgentCall memory, bytes memory)
        internal
        pure
        override
        returns (Tier, uint16, uint48)
    {
        return (Tier.NONE, 0, type(uint48).max);
    }

    function _door1271(bytes32, bytes calldata) internal pure override returns (bytes4) {
        return 0xffffffff;
    }

    function _doorDecodeOp(OpContext memory, AgentCall memory) internal pure override returns (uint16) {
        return 15;
    }

    function _doorExecuteOp(OpContext memory, AgentCall memory) internal pure override {}

    function _approvalValidate(OpContext memory, AgentCall memory, bytes memory)
        internal
        pure
        override
        returns (uint16, uint48)
    {
        return (17, 0);
    }

    function _approvalBefore(OpContext memory, AgentCall memory, bytes memory) internal pure override returns (bytes memory) {}

    function _approvalAfter(OpContext memory, AgentCall memory, bytes memory, bytes memory, Outflow[] memory)
        internal
        pure
        override
    {}

    function _freezeReason(OpContext memory) internal pure override returns (uint16) {
        return 0;
    }

    function _preCallTripwire(OpContext memory, AgentCall memory) internal pure override returns (bool) {}

    function _postCallTripwire(OpContext memory, AgentCall memory, Outflow[] memory) internal pure override returns (bool) {}

    function _onBlocked(OpContext memory, bytes memory, bool) internal pure override returns (bool) {}

    function _freezeKey(address) internal pure override {}
}

/// The real AgentAccount with the FRZ execution tripwires (T1-T4) and the strike-to-freeze policy
/// switched off; FROZEN in validation stays. Isolates the meter's bound from lane FRZ's thresholds:
/// T1 velocity (40% of the global cap per clock-hour pair) and the T3 streak would otherwise stop
/// the very traffic the M2 tests and invariants need to push against the buckets. INT tests both together.
contract M2QuietAccount is AgentAccount {
    constructor(IEntryPoint ep, address admin_) AgentAccount(ep, admin_) {}

    function _preCallTripwire(OpContext memory, AgentCall memory)
        internal
        pure
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return false;
    }

    function _postCallTripwire(OpContext memory, AgentCall memory, Outflow[] memory)
        internal
        pure
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return false;
    }

    function _onBlocked(OpContext memory, bytes memory, bool)
        internal
        pure
        override(AgentAccountBase, FreezeModule)
        returns (bool)
    {
        return false;
    }
}

/// M2QuietAccount with the four meter hooks stubbed (the M1 no-op meter): the baseline for the
/// in-place meter gas overhead in results/gas_m2.json.
contract M2NoMeterAccount is M2QuietAccount {
    constructor(IEntryPoint ep, address admin_) M2QuietAccount(ep, admin_) {}

    function _meterBefore(OpContext memory, AgentCall memory)
        internal
        pure
        override(AgentAccountBase, MeterModule)
        returns (bytes memory)
    {
        return "";
    }

    function _meterAfter(OpContext memory, AgentCall memory, bytes memory)
        internal
        pure
        override(AgentAccountBase, MeterModule)
        returns (Outflow[] memory o)
    {
        return o;
    }

    function _meterDebitDeclared(OpContext memory, address, uint256)
        internal
        pure
        override(AgentAccountBase, MeterModule)
    {}

    function _meterCredit(uint64, Track, address, uint256) internal pure override(AgentAccountBase, MeterModule) {}
}
