/**
 * pnpm run demo  ->  start anvil, run tools/demo/beats/*.ts in name order, write results/demo_run.json.
 * Each beat default-exports `async (ctx: BeatContext) => BeatResult`. Each milestone adds its own beat
 * file and never edits another milestone's beat. Set DEMO_NO_ANVIL=1 to skip starting anvil.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { foundryBin, loadEnv, RESULTS, ROOT, rpcReachable, type Beat, type BeatContext } from './lib/common.ts';

async function freePort(preferred: number): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number>((res, rej) => {
      const s = createServer();
      s.once('error', rej);
      s.listen(p, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => res(port));
      });
    });
  try {
    return await tryPort(preferred);
  } catch {
    return tryPort(0);
  }
}

async function startAnvil(cfg: ReturnType<typeof loadEnv>): Promise<{ proc: ChildProcess; rpcUrl: string }> {
  const port = await freePort(cfg.ANVIL_PORT);
  const args = ['--port', String(port), '--silent'];
  if (cfg.CHAIN_MODE === 'fork') args.push('--fork-url', cfg.BASE_RPC, '--fork-block-number', String(cfg.FORK_BLOCK));
  const proc = spawn(foundryBin('anvil'), args, { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with code ${proc.exitCode}`);
    if ((await rpcReachable(rpcUrl, 1000)).ok) return { proc, rpcUrl };
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error('anvil did not answer within 60 s');
}

const cfg = loadEnv();
mkdirSync(RESULTS, { recursive: true });
const startedAt = new Date().toISOString();
const beats: Record<string, unknown>[] = [];
let anvil: ChildProcess | undefined;
let rpcUrl = '';
let fatal: string | undefined;

try {
  if (process.env.DEMO_NO_ANVIL !== '1') {
    ({ proc: anvil, rpcUrl } = await startAnvil(cfg));
    console.log(`[demo] anvil up at ${rpcUrl} (CHAIN_MODE=${cfg.CHAIN_MODE})`);
  }
  const ctx: BeatContext = { root: ROOT, config: cfg, rpcUrl, log: (m) => console.log(`  ${m}`) };
  const dir = join(ROOT, 'tools', 'demo', 'beats');
  const files = readdirSync(dir)
    .filter((f) => /^\d+.*\.ts$/.test(f))
    .sort();
  for (const f of files) {
    console.log(`[demo] beat ${f}`);
    const t0 = Date.now();
    try {
      const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default: Beat };
      const r = await mod.default(ctx);
      beats.push({ beat: f, ok: r.ok, ms: Date.now() - t0, summary: r.summary, details: r.details ?? {} });
      console.log(`[demo] ${f}: ${r.ok ? 'ok' : 'FAIL'} - ${r.summary}`);
    } catch (e) {
      beats.push({ beat: f, ok: false, ms: Date.now() - t0, summary: `threw: ${(e as Error).message}` });
      console.log(`[demo] ${f}: FAIL - threw: ${(e as Error).message}`);
    }
  }
} catch (e) {
  fatal = (e as Error).message;
  console.log(`[demo] FAIL: ${fatal}`);
} finally {
  anvil?.kill();
}

const ok = !fatal && beats.length > 0 && beats.every((b) => b.ok === true);
writeFileSync(
  join(RESULTS, 'demo_run.json'),
  JSON.stringify(
    { ok, chainMode: cfg.CHAIN_MODE, rpcUrl, startedAt, finishedAt: new Date().toISOString(), fatal, beats },
    null,
    2,
  ),
);
console.log(`[demo] ${ok ? 'ok' : 'FAIL'}: ${beats.length} beats -> results/demo_run.json`);
process.exit(ok ? 0 : 1);
