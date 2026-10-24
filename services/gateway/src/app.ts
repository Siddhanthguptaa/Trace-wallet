/**
 * The gateway: ONE process that serves every base URL the web frontend calls (agent tools, approval,
 * attestor, attack runner), all backed by the REAL chain and the REAL attestor / approval services.
 * Every response is checked against the frontend's own zod schemas (wire.ts, a byte copy of
 * web/src/api/schemas.ts, guarded by a test), so contract drift fails here and not in the browser.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { type Address, getAddress, isAddress } from 'viem';
import { AgentTools } from '../../../agent/src/tools/engine.ts';
import { type GatewayConfig } from './config.ts';
import { Approvals, HttpError } from './approvals.ts';
import { Reader } from './policy.ts';
import * as W from './wire.ts';
import { type Live, buildLive, refreshGas } from './world.ts';

export interface GatewayOptions {
  cfg: GatewayConfig;
  live?: Live;
  /** The attack runner (services/runner `createRunnerApp`). Mounted lazily if omitted. */
  runner?: Hono;
}

/** Validate against the frontend schema, answer with the plain JSON (the schema's transforms yield bigints). */
function checked<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): unknown {
  const r = schema.safeParse(value);
  if (!r.success) {
    const why = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new HttpError(500, `gateway produced a ${what} the frontend would reject (${why})`);
  }
  return value;
}

const bad = (msg: string) => new HttpError(400, msg);

