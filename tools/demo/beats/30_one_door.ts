/**
 * Beat 30 (M3): D1 one door. The leaked agent key signs EIP-3009 / EIP-2612 authorizations for the
 * attacker; the token asks the account through ERC-1271 and gets 0xffffffff. Only a pre-registered,
 * already-debited x402 voucher (opt-in mode) is honoured, exactly once.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { e2eBeat, pick } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  return e2eBeat(ctx, {
    title: 'one door',
    script: 'scripts/e2e/onedoor.ts',
    file: 'm3_onedoor_e2e.json',
    highlights: (d) => [
      pick(d, 'owner-only: the agent key signature'),
      pick(d, 'owner-only: the token rejects'),
      pick(d, 'voucher mode: an agent envelope'),
      pick(d, 'register: registration debited'),
      pick(d, 'settle: the shop is paid'),
      pick(d, 'settle: the same nonce'),
      pick(d, 'reclaim: the bucket was credited'),
    ],
  });
}
