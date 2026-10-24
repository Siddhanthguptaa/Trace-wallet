/**
 * Runner HTTP API for the demo surface (web/src/api/endpoints.ts `runner`). See API.md.
 *
 *   GET  /health
 *   GET  /v1/cards      the 13 X1 attack cards
 *   GET  /v1/configs    R1..R4 -> the real wallet address of each
 *   GET  /v1/bounty     the LEAKED agent key (throwaway, testnet) and the wallet it can touch
 *   GET  /v1/results    the recorded X1 table (x1Table shape) + the legit-stream openness metric
 *   POST /v1/runs       { cardId, shooter?: 'raw'|'llm', configs? } -> { runId }; one run at a time
 *   GET  /v1/runs/:id/events   Server-Sent Events: attempt | log | done
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { CONFIG_IDS, assertChainAllowed, type ConfigId, type RunnerOptions } from './config.ts';
import { buildResults, loadCards } from './data.ts';
import { LiveRunner, type Attempt } from './live.ts';

const CONFIG_LABEL: Record<ConfigId, string> = { R1: 'Raw key', R2: 'Static allowlist', R3: 'Ours, without D3', R4: 'Ours, with D3' };
const runBody = z.object({ cardId: z.string().min(1), shooter: z.enum(['raw', 'llm']).default('raw'), configs: z.array(z.enum(['R1', 'R2', 'R3', 'R4'])).optional() });

type WireEvent = Record<string, unknown> & { type: 'attempt' | 'log' | 'done' };
interface Run {
  events: WireEvent[];
  done: boolean;
  wake: (() => void)[];
}

const wireAttempt = (runId: string, config: ConfigId, a: Attempt): WireEvent => ({
  type: 'attempt',
  runId,
  config,
  outcome: a.outcome,
  ...(a.amount !== undefined ? { amount: a.amount.toString() } : {}),
  ...(a.asset ? { asset: a.asset } : {}),
  ...(a.reasonCode ? { reasonCode: a.reasonCode } : {}),
  ...(a.txHash ? { txHash: a.txHash } : {}),
  ...(a.k !== undefined ? { k: a.k } : {}),
  ...(a.n !== undefined ? { n: a.n } : {}),
  ...(a.note ? { note: a.note } : {}),
  at: Math.floor(Date.now() / 1000),
});

export function createRunnerApp(opts: RunnerOptions, extra: { cors?: boolean } = {}): Hono {
  assertChainAllowed(opts);
  const app = new Hono();
  const live = new LiveRunner(opts);
  const runs = new Map<string, Run>();
  let active: string | null = null;
  if (extra.cors !== false) app.use('*', cors({ origin: '*' }));

  app.onError((e, c) => c.json({ error: e.message.slice(0, 300) }, 500));
  app.get('/health', (c) => c.json({ service: '@hypnexis/runner', ok: true, chainId: opts.chainId, wallets: Object.keys(opts.wallets), busy: active !== null }));

  app.get('/v1/cards', (c) => c.json(loadCards(opts.root)));

  app.get('/v1/configs', (c) =>
    c.json(CONFIG_IDS.filter((id) => opts.wallets[id]).map((id) => ({ id, label: CONFIG_LABEL[id], wallet: opts.wallets[id]!.address }))),
  );

  app.get('/v1/bounty', (c) => {
    const wallet = opts.wallets.R4 ?? opts.wallets.R3 ?? opts.wallets.R1;
    if (!wallet) return c.json({ error: 'no wallet is configured' }, 503);
    return c.json({ agentPrivateKey: opts.agentKey, agentAddress: privateKeyToAccount(opts.agentKey).address, wallet: wallet.address, chainId: opts.chainId });
  });

  app.get('/v1/results', (c) => c.json(buildResults(opts.root, opts.usdc)));

  app.post('/v1/runs', async (c) => {
    const parsed = runBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'body must be { cardId, shooter?, configs? }' }, 400);
    const { cardId, shooter, configs } = parsed.data;
    if (!loadCards(opts.root).some((x) => x.id === cardId)) return c.json({ error: `unknown card ${cardId}` }, 404);
    if (active) return c.json({ error: 'a run is already in progress; wait for it to finish' }, 409);
    const runId = crypto.randomUUID();
    const run: Run = { events: [], done: false, wake: [] };
    runs.set(runId, run);
    active = runId;
    const push = (e: WireEvent) => {
      run.events.push(e);
      for (const w of run.wake.splice(0)) w();
    };
    void (async () => {
      try {
        await live.run(cardId, shooter, configs, (e) => {
          if (e.type === 'log') push({ type: 'log', runId, message: e.message, at: Math.floor(Date.now() / 1000) });
          else push(wireAttempt(runId, e.config, e.attempt));
        });
      } catch (err) {
        push({ type: 'log', runId, message: `run failed: ${(err as Error).message.slice(0, 200)}`, at: Math.floor(Date.now() / 1000) });
      } finally {
        push({ type: 'done', runId, at: Math.floor(Date.now() / 1000) });
        run.done = true;
        active = null;
      }
    })();
    return c.json({ runId });
  });

  app.get('/v1/runs/:id/events', (c) => {
    const run = runs.get(c.req.param('id'));
    if (!run) return c.json({ error: 'unknown run' }, 404);
    return streamSSE(c, async (stream) => {
      let i = 0;
      for (;;) {
        while (i < run.events.length) await stream.writeSSE({ data: JSON.stringify(run.events[i++]) });
        if (run.done) break;
        await Promise.race([new Promise<void>((res) => run.wake.push(res)), new Promise<void>((res) => setTimeout(res, 15_000))]);
      }
    });
  });

  return app;
}