export function createGatewayApp(opts: GatewayOptions): Hono {
  const { cfg } = opts;
  const live = opts.live ?? buildLive(cfg);
  const reader = new Reader(live, cfg);
  const approvals = new Approvals(cfg, live, reader);
  const tools = new AgentTools({ world: live.world, wallet: live.wallet, attestorUrl: cfg.attestorUrl, approvalSink: approvals.sink });

  const app = new Hono();
  app.use('*', cors({ origin: (o) => (cfg.corsOrigins.includes(o) ? o : cfg.corsOrigins[0]!), allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['content-type'] }));
  app.onError((e, c) => {
    const status = e instanceof HttpError ? e.status : 500;
    return c.json({ error: e.message }, status as 400);
  });

  app.get('/health', async (c) => {
    const block = await live.pub.getBlockNumber().catch(() => null);
    return c.json({ ok: block !== null, service: '@hypnexis/gateway', chainId: cfg.chainId, wallet: cfg.wallet, agent: live.wallet.agentAddress, block: block?.toString() ?? null, lens: cfg.lens ?? null });
  });

  const body = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
  const sameWallet = (w: unknown) => {
    if (w !== undefined && (typeof w !== 'string' || !isAddress(w))) throw bad('wallet must be an address');
    if (typeof w === 'string' && getAddress(w) !== cfg.wallet) throw new HttpError(404, `this gateway serves wallet ${cfg.wallet}, not ${w}`);
  };

  // ---------------------------------------------------------------- agent tools
  app.post('/tools/get_policy', async (c) => {
    sameWallet((await body(c)).wallet);
    return c.json(checked(W.policy, await reader.getPolicy(), 'policy'));
  });

  app.post('/tools/get_budget', async (c) => {
    sameWallet((await body(c)).wallet);
    return c.json(checked(W.budget, await reader.getBudget(), 'budget'));
  });

  app.post('/tools/check', async (c) => {
    const b = await body(c);
    sameWallet(b.wallet);
    if (!isAddress(b.target ?? '')) throw bad('target must be an address');
    await refreshGas(live);
    const r = await tools.check({ target: getAddress(b.target), value: b.value ? BigInt(b.value) : 0n, data: b.data ?? '0x', payee: b.payee && isAddress(b.payee) ? getAddress(b.payee) : undefined });
    return c.json({ ok: r.ok, reasonCode: r.reasonName, track: r.tier === 'PROVEN' ? 'proven' : r.tier === 'FLAGGED' ? 'flagged' : 'unproven', simulatedOutflows: r.simulatedOutflows });
  });

  app.post('/tools/pay', async (c) => {
    const b = await body(c);
    sameWallet(b.wallet);
    if (!isAddress(b.to ?? '') || !isAddress(b.asset ?? '')) throw bad('to and asset must be addresses');
    let amount: bigint;
    try {
      amount = BigInt(b.amount);
    } catch {
      throw bad('amount must be an integer in base units');
    }
    await refreshGas(live);
    const to = getAddress(b.to) as Address;
    const asset = getAddress(b.asset) as Address;
    // the same check the tools run inside pay(): gives the track and the reason without a second submit
    const pre = await tools.check({ target: asset, data: (await import('../../../agent/src/ops/encode.ts')).erc20.transfer(to, amount), payee: to });
    const r = await tools.pay({ asset, to, amount });
    const status = r.status === 'needs_approval' ? 'approval_requested' : r.status;
    const out = {
      status,
      track: pre.tier === 'PROVEN' ? 'proven' : pre.tier === 'FLAGGED' ? 'flagged' : 'unproven',
      ...(status === 'refused' || status === 'approval_requested' ? { reasonCode: r.reasonName ?? r.reason ?? pre.reasonName } : {}),
      ...(status === 'executed' ? { outflow: amount.toString() } : {}),
      ...(r.txHash ? { txHash: r.txHash } : {}),
      ...(r.userOpHash ? { userOpHash: r.userOpHash } : {}),
      ...(r.requestId && approvals.toolToService.get(r.requestId) ? { approvalId: approvals.toolToService.get(r.requestId) } : {}),
    };
    return c.json(checked(W.payResult, out, 'payResult'));
  });

  app.post('/tools/approval_status', async (c) => {
    const b = await body(c);
    const id = String(b.id ?? b.requestId ?? '');
    if (!id) throw bad('id is required');
    return c.json(checked(W.approvalRequest, await approvals.one(id), 'approval request'));
  });

  // ---------------------------------------------------------------- approval service (adapter)
  app.get('/v1/requests', async (c) => {
    const w = c.req.query('wallet') ?? '';
    if (!isAddress(w)) throw bad('wallet must be an address');
    sameWallet(w);
    return c.json(checked(z.array(W.approvalSummary), await approvals.list(getAddress(w), c.req.query('status') || undefined), 'approval list'));
  });
  app.get('/v1/requests/:id', async (c) => c.json(checked(W.approvalRequest, await approvals.one(c.req.param('id')), 'approval request')));
  app.post('/v1/requests/:id/signature', async (c) => {
    const b = await body(c);
    if (typeof b.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(b.signature)) throw bad('signature must be 0x-hex');
    return c.json(checked(W.approvalRequest, await approvals.sign(c.req.param('id'), b.signature), 'approval request'));
  });
  app.post('/v1/requests/:id/decline', async (c) => {
    const b = await body(c);
    return c.json(checked(W.approvalRequest, await approvals.decline(c.req.param('id'), typeof b.signature === 'string' ? b.signature : undefined), 'approval request'));
  });

  // ---------------------------------------------------------------- attestor (adapter)
  app.get('/v1/attest', async (c) => {
    const w = c.req.query('wallet') ?? '';
    const p = c.req.query('payee') ?? '';
    if (!isAddress(w) || !isAddress(p)) throw bad('wallet and payee must be addresses');
    sameWallet(w);
    const payee = getAddress(p);
    let res: Response;
    try {
      res = await fetch(`${cfg.attestorUrl}/v1/attest?wallet=${cfg.wallet}&payee=${payee}&chainId=${cfg.chainId}`, { signal: AbortSignal.timeout(8000) });
    } catch (e) {
      throw new HttpError(502, `attestor unreachable at ${cfg.attestorUrl}: ${(e as Error).message}`);
    }
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 200 && j.tier === 'PROVEN') {
      return c.json(checked(W.attestation, { tier: 'PROVEN', validUntil: j.validUntil, epoch: Number(j.epoch), signature: j.signature }, 'attestation'));
    }
    if (res.status === 404 || res.status === 200) {
      if (await reader.read<boolean>('isFlagged', [payee])) {
        const epoch = Number(await reader.read<bigint>('attestEpoch'));
        return c.json(checked(W.attestation, { tier: 'FLAGGED', validUntil: Math.floor(Date.now() / 1000), epoch, signature: '0x' }, 'attestation'));
      }
      return c.json(checked(W.attestation, { attestation: null }, 'attestation'));
    }
    throw new HttpError(502, `attestor answered ${res.status}: ${j?.error ?? ''}`);
  });

  // ---------------------------------------------------------------- attack runner (mounted)
  let runner: Hono | null = opts.runner ?? null;
  const runnerCall = async (req: Request): Promise<Response> => {
    if (!runner) {
      try {
        const path = '../../runner/src/app.ts'; // built by the runner lane; absent until it lands
        const cfgPath = '../../runner/src/config.ts';
        const mod = (await import(/* @vite-ignore */ path)) as { createRunnerApp: (o: unknown, x?: { cors?: boolean }) => Hono };
        const cm = (await import(/* @vite-ignore */ cfgPath)) as { loadRunnerOptions: (env: NodeJS.ProcessEnv, root: string) => unknown };
        const root = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
        runner = mod.createRunnerApp(cm.loadRunnerOptions(process.env, decodeURIComponent(root)), { cors: false });
      } catch (e) {
        return Response.json({ error: `the attack runner is not available yet (${(e as Error).message.split('\n')[0]})` }, { status: 503 });
      }
    }
    return runner.fetch(req);
  };
  for (const p of ['/v1/cards', '/v1/configs', '/v1/bounty', '/v1/results', '/v1/runs', '/v1/runs/:id/events']) app.all(p, (c) => runnerCall(c.req.raw));

  return app;
}
