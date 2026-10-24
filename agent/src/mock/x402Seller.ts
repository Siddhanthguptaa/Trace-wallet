/**
 * Mock x402 seller (BUILD.md M7): answers 402 with the exact-scheme accepts, then accepts an
 * EIP-3009 authorization as the payment and settles it through the on-chain ApiSeller (its own
 * facilitator, docs/api.md note). The real facilitator is X3's job; this one runs on anvil.
 *
 * Flow (x402 "exact" over EIP-3009): GET /resource -> 402 { accepts }. The client builds a
 * TransferWithAuthorization(from = wallet, to = ApiSeller, value = price) and asks the wallet's
 * isValidSignature for a contract signature (the one-door envelope). POST /settle { resource,
 * authorization, signature } -> ApiSeller.settle submits it to USDC; on success -> 200 + receipt.
 */
import { Hono } from 'hono';
import { type Abi, type Address, type Hex, encodeFunctionData, erc20Abi } from 'viem';
import type { World } from '../world/deploy.ts';

const apiSellerAbi = [
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
      { name: 'resource', type: 'string' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export interface X402Accepts {
  scheme: 'exact';
  network: string;
  asset: Address;
  payTo: Address;
  maxAmountRequired: string;
  resource: string;
  nonceSuggestion: Hex;
  validAfter: number;
  validBefore: number;
}

export interface SettleBody {
  resource: string;
  from: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
}

export function createX402Seller(w: World, facilitatorPk: Hex = w.keys.facilitator): Hono {
  const app = new Hono();
  const price = w.policy.shops.apiPrice;
  app.get('/health', (c) => c.json({ ok: true, payTo: w.api, asset: w.usdc, price: price.toString() }));
  app.get('/resource/:name', async (c) => {
    const now = Number(BigInt((await w.c.pub.getBlock()).timestamp));
    const accepts: X402Accepts = {
      scheme: 'exact',
      network: `eip155:${w.chainId}`,
      asset: w.usdc,
      payTo: w.api,
      maxAmountRequired: price.toString(),
      resource: c.req.param('name'),
      nonceSuggestion: `0x${'00'.repeat(31)}01`,
      validAfter: now - 60,
      validBefore: now + 300, // x402 maxTimeoutSeconds is 60-300 s; the wallet caps voucher validity at 600 s (OneDoorLib.VOUCHER_MAX_TTL)
    };
    return c.json({ x402Version: 1, error: 'payment required', accepts: [accepts] }, 402);
  });
  app.post('/settle', async (c) => {
    const b = (await c.req.json()) as SettleBody;
    try {
      const data = encodeFunctionData({
        abi: apiSellerAbi,
        functionName: 'settle',
        args: [b.from, BigInt(b.value), BigInt(b.validAfter), BigInt(b.validBefore), b.nonce, b.signature, b.resource],
      });
      const hash = await w.c.wallet(facilitatorPk).sendTransaction({ to: w.api, data, gas: 2_000_000n });
      const r = await w.c.pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') return c.json({ error: 'settlement_failed', transaction: hash }, 402);
      const bal = (await w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [w.api] })) as bigint;
      return c.json({ success: true, receipt: { success: true, transaction: hash, network: `eip155:${w.chainId}`, payer: b.from }, sellerBalance: bal.toString() });
    } catch (e) {
      return c.json({ error: 'settlement_reverted', message: (e as Error).message }, 402);
    }
  });
  return app;
}
