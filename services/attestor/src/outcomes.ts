/**
 * Outcome ingestion ([A22], IDEA.md 7.5). Accepted evidence:
 *  - x402: the facilitator's settlement receipt, verified on-chain (Transfer wallet -> payee),
 *    plus a delivery check (HTTP 200 + schema) signed by a configured verifier;
 *  - owner: an EIP-712 Outcome signed by the wallet's on-chain owner;
 *  - verifier: an EIP-712 Outcome signed by a configured verifier.
 * Everything reported by the agent alone is ignored: source "agent", or any signature that is not
 * the owner's or a verifier's (the agent key included, even if misconfigured as a verifier).
 */
import { type Address, type Hex, getAddress, recoverTypedDataAddress } from 'viem';
import { z } from 'zod';
import { deliveryCheckTypedData, outcomeTypedData } from '../../../packages/shared/src/attestor/typedData.ts';
import type { AccountReader, ReceiptVerifier } from './chain.ts';
import type { OutcomeRecord } from './trace/engine.ts';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => getAddress(s));
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as Hex);
const sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((s) => s as Hex);
const amount = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const decimals = z.number().int().min(0).max(36).default(6);

const X402 = z.object({
  source: z.literal('x402'),
  wallet: address,
  payee: address,
  asset: address,
  amount,
  decimals,
  /** x402 settlement response (X-PAYMENT-RESPONSE). */
  receipt: z.object({ success: z.boolean(), transaction: bytes32, network: z.string().min(1), payer: address }),
  delivery: z.object({ httpStatus: z.number().int().min(0).max(65535), schemaOk: z.boolean(), signature: sig }),
});

const SignedOutcome = z.object({
  source: z.enum(['owner', 'verifier']),
  outcome: z.object({ wallet: address, payee: address, success: z.boolean(), ref: bytes32, asset: address, amount }),
  decimals,
  signature: sig,
});

const AgentReport = z.object({ source: z.literal('agent') }).passthrough();

export const OutcomeBody = z.union([X402, SignedOutcome, AgentReport]);
export type OutcomeBody = z.input<typeof OutcomeBody>;

export type IngestResult =
  | { status: 'accepted'; record: OutcomeRecord }
  | { status: 'duplicate'; id: string }
  | { status: 'ignored'; reason: string }
  | { status: 'rejected'; reason: string };

export interface IngestDeps {
  chainId: number;
  verifiers: Set<string>;
  agents: Set<string>;
  reader: AccountReader | null;
  receipts: ReceiptVerifier | null;
  now: () => number;
  has: (id: string) => boolean;
}

const lc = (a: string) => a.toLowerCase();
const refId = (wallet: Address, payee: Address, ref: Hex) => `ref:${lc(wallet)}:${lc(payee)}:${ref.toLowerCase()}`;

/** Validates and authenticates one report. Does not store it (the caller does, atomically). */
export async function ingest(body: unknown, deps: IngestDeps): Promise<IngestResult> {
  const parsed = OutcomeBody.safeParse(body);
  if (!parsed.success) return { status: 'rejected', reason: `invalid_body: ${parsed.error.issues[0]?.message ?? 'schema'}` };
  const b = parsed.data;
  if (b.source === 'agent') return { status: 'ignored', reason: 'agent_only_ignored' };

  if (b.source === 'x402') {
    const x = b as z.output<typeof X402>;
    if (lc(x.wallet) === lc(x.payee)) return { status: 'rejected', reason: 'self_payment' };
    if (!x.receipt.success) return { status: 'rejected', reason: 'settlement_failed' };
    if (lc(x.receipt.payer) !== lc(x.wallet)) return { status: 'rejected', reason: 'payer_mismatch' };
    const checker = await recoverTypedDataAddress({
      ...deliveryCheckTypedData(deps.chainId, {
        wallet: x.wallet,
        payee: x.payee,
        txHash: x.receipt.transaction,
        httpStatus: x.delivery.httpStatus,
        schemaOk: x.delivery.schemaOk,
      }),
      signature: x.delivery.signature,
    });
    if (deps.agents.has(lc(checker)) || !deps.verifiers.has(lc(checker))) {
      return { status: 'ignored', reason: 'agent_only_ignored: delivery check not signed by a verifier' };
    }
    const id = refId(x.wallet, x.payee, x.receipt.transaction);
    if (deps.has(id)) return { status: 'duplicate', id };
    if (!deps.receipts) return { status: 'rejected', reason: 'receipt_unverifiable: no RPC configured' };
    const v = await deps.receipts.verify({ wallet: x.wallet, payee: x.payee, asset: x.asset, amount: x.amount, txHash: x.receipt.transaction });
    if (!v.ok) return { status: 'rejected', reason: `receipt_${v.reason}` };
    return {
      status: 'accepted',
      record: {
        id,
        source: 'x402',
        wallet: x.wallet,
        payee: x.payee,
        success: x.delivery.httpStatus === 200 && x.delivery.schemaOk,
        amount: x.amount,
        decimals: x.decimals,
        ts: v.ts,
      },
    };
  }

  const s = b as z.output<typeof SignedOutcome>;
  const o = s.outcome;
  if (lc(o.wallet) === lc(o.payee)) return { status: 'rejected', reason: 'self_payment' };
  const signer = await recoverTypedDataAddress({ ...outcomeTypedData(deps.chainId, o), signature: s.signature });
  if (deps.agents.has(lc(signer))) return { status: 'ignored', reason: 'agent_only_ignored: signed by an agent key' };
  if (s.source === 'verifier') {
    if (!deps.verifiers.has(lc(signer))) return { status: 'ignored', reason: 'agent_only_ignored: signer is not a verifier' };
  } else {
    if (!deps.reader) return { status: 'rejected', reason: 'owner_unverifiable: no account reader' };
    let owner: Address;
    try {
      owner = await deps.reader.owner(o.wallet);
    } catch {
      return { status: 'rejected', reason: 'owner_unreadable' };
    }
    if (lc(owner) !== lc(signer)) return { status: 'ignored', reason: 'agent_only_ignored: signer is not the wallet owner' };
  }
  const id = refId(o.wallet, o.payee, o.ref);
  if (deps.has(id)) return { status: 'duplicate', id };
  return {
    status: 'accepted',
    record: { id, source: s.source, wallet: o.wallet, payee: o.payee, success: o.success, amount: o.amount, decimals: s.decimals, ts: deps.now() },
  };
}
