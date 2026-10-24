/** EIP-712 signer: digest == vector file == hand-built digest; validUntil/epoch; key separation. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Hex, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  SCORE_ATTESTATION_TYPEHASH,
  accountDomainSeparator,
  scoreAttestationStructHash,
  decodeAttestation,
  recoverScoreAttestationSigner,
  scoreAttestationDigest,
  scoreAttestationDigestManual,
} from '../../../packages/shared/src/attestor/typedData.ts';
import { DEV_KEYS } from '../scripts/lib/devchain.ts';
import { VECTORS_PATH, buildVectors, serialize } from '../scripts/vectors.ts';
import { AttestationSigner, KeySeparationError, MAX_UINT48, assertKeySeparation } from '../src/signer.ts';
import { buildAttestor } from '../src/build.ts';
import { loadAttestorConfig } from '../src/config.ts';

const WALLET = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const SHOP = getAddress('0x000000000000000000000000000000000000beef');
const agentAddr = privateKeyToAccount(DEV_KEYS.agent).address;
const M1_VECTORS = fileURLToPath(new URL('../../../results/m1_typed_data_vectors.json', import.meta.url));

describe('ScoreAttestation signer', () => {
  it('type hash is the one in contracts/src/lib/TypedData.sol', () => {
    const sol = readFileSync(new URL('../../../contracts/src/lib/TypedData.sol', import.meta.url), 'utf8');
    expect(sol).toContain('"ScoreAttestation(address recipient,uint8 tier,uint48 validUntil,uint64 epoch)"');
    expect(SCORE_ATTESTATION_TYPEHASH).toBe('0xdb0785987920e14b8dfe18b6cd5552050360fd825b67269b02ef83cd3a0a34c0');
  });

  it('contracts/test/vectors/score_attestation.json is current and self-consistent', async () => {
    const v = await buildVectors();
    expect(readFileSync(VECTORS_PATH, 'utf8')).toBe(serialize(v));
    const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
    for (const c of file.cases) {
      const msg = { recipient: c.recipient, tier: Number(c.tier), validUntil: Number(c.validUntil), epoch: BigInt(c.epoch) };
      expect(scoreAttestationDigest(BigInt(c.chainId), c.wallet, msg)).toBe(c.digest);
      expect(scoreAttestationDigestManual(BigInt(c.chainId), c.wallet, msg)).toBe(c.digest);
      expect(await recoverScoreAttestationSigner(BigInt(c.chainId), c.wallet, msg, c.signature)).toBe(c.signer);
      const dec = decodeAttestation(c.attestation);
      expect(dec).toEqual({ tier: msg.tier, validUntil: msg.validUntil, epoch: msg.epoch, signature: c.signature });
      expect(c.expectProven).toBe(msg.tier === 1 && c.signer === file.attestor);
    }
    for (const r of file.replays) {
      expect(r.recoveredSigner).not.toBe(file.attestor);
      expect(r.expectProven).toBe(false);
    }
  });

  it.runIf(existsSync(M1_VECTORS))('agrees with CORE results/m1_typed_data_vectors.json (digest computed by the contract code)', () => {
    const m = JSON.parse(readFileSync(M1_VECTORS, 'utf8'));
    const a = m.scoreAttestation;
    expect(m.scoreAttestationTypehash).toBe(SCORE_ATTESTATION_TYPEHASH);
    expect(accountDomainSeparator(m.chainId, m.verifyingContract)).toBe(m.domainSeparator);
    const msg = { recipient: a.recipient, tier: Number(a.tier), validUntil: Number(a.validUntil), epoch: BigInt(a.epoch) };
    expect(scoreAttestationStructHash(msg)).toBe(a.structHash);
    expect(scoreAttestationDigest(m.chainId, m.verifyingContract, msg)).toBe(a.digest);
  });

  it('signs PROVEN with validUntil = now + 24 h and the given epoch; recovers to the attestor', async () => {
    const s = new AttestationSigner(DEV_KEYS.attestor);
    const now = 1_800_000_000;
    const a = await s.signProven({ chainId: 31337, wallet: WALLET, recipient: SHOP, epoch: 7n, nowSeconds: now });
    expect(a.tier).toBe(1);
    expect(a.validUntil).toBe(now + 86_400);
    expect(a.epoch).toBe(7n);
    expect(await recoverScoreAttestationSigner(31337, WALLET, { recipient: SHOP, tier: 1, validUntil: a.validUntil, epoch: 7n }, a.signature)).toBe(s.address);
    // Other chain / wallet / epoch give other digests (F25 replay).
    const msg = { recipient: SHOP, tier: 1, validUntil: a.validUntil, epoch: 7n };
    expect(scoreAttestationDigest(8453, WALLET, msg)).not.toBe(a.digest);
    expect(scoreAttestationDigest(31337, SHOP, msg)).not.toBe(a.digest);
    expect(scoreAttestationDigest(31337, WALLET, { ...msg, epoch: 8n })).not.toBe(a.digest);
    // validUntil saturates at uint48 max.
    expect(s.validUntil(MAX_UINT48)).toBe(MAX_UINT48);
  });

  it('refuses to sign anything but PROVEN', async () => {
    const s = new AttestationSigner(DEV_KEYS.attestor);
    for (const tier of [0, 2, 3]) {
      await expect(s.sign(31337, WALLET, { recipient: SHOP, tier, validUntil: 1, epoch: 1n })).rejects.toThrow(/only PROVEN/);
    }
  });

  it('key separation: refuses an attestor key equal to an agent key, and agent keys as verifiers [A20]', () => {
    expect(() => new AttestationSigner(DEV_KEYS.agent, { agents: [agentAddr] })).toThrow(KeySeparationError);
    expect(() => assertKeySeparation(privateKeyToAccount(DEV_KEYS.attestor).address, [agentAddr], [agentAddr])).toThrow(KeySeparationError);
    expect(() => new AttestationSigner(DEV_KEYS.attestor, { agents: [agentAddr] })).not.toThrow();
    // Via the service config: AGENT_PRIVATE_KEY == ATTESTOR_PRIVATE_KEY must not build.
    const cfg = loadAttestorConfig({ ATTESTOR_PRIVATE_KEY: DEV_KEYS.agent, AGENT_PRIVATE_KEY: DEV_KEYS.agent } as NodeJS.ProcessEnv);
    expect(() => buildAttestor(cfg)).toThrow(KeySeparationError);
    const ok = loadAttestorConfig({ ATTESTOR_PRIVATE_KEY: DEV_KEYS.attestor, AGENT_PRIVATE_KEY: DEV_KEYS.agent } as NodeJS.ProcessEnv);
    expect(buildAttestor(ok).signer.address).toBe(privateKeyToAccount(DEV_KEYS.attestor).address);
  });

  it('decodeAttestation round-trips the userOp.signature slot', async () => {
    const s = new AttestationSigner(DEV_KEYS.attestor);
    const a = await s.signProven({ chainId: 1, wallet: WALLET, recipient: SHOP, epoch: 1n, nowSeconds: 0 });
    expect(decodeAttestation(a.attestation)).toEqual({ tier: 1, validUntil: 86_400, epoch: 1n, signature: a.signature as Hex });
  });
});
