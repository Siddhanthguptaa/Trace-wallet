/**
 * Local anvil for the harness: deterministic time (genesis timestamp + 1 s per block), zero base
 * fee (so a raw-key ETH transfer moves exactly its value, like a Foundry prank), 20 dev accounts.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundryExe } from './artifacts.ts';
import { ANVIL_ACCOUNTS } from '../env.ts';

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export interface Anvil {
  rpcUrl: string;
  chainId: number;
  proc: ChildProcess | null;
  stop: () => void;
}

export interface AnvilOptions {
  port?: number;
  chainId?: number;
  genesisTs?: number;
  forkUrl?: string;
  forkBlock?: number;
}

export async function startAnvil(o: AnvilOptions = {}): Promise<Anvil> {
  const port = o.port ?? (await freePort());
  const chainId = o.chainId ?? 31337;
  const args = [
    '--port', String(port),
    '--chain-id', String(chainId),
    '--accounts', String(ANVIL_ACCOUNTS),
    '--block-base-fee-per-gas', '0',
    '--gas-price', '0',
    '--code-size-limit', '49152',
    '--silent',
  ];
  if (o.genesisTs !== undefined && !o.forkUrl) args.push('--timestamp', String(o.genesisTs));
  if (o.forkUrl) args.push('--fork-url', o.forkUrl, ...(o.forkBlock ? ['--fork-block-number', String(o.forkBlock)] : []));
  const proc = spawn(foundryExe('anvil'), args, { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      const r = await rpc<string>(rpcUrl, 'eth_chainId', []);
      if (r) {
        await rpc(rpcUrl, 'anvil_setBlockTimestampInterval', [1]);
        return { rpcUrl, chainId, proc, stop: () => proc.kill() };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('anvil did not start within 60 s');
}

let rpcId = 1;
export async function rpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export function chainOf(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `harness-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface Clients {
  rpcUrl: string;
  chain: Chain;
  pub: PublicClient<Transport, Chain>;
  wallet: (pk: Hex) => WalletClient<Transport, Chain, Account>;
}

export function clients(rpcUrl: string, chainId: number): Clients {
  const chain = chainOf(chainId, rpcUrl);
  const transport = http(rpcUrl, { retryCount: 0 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 50 });
  const cache = new Map<string, WalletClient<Transport, Chain, Account>>();
  return {
    rpcUrl,
    chain,
    pub,
    wallet: (pk: Hex) => {
      let w = cache.get(pk);
      if (!w) {
        w = createWalletClient({ account: privateKeyToAccount(pk), chain, transport });
        cache.set(pk, w);
      }
      return w;
    },
  };
}

/** Test-chain controls (anvil only). */
export const devchain = {
  snapshot: (url: string) => rpc<Hex>(url, 'evm_snapshot', []),
  revert: (url: string, id: Hex) => rpc<boolean>(url, 'evm_revert', [id]),
  mine: (url: string) => rpc(url, 'evm_mine', []),
  setBalance: (url: string, who: string, wei: bigint) => rpc(url, 'anvil_setBalance', [who, `0x${wei.toString(16)}`]),
  /** Next block gets timestamp `ts`, then mine it. */
  async setTime(url: string, ts: number): Promise<void> {
    await rpc(url, 'evm_setNextBlockTimestamp', [ts]);
    await rpc(url, 'evm_mine', []);
  },
  async now(url: string): Promise<number> {
    const b = await rpc<{ timestamp: Hex }>(url, 'eth_getBlockByNumber', ['latest', false]);
    return Number(BigInt(b.timestamp));
  },
  async warp(url: string, seconds: number): Promise<number> {
    const t = (await devchain.now(url)) + seconds;
    await devchain.setTime(url, t);
    return t;
  },
};
