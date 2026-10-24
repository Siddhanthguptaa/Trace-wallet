/** HTTP API end to end in-process: cold start, proven, Sybil ring flagged + flag sent, epoch, scripted mode. */
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { recoverScoreAttestationSigner } from '../../../packages/shared/src/attestor/typedData.ts';
import { DEV_KEYS } from '../scripts/lib/devchain.ts';
import { createApp } from '../src/app.ts';
import { Attestor } from '../src/attestor.ts';
import { AttestationSigner } from '../src/signer.ts';
import { Store } from '../src/store.ts';
import { AGENT, CHAIN_ID, OWNER, VERIFIER, addr, fake, makeAttestor, signedOutcome } from './helpers.ts';

const WALLET = getAddress(fake('wallet-main'));
const SHOP = getAddress(fake('legit-new-shop'));

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await app.request('/v1/outcomes', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
async function attest(app: ReturnType<typeof createApp>, wallet: string, payee: string) {
  const res = await app.request(`/v1/attest?wallet=${wallet}&payee=${payee}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('attestor HTTP API', () => {
  it('cold start: 404 no_attestation (UNPROVEN); 2 successes: still 404; 3 verifier successes: 200 PROVEN', async () => {
    const { attestor, signer } = makeAttestor({ epoch: 3n, now: 1_800_000_000 });
    const app = createApp(attestor);
    expect(await attest(app, WALLET, SHOP)).toMatchObject({ status: 404, body: { error: 'no_attestation', tier: 'UNPROVEN', code: null, reason: 'cold_start' } });

    for (let i = 0; i < 2; i++) {
      const r = await post(app, await signedOutcome(DEV_KEYS.verifier, 'verifier', { wallet: fake(`buyer${i}`), payee: SHOP, success: true }));
      expect(r.status).toBe(200);
    }
    expect(await attest(app, WALLET, SHOP)).toMatchObject({ status: 404, body: { tier: 'UNPROVEN', code: 'ROUTE_WITH_CAUTION' } });

    await post(app, await signedOutcome(DEV_KEYS.verifier, 'verifier', { wallet: fake('buyer2'), payee: SHOP, success: true }));
    const a = await attest(app, WALLET, SHOP);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ tier: 'PROVEN', tierCode: 1, epoch: '3', wallet: WALLET, payee: SHOP, chainId: CHAIN_ID, code: 'ROUTE' });
    // validUntil = now + 24 h (now() ticks once per call in the helper)
    expect(a.body.validUntil - 1_800_000_000).toBeGreaterThanOrEqual(86_400);
    expect(a.body.validUntil - 1_800_000_000).toBeLessThan(86_400 + 20);
    const rec = await recoverScoreAttestationSigner(CHAIN_ID, WALLET, { recipient: SHOP, tier: 1, validUntil: a.body.validUntil, epoch: 3n }, a.body.signature);
    expect(rec).toBe(signer.address);

    const score = await (await app.request(`/v1/score?payee=${SHOP}`)).json();
    expect(score).toMatchObject({ totalJobs: 3, successes: 3, failures: 0, tier: 'PROVEN' });
  });

  it('agent-only report: 202 ignored, no effect on tier', async () => {
    const { attestor } = makeAttestor();
    const app = createApp(attestor);
    for (let i = 0; i < 5; i++) {
      const r = await post(app, await signedOutcome(DEV_KEYS.agent, 'verifier', { wallet: fake(`b${i}`), payee: SHOP, success: true }));
      expect(r).toMatchObject({ status: 202, body: { accepted: false, status: 'ignored' } });
    }
    expect((await attest(app, WALLET, SHOP)).body.tier).toBe('UNPROVEN');
  });

  it('Sybil ring of owner-signed wallets turns FLAGGED: 404 + flag(payee) sent on every served wallet', async () => {
    // Attacker owns three AgentAccounts that pay each other in a ring (owner-signed, so accepted).
    const ring = ['s1', 's2', 's3'].map((t) => getAddress(fake(t)));
    const owners = Object.fromEntries(ring.map((w) => [w, addr(DEV_KEYS.attacker)]));
    const { attestor, chain } = makeAttestor({ owners: { ...owners, [WALLET]: OWNER } });
    const app = createApp(attestor);
    expect((await attest(app, WALLET, ring[1]!)).status).toBe(404); // WALLET is now a served wallet
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) {
        const r = await post(app, await signedOutcome(DEV_KEYS.attacker, 'owner', { wallet: ring[i]!, payee: ring[(i + 1) % 3]!, success: true }));
        expect(r.status).toBe(200);
      }
    }
    const prof = attestor.profile(ring[1]!);
    expect(prof.sybilRisk).toBeGreaterThan(0.5);
    expect(prof).toMatchObject({ tier: 'FLAGGED', code: 'QUARANTINE' });
    const a = await attest(app, WALLET, ring[1]!);
    expect(a).toMatchObject({ status: 404, body: { tier: 'FLAGGED', code: 'QUARANTINE' } });
    // flag(payee) went to the served wallet (and to the ring wallets, which also "use" this attestor).
    expect(chain.flaggedPairs.has(`${WALLET.toLowerCase()}:${ring[1]!.toLowerCase()}`)).toBe(true);
    expect(attestor.store.flags().filter((f) => f.status === 'sent').length).toBeGreaterThanOrEqual(3);
    // Idempotent: a second sync sends nothing new.
    const again = (await (await app.request('/v1/flags/sync', { method: 'POST' })).json()) as { results: Array<{ status: string }> };
    expect(again.results.every((r: { status: string }) => r.status === 'already')).toBe(true);
  });

  it('a payee that defaults after earning PROVEN loses it (INVESTIGATE -> FLAGGED -> flagged on-chain)', async () => {
    const { attestor, chain } = makeAttestor();
    const app = createApp(attestor);
    await attest(app, WALLET, SHOP);
    for (let i = 0; i < 3; i++) await post(app, await signedOutcome(DEV_KEYS.verifier, 'verifier', { wallet: fake(`c${i}`), payee: SHOP, success: true }));
    expect((await attest(app, WALLET, SHOP)).status).toBe(200);
    for (let i = 0; i < 2; i++) await post(app, await signedOutcome(DEV_KEYS.verifier, 'verifier', { wallet: fake(`d${i}`), payee: SHOP, success: false }));
    const a = await attest(app, WALLET, SHOP);
    expect(a).toMatchObject({ status: 404, body: { tier: 'FLAGGED', code: 'INVESTIGATE' } });
    expect(chain.flaggedPairs.has(`${WALLET.toLowerCase()}:${SHOP.toLowerCase()}`)).toBe(true);
  });

  it('epoch read failure -> 503 (tools treat as unproven); never signs with a guessed epoch', async () => {
    const signer = new AttestationSigner(DEV_KEYS.attestor, { agents: [AGENT] });
    const attestor = new Attestor({
      chainId: CHAIN_ID,
      signer,
      store: new Store(),
      mode: 'scripted',
      scriptedTiers: { [SHOP]: 'PROVEN' },
      reader: {
        owner: async () => OWNER,
        attestor: async () => signer.address,
        attestEpoch: async () => {
          throw new Error('rpc down');
        },
        isFlagged: async () => false,
      },
    });
    const app = createApp(attestor);
    expect(await attest(app, WALLET, SHOP)).toMatchObject({ status: 503, body: { error: 'epoch_unavailable' } });
  });

  it('scripted mode (D3-lite fallback): real signatures, fixed tiers', async () => {
    const flaggedPayee = getAddress(fake('bad'));
    const { attestor, signer } = makeAttestor({ mode: 'scripted', scriptedTiers: { [SHOP]: 'PROVEN', [flaggedPayee]: 'FLAGGED' } });
    const app = createApp(attestor);
    const ok = await attest(app, WALLET, SHOP);
    expect(ok.status).toBe(200);
    expect(await recoverScoreAttestationSigner(CHAIN_ID, WALLET, { recipient: SHOP, tier: 1, validUntil: ok.body.validUntil, epoch: 1n }, ok.body.signature)).toBe(signer.address);
    expect(await attest(app, WALLET, flaggedPayee)).toMatchObject({ status: 404, body: { tier: 'FLAGGED', flag: { status: 'sent' } } });
    expect(await attest(app, WALLET, fake('other'))).toMatchObject({ status: 404, body: { tier: 'UNPROVEN' } });
  });

  it('health and input validation', async () => {
    expect(await (await createApp().request('/health')).json()).toMatchObject({ ok: true, status: 'unconfigured' });
    expect((await createApp().request(`/v1/attest?wallet=${WALLET}&payee=${SHOP}`)).status).toBe(503);
    const { attestor } = makeAttestor();
    const app = createApp(attestor);
    expect((await app.request('/v1/attest?wallet=0x12&payee=nope')).status).toBe(400);
    expect(await (await app.request(`/v1/attest?wallet=${WALLET}&payee=${SHOP}&chainId=8453`)).json()).toMatchObject({ error: 'wrong_chain' });
    expect((await app.request(`/v1/attest?wallet=${WALLET}&payee=${SHOP}&chainId=${CHAIN_ID}`)).status).toBe(404);
    expect((await app.request('/v1/outcomes', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect(await (await app.request('/health')).json()).toMatchObject({ status: 'ready', mode: 'trace', attestor: addr(DEV_KEYS.attestor) });
    expect(VERIFIER).toBeTruthy();
  });
});
