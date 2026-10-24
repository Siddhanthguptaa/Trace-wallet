/**
 * Beat 59 (live hijack): the agent's private key is handed to an attacker on a fresh chain and the
 * attacks run live with a running loss counter against the daily limit, once with every defence on
 * (the key freezes) and once with every detector off (the caps alone bound the loss). The key is a
 * throwaway local dev key. Script: agent/hijack/liveDemo.ts -> results/demo_hijack_live.json.
 */
import { join } from 'node:path';
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { readResult, runTsx } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  const r = runTsx('hijack/liveDemo.ts', join(ctx.root, 'agent'), {}, 420_000);
  const d = readResult<{ ok: boolean; dailyLimitBaseUnits: string; phases: { name: string; mode: string; gainBaseUnits: string; frozenAtOp: number | null }[]; lines: string[] }>(ctx, 'demo_hijack_live.json');
  if (!d) return { ok: false, summary: `live hijack demo wrote no result (exit ${r.status}): ${r.tail}` };
  for (const l of d.lines) ctx.log(l);
  const usdc = (x: string) => (Number(BigInt(x)) / 1e6).toFixed(2);
  return {
    ok: d.ok && r.status === 0,
    summary: `live hijack: ${d.phases.map((p) => `${p.name} gained ${usdc(p.gainBaseUnits)} USDC${p.frozenAtOp ? ` (frozen at op ${p.frozenAtOp})` : ''}`).join('; ')}; daily limit ${usdc(d.dailyLimitBaseUnits)} USDC`,
    details: { phases: d.phases },
  };
}
