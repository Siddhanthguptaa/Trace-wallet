/**
 * `lib/Buckets.availableAt` in TypeScript (docs/api.md 2.3 note): the refill a view must add to a
 * stored bucket level. level + ratePerDay * (now - lastRefill) / 86400, capped at burst. Pure,
 * so the tools and X5 agree with the Solidity `Buckets` library. Unit-tested in buckets.test.ts.
 */
export interface Bucket {
  burst: bigint;
  ratePerDay: bigint;
  level: bigint;
  lastRefill: bigint | number;
}

const DAY = 86_400n;

export function availableAt(b: Bucket, now: number | bigint): bigint {
  const t = BigInt(now);
  const last = BigInt(b.lastRefill);
  if (t <= last) return b.level > b.burst ? b.burst : b.level;
  const refilled = b.level + (b.ratePerDay * (t - last)) / DAY;
  return refilled > b.burst ? b.burst : refilled;
}

/** Can a bucket afford `amount` at time `now`? */
export function affords(b: Bucket, amount: bigint, now: number | bigint): boolean {
  return availableAt(b, now) >= amount;
}
