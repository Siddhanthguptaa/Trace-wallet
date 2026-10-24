/**
 * Beat 50 (M5): owner outcome approvals on the real account through the HTTP approval service
 * (approved / price+1 tampered / replays / PAYEE transfer / foreign key), then 13 adversarial
 * approvals built by hand straight at the account (wrong chain, wrong account, tampered calldata,
 * expired, agent-signed, cancelled nonce, over-maxOutflow).
 */
import { join } from 'node:path';
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { readResult, runTsx } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  const svc = join(ctx.root, 'services', 'approval');
  const env = { E2E_TARGET_MODULE: join(svc, 'scripts', 'lib', 'realTarget.ts') };
  const run = runTsx(join(svc, 'scripts', 'e2e.ts'), svc, env);
  const d = readResult(ctx, 'm5_approval_e2e.json');
  const chk = runTsx(join(svc, 'scripts', 'account-checks.ts'), svc);
  const c = readResult(ctx, 'm5_approval_account_checks.json');
  if (!d || !d.realAccount) return { ok: false, summary: `approval e2e produced no real-account result (exit ${run.status}): ${run.tail}` };
  if (!c) return { ok: false, summary: `approval account checks produced no result (exit ${chk.status}): ${chk.tail}` };
  ctx.log(`service e2e on AgentAccount: approved=${d.approved} (simulated ${d.details.approved.simulatedOutflow}, measured ${d.details.approved.measuredOutflow})`);
  ctx.log(`  shop raises its price +1 after the owner signed -> ${d.tampered} (${d.details.tampered.reason}; moved ${d.details.tampered.moved})`);
  ctx.log(`  replays -> ${d.replay}; PAYEE transfer -> ${d.payeeTransfer}; foreign key refused -> ${d.foreignKeyRefused}`);
  ctx.log(`direct-to-account approval checks: ${c.passed}/${c.total}`);
  for (const x of c.checks as { name: string; observed: string; pass: boolean }[]) if (!x.pass) ctx.log(`  FAIL ${x.name} -> ${x.observed}`);
  return {
    ok: d.ok === true && run.status === 0 && c.ok === true,
    summary: `approval: approved=${d.approved} tampered=${d.tampered} replay=${d.replay}; account checks ${c.passed}/${c.total}`,
    details: { e2e: 'results/m5_approval_e2e.json', accountChecks: 'results/m5_approval_account_checks.json' },
  };
}
