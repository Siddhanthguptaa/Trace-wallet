/** HTTP API (docs: services/attestor/API.md, merged into docs/api.md by INT). */
import { Hono } from 'hono';
import { isAddress } from 'viem';
import { type Attestor, EpochUnavailableError } from './attestor.ts';

export const SERVICE = '@hypnexis/attestor';

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createApp(attestor?: Attestor): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      service: SERVICE,
      ok: true,
      status: attestor ? 'ready' : 'unconfigured',
      ...(attestor ? { mode: attestor.mode, attestor: attestor.signer.address, chainId: attestor.chainId } : {}),
    }),
  );

  app.use('/v1/*', async (c, next) => {
    if (!attestor) return c.json({ error: 'unconfigured' }, 503);
    await next();
  });

  app.get('/v1/attest', async (c) => {
    const wallet = c.req.query('wallet') ?? '';
    const payee = c.req.query('payee') ?? '';
    const chainId = c.req.query('chainId');
    if (!isAddress(wallet) || !isAddress(payee)) return c.json({ error: 'bad_request', detail: 'wallet and payee must be 0x addresses' }, 400);
    if (chainId !== undefined && Number(chainId) !== attestor!.chainId) {
      return c.json({ error: 'wrong_chain', detail: `this attestor signs for chainId ${attestor!.chainId}` }, 400);
    }
    try {
      const r = await attestor!.attest(wallet, payee);
      if (r.kind === 'attestation') {
        const s = r.signed;
        return c.json(
          json({
            tier: 'PROVEN',
            tierCode: s.tier,
            validUntil: s.validUntil,
            epoch: s.epoch,
            signature: s.signature,
            attestation: s.attestation,
            digest: s.digest,
            wallet: s.wallet,
            payee: s.recipient,
            recipient: s.recipient,
            chainId: s.chainId,
            attestor: attestor!.signer.address,
            code: r.code,
          }),
        );
      }
      return c.json(json({ error: 'no_attestation', tier: r.tier, code: r.code, reason: r.reason, ...(r.flag ? { flag: r.flag } : {}) }), 404);
    } catch (e) {
      if (e instanceof EpochUnavailableError) return c.json({ error: 'epoch_unavailable', detail: e.message }, 503);
      throw e;
    }
  });

  app.post('/v1/outcomes', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ accepted: false, status: 'rejected', reason: 'invalid_json' }, 400);
    }
    const r = await attestor!.report(body);
    switch (r.status) {
      case 'accepted':
        return c.json(json({ accepted: true, status: 'accepted', id: r.record.id, payee: r.record.payee, success: r.record.success, source: r.record.source, tier: r.tier, code: r.code, flags: r.flags }));
      case 'duplicate':
        return c.json({ accepted: false, status: 'duplicate', id: r.id }, 409);
      case 'ignored':
        return c.json({ accepted: false, status: 'ignored', reason: r.reason }, 202);
      default:
        return c.json({ accepted: false, status: 'rejected', reason: r.reason }, 400);
    }
  });

  app.get('/v1/score', (c) => {
    const payee = c.req.query('payee') ?? '';
    if (!isAddress(payee)) return c.json({ error: 'bad_request', detail: 'payee must be a 0x address' }, 400);
    return c.json(json(attestor!.profile(payee)));
  });

  app.post('/v1/flags/sync', async (c) => c.json(json({ results: await attestor!.syncFlags() })));

  return app;
}
