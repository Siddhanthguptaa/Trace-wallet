/**
 * Local dev chain for the ATT lane's anvil checks: find anvil + solc 0.8.28, compile
 * test/anvil/AttestorStub.sol (which imports CORE's contracts/src/lib/TypedData.sol), start anvil,
 * deploy the stub. Returns null pieces instead of throwing when the toolchain is missing, so tests
 * can skip with a note.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainFor } from '../../src/chain.ts';

export const SVC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUILD_ROOT = resolve(SVC_ROOT, '..', '..');

/** anvil's default dev keys (public, test only). Roles follow BUILD.md Conventions: all distinct. */
export const DEV_KEYS = {
  deployerOwner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  attacker: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  verifier: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  attestor: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  relayer: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
} as const satisfies Record<string, Hex>;

function exe(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

export function findAnvil(): string | null {
  const fromEnv = process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, exe('anvil')) : null;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0) return 'anvil';
  const home = join(homedir(), '.foundry', 'bin', exe('anvil'));
  return existsSync(home) ? home : null;
}

export function findSolc(): string | null {
  const cands = [
    process.env.SOLC,
    process.env.APPDATA ? join(process.env.APPDATA, 'svm', '0.8.28', 'solc-0.8.28') : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, 'svm', '0.8.28', 'solc-0.8.28.exe') : undefined,
    join(homedir(), '.svm', '0.8.28', 'solc-0.8.28'),
    join(homedir(), '.foundry', 'bin', 'solc-0.8.28'),
  ].filter((x): x is string => !!x);
  return cands.find((c) => existsSync(c)) ?? null;
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function compileStubs(solc: string): { stub: Artifact; token: Artifact } {
  const src = 'services/attestor/test/anvil/AttestorStub.sol';
  const r = spawnSync(solc, ['--base-path', BUILD_ROOT, '--evm-version', 'cancun', '--optimize', '--combined-json', 'abi,bin', src], {
    cwd: BUILD_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  if (r.status !== 0) throw new Error(`solc failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { contracts: Record<string, { abi: Abi | string; bin: string }> };
  const get = (name: string): Artifact => {
    const key = Object.keys(out.contracts).find((k) => k.endsWith(`:${name}`));
    if (!key) throw new Error(`${name} not in solc output`);
    const c = out.contracts[key]!;
    return { abi: typeof c.abi === 'string' ? (JSON.parse(c.abi) as Abi) : c.abi, bytecode: `0x${c.bin}` as Hex };
  };
  return { stub: get('AttestorStub'), token: get('StubToken') };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export interface DevChain {
  rpcUrl: string;
  chainId: number;
  proc: ChildProcess;
  stop: () => void;
}

export async function startAnvil(anvil: string, chainId = 31337): Promise<DevChain> {
  const port = await freePort();
  const proc = spawn(anvil, ['--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(1000),
      });
      if (((await res.json()) as { result?: string }).result) return { rpcUrl, chainId, proc, stop: () => proc.kill() };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('anvil did not start within 30 s');
}

export async function deploy(chain: DevChain, art: Artifact, args: unknown[], deployerKey: Hex = DEV_KEYS.deployerOwner): Promise<Address> {
  const c = chainFor(chain.chainId, chain.rpcUrl);
  const account = privateKeyToAccount(deployerKey);
  const wc = createWalletClient({ account, chain: c, transport: http(chain.rpcUrl) });
  const pub = createPublicClient({ chain: c, transport: http(chain.rpcUrl), pollingInterval: 100 });
  const hash = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain: c });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error('deploy failed');
  return getAddress(r.contractAddress);
}
