/**
 * `live.ts console`: the owner-console BACKEND on http://localhost:8799 (127.0.0.1 only). There is no
 * frontend in this repo: it serves YOUR frontend from scripts/live/console/public/ (or --frontend <dir>).
 *   GET  /                 index.html of the frontend folder (and any static file in it)
 *   GET  /sdk.js           browser SDK, global `HypnexisOwner` (esbuild bundle, viem inside, works offline)
 *   GET  /config.json      PUBLIC config (addresses and policy numbers; never a key)
 *   GET  /api/status       live status read from the chain and the three services
 *   POST /api/agent/pay | /api/agent/request   demo helpers that act as the AGENT with its own key
 *   ANY  /approval/*  /attestor/*   proxies to the real approval and attestor services (no CORS needed)
 * The OWNER's key is not here: every owner transaction and signature happens in MetaMask in the browser.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Address, isAddress, parseUnits } from 'viem';
import { agentPay, fileApprovalRequest, makeCtx } from '../lib/agent.ts';
import { readLive, publicConfig, type Live } from '../lib/envfile.ts';
import { getStatus } from '../lib/status.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** esbuild ships with tsx; resolve it from there so no extra dependency is needed. */
async function bundle(): Promise<string> {
  const req = createRequire(import.meta.url);
  const tsxPkg = req.resolve('tsx/package.json');
  const esbuild = createRequire(tsxPkg)('esbuild') as { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };
  const r = await esbuild.build({
    entryPoints: [join(HERE, 'sdk.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'HypnexisOwner',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return r.outputFiles[0]!.text;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function proxy(req: IncomingMessage, res: ServerResponse, base: string, rest: string): Promise<void> {
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const r = await fetch(`${base}${rest}`, { method: req.method, headers: body ? { 'content-type': 'application/json' } : undefined, body, signal: AbortSignal.timeout(60_000) });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    json(res, 502, { error: `service unreachable: ${(e as Error).message}` });
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

/** Serve a static file from `root` (no path traversal; directories map to index.html). Returns false if absent. */
function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(root, '.' + normalize('/' + rel));
  if (!file.startsWith(resolve(root) + sep) && file !== resolve(root)) return false;
  if (!existsSync(file) || !statSync(file).isFile() || file.endsWith('README.md')) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
  return true;
}

export async function startConsole(opts: { port?: number; frontend?: string; log?: (m: string) => void } = {}): Promise<{ server: Server; url: string; close: () => void }> {
  const log = opts.log ?? console.log;
  const js = await bundle();
  const frontend = resolve(opts.frontend ?? join(HERE, 'public'));
  const port = opts.port ?? readLive().ports.console;

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').split(':')[0];
      if (host !== 'localhost' && host !== '127.0.0.1') return json(res, 403, { error: 'localhost only' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const L: Live = readLive(); // re-read every request: deploy / init may have updated it
      const p = url.pathname;
      if (req.method === 'GET' && p === '/sdk.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(js);
      }
      if (req.method === 'GET' && p === '/config.json') return json(res, 200, publicConfig(L));
      if (req.method === 'GET' && p === '/api/status') return json(res, 200, await getStatus(L));
      if (p.startsWith('/approval/')) return void (await proxy(req, res, L.urls.approval, p.slice('/approval'.length) + url.search));
      if (p.startsWith('/attestor/')) return void (await proxy(req, res, L.urls.attestor, p.slice('/attestor'.length) + url.search));
      if (req.method === 'POST' && (p === '/api/agent/pay' || p === '/api/agent/request')) {
        const b = JSON.parse((await readBody(req)) || '{}') as { to?: string; amount?: string; attested?: boolean; note?: string };
        if (!b.to || !isAddress(b.to)) return json(res, 400, { error: 'to must be an address' });
        const amount = parseUnits(String(b.amount ?? '1'), L.usdcDecimals);
        const ctx = await makeCtx(L, log);
        if (p === '/api/agent/pay') {
          const out = await agentPay(ctx, b.to as Address, amount, !!b.attested);
          return json(res, 200, { status: out.status, reason: out.reason, frozen: out.frozen, url: out.txHash && L.explorer ? `${L.explorer}/tx/${out.txHash}` : '' });
        }
        const r = await fileApprovalRequest(ctx, b.to as Address, amount, (b.note ?? '').slice(0, 280));
        return json(res, r.status, r.body);
      }
      if (req.method === 'GET' && serveStatic(frontend, p, res)) return;
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end(`Hypnexis owner-console backend is running.
No frontend found in ${frontend}.
Put index.html there, or start with --frontend <dir>.
API: /config.json /api/status /sdk.js /approval/* /attestor/* POST /api/agent/pay /api/agent/request
`);
      }
      return json(res, 404, { error: `no route ${req.method} ${p}` });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  const addr = server.address();
  const real = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://localhost:${real}`;
  log(`owner console backend: ${url}   (serving ${frontend}; open it in the browser profile that has MetaMask)`);
  return { server, url, close: () => server.close() };
}
