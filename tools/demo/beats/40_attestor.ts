/**
 * Beat 40 (M6, ATT): the TRACE attestor end to end on its own anvil, through its HTTP API:
 * cold start gets no attestation, agent-only reports are ignored, three x402 purchases earn a
 * PROVEN attestation the wallet accepts, and an owner-signed Sybil ring gets flag(payee) on-chain.
 * Until INT wires the real AgentAccount (E2E_TARGET_MODULE), the wallet is the TypedData.sol stub,
 * and the beat says so.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BeatContext, BeatResult } from '../../lib/common.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  const svc = join(ctx.root, 'services', 'attestor');
  const tsx = [join(svc, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ctx.root, 'node_modules', 'tsx', 'dist', 'cli.mjs')].find(existsSync);
  if (!tsx) return { ok: false, summary: 'tsx not installed (run pnpm install)' };
  const r = spawnSync(process.execPath, [tsx, join(svc, 'scripts', 'e2e.ts')], { cwd: svc, encoding: 'utf8', timeout: 180_000 });
  const real = !!process.env.E2E_TARGET_MODULE;
  const file = join(ctx.root, 'results', real ? 'm6_attestor_e2e.json' : 'm6_attestor_e2e_stub.json');
  if (r.status !== 0 || !existsSync(file)) return { ok: false, summary: `attestor e2e failed (exit ${r.status}): ${(r.stderr ?? '').slice(-300)}` };
  const d = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  ctx.log(`attestor ${d.attestor} on anvil, wallet ${d.wallet} (${d.realAccount ? 'AgentAccount' : 'TypedData.sol stub'})`);
  ctx.log(`cold-start payee -> no attestation: ${d.coldStartUnproven}`);
  ctx.log(`agent-only outcome reports ignored (HTTP ${d.details.agentOnly.statuses.join(',')}): ${d.agentOnlyIgnored}`);
  ctx.log(`3 x402 purchases -> PROVEN attestation (epoch ${d.details.proven.epoch}), wallet check ${d.details.proven.onChainCheck}: ${d.provenAccepted}`);
  ctx.log(`Sybil ring (risk ${d.details.sybil.sybilRisk}) -> ${d.details.sybil.code} -> flag tx ${d.details.sybil.flagTx}: ${d.flaggedOnChain}`);
  return {
    ok: d.ok === true,
    summary: `attestor: proven=${d.provenAccepted} flagged=${d.flaggedOnChain} cold=${d.coldStartUnproven} agentIgnored=${d.agentOnlyIgnored}${d.realAccount ? '' : ' (stub wallet)'}`,
    details: { file: relative(ctx.root, file).split('\\').join('/'), realAccount: d.realAccount },
  };
}
