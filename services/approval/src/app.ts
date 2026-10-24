/** HTTP API (docs/api.md section 16; base http://127.0.0.1:8788). Errors: { error: { code, message, ... } }. */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ApiError, type ApprovalService } from './service.ts';

export const SERVICE = '@hypnexis/approval';

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createApp(svc?: ApprovalService): Hono {
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof ApiError) return c.json(json({ error: { code: e.code, message: e.message, ...e.extra } }), e.http as ContentfulStatusCode);
    return c.json({ error: { code: 'INTERNAL', message: (e as Error).message.slice(0, 300) } }, 500);
  });

  app.get('/health', (c) =>
    c.json({
      service: SERVICE,
      ok: true,
      status: svc ? 'ready' : 'unconfigured',
      ...(svc ? { chainId: svc.cfg.chainId, simulationMode: svc.cfg.simulationMode } : {}),
    }),
  );

  app.use('/v1/*', async (c, next) => {
    if (!svc) return c.json({ error: { code: 'UNCONFIGURED', message: 'service has no chain config' } }, 503);
    await next();
  });

  const body = async (c: { req: { json: () => Promise<unknown> } }) => {
    try {
      return await c.req.json();
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'body must be JSON');
    }
  };

  app.post('/v1/requests', async (c) => c.json(json(await svc!.create(await body(c))), 201));
  app.get('/v1/requests', async (c) => c.json(json(await svc!.list(c.req.query()))));
  app.get('/v1/requests/:id', async (c) => c.json(json(await svc!.status(c.req.param('id')))));
  app.get('/v1/requests/:id/typed-data', async (c) => c.json(json(await svc!.typedData(c.req.param('id')))));
  app.get('/v1/requests/:id/userop', async (c) => c.json(json(await svc!.finalUserOp(c.req.param('id')))));
  app.post('/v1/requests/:id/signature', async (c) => {
    const wait = c.req.query('wait') === '1' || c.req.query('wait') === 'true';
    return c.json(json(await svc!.submitSignature(c.req.param('id'), await body(c), wait)));
  });
  app.post('/v1/requests/:id/reject', async (c) => c.json(json(await svc!.reject(c.req.param('id'), await body(c)))));
  app.get('/v1/keys/:agentKey', async (c) => c.json(json(await svc!.keyStats(c.req.param('agentKey'), c.req.query('account')))));

  return app;
}
