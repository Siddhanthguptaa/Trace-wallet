import { describe, expect, it } from 'vitest';
import { affords, availableAt } from '../src/tools/buckets.ts';

describe('Buckets.availableAt (docs/api.md 2.3)', () => {
  const b = { burst: 10_000_000n, ratePerDay: 10_000_000n, level: 0n, lastRefill: 1000 };
  it('refills linearly and caps at burst', () => {
    expect(availableAt(b, 1000)).toBe(0n);
    expect(availableAt(b, 1000 + 43_200)).toBe(5_000_000n); // half a day
    expect(availableAt(b, 1000 + 86_400)).toBe(10_000_000n); // full day -> capped at burst
    expect(availableAt(b, 1000 + 172_800)).toBe(10_000_000n); // stays capped
  });
  it('never exceeds burst even if the stored level already does', () => {
    expect(availableAt({ ...b, level: 99_000_000n }, 2000)).toBe(10_000_000n);
  });
  it('affords compares against the available level', () => {
    expect(affords(b, 5_000_000n, 1000 + 43_200)).toBe(true);
    expect(affords(b, 5_000_001n, 1000 + 43_200)).toBe(false);
  });
});
