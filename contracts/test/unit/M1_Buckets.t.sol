// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Buckets} from "../../src/lib/Buckets.sol";
import {Bucket} from "../../src/lib/PolicyTypes.sol";

/// Bucket math (IDEA 7.1 bucket rule, F3): burst + 24 h refill = cap, so debits in any window of
/// t seconds are <= burst + ratePerDay * t / 86400, which is <= cap for any 24 h window.
contract M1BucketsTest is Test {
    using Buckets for Bucket;

    uint256 internal constant DAY = 86400;
    uint256 internal constant T0 = 1_800_000_000;
    Bucket internal b;

    // Harness entry for expectRevert (library calls are inlined).
    function debitExt(uint256 amount, uint256 nowTs) external {
        b.debit(amount, nowTs);
    }

    function test_bucket_startsFullAtBurst() public {
        b.configure(10e6, 10e6, T0);
        assertEq(b.level, 10e6);
        assertEq(Buckets.cap(b), 20e6);
        assertTrue(Buckets.configured(b));
        assertEq(Buckets.availableAt(b, T0 + 365 days), 10e6, "never above burst");
    }

    function test_bucket_split() public pure {
        (uint128 burst, uint128 rate) = Buckets.split(20e6);
        assertEq(burst, 10e6);
        assertEq(rate, 10e6);
        (burst, rate) = Buckets.split(7);
        assertEq(uint256(burst) + rate, 7, "split sums to the cap");
    }

    function test_bucket_refillRateRoundsDown() public {
        b.configure(10e6, 10e6, T0);
        b.debit(10e6, T0);
        assertEq(Buckets.availableAt(b, T0 + DAY / 2), 5e6, "half a day refills half the rate");
        assertEq(Buckets.availableAt(b, T0 + 1), 115, "10e6/86400 per second, rounded down");
        assertEq(Buckets.availableAt(b, T0 + DAY), 10e6);
    }

    function test_bucket_debitRevertsOverLevel() public {
        b.configure(10e6, 10e6, T0);
        vm.expectRevert(abi.encodeWithSelector(Buckets.BucketExceeded.selector, 10e6 + 1, 10e6));
        this.debitExt(10e6 + 1, T0);
        this.debitExt(10e6, T0);
        assertEq(b.level, 0);
    }

    function test_bucket_tryDebit() public {
        b.configure(5, 5, T0);
        assertFalse(b.tryDebit(6, T0));
        assertEq(b.level, 5, "failed tryDebit leaves the level");
        assertTrue(b.tryDebit(5, T0));
        assertEq(b.level, 0);
        assertTrue(b.canDebit(0, T0));
        assertFalse(b.canDebit(1, T0));
    }

    function test_bucket_creditCapsAtBurst() public {
        b.configure(10e6, 10e6, T0);
        b.debit(4e6, T0);
        b.credit(1e6, T0);
        assertEq(b.level, 7e6);
        b.credit(100e6, T0);
        assertEq(b.level, 10e6, "credit never above burst");
    }

    function test_bucket_reconfigureKeepsSpent() public {
        b.configure(10e6, 10e6, T0);
        b.debit(8e6, T0);
        b.configure(20e6, 20e6, T0); // raising the cap does not refill instantly
        assertEq(b.level, 2e6);
        b.configure(1e6, 1e6, T0); // lowering applies at once
        assertEq(b.level, 1e6);
    }

    function test_bucket_unconfiguredIsEmpty() public view {
        assertFalse(Buckets.configured(b));
        assertEq(Buckets.availableAt(b, T0), 0);
    }

    /// Midnight / sliding-window scenario: spend everything available as fast as possible across
    /// 48 h; every 24 h window stays <= cap (a burst = cap bucket would allow 2x cap).
    function test_bucket_capWindow24h() public {
        b.configure(10e6, 10e6, T0);
        uint256[] memory ts = new uint256[](49);
        uint256[] memory amt = new uint256[](49);
        for (uint256 h; h <= 48; ++h) {
            uint256 t = T0 + h * 3600;
            uint256 a = Buckets.availableAt(b, t);
            b.debit(a, t);
            ts[h] = t;
            amt[h] = a;
        }
        for (uint256 i; i < ts.length; ++i) {
            uint256 sum;
            for (uint256 j = i; j < ts.length && ts[j] < ts[i] + DAY; ++j) {
                sum += amt[j];
            }
            assertLe(sum, 20e6, "any 24 h window <= cap");
        }
    }

    /// Fuzz: any debit sequence; for every window [t_i, t_j] the debits are
    /// <= burst + ratePerDay * (t_j - t_i) / 86400, and <= cap when t_j - t_i < 24 h.
    function testFuzz_bucketWindow(uint64 burst, uint64 rate, uint32[12] memory gaps, uint64[12] memory wants)
        public
    {
        burst = uint64(bound(burst, 1, 1e15));
        rate = uint64(bound(rate, 0, 1e15));
        b.configure(burst, rate, T0);
        uint256 n = gaps.length;
        uint256[] memory ts = new uint256[](n);
        uint256[] memory amt = new uint256[](n);
        uint256 t = T0;
        for (uint256 i; i < n; ++i) {
            t += bound(gaps[i], 0, 2 * DAY);
            uint256 want = bound(wants[i], 0, uint256(burst) + rate);
            if (b.tryDebit(want, t)) amt[i] = want;
            ts[i] = t;
        }
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            for (uint256 j = i; j < n; ++j) {
                sum += amt[j];
                uint256 span = ts[j] - ts[i];
                assertLe(sum, uint256(burst) + uint256(rate) * span / DAY, "window bound");
                if (span < DAY) assertLe(sum, uint256(burst) + rate, "24 h window <= cap");
            }
        }
    }

    /// Fuzz: availability is monotone in time and capped by burst.
    function testFuzz_bucketWindowRefillMonotone(uint64 burst, uint64 rate, uint64 spend, uint32 dt1, uint32 dt2)
        public
    {
        burst = uint64(bound(burst, 1, 1e18));
        b.configure(burst, rate, T0);
        b.tryDebit(bound(spend, 0, burst), T0);
        uint256 t1 = T0 + dt1;
        uint256 t2 = t1 + dt2;
        uint256 a1 = Buckets.availableAt(b, t1);
        uint256 a2 = Buckets.availableAt(b, t2);
        assertLe(a1, a2);
        assertLe(a2, burst);
    }
}
