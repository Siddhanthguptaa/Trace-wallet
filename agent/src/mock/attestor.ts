/**
 * Scripted mock attestor: the docs/api.md section 15 HTTP surface (GET /health, GET /v1/attest)
 * with fixed tiers, signing ScoreAttestation in the wallet's domain with the attestor key. Same
 * behaviour as the real service in ATTESTOR_MODE=scripted (D3-lite); used for harness smoke runs
 * when services/attestor is not started. The real service is preferred via ATTESTOR_URL.
 */
import { Hono } from 'hono';
import { type Address, type Hex, getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ATTESTATION_TTL_SECONDS,
  encodeAttestation,
  scoreAttestationDigest,
  scoreAttestationTypedData,
} from '../../../packages/shared/src/attestor/typedData.ts';

export interface MockAttestorOptions {
  attestorKey: Hex;
  chainId: number;
  /** payee (lowercase) -> tier. Anything absent is cold start (UNPROVEN). */
  tiers: Record<string, 'PROVEN' | 'UNPROVEN' | 'FLAGGED'>;
  /** Reads attestEpoch() of the wallet; throw -> 503 (never sign with a guessed epoch). */
  epochOf: (wallet: Address) => Promise<bigint>;
  now: () => Promise<number>;
  ttlSeconds?: number;
}

export async function signAttestation(o: { attestorKey: Hex; chainId: number; wallet: Address; payee: Address; tier?: number; validUntil: number; epoch: bigint }): Promise<{ signature: Hex; attestation: Hex; digest: Hex }> {
  const acct = privateKeyToAccount(o.attestorKey);
  const msg = { recipient: o.payee, tier: o.tier ?? 1, validUntil: o.validUntil, epoch: o.epoch };
  const signature = await acct.signTypedData(scoreAttestationTypedData(o.chainId, o.wallet, msg));
  return { signature, attestation: encodeAttestation({ ...msg, signature }), digest: scoreAttestationDigest(o.chainId, o.wallet, msg) };
}

export function createMockAttestor(o: MockAttestorOptions): Hono {
  const app = new Hono();
  const attestor = privateKeyToAccount(o.attestorKey).address;
  app.get('/health', (c) => c.json({ service: 'hypnexis-agent/mock-attestor', ok: true, status: 'ready', mode: 'scripted', attestor, chainId: o.chainId }));
  app.get('/v1/attest', async (c) => {
    const wallet = c.req.query('wallet') ?? '';
    const payee = c.req.query('payee') ?? '';
    const chainId = c.req.query('chainId');
    if (!isAddress(wallet) || !isAddress(payee)) return c.json({ error: 'bad_address' }, 400);
    if (chainId && Number(chainId) !== o.chainId) return c.json({ error: 'wrong_chain' }, 400);
    const tier = o.tiers[payee.toLowerCase()];
    if (tier !== 'PROVEN')
      return c.json({ error: 'no_attestation', tier: tier ?? 'UNPROVEN', code: tier === 'FLAGGED' ? 'QUARANTINE' : null, reason: tier ? 'scripted' : 'cold_start' }, 404);
    let epoch: bigint;
    try {
      epoch = await o.epochOf(getAddress(wallet));
    } catch {
      return c.json({ error: 'epoch_unavailable' }, 503);
    }
    const validUntil = (await o.now()) + (o.ttlSeconds ?? ATTESTATION_TTL_SECONDS);
    const s = await signAttestation({ attestorKey: o.attestorKey, chainId: o.chainId, wallet: getAddress(wallet), payee: getAddress(payee), validUntil, epoch });
    return c.json({
      tier: 'PROVEN', tierCode: 1, validUntil, epoch: epoch.toString(), signature: s.signature, attestation: s.attestation, digest: s.digest,
      wallet: getAddress(wallet), payee: getAddress(payee), recipient: getAddress(payee), chainId: o.chainId, attestor, code: 'ROUTE',
    });
  });
  return app;
}
