/**
 * HTTP wrapper for the agent tools (docs/api.md 12.1). Base http://localhost:8787/v1/tools.
 * Plain HTTP only; the MCP wrapper is CUT (FASTPLAN cut 2). Bodies are JSON, amounts decimal
 * strings in base units, addresses 0x-hex, errors `{ error: { code, message } }`.
 */
import { type Context, Hono } from 'hono';
import { type Address, type Hex, getAddress, isAddress } from 'viem';
import type { AgentTools } from './engine.ts';
import { payX402 } from '../legit/x402.ts';

function bad(c: Context, code: string, message: string) {
  return c.json({ error: { code, message } }, 400);
}

export interface ServerOptions {
  sellerBase?: string;
}

export function createToolsServer(tools: AgentTools, opts: ServerOptions = {}): Hono {
  const app = new Hono();
  const base = app.basePath('/v1/tools');

  base.post('/get_policy', async (c) => c.json(await tools.getPolicy()));

  base.post('/get_budget', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { asset?: string };
    const asset = b.asset && isAddress(b.asset) ? getAddress(b.asset) : undefined;
    return c.json(await tools.getBudget(asset));
  });

  base.post('/check', async (c) => {
    const b = (await c.req.json()) as { target: string; value?: string; data?: string; payee?: string };
    if (!isAddress(b.target)) return bad(c, 'BAD_ADDRESS', 'target must be an address');
    const r = await tools.check({ target: getAddress(b.target), value: b.value ? BigInt(b.value) : 0n, data: (b.data ?? '0x') as Hex, payee: b.payee && isAddress(b.payee) ? getAddress(b.payee) : undefined });
    return c.json(r);
  });

  base.post('/pay', async (c) => {
    const b = (await c.req.json()) as { asset: string; to: string; amount: string };
    if (!isAddress(b.asset) || !isAddress(b.to)) return bad(c, 'BAD_ADDRESS', 'asset and to must be addresses');
    return c.json(await tools.pay({ asset: getAddress(b.asset), to: getAddress(b.to), amount: BigInt(b.amount) }));
  });

  base.post('/pay_x402', async (c) => {
    const b = (await c.req.json()) as { url: string; maxAmount: string; resource?: string };
    const sellerBase = opts.sellerBase ?? b.url;
    const out = await payX402(tools.ctx.world, tools, sellerBase, b.resource ?? 'resource', BigInt(b.maxAmount));
    return c.json(out);
  });

  base.post('/buy', async (c) => {
    const b = (await c.req.json()) as { shop: string; item?: string; amount?: string; recipient?: string };
    const shop = b.shop === 'ticket' || b.shop === 'grocery' ? b.shop : isAddress(b.shop) ? (getAddress(b.shop) as Address) : null;
    if (!shop) return bad(c, 'BAD_SHOP', 'shop must be "ticket", "grocery" or an address');
    return c.json(await tools.buy({ shop, item: b.item ? BigInt(b.item) : undefined, amount: b.amount ? BigInt(b.amount) : undefined, recipient: b.recipient && isAddress(b.recipient) ? getAddress(b.recipient) : undefined }));
  });

  base.post('/request_approval', async (c) => {
    const b = (await c.req.json()) as { target: string; value?: string; data?: string; reason: string };
    if (!isAddress(b.target)) return bad(c, 'BAD_ADDRESS', 'target must be an address');
    return c.json(await tools.requestApproval({ target: getAddress(b.target), value: b.value ? BigInt(b.value) : 0n, data: (b.data ?? '0x') as Hex, reason: b.reason }));
  });

  base.post('/approval_status', async (c) => {
    const b = (await c.req.json()) as { requestId: string };
    return c.json(await tools.approvalStatus(b.requestId));
  });

  app.get('/health', (c) => c.json({ ok: true, service: '@hypnexis/agent tools', account: tools.ctx.wallet.address }));
  return app;
}
