/**
 * Beat 55 (M10): automatic freeze on unusual spending. On-chain tripwire (6th unproven payee), the
 * off-chain watcher (approval-request flood) through the escalate-only role, owner-only unfreeze.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { e2eBeat, pick } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  return e2eBeat(ctx, {
    title: 'freeze',
    script: 'scripts/e2e/freeze.ts',
    file: 'm10_freeze_e2e.json',
    highlights: (d) => [
      pick(d, 'T2:'),
      `spray loss ${d.metrics.sprayLossBaseUnits} base units (exploration cap 1000000)`,
      pick(d, 'a frozen key is refused'),
      pick(d, 'watcher: the 7th approval request'),
      pick(d, 'the watcher cannot unfreeze'),
      pick(d, 'after the owner unfreezes'),
    ],
  });
}
