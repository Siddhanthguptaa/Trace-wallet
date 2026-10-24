/**
 * The one smoke test: real contracts on anvil, the REAL approval and attestor services in process,
 * the gateway on top, and every response parsed with the frontend's ORIGINAL schema file
 * (web/src/api/schemas.ts), so contract drift fails here. (MockUSDC / anvil exist only in this test.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployBase, deployWallet, type Wallet, type World } from '../../../agent/src/world/deploy.ts';
import { loadApprovalConfig } from '../../approval/src/config.ts';
import { buildService } from '../../approval/src/build.ts';
import { createApp as createApprovalApp } from '../../approval/src/app.ts';
import { loadAttestorConfig } from '../../attestor/src/config.ts';
import { buildAttestor } from '../../attestor/src/build.ts';
import { createApp as createAttestorApp } from '../../attestor/src/app.ts';
import { createGatewayApp } from '../src/app.ts';
import type { GatewayConfig } from '../src/config.ts';
import * as S from '../../../web/src/api/schemas.ts';

let w: World;
let wallet: Wallet;
let app: ReturnType<typeof createGatewayApp>;
const servers: { close: () => void }[] = [];

function listen(fetch: (r: Request) => Response | Promise<Response>): Promise<string> {
  return new Promise((res) => {
    const s = serve({ fetch, port: 0, hostname: '127.0.0.1' }, (i) => res(`http://127.0.0.1:${i.port}`));
    servers.push(s as unknown as { close: () => void });
  });
}

const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => app.request(path);

beforeAll(async () => {
  w = await deployBase({});
  wallet = await deployWallet(w, 'R4');
  const env = { RPC_URL: w.c.rpcUrl, CHAIN_ID: String(w.chainId), ENTRYPOINT: w.ep };
  const approvalUrl = await listen(createApprovalApp(buildService(loadApprovalConfig({ ...env, RELAYER_PRIVATE_KEY: w.keys.relayer, APPROVAL_DB: ':memory:', AGENT_ADDRESSES: w.addrOf.agent })) as never).fetch);
  const attestorUrl = await listen(
    createAttestorApp(
      buildAttestor(loadAttestorConfig({ ...env, ATTESTOR_PRIVATE_KEY: w.keys.attestor, ATTESTOR_MODE: 'scripted', ATTESTOR_DB: ':memory:', AGENT_PRIVATE_KEY: w.keys.agent, WALLETS: wallet.address } as never)),
    ).fetch,
  );
  const cfg: GatewayConfig = {
    port: 0,
    chainId: w.chainId,
    rpcUrl: w.c.rpcUrl,
    entryPoint: w.ep,
    usdc: w.usdc,
    usdcSymbol: 'USDC',
    usdcDecimals: 6,
    wallet: wallet.address,
    lens: w.lens ?? undefined,
    agentKey: w.keys.agent,
    relayerKey: w.keys.relayer,
    approvalUrl,
    attestorUrl,
    forgeOut: 'out',
    maxFeeWei: 10_000_000n, // anvil quotes 1 gwei; the demo policy's 0.001 ETH gas credit assumes Base-like fees
    corsOrigins: ['http://localhost:5173'],
  };
  app = createGatewayApp({ cfg });
}, 180_000);

afterAll(() => {
  for (const s of servers) s.close();
  w?.anvil.stop();
});

describe('gateway smoke: real responses parse with the frontend schemas', () => {
  it('wire.ts is a byte copy of the frontend schema file', () => {
    const a = readFileSync(resolve(import.meta.dirname, '../src/wire.ts'), 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(resolve(import.meta.dirname, '../../../web/src/api/schemas.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(a).toBe(b);
  });

  it('policy, budget, pay, approvals, attestor, runner', async () => {
    expect((await get('/health')).status).toBe(200);

    const pol = S.policy.parse(await (await post('/tools/get_policy', { wallet: wallet.address })).json());
    expect(pol.wallet).toBe(wallet.address);
    expect(pol.keys.length).toBeGreaterThan(0);
    expect(pol.assets[0]!.globalCap).toBeGreaterThan(0n);
    const bud = S.budget.parse(await (await post('/tools/get_budget', { wallet: wallet.address })).json());
    expect(bud.buckets.some((b) => b.scope === 'global')).toBe(true);

    // in-policy payment to an owner-listed shop executes on chain
    const ok = S.payResult.parse(await (await post('/tools/pay', { wallet: wallet.address, to: w.api, asset: w.usdc, amount: '100000' })).json());
    expect(ok.status, JSON.stringify(ok, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe('executed');
    expect(ok.txHash).toBeTruthy();

    // an unknown payee above the exploration cap is NOT executed: it becomes an owner approval request
    const stranger = '0x00000000000000000000000000000000000d00d1';
    const need = S.payResult.parse(await (await post('/tools/pay', { wallet: wallet.address, to: stranger, asset: w.usdc, amount: '500000' })).json());
    expect(need.status).toBe('approval_requested');
    expect(need.approvalId).toBeTruthy();

    const list = S.approvalSummary.array().parse(await (await get(`/v1/requests?wallet=${wallet.address}`)).json());
    expect(list.some((r) => r.id === need.approvalId)).toBe(true);
    const req = S.approvalRequest.parse(await (await get(`/v1/requests/${need.approvalId}`)).json());
    expect(req.status).toBe('pending');
    expect(req.typedData?.primaryType).toBe('OutcomeApproval');

    // the owner signs the typed data (what MetaMask's eth_signTypedData_v4 does) and the real service relays it
    const owner = privateKeyToAccount(w.keys.owner);
    const t = req.typedData!;
    const signature = await owner.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: reviveBigints(t.types as never, t.primaryType, t.message) } as never);
    const signed = S.approvalRequest.parse(await (await post(`/v1/requests/${need.approvalId}/signature`, { signature })).json());
    expect(['signed', 'executed', 'reverted'], String(signed.revertReason)).toContain(signed.status);

    const att = S.attestation.parse(await (await get(`/v1/attest?wallet=${wallet.address}&payee=${stranger}`)).json());
    expect('attestation' in att).toBe(true); // a payee with no history gets no attestation

    const cards = await get('/v1/cards');
    expect([200, 503]).toContain(cards.status); // the runner is mounted when services/runner exists
  }, 180_000);
});

/** typed-data message numbers arrive as decimal strings; viem wants bigint for uint / int fields (by declared type). */
function reviveBigints(types: Record<string, { name: string; type: string }[]>, primary: string, m: Record<string, unknown>): Record<string, unknown> {
  const conv = (type: string, v: unknown): unknown => {
    if (type.endsWith('[]')) return (v as unknown[]).map((x) => conv(type.slice(0, -2), x));
    if (types[type]) return Object.fromEntries(types[type]!.map((f) => [f.name, conv(f.type, (v as Record<string, unknown>)[f.name])]));
    if (/^u?int\d*$/.test(type)) return BigInt(v as string);
    return v;
  };
  return conv(primary, m) as Record<string, unknown>;
}
