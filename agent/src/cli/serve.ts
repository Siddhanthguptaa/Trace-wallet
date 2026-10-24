/**
 * Dev server (docs/api.md 12): start anvil, deploy the world + one wallet config, and serve the
 * agent tools (:8787), a scripted mock attestor (:8789) and the mock x402 seller (:8790). For local
 * poking and the demo beat; the shooters build their own ephemeral chains.
 *
 * Usage: pnpm --filter @hypnexis/agent tools:serve [R3|R4|X6]
 */
import { serve } from '@hono/node-server';
import { deployBase, deployWallet } from '../world/deploy.ts';
import { AgentTools } from '../tools/engine.ts';
import { createToolsServer } from '../tools/server.ts';
import { createMockAttestor } from '../mock/attestor.ts';
import { createX402Seller } from '../mock/x402Seller.ts';
import { harnessEnv } from '../env.ts';
import { devchain } from '../chain/anvil.ts';
import { loadLegitStream } from '../legit/stream.ts';

async function main(): Promise<void> {
  const configId = process.argv[2] ?? 'R4';
  const env = harnessEnv();
  const w = await deployBase({ env });
  const wallet = await deployWallet(w, configId);
  const legit = loadLegitStream();
  const proven = new Set(Object.entries((legit as unknown as { attestorTiers: Record<string, string> }).attestorTiers).filter(([, t]) => t === 'PROVEN').map(([k]) => k));
  const tiers: Record<string, 'PROVEN' | 'UNPROVEN' | 'FLAGGED'> = {};
  for (const name of proven) tiers[w.labels[name]!.toLowerCase()] = 'PROVEN';

  const tools = new AgentTools({ world: w, wallet, attestorUrl: configId === 'R3' ? '' : env.attestorUrl, log: (m, d) => console.log(`[tools] ${m}`, d ?? '') });
  const attestor = createMockAttestor({
    attestorKey: w.keys.attestor,
    chainId: w.chainId,
    tiers,
    epochOf: (acct) => w.c.pub.readContract({ address: acct, abi: w.accountAbi, functionName: 'attestEpoch', args: [] }) as Promise<bigint>,
    now: () => devchain.now(w.c.rpcUrl),
  });

  serve({ fetch: createToolsServer(tools, { sellerBase: `http://127.0.0.1:${env.sellerPort}` }).fetch, port: env.toolsPort });
  serve({ fetch: attestor.fetch, port: 8789 });
  serve({ fetch: createX402Seller(w).fetch, port: env.sellerPort });
  console.log(`world up: anvil ${w.anvil.rpcUrl}, wallet ${configId} ${wallet.address}`);
  console.log(`tools    http://127.0.0.1:${env.toolsPort}/v1/tools`);
  console.log(`attestor http://127.0.0.1:8789/v1`);
  console.log(`x402     http://127.0.0.1:${env.sellerPort}`);
  console.log('Ctrl-C to stop.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
