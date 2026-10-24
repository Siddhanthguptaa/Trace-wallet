/**
 * HTTP surface (node:http, no framework): GET /health, GET /v1/state,
 * POST /v1/approval-requests {account, agentKey, ts?} (reported by the approval service / tools layer).
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { getAddress, isAddress } from 'viem';
import type { WatcherService } from './service.ts';

const MAX_BODY = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(s);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function makeServer(svc: WatcherService, info: { watcher: string | null; chainId: number }): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, service: 'watcher', watcher: info.watcher, chainId: info.chainId });
      }
      if (req.method === 'GET' && url.pathname === '/v1/state') return send(res, 200, svc.state());
      if (req.method === 'POST' && url.pathname === '/v1/approval-requests') {
        let body: { account?: string; agentKey?: string; ts?: number };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: { code: 'BAD_JSON', message: 'invalid JSON body' } });
        }
        if (!body.account || !isAddress(body.account) || !body.agentKey || !isAddress(body.agentKey)) {
          return send(res, 400, { error: { code: 'BAD_REQUEST', message: 'account and agentKey must be addresses' } });
        }
        const ts = Number.isFinite(body.ts) ? Number(body.ts) : undefined;
        const raised = await svc.approvalRequest(getAddress(body.account), getAddress(body.agentKey), ts);
        return send(res, 200, { accepted: true, alarms: raised.map((r) => ({ ...r.alarm, freeze: r.freeze?.status ?? 'already_frozen' })) });
      }
      return send(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
    } catch (e) {
      return send(res, 500, { error: { code: 'INTERNAL', message: (e as Error).message } });
    }
  });
}
