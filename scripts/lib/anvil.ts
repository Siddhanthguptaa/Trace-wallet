/** Minimal anvil lifecycle + time helpers for the scripts/ e2es and the demo beats. */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Address, type Hex, bytesToHex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);

export function findFoundry(name: 'anvil' | 'forge' | 'cast'): string {
  const fromEnv = process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, exe(name)) : null;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  const home = join(homedir(), '.foundry', 'bin', exe(name));
  if (existsSync(home)) return home;
  throw new Error(`${name} not found (foundryup or FOUNDRY_BIN)`);
}

export interface Anvil {
  rpcUrl: string;
  chainId: number;
  proc: ChildProcess;
  stop: () => void;
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

export async function startAnvil(chainId = 31337, extra: string[] = []): Promise<Anvil> {
  const port = await freePort();
  const proc = spawn(findFoundry('anvil'), ['--port', String(port), '--chain-id', String(chainId), '--accounts', '20', '--silent', ...extra], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      if (await rpc(rpcUrl, 'eth_chainId')) return { rpcUrl, chainId, proc, stop: () => proc.kill() };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('anvil did not start within 30 s');
}

export const chainNow = async (url: string): Promise<number> => Number(BigInt(((await rpc<{ timestamp: string }>(url, 'eth_getBlockByNumber', ['latest', false])).timestamp)));
export async function warp(url: string, seconds: number): Promise<number> {
  const t = (await chainNow(url)) + seconds;
  await rpc(url, 'evm_setNextBlockTimestamp', [t]);
  await rpc(url, 'evm_mine');
  return t;
}

/** anvil's public test mnemonic: dev keys only, never real funds. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
export function devKey(index: number): Hex {
  const pk = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (!pk) throw new Error(`no private key for dev index ${index}`);
  return bytesToHex(pk);
}

/** Role -> anvil account index (same numbering as agent/src/env.ts ROLE_INDEX). */
export const ROLE_INDEX = {
  owner: 0, agent: 1, attacker: 2, verifier: 3, attestor: 4, relayer: 5, agent2: 6, agent3: 7, facilitator: 8,
  watcher: 9, guardian0: 10, guardian1: 11, guardian2: 12, guardian3: 13, guardian4: 14, attackerAttestor: 15,
} as const;
export type Role = keyof typeof ROLE_INDEX;
export const DEV = Object.fromEntries((Object.keys(ROLE_INDEX) as Role[]).map((r) => [r, devKey(ROLE_INDEX[r])])) as Record<Role, Hex>;
export const addr = (r: Role): Address => privateKeyToAccount(DEV[r]).address;
