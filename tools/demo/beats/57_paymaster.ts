/**
 * Beat 57 (M12): sponsored gas with a per-agent quota that spam cannot drain. The hijacked key spams
 * reverting ops with the ATTACKER as bundler; its gain is bounded by the quota and a second agent is
 * unaffected.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { e2eBeat, pick } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  return e2eBeat(ctx, {
    title: 'paymaster',
    script: 'scripts/e2e/paymaster.ts',
    file: 'm12_paymaster_e2e.json',
    highlights: (d) => [
      pick(d, 'sponsored in-policy op'),
      `spam: ${d.metrics.spamAccepted} sponsored, ${d.metrics.spamRefused} refused; attacker gain ${d.metrics.attackerGainWei} wei <= bound ${d.metrics.quotaWindowBoundWei} wei`,
      pick(d, 'A\'s spam leaves B\'s quota'),
      pick(d, 'an account the owner did not register'),
      pick(d, 'a gas field above'),
      pick(d, 'after 24 h'),
    ],
  });
}
