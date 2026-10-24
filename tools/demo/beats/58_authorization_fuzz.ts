/**
 * Beat 58 (I11): the fuzzed authorization invariant. Reads the long-profile campaign results
 * (results/forge_summary_i11.json + results/i11.json) written by
 * `FOUNDRY_PROFILE=invariant forge test --match-path 'test/invariant/I11_*' --json` and
 * `python tools/i11_summary.py`; fails clearly if they are absent or show a violation.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { readResult } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  const sum = readResult(ctx, 'forge_summary_i11.json');
  const cov = readResult(ctx, 'i11.json');
  if (!sum || !cov) return { ok: false, summary: 'missing results/forge_summary_i11.json or results/i11.json: run the I11 long profile and tools/i11_summary.py' };
  const campaigns = Object.entries(cov.campaigns as Record<string, any>);
  let runs = 0;
  for (const [name, c] of campaigns) {
    runs += c.fuzzRuns;
    ctx.log(`${name}: ${c.fuzzRuns} fuzz runs; ${c.ownerMoves} owner moves, ${c.agentMoves} agent moves, ${c.unauthorizedAttempts} no-authority attempts, ${c.recoveriesExecuted} executed recoveries, ${c.forgedOrReplayedOpsAccepted} forged/replayed ops accepted`);
  }
  const forged = campaigns.reduce((a, [, c]) => a + c.forgedOrReplayedOpsAccepted, 0);
  const ok = sum.failed === 0 && sum.passed >= 3 && forged === 0 && campaigns.every(([, c]) => c.runsWithAgentMove > 0 && c.runsWithRecovery > 0);
  return {
    ok,
    summary: `I11 funds move only with owner / in-policy agent / recovery approval: ${sum.passed} invariants passed, ${sum.failed} failed over ${runs} fuzz runs; ${forged} forged ops accepted`,
    details: { forge: 'results/forge_summary_i11.json', coverage: 'results/i11.json' },
  };
}
