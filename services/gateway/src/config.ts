/**
 * Gateway config. Reads the repo-root `.env.live` (written by scripts/live `init`) and lets real
 * environment variables override it. No private key of the OWNER is ever read: the owner is a public
 * address and signs in MetaMask.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Address, type Hex, getAddress, isAddress } from 'viem';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

export interface GatewayConfig {
  port: number;
  chainId: number;
  rpcUrl: string;
  entryPoint: Address;
  usdc: Address;
  usdcSymbol: string;
  usdcDecimals: number;
  wallet: Address;
  owner?: Address;
  lens?: Address;
  agentKey: Hex;
  relayerKey: Hex;
  approvalUrl: string;
  attestorUrl: string;
  forgeOut: string;
  fromBlock?: bigint;
  /** Optional ceiling on the op fee (wei), on top of the session's own maxFeePerGas cap. */
  maxFeeWei?: bigint;
  corsOrigins: string[];
}

const need = (e: Record<string, string | undefined>, k: string): string => {
  const v = e[k];
  if (!v) throw new Error(`gateway: ${k} is not set (run \`live.ts init\` / \`deploy\`, or set it in the environment)`);
  return v;
};
const addr = (e: Record<string, string | undefined>, k: string): Address => {
  const v = need(e, k);
  if (!isAddress(v)) throw new Error(`gateway: ${k} is not an address`);
  return getAddress(v);
};

export function loadConfig(env: Record<string, string | undefined> = {}, file = resolve(REPO_ROOT, '.env.live')): GatewayConfig {
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const e = { ...fromFile, ...process.env, ...env } as Record<string, string | undefined>;
  const wallet = e.WALLET_ADDRESS || e.ACCOUNT;
  if (!wallet || !isAddress(wallet)) throw new Error('gateway: ACCOUNT (or WALLET_ADDRESS) is not set: deploy and create the account first');
  const agentKey = need(e, 'AGENT_KEY') as Hex;
  return {
    port: Number(e.GATEWAY_PORT ?? 8800),
    chainId: Number(need(e, 'CHAIN_ID')),
    rpcUrl: need(e, 'RPC_URL'),
    entryPoint: addr(e, 'ENTRYPOINT'),
    usdc: addr(e, 'USDC'),
    usdcSymbol: e.USDC_SYMBOL ?? 'USDC',
    usdcDecimals: Number(e.USDC_DECIMALS ?? 6),
    wallet: getAddress(wallet),
    owner: e.OWNER_ADDRESS && isAddress(e.OWNER_ADDRESS) ? getAddress(e.OWNER_ADDRESS) : undefined,
    lens: e.LENS && isAddress(e.LENS) ? getAddress(e.LENS) : undefined,
    agentKey,
    relayerKey: (e.DEPLOYER_KEY ?? e.RELAYER_KEY ?? agentKey) as Hex,
    approvalUrl: (e.APPROVAL_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, ''),
    attestorUrl: (e.ATTESTOR_URL ?? 'http://127.0.0.1:8789').replace(/\/$/, ''),
    forgeOut: e.HARN_FORGE_OUT ?? 'out',
    fromBlock: e.GATEWAY_FROM_BLOCK ? BigInt(e.GATEWAY_FROM_BLOCK) : undefined,
    maxFeeWei: e.GATEWAY_MAX_FEE_WEI ? BigInt(e.GATEWAY_MAX_FEE_WEI) : undefined,
    corsOrigins: (e.GATEWAY_CORS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173').split(',').map((s) => s.trim()),
  };
}
