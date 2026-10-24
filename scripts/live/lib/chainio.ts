/**
 * Node-side chain access for the live demo, built from `.env.live`. Reuses scripts/lib/stack.ts
 * (artifact loading, library linking, Deployer) and scripts/lib/ops.ts (UserOps, handleOps).
 * Public RPC friendly: receipts are polled every 1.5 s, not every 100 ms.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Abi, type Address, type Hex, createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Deployer, type Stack, accountAbi, loadArtifact } from '../../lib/stack.ts';
import { type OpGas } from '../../lib/ops.ts';
import { STATE_DIR, type Live } from './envfile.ts';

export const usdcAbi = parseAbi([
  'function balanceOf(address who) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function name() view returns (string)',
  'function version() view returns (string)',
]);

export const erc1271Abi = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

export function chainFor(L: Pick<Live, 'chainId' | 'chainName' | 'rpcUrl'>) {
  return defineChain({ id: L.chainId, name: L.chainName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [L.rpcUrl] } } });
}

export function publicClient(L: Pick<Live, 'chainId' | 'chainName' | 'rpcUrl'>) {
  return createPublicClient({ chain: chainFor(L), transport: http(L.rpcUrl, { retryCount: 4, retryDelay: 600 }), pollingInterval: 1500 });
}

export function walletClient(L: Pick<Live, 'chainId' | 'chainName' | 'rpcUrl'>, key: Hex) {
  return createWalletClient({ account: privateKeyToAccount(key), chain: chainFor(L), transport: http(L.rpcUrl, { retryCount: 4, retryDelay: 600 }) });
}

/** A scripts/lib Deployer with a gentle polling interval, for deploys, sends and handleOps. */
export function makeDeployer(L: Live, key: Hex = L.deployerKey): Deployer {
  const d = new Deployer({ rpcUrl: L.rpcUrl, chainId: L.chainId }, key);
  (d as unknown as { pub: unknown }).pub = publicClient(L);
  return d;
}

/** The deployed stack as scripts/lib/ops.ts expects it (needs FACTORY etc. in .env.live). */
export function stackOf(L: Live): Stack {
  const abis = { account: accountAbi(), factory: loadArtifact('AgentAccountFactory').abi, entryPoint: loadArtifact('EntryPoint').abi, paymaster: loadArtifact('AgentPaymaster').abi, lens: loadArtifact('PolicyLens').abi };
  return {
    entryPoint: L.entryPoint,
    libs: {},
    admin: (L.admin || '0x0000000000000000000000000000000000000000') as Address,
    implementation: (L.implementation || '0x0000000000000000000000000000000000000000') as Address,
    factory: (L.factory || '0x0000000000000000000000000000000000000000') as Address,
    lens: (L.lens || '0x0000000000000000000000000000000000000000') as Address,
    paymaster: null,
    abi: abis,
  };
}

/** Agent-op gas that is cheap on a real chain: fee cap = 3x the current gas price (at most 1 gwei). */
export async function liveOpGas(L: Live): Promise<OpGas> {
  const price = await publicClient(L).getGasPrice();
  let fee = price * 3n;
  if (fee < 5_000_000n) fee = 5_000_000n;
  if (fee > 1_000_000_000n) fee = 1_000_000_000n;
  return { verificationGasLimit: 250_000n, callGasLimit: 300_000n, preVerificationGas: 60_000n, maxFeePerGas: fee, maxPriorityFeePerGas: fee };
}

// ---- runtime state (spray addresses, attack log): git-ignored, scripts/live/.state/state.json ----

export interface RunState {
  spray: Address[];
  attackLog: { at: string; attack: string; summary: string }[];
}
const STATE_FILE = join(STATE_DIR, 'state.json');
export function loadState(): RunState {
  if (!existsSync(STATE_FILE)) return { spray: [], attackLog: [] };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState;
}
export function saveState(s: RunState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson<T = unknown>(url: string, init?: RequestInit, timeoutMs = 4000): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, body: body as T };
}

export type { Abi };
