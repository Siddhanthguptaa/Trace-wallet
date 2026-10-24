/**
 * Helpers shared by the demo beats: run a tsx script in a child process (each e2e starts its own
 * anvil, so beats stay independent of the demo's shared chain), read a results file, and turn an
 * e2e `checks` list into beat output.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BeatContext, BeatResult } from '../lib/common.ts';

export interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}

export const rel = (p: string) => p.split('\\').join('/');

/** Run `node --import tsx <script>` from `cwd`; returns exit status and the tail of the output. */
export function runTsx(script: string, cwd: string, env: Record<string, string> = {}, timeoutMs = 420_000): { status: number | null; tail: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 << 20,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n');
  return { status: r.status, tail: out.slice(-6).join(' | ').slice(-600) };
}

export function readResult<T = Record<string, any>>(ctx: BeatContext, file: string): T | null {
  const p = join(ctx.root, 'results', file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

/** Run a scripts/e2e script that writes results/<file> with {ok, passed, total, checks}. */
export function e2eBeat(
  ctx: BeatContext,
  o: { title: string; script: string; file: string; highlights?: (d: Record<string, any>) => string[]; env?: Record<string, string> },
): BeatResult {
  const run = runTsx(join(ctx.root, o.script), ctx.root, o.env);
  const d = readResult(ctx, o.file);
  if (!d) return { ok: false, summary: `${o.title}: ${o.script} produced no ${o.file} (exit ${run.status}): ${run.tail}` };
  if (run.status !== 0 && d.ok === true) return { ok: false, summary: `${o.title}: script exited ${run.status} but ${o.file} says ok (stale file?)` };
  ctx.log(`${o.title}: ${d.passed}/${d.total} checks on the real AgentAccount (${d.generatedAt})`);
  for (const l of o.highlights?.(d) ?? []) ctx.log(`  ${l}`);
  for (const c of (d.checks as Check[]) ?? []) if (!c.pass) ctx.log(`  FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
  return {
    ok: d.ok === true && run.status === 0,
    summary: `${o.title}: ${d.passed}/${d.total} checks ok`,
    details: { file: `results/${o.file}`, passed: d.passed, total: d.total, realAccount: d.realAccount === true },
  };
}

/** The first check whose name starts with `prefix` (for highlight lines). */
export const pick = (d: Record<string, any>, prefix: string): string => {
  const c = ((d.checks as Check[]) ?? []).find((x) => x.name.startsWith(prefix));
  return c ? `${c.pass ? 'ok  ' : 'FAIL'} ${c.name} -> ${c.observed}` : `(no check "${prefix}")`;
};
