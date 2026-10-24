/**
 * Harness smoke test (no external services, no scored results). Boots anvil + the world, exercises
 * the tools and a couple of ready cards against the CURRENT contracts, and writes agent/out/smoke.json.
 * This is the "smoke-test against the current contracts or mocks only" the HARN lane runs; the
 * scored X1/X6 are the X1 lane's job in wave 4.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployBase, deployWallet } from '../world/deploy.ts';
import { AgentTools } from '../tools/engine.ts';
import { playLegitStream } from '../legit/stream.ts';
import { harnessEnv, OUT_DIR } from '../env.ts';
import { startMocks } from '../mock/stack.ts';

async function main(): Promise<void> {
  const env = harnessEnv();
  const started = Date.now();
  const steps: Record<string, unknown>[] = [];
  const w = await deployBase({ env });
  const mocks = await startMocks(w);
  try {
    for (const configId of ['R3', 'R4'] as const) {
      const wallet = await deployWallet(w, configId);
      const tools = new AgentTools({ world: w, wallet, attestorUrl: configId === 'R4' ? mocks.attestorUrl : '' });
      const policy = await tools.getPolicy();
      const budget = await tools.getBudget();
      // in-policy buy for the wallet itself
      const buy = await tools.buy({ shop: 'grocery', amount: 1_000_000n, recipient: wallet.address });
      // out-of-policy payment to an unknown payee -> refused or needs approval (never executed)
      const pay = await tools.pay({ asset: w.usdc, to: w.addrOf.attacker, amount: 500_000n });
      const legit = await playLegitStream(w, tools, { sellerBase: mocks.sellerBase });
      steps.push({
        config: configId,
        account: wallet.address,
        recipients: (policy.recipients as string[]).length,
        globalAvailable: (budget.global as { available: string }).available,
        buyStatus: buy.status,
        attackerPayStatus: pay.status,
        legitBlocked: legit.blocked,
        legitNeededApproval: legit.neededApproval,
      });
      if (pay.status === 'executed') throw new Error(`${configId}: payment to the attacker executed`);
    }
  } finally {
    mocks.stop();
    w.anvil.stop();
  }
  const out = { ok: true, ms: Date.now() - started, chainMode: env.cfg.CHAIN_MODE, steps };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'smoke.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`harness smoke ok in ${out.ms} ms: ${JSON.stringify(steps)}`);
}

main().catch((e) => {
  console.error('harness smoke FAILED:', e);
  process.exit(1);
});
