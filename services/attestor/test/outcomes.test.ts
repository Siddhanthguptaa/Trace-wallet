/** Outcome ingestion [A22]: what counts, what is ignored (agent-only), what is rejected. */
import { keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { DEV_KEYS } from '../scripts/lib/devchain.ts';
import { AGENT, OWNER, VERIFIER, fake, makeAttestor, ref, signedOutcome, x402Report } from './helpers.ts';

const WALLET = fake('wallet-1');
const SHOP = fake('shop');
const tx = (t: string) => keccak256(toHex(`tx:${t}`));

describe('POST /v1/outcomes semantics (Attestor.report)', () => {
  it('ignores agent-only reports: source "agent", agent-signed outcomes, agent-signed delivery checks', async () => {
    const { attestor, receipts } = makeAttestor({ owners: { [WALLET]: OWNER } });
    expect(await attestor.report({ source: 'agent', wallet: WALLET, payee: SHOP, success: true })).toMatchObject({ status: 'ignored', reason: 'agent_only_ignored' });
    // The agent signs an Outcome and claims to be the verifier or the owner.
    expect(await attestor.report(await signedOutcome(DEV_KEYS.agent, 'verifier', { wallet: WALLET, payee: SHOP, success: true }))).toMatchObject({ status: 'ignored' });
    expect(await attestor.report(await signedOutcome(DEV_KEYS.agent, 'owner', { wallet: WALLET, payee: SHOP, success: true }))).toMatchObject({ status: 'ignored' });
    // Real on-chain payment, but the delivery check is signed by the agent.
    receipts.add(tx('a'), WALLET, SHOP, 100_000n);
    expect(await attestor.report(await x402Report(DEV_KEYS.agent, { wallet: WALLET, payee: SHOP, txHash: tx('a') }))).toMatchObject({ status: 'ignored' });
    // A random key is not a verifier either.
    expect(await attestor.report(await signedOutcome(DEV_KEYS.attacker, 'verifier', { wallet: WALLET, payee: SHOP, success: true }))).toMatchObject({ status: 'ignored' });
    expect(attestor.store.outcomeCount()).toBe(0);
    expect(attestor.profile(SHOP).tier).toBe('UNPROVEN');
  });

  it('accepts owner-signed and verifier-signed outcomes; drops replays of the same ref', async () => {
    const { attestor } = makeAttestor({ owners: { [WALLET]: OWNER } });
    const o1 = await signedOutcome(DEV_KEYS.deployerOwner, 'owner', { wallet: WALLET, payee: SHOP, success: true, ref: ref('job1') });
    expect(await attestor.report(o1)).toMatchObject({ status: 'accepted', record: { source: 'owner', success: true } });
    expect(await attestor.report(o1)).toMatchObject({ status: 'duplicate' });
    // Same job ref reported by the verifier is the same job: still a duplicate.
    const o1v = await signedOutcome(DEV_KEYS.verifier, 'verifier', { wallet: WALLET, payee: SHOP, success: true, ref: ref('job1') });
    expect(await attestor.report(o1v)).toMatchObject({ status: 'duplicate' });
    const o2 = await signedOutcome(DEV_KEYS.verifier, 'verifier', { wallet: WALLET, payee: SHOP, success: false, ref: ref('job2') });
    expect(await attestor.report(o2)).toMatchObject({ status: 'accepted', record: { source: 'verifier', success: false } });
    expect(attestor.store.outcomeCount()).toBe(2);
  });

  it('owner outcomes must be signed by the wallet owner read from chain', async () => {
    const { attestor } = makeAttestor({ owners: { [WALLET]: OWNER } });
    // The verifier key signs but claims "owner": not the owner of WALLET.
    expect(await attestor.report(await signedOutcome(DEV_KEYS.verifier, 'owner', { wallet: WALLET, payee: SHOP, success: true }))).toMatchObject({
      status: 'ignored',
    });
    // Unknown wallet (owner unreadable) is rejected, never accepted.
    expect(await attestor.report(await signedOutcome(DEV_KEYS.deployerOwner, 'owner', { wallet: fake('nobody'), payee: SHOP, success: true }))).toMatchObject({
      status: 'rejected',
      reason: 'owner_unreadable',
    });
  });

  it('x402: settlement receipt verified on-chain + verifier delivery check; success iff HTTP 200 and schema ok', async () => {
    const { attestor, receipts } = makeAttestor();
    receipts.add(tx('ok'), WALLET, SHOP, 100_000n);
    receipts.add(tx('bad'), WALLET, SHOP, 100_000n);
    expect(await attestor.report(await x402Report(DEV_KEYS.verifier, { wallet: WALLET, payee: SHOP, txHash: tx('ok') }))).toMatchObject({
      status: 'accepted',
      record: { source: 'x402', success: true, ts: 1_800_000_000 },
    });
    expect(await attestor.report(await x402Report(DEV_KEYS.verifier, { wallet: WALLET, payee: SHOP, txHash: tx('bad'), schemaOk: false }))).toMatchObject({
      status: 'accepted',
      record: { success: false },
    });
    // Replayed receipt.
    expect(await attestor.report(await x402Report(DEV_KEYS.verifier, { wallet: WALLET, payee: SHOP, txHash: tx('ok') }))).toMatchObject({ status: 'duplicate' });
    // No such tx, payer mismatch, inflated amount, self-payment.
    expect(await attestor.report(await x402Report(DEV_KEYS.verifier, { wallet: WALLET, payee: SHOP, txHash: tx('missing') }))).toMatchObject({ status: 'rejected', reason: 'receipt_tx_not_found' });
    expect(await attestor.report(await x402Report(DEV_KEYS.verifier, { wallet: WALLET, payee: SHOP, txHash: tx('p'), payer: fake('x') }))).toMatchObject({ status: 'rejected', reason: 'payer_mismatch' });
    receipts.add(tx('small'), WALLET, SHOP, 1n);
    expect(await attestor.report(await x402Report(DEV_KEYS.verifier, { wallet: WALLET, payee: SHOP, txHash: tx('small') }))).toMatchObject({ status: 'rejected', reason: 'receipt_no_matching_transfer' });
    expect(await attestor.report(await x402Report(DEV_KEYS.verifier, { wallet: WALLET, payee: WALLET, txHash: tx('self') }))).toMatchObject({ status: 'rejected', reason: 'self_payment' });
  });

  it('rejects malformed bodies', async () => {
    const { attestor } = makeAttestor();
    expect(await attestor.report({ source: 'owner' })).toMatchObject({ status: 'rejected' });
    expect(await attestor.report(42)).toMatchObject({ status: 'rejected' });
    expect(VERIFIER).not.toBe(AGENT);
  });
});
