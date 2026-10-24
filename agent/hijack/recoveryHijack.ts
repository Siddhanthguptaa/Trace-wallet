/**
 * H7 recovery hijack (EXPERIMENTS X6, problem statement "recover with 3 of 5 guardians after a
 * 48-hour delay, with an owner veto"). The attacker holds the leaked agent key plus guardian keys
 * and tries to take the wallet over through the recovery path. Two variants, by seed:
 *
 *   V1 two guardian keys   propose + approve (2 of 5), try to execute at once and again after the delay
 *   V2 three guardian keys quorum reached, but the owner notices inside the 48 h window and vetoes
 *
 * Both must end with the owner unchanged and the agent key's policy untouched. A takeover by three
 * colluding guardians against an absent owner is the stated trust assumption (THREAT_MODEL), not a
 * hijack the contract can stop; it is exercised on the success path in recoveryFlow.ts.
 */
import type { Address, Hex } from 'viem';
import type { RunContext, RunRecord } from './types.ts';
import { hijackRecord, observe, warp } from './harness.ts';
import { send } from '../src/world/deploy.ts';

const DELAY = 48 * 3600;

export async function recoveryHijack(ctx: RunContext): Promise<RunRecord> {
  const w = ctx.world;
  const acct = ctx.wallet.address;
  const guard = [w.keys.guardian0, w.keys.guardian1, w.keys.guardian2, w.keys.guardian3, w.keys.guardian4] as Hex[];
  const thief = w.addrOf.attacker;
  const tx = async (pk: Hex, fn: string, args: unknown[] = []): Promise<boolean> => {
    try {
      await send(w, pk, acct, w.accountAbi, fn, args);
      return true;
    } catch {
      return false;
    }
  };
  const ownerOf = async () => ((await w.c.pub.readContract({ address: acct, abi: w.accountAbi, functionName: 'owner' })) as Address).toLowerCase();
  const owner0 = await ownerOf();
  const ops = [];
  const metrics: Record<string, string | number | boolean> = {};

  // The leaked AGENT key is not a guardian: it cannot even propose.
  metrics.agentKeyCanPropose = await tx(ctx.wallet.agentKey, 'proposeRecovery', [thief]);
  ops.push(await observe(ctx, 'agent_key_propose'));

  const variant = ctx.rng() < 0.5 ? 'V1_two_guardians' : 'V2_three_guardians_owner_vetoes';
  metrics.variant = variant;
  const quorum = variant === 'V1_two_guardians' ? 2 : 3;
  metrics.proposed = await tx(guard[0]!, 'proposeRecovery', [thief]);
  ops.push(await observe(ctx, 'propose'));
  for (let i = 1; i < quorum; i++) {
    await tx(guard[i]!, 'approveRecovery', [1n]);
    ops.push(await observe(ctx, `approve#${i}`));
  }
  // Skip the delay: execute immediately (anyone may call).
  metrics.executedEarly = await tx(w.keys.attacker, 'executeRecovery');
  ops.push(await observe(ctx, 'execute_early'));

  if (variant === 'V2_three_guardians_owner_vetoes') {
    await warp(ctx, Math.floor(DELAY * (0.2 + ctx.rng() * 0.7))); // the owner notices inside the window
    metrics.vetoed = await tx(w.keys.owner, 'vetoRecovery');
    ops.push(await observe(ctx, 'owner_veto'));
  }
  await warp(ctx, DELAY + 3600);
  metrics.executedAfterDelay = await tx(w.keys.attacker, 'executeRecovery');
  ops.push(await observe(ctx, 'execute_after_delay'));

  const ownerChanged = (await ownerOf()) !== owner0;
  const keyStillLive = !((await w.c.pub.readContract({ address: acct, abi: w.accountAbi, functionName: 'sessionOf', args: [ctx.wallet.agentAddress] })) as [bigint, { revoked: boolean }])[1].revoked;
  metrics.ownerChanged = ownerChanged;
  metrics.agentKeyUntouched = keyStillLive;
  metrics.boundHeld = !ownerChanged && keyStillLive && metrics.executedEarly === false && metrics.executedAfterDelay === false && metrics.agentKeyCanPropose === false;
  return hijackRecord('H7', ctx, ops, 0n, `${variant}: owner ${ownerChanged ? 'CHANGED' : 'unchanged'}`, { reachedWallet: false, metrics });
}
