/**
 * Local toolchain helpers for the APPS lane (own copy; same approach as the ATT lane): find anvil +
 * solc 0.8.28, compile with the contracts/ remappings, start anvil on a free port, deploy. Missing
 * tools give null so tests can skip with a note.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Abi, type Address, type Hex, createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainForId } from '../../../../packages/shared/src/approval/submitter.ts';

export const SVC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUILD_ROOT = resolve(SVC_ROOT, '..', '..');

/** anvil's public dev keys (test only). Roles per BUILD.md Conventions, same numbering as ATT. */
export const DEV_KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // #0
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // #1
  attacker: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // #2
  relayer: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // #5
  shop: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // #6
} as const satisfies Record<string, Hex>;

const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);

export function findAnvil(): string | null {
  const fromEnv = process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, exe('anvil')) : null;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = join(homedir(), '.foundry', 'bin', exe('anvil'));
  if (existsSync(home)) return home;
  return spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0 ? 'anvil' : null;
}

export function findSolc(): string | null {
  const c = [
    process.env.SOLC,
    process.env.APPDATA ? join(process.env.APPDATA, 'svm', '0.8.28', 'solc-0.8.28') : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, 'svm', '0.8.28', 'solc-0.8.28.exe') : undefined,
    join(homedir(), '.svm', '0.8.28', 'solc-0.8.28'),
    join(homedir(), '.foundry', 'bin', 'solc-0.8.28'),
  ].filter((x): x is string => !!x);
  return c.find((p) => existsSync(p)) ?? null;
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  runtime: Hex;
}

/** solc --combined-json over build-root-relative sources, with contracts/foundry.toml remappings. */
export function compile(solc: string, sources: string[]): Record<string, Artifact> {
  const args = [
    '--base-path', BUILD_ROOT,
    '--include-path', join(BUILD_ROOT, 'contracts', 'lib'),
    '--evm-version', 'cancun',
    '--optimize',
    'account-abstraction/=contracts/lib/account-abstraction/contracts/',
    '@openzeppelin/contracts/=contracts/lib/openzeppelin-contracts/contracts/',
    '--combined-json', 'abi,bin,bin-runtime',
    ...sources,
  ];
  const r = spawnSync(solc, args, { cwd: BUILD_ROOT, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`solc failed: ${r.stderr.slice(0, 2000)}`);
  const out = JSON.parse(r.stdout) as { contracts: Record<string, { abi: Abi | string; bin: string; 'bin-runtime': string }> };
  const res: Record<string, Artifact> = {};
  for (const [k, v] of Object.entries(out.contracts)) {
    const name = k.split(':').pop()!;
    res[name] = {
      abi: typeof v.abi === 'string' ? (JSON.parse(v.abi) as Abi) : v.abi,
      bytecode: `0x${v.bin}` as Hex,
      runtime: `0x${v['bin-runtime']}` as Hex,
    };
  }
  return res;
}

export const SIMULATOR_SOURCE = 'services/approval/contracts/ApprovalSimulator.sol';
export const STUB_SOURCE = 'services/approval/test/anvil/ApprovalStub.sol';
export const ENTRYPOINT_SOURCE = 'contracts/lib/account-abstraction/contracts/core/EntryPoint.sol';

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
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

export function clients(chain: DevChain, key: Hex) {
  const c = chainForId(chain.chainId, chain.rpcUrl);
  const account = privateKeyToAccount(key);
  return {
    account,
    pub: createPublicClient({ chain: c, transport: http(chain.rpcUrl), pollingInterval: 100 }),
    wallet: createWalletClient({ account, chain: c, transport: http(chain.rpcUrl) }),
  };
}

export async function deploy(chain: DevChain, art: Artifact, args: unknown[], key: Hex = DEV_KEYS.owner): Promise<Address> {
  const { pub, wallet, account } = clients(chain, key);
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args, account, chain: wallet.chain });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error('deploy failed');
  return getAddress(r.contractAddress);
}

/** write + wait; throws on revert. */
export async function send(
  chain: DevChain,
  key: Hex,
  p: { address: Address; abi: Abi; functionName: string; args?: unknown[]; value?: bigint },
): Promise<Hex> {
  const { pub, wallet, account } = clients(chain, key);
  const hash = await wallet.writeContract({ ...p, args: p.args ?? [], account, chain: wallet.chain } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${p.functionName} reverted`);
  return hash;
}
