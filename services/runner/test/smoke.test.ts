/**
 * Smoke test (anvil, the REAL contracts; the mock USDC is allowed only here): fire the x402 side-door card
 * with the leaked key at four wallets and check R1/R2 lose, R3/R4 refuse, and that every payload parses with
 * the FRONTEND's own schemas (web/src/api/schemas.ts).
 */
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as S from '../../../web/src/api/schemas.ts';
import { deployBase, deployWallet, type World } from '../../../agent/src/world/deploy.ts';
import { harnessEnv } from '../../../agent/src/env.ts';
import { createRunnerApp } from '../src/app.ts';
import type { ConfigId, RunnerOptions } from '../src/config.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
let world: World;
let app: ReturnType<typeof createRunnerApp>;

beforeAll(async () => {
  world = await deployBase({ env: harnessEnv() });
  const wallets: RunnerOptions['wallets'] = {};
  for (const id of ['R1', 'R2', 'R3', 'R4'] as ConfigId[]) {
    const w = await deployWallet(world, id);
    wallets[id] = { address: w.address, kind: w.kind };
  }
  app = createRunnerApp({
    root: ROOT,
    chainId: world.chainId,
    rpcUrl: world.c.rpcUrl,
    usdc: world.usdc,
    entryPoint: world.ep,
    agentKey: world.keys.agent,
    relayerKey: world.keys.relayer,
    attackerAddress: world.addrOf.attacker,
    attestorKey: world.keys.attestor,
    wallets,
  });
});
afterAll(() => world?.anvil.stop());

describe('runner', () => {
  it('serves the frontend contract and runs a real card: R1/R2 lose, R3/R4 refuse', async () => {
    const get = async (p: string) => (await app.request(p)).json();
    expect(S.card.array().parse(await get('/v1/cards'))).toHaveLength(13);
    expect(S.walletConfig.array().parse(await get('/v1/configs'))).toHaveLength(4);
    expect(S.bounty.parse(await get('/v1/bounty')).agentPrivateKey).toBe(world.keys.agent);
    const table = S.x1Table.parse(await get('/v1/results'));
    expect(table.rows.length).toBeGreaterThanOrEqual(13);
    expect(table.rows.find((r) => r.cardId === 'x402_side_door')!.cells.R4.outcome).toBe('refused');

    const started = await app.request('/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: 'x402_side_door', shooter: 'raw' }) });
    const { runId } = S.runStarted.parse(await started.json());
    const busy = await app.request('/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: 'approve_max' }) });
    expect(busy.status).toBe(409);

    const text = await (await app.request(`/v1/runs/${runId}/events`)).text();
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => S.runEvent.parse(JSON.parse(l.slice(5).trim())));
    expect(events.at(-1)!.type).toBe('done');
    const attempt = (c: string) => events.find((e) => e.type === 'attempt' && e.config === c) as Extract<S.RunEvent, { type: 'attempt' }>;
    for (const lost of ['R1', 'R2']) {
      expect(attempt(lost).outcome).toBe('lost');
      expect(attempt(lost).amount).toBe(1_000_000n);
    }
    for (const held of ['R3', 'R4']) {
      expect(attempt(held).outcome).toBe('refused');
      expect(attempt(held).amount).toBeUndefined();
    }
  });
});
