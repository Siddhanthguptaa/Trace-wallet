/**
 * x402 payment flow against the mock seller (BUILD.md M7). Drives the full round trip:
 *   1. GET the resource -> 402 { accepts } (the seller states asset, payTo, price, nonce window).
 *   2. Register a one-door voucher for that payment (agent op, kind = REGISTER_VOUCHER) so the
 *      account's isValidSignature accepts the EIP-3009 authorization as a contract signature (D1,
 *      docs/api.md 4.6). For an EOA wallet (R1) the agent key signs the authorization directly.
 *   3. POST /settle; the seller submits the authorization to USDC and returns the receipt.
 *
 * During the scaffold the OneDoorModule is a stub (voucher ops refused), so step 2 fails for a
 * contract wallet; the flow then reports status "needs_one_door" rather than inventing a receipt.
 */
import { type Address, type Hex, erc20Abi } from 'viem';
import type { AgentTools } from '../tools/engine.ts';
import type { World } from '../world/deploy.ts';
import {
  type Authorization3009,
  OP_KIND,
  agentCallData,
  auth3009Digest,
  voucherBody,
  x402Envelope,
} from '../ops/encode.ts';
import { buildOp, defaultGas, executed, getNonce, opHash, sign65, signAgent, submit } from '../ops/submitter.ts';
import type { X402Accepts } from '../mock/x402Seller.ts';

export interface X402Outcome {
  status: 'paid' | 'refused' | 'needs_one_door' | 'error';
  receipt?: unknown;
  voucherNonce?: Hex;
  paid?: string;
  reason?: string;
}

export async function payX402(
  w: World,
  tools: AgentTools,
  sellerBase: string,
  resource: string,
  maxAmount: bigint,
): Promise<X402Outcome> {
  const wallet = tools.ctx.wallet;
  let accepts: X402Accepts;
  try {
    const res = await fetch(`${sellerBase.replace(/\/$/, '')}/resource/${resource}`);
    if (res.status !== 402) return { status: 'error', reason: `expected 402, got ${res.status}` };
    accepts = ((await res.json()) as { accepts: X402Accepts[] }).accepts[0]!;
  } catch (e) {
    return { status: 'error', reason: (e as Error).message };
  }
  const value = BigInt(accepts.maxAmountRequired);
  if (value > maxAmount) return { status: 'refused', reason: `price ${value} over maxAmount ${maxAmount}` };
  const nonce = accepts.nonceSuggestion;
  const auth: Authorization3009 = {
    from: wallet.address,
    to: accepts.payTo,
    value,
    validAfter: BigInt(accepts.validAfter),
    validBefore: BigInt(accepts.validBefore),
    nonce,
  };
  const digest = auth3009Digest(w.chainId, w.usdc, auth);

  let signature: Hex;
  if (wallet.kind === 'eoa' || wallet.kind === 'naive') {
    // EOA: ecrecover. R2 NaiveAccount: isValidSignature accepts the agent key (the x402 "permissive" account).
    signature = await sign65(wallet.agentKey, digest);
  } else {
    const reg = await registerVoucher(w, wallet.agentKey, wallet.address, accepts.payTo, value, auth.validAfter, auth.validBefore, nonce);
    if (!reg) return { status: 'needs_one_door', reason: 'voucher registration refused (OneDoorModule stub; built in D1/M3)', voucherNonce: nonce };
    const agentSig = await sign65(wallet.agentKey, digest);
    signature = x402Envelope(accepts.payTo, value, auth.validAfter, auth.validBefore, nonce, agentSig);
    // Sanity: the one door must accept this contract signature.
    const magic = (await w.c.pub.readContract({ address: wallet.address, abi: w.accountAbi, functionName: 'isValidSignature', args: [digest, signature] })) as Hex;
    if (magic.toLowerCase() !== '0x1626ba7e') return { status: 'needs_one_door', reason: `isValidSignature returned ${magic}`, voucherNonce: nonce };
  }
  const before = (await w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [accepts.payTo] })) as bigint;
  try {
    const res = await fetch(`${sellerBase.replace(/\/$/, '')}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource, from: auth.from, value: value.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString(), nonce, signature }),
    });
    const body = (await res.json()) as { receipt?: unknown; error?: string };
    if (res.status !== 200) return { status: 'refused', reason: body.error ?? `HTTP ${res.status}`, voucherNonce: nonce };
    const after = (await w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [accepts.payTo] })) as bigint;
    return { status: 'paid', receipt: body.receipt, voucherNonce: nonce, paid: (after - before).toString() };
  } catch (e) {
    return { status: 'error', reason: (e as Error).message };
  }
}

/** Agent op of kind REGISTER_VOUCHER (docs/api.md 4.1). Returns false if the door stub refuses it. */
async function registerVoucher(
  w: World,
  agentKey: Hex,
  account: Address,
  to: Address,
  value: bigint,
  validAfter: bigint,
  validBefore: bigint,
  nonce: Hex,
): Promise<boolean> {
  const body = voucherBody(to, value, validAfter, validBefore, nonce);
  const callData = agentCallData(w.usdc, 0n, body, OP_KIND.REGISTER_VOUCHER);
  const nonceKey = (await w.c.pub.readContract({ address: account, abi: w.accountAbi, functionName: 'nonceKeyOf', args: [w.addrOf.agent, 0] })) as bigint;
  const epNonce = await getNonce(w, account, nonceKey);
  const op = buildOp(account, epNonce, callData, defaultGas(w));
  const signed = await signAgent(w, op, agentKey);
  const res = await submit(w, [signed]);
  return executed(res);
}

export { opHash };
