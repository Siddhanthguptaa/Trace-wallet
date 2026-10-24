/**
 * Beat 10 (M1): the ERC-4337 account core on the REAL AgentAccount: owner path, in-policy agent,
 * allowed contracts / functions, recipient arguments, per-tx limit, exploration track for unproven
 * payees, owner-only admin, signature / nonce / chain-id validation, replay, revocation, expiry.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { e2eBeat, pick } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  return e2eBeat(ctx, {
    title: 'core',
    script: 'scripts/e2e/core.ts',
    file: 'm1_core_e2e.json',
    highlights: (d) => [
      pick(d, 'agent: in-policy transfer'),
      pick(d, 'argument rule: buy(ticket, attacker)'),
      pick(d, 'per-transaction limit'),
      pick(d, 'allowed recipients'),
      pick(d, 'unproven payee'),
      pick(d, 'wrong chain id'),
      pick(d, 'replay'),
      pick(d, 'expiry: an op after'),
    ],
  });
}
