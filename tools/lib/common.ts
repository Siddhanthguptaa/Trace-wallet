import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, readRootEnv, type Config } from '@hypnexis/shared';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTRACTS = join(ROOT, 'contracts');
export const RESULTS = join(ROOT, 'results');

/** Merge <root>/.env into process.env (process env wins) so child processes (forge) see it. */
export function loadEnv(): Config {
  for (const [k, v] of Object.entries(readRootEnv(ROOT))) if (process.env[k] === undefined) process.env[k] = v;
  return loadConfig(process.env, { root: ROOT, useEnvFile: false });
}

/** forge/anvil/cast: FOUNDRY_BIN, then PATH, then ~/.foundry/bin (where foundryup installs). */
export function foundryBin(name: 'forge' | 'anvil' | 'cast'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const fromEnv = process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, exe) : undefined;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = spawnSync(name, ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return name;
  const home = join(homedir(), '.foundry', 'bin', exe);
  if (existsSync(home)) return home;
  throw new Error(`${name} not found: install Foundry (foundryup) or set FOUNDRY_BIN`);
}

export function pythonBin(): string {
  return process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
}

/** Run pnpm: reuse the pnpm that launched us (npm_execpath) to avoid .cmd shims on Windows. */
export function runPnpm(args: string[], cwd = ROOT): SpawnSyncReturns<Buffer> {
  const execpath = process.env.npm_execpath;
  if (execpath && /\.(c?js|mjs)$/.test(execpath)) {
    return spawnSync(process.execPath, [execpath, ...args], { cwd, stdio: 'inherit' });
  }
  return spawnSync(`pnpm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true });
}

/** Run forge in contracts/ and capture stdout (for --json). stderr is passed through. */
export function runForge(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(foundryBin('forge'), args, {
    cwd: CONTRACTS,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

export async function rpcReachable(url: string, timeoutMs = 5000): Promise<{ ok: boolean; chainId?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: string };
    if (!body.result) return { ok: false, error: `no result (HTTP ${res.status})` };
    return { ok: true, chainId: Number(body.result) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface BeatContext {
  root: string;
  config: Config;
  rpcUrl: string;
  log: (msg: string) => void;
}

export interface BeatResult {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export type Beat = (ctx: BeatContext) => Promise<BeatResult>;

export { spawn };
