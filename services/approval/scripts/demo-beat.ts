/**
 * Beat 50 (M5, APPS) body. tools/ is outside the APPS lane, so INT adds
 *   tools/demo/beats/50_approval.ts:  export { default } from '../../../services/approval/scripts/demo-beat.ts';
 * Runs the approval e2e on its own anvil and reports approved / tampered / replay. Labelled
 * "stub account" until INT supplies E2E_TARGET_MODULE for the real AgentAccount.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BeatContext, BeatResult } from '../../../tools/lib/common.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  const svc = join(ctx.root, 'services', 'approval');
  const tsx = [join(svc, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ctx.root, 'node_modules', 'tsx', 'dist', 'cli.mjs')].find(existsSync);
  if (!tsx) return { ok: false, summary: 'tsx not installed (run pnpm install)' };
  const r = spawnSync(process.execPath, [tsx, join(svc, 'scripts', 'e2e.ts')], { cwd: svc, encoding: 'utf8', timeout: 240_000 });
  const real = !!process.env.E2E_TARGET_MODULE;
  const file = join(ctx.root, 'results', real ? 'm5_approval_e2e.json' : 'm5_approval_e2e_stub.json');
  if (r.status !== 0 || !existsSync(file)) return { ok: false, summary: `approval e2e failed (exit ${r.status}): ${(r.stderr ?? '').slice(-300)}` };
  const d = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  ctx.log(`account: ${d.realAccount ? 'AgentAccount' : 'approval stub (TypedData.sol digest)'} on anvil ${d.chainId}`);
  ctx.log(`owner-approved order: simulated ${d.details.approved.simulatedOutflow}, measured ${d.details.approved.measuredOutflow} -> ${d.approved}`);
  ctx.log(`shop raises price +1 after signing -> ${d.tampered} (${d.details.tampered.reason}; moved ${d.details.tampered.moved})`);
  ctx.log(`replays: resend ${d.details.replay.resendExecutedOp.reason}; old approval ${d.details.replay.oldApprovalOnNewOp.reason}; old owner sig HTTP ${d.details.replay.oldOwnerSigOnNewRequest.http} -> ${d.replay}`);
  return {
    ok: d.ok === true,
    summary: `approval: approved=${d.approved} tampered=${d.tampered} replay=${d.replay}${d.realAccount ? '' : ' (stub account)'}`,
    details: { file: relative(ctx.root, file).split('\\').join('/'), realAccount: d.realAccount },
  };
}
