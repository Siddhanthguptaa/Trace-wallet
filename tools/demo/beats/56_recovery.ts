/**
 * Beat 56 (M11): guardian recovery. 3 of 5 guardians, 48 h delay, owner veto; funds never move;
 * agent keys are revoked; a quorum short of 3 never executes.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { e2eBeat, pick } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  return e2eBeat(ctx, {
    title: 'recovery',
    script: 'scripts/e2e/recovery.ts',
    file: 'm11_recovery_e2e.json',
    highlights: (d) => [
      pick(d, 'A. execute with 2 of 5'),
      pick(d, 'A. execute 1 h before the delay'),
      pick(d, 'A. execute after 48 h'),
      pick(d, 'A. every agent session was revoked'),
      pick(d, 'A. recovery moved no funds'),
      pick(d, 'B. the owner vetoes'),
      pick(d, 'B. execute after the delay fails'),
      pick(d, 'C. 2 of 5 never executes'),
    ],
  });
}
