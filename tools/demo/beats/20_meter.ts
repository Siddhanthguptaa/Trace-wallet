/**
 * Beat 20 (M2): D2 effect metering on the real account. A greedy merchant pulls 10x through an
 * owner-granted allowance and is blocked with nothing moved; approve-then-pull counts once; the
 * daily limit holds across UTC midnight and across three session keys.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { e2eBeat, pick } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  return e2eBeat(ctx, {
    title: 'meter',
    script: 'scripts/e2e/meter.ts',
    file: 'm2_meter_e2e.json',
    highlights: (d) => [
      pick(d, 'greedy merchant: buy()'),
      pick(d, 'once: a further 5 USDC'),
      `midnight: ${d.metrics.midnightExecutedBefore} payments before midnight, ${d.metrics.midnightExecutedAfter} after; window outflow ${d.metrics.midnightWindowOutflow} <= ${d.dailyLimit}`,
      `multi-key: executed ${d.metrics.multiKeyExecuted}, total ${d.metrics.multiKeyOutflow} <= ${d.dailyLimit}`,
    ],
  });
}
