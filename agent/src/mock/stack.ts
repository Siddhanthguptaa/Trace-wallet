/**
 * Per-chain mock stack for the shooters / X6 runner: the mock x402 seller and the scripted mock
 * attestor on free ports, bound to one World. The attestor issues PROVEN only for the legit
 * stream's attested payees (fixtures/legit_stream.json attestorTiers); everything else is cold
 * start. Set USE_REAL_ATTESTOR=1 (plus ATTESTOR_URL) to point R4 at services/attestor instead.
 */
import { serve, type ServerType } from '@hono/node-server';
import type { World } from '../world/deploy.ts';
import { freePort, devchain } from '../chain/anvil.ts';
import { createMockAttestor } from './attestor.ts';
import { createX402Seller } from './x402Seller.ts';
import { loadFixture } from '../world/policy.ts';

export interface MockStack {
  sellerBase: string;
  attestorUrl: string;
  stop: () => void;
}

export async function startMocks(w: World, extraProven: string[] = []): Promise<MockStack> {
  const legit = loadFixture<{ attestorTiers: Record<string, string> }>('legit_stream.json');
  const tiers: Record<string, 'PROVEN' | 'UNPROVEN' | 'FLAGGED'> = {};
  for (const [name, t] of Object.entries(legit.attestorTiers)) if (t === 'PROVEN' && w.labels[name]) tiers[w.labels[name]!.toLowerCase()] = 'PROVEN';
  for (const a of extraProven) tiers[a.toLowerCase()] = 'PROVEN';
  const servers: ServerType[] = [];
  const sellerPort = await freePort();
  servers.push(serve({ fetch: createX402Seller(w).fetch, port: sellerPort, hostname: '127.0.0.1' }));
  let attestorUrl = w.env.attestorUrl;
  if (process.env.USE_REAL_ATTESTOR !== '1') {
    const attPort = await freePort();
    const app = createMockAttestor({
      attestorKey: w.keys.attestor,
      chainId: w.chainId,
      tiers,
      epochOf: (acct) => w.c.pub.readContract({ address: acct, abi: w.accountAbi, functionName: 'attestEpoch', args: [] }) as Promise<bigint>,
      now: () => devchain.now(w.c.rpcUrl),
    });
    servers.push(serve({ fetch: app.fetch, port: attPort, hostname: '127.0.0.1' }));
    attestorUrl = `http://127.0.0.1:${attPort}`;
  }
  return {
    sellerBase: `http://127.0.0.1:${sellerPort}`,
    attestorUrl,
    stop: () => {
      for (const s of servers) s.close();
    },
  };
}
