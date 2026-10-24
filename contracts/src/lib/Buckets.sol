// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Bucket} from "./PolicyTypes.sol";

/// @title Buckets: honest 24 h token buckets (IDEA.md 7.1 bucket rule, F3).
/// @notice A bucket {burst, ratePerDay, level, lastRefill} never holds more than `burst` and refills
///         at ratePerDay x elapsed / 86400 (rounded down). So the debits in any window of t seconds
///         are at most burst + ratePerDay x t / 86400, which is <= cap = burst + ratePerDay for any
///         24 h window. Default split: burst = cap / 2, ratePerDay = cap - cap / 2.
///         Time is a parameter: callers pass block.timestamp in execution only (never validation [E2]).
///         Rounding always goes against the spender, so the bound holds exactly.
library Buckets {
    uint256 internal constant DAY = 86400;

    error BucketExceeded(uint256 amount, uint256 available);

    /// cap = burst + ratePerDay (max debits in any 24 h window).
    function cap(Bucket memory b) internal pure returns (uint256) {
        return uint256(b.burst) + uint256(b.ratePerDay);
    }

    /// Default split of a 24 h cap: burst = cap / 2, ratePerDay = cap - burst.
    function split(uint256 cap_) internal pure returns (uint128 burst, uint128 ratePerDay) {
        burst = uint128(cap_ / 2);
        ratePerDay = uint128(cap_ - cap_ / 2);
    }

    /// True once `configure` ran (a zero-cap bucket can still be configured: nothing spendable).
    function configured(Bucket memory b) internal pure returns (bool) {
        return b.lastRefill != 0;
    }

    /// Level after refilling to `nowTs` (pure; does not write).
    function availableAt(Bucket memory b, uint256 nowTs) internal pure returns (uint256) {
        uint256 level = b.level;
        if (nowTs > b.lastRefill) {
            uint256 added = uint256(b.ratePerDay) * (nowTs - b.lastRefill) / DAY;
            level += added;
        }
        return level > b.burst ? b.burst : level;
    }

    /// Set or reconfigure. A new bucket starts full (level = burst). A reconfigured bucket keeps
    /// what is already spent: level = min(available now, new burst), so lowering a cap is immediate
    /// and raising it never refills instantly.
    function configure(Bucket storage b, uint128 burst, uint128 ratePerDay, uint256 nowTs) internal {
        uint256 level = configured(b) ? availableAt(b, nowTs) : burst;
        if (level > burst) level = burst;
        b.burst = burst;
        b.ratePerDay = ratePerDay;
        b.level = uint128(level);
        b.lastRefill = uint48(nowTs);
    }

    /// Refill to `nowTs` and store. Returns the new level.
    function refill(Bucket storage b, uint256 nowTs) internal returns (uint256 level) {
        level = availableAt(b, nowTs);
        b.level = uint128(level);
        if (nowTs > b.lastRefill) b.lastRefill = uint48(nowTs);
    }

    function canDebit(Bucket memory b, uint256 amount, uint256 nowTs) internal pure returns (bool) {
        return amount <= availableAt(b, nowTs);
    }

    /// Refill, then debit `amount` if it fits. Returns false (and only refills) if it does not.
    function tryDebit(Bucket storage b, uint256 amount, uint256 nowTs) internal returns (bool) {
        uint256 level = refill(b, nowTs);
        if (amount > level) return false;
        b.level = uint128(level - amount);
        return true;
    }

    /// Refill, then debit `amount` or revert BucketExceeded.
    function debit(Bucket storage b, uint256 amount, uint256 nowTs) internal {
        uint256 level = refill(b, nowTs);
        if (amount > level) revert BucketExceeded(amount, level);
        b.level = uint128(level - amount);
    }

    /// Refill, then credit `amount` back (voucher reclaim), never above burst.
    function credit(Bucket storage b, uint256 amount, uint256 nowTs) internal {
        uint256 level = refill(b, nowTs) + amount;
        b.level = uint128(level > b.burst ? b.burst : level);
    }
}
