/** Test helpers: signed outcome reports and an in-memory attestor with a static chain stub. */
import { type Address, type Hex, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  type DeliveryCheckMessage,
  type OutcomeMessage,
  deliveryCheckTypedData,
  outcomeTypedData,
} from '../../../packages/shared/src/attestor/typedData.ts';
import type { Tier } from '../../../packages/shared/src/attestor/tier.ts';
import { DEV_KEYS } from '../scripts/lib/devchain.ts';
import { Attestor } from '../src/attestor.ts';
import { type ReceiptVerifier, staticReader } from '../src/chain.ts';
import { AttestationSigner } from '../src/signer.ts';
import { Store } from '../src/store.ts';

export const CHAIN_ID = 31337;
export const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const addr = (k: Hex) => privateKeyToAccount(k).address;
export const AGENT = addr(DEV_KEYS.agent);
export const VERIFIER = addr(DEV_KEYS.verifier);
export const OWNER = addr(DEV_KEYS.deployerOwner);
export const ATTACKER = addr(DEV_KEYS.attacker);

/** deterministic fake addresses / refs */
export const fake = (tag: string): Address => `0x${keccak256(toHex(tag)).slice(26)}` as Address;
export const ref = (tag: string): Hex => keccak256(toHex(`ref:${tag}`));

export async function signedOutcome(
  key: Hex,
  source: 'owner' | 'verifier',
  o: Omit<OutcomeMessage, 'asset' | 'amount' | 'ref'> & { ref?: Hex; asset?: Address; amount?: bigint },
  chainId = CHAIN_ID,
) {
  const msg: OutcomeMessage = { asset: USDC, amount: 200_000n, ref: ref(`${o.wallet}-${o.payee}-${Math.random()}`), ...o };
  const signature = await privateKeyToAccount(key).signTypedData(outcomeTypedData(chainId, msg));
  return { source, outcome: { ...msg, amount: msg.amount.toString() }, signature };
}

export async function x402Report(
  checkerKey: Hex,
  o: { wallet: Address; payee: Address; txHash: Hex; httpStatus?: number; schemaOk?: boolean; amount?: bigint; payer?: Address },
  chainId = CHAIN_ID,
) {
  const msg: DeliveryCheckMessage = { wallet: o.wallet, payee: o.payee, txHash: o.txHash, httpStatus: o.httpStatus ?? 200, schemaOk: o.schemaOk ?? true };
  const signature = await privateKeyToAccount(checkerKey).signTypedData(deliveryCheckTypedData(chainId, msg));
  return {
    source: 'x402',
    wallet: o.wallet,
    payee: o.payee,
    asset: USDC,
    amount: (o.amount ?? 100_000n).toString(),
    receipt: { success: true, transaction: o.txHash, network: 'base-sepolia', payer: o.payer ?? o.wallet },
    delivery: { httpStatus: msg.httpStatus, schemaOk: msg.schemaOk, signature },
  };
}

/** Receipt verifier stub: accepts tx hashes registered with the transfer they carry. */
export function stubReceipts(): ReceiptVerifier & { add: (txHash: Hex, wallet: Address, payee: Address, amount: bigint) => void } {
  const txs = new Map<string, { wallet: Address; payee: Address; amount: bigint }>();
  return {
    add: (h, wallet, payee, amount) => txs.set(h.toLowerCase(), { wallet, payee, amount }),
    async verify(c) {
      const t = txs.get(c.txHash.toLowerCase());
      if (!t) return { ok: false, reason: 'tx_not_found' };
      if (t.wallet.toLowerCase() !== c.wallet.toLowerCase() || t.payee.toLowerCase() !== c.payee.toLowerCase() || t.amount < c.amount) {
        return { ok: false, reason: 'no_matching_transfer' };
      }
      return { ok: true, ts: 1_800_000_000 };
    },
  };
}

export function makeAttestor(o: { owners?: Record<string, Address>; epoch?: bigint; mode?: 'trace' | 'scripted'; scriptedTiers?: Record<string, Tier>; now?: number } = {}) {
  const signer = new AttestationSigner(DEV_KEYS.attestor, { agents: [AGENT], verifiers: [VERIFIER] });
  const chain = staticReader({ owners: o.owners ?? {}, attestor: signer.address, epoch: o.epoch ?? 1n });
  const receipts = stubReceipts();
  let t = o.now ?? 1_800_000_000;
  const attestor = new Attestor({
    chainId: CHAIN_ID,
    signer,
    store: new Store(':memory:'),
    reader: chain,
    writer: chain,
    receipts,
    verifiers: [VERIFIER],
    agents: [AGENT],
    mode: o.mode,
    scriptedTiers: o.scriptedTiers,
    now: () => t++,
  });
  return { attestor, chain, receipts, signer };
}
