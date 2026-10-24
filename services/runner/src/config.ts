/**
 * Runner configuration. `loadRunnerOptions` reads `.env.live` (written by scripts/live/live.ts init) and the
 * `live` section of deployments/<chainId>.json (written by the live-infra deploy); tests pass options directly.
 *
 * deployments/<chainId>.json  ->  { "live": { "wallets": { "R1": {"address","kind":"eoa"}, "R2": {"address","kind":"naive"},
 *                                             "R3": {"address","kind":"agent"}, "R4": {"address","kind":"agent"} },
 *                                             "merchant"?: "0x..", "attacker"?: "0x.." } }
 * When the file has no `live.wallets`, R4 falls back to ACCOUNT from .env.live and R1 to the agent EOA.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type ConfigId = 'R1' | 'R2' | 'R3' | 'R4';
export const CONFIG_IDS: ConfigId[] = ['R1', 'R2', 'R3', 'R4'];
export type WalletKind = 'eoa' | 'naive' | 'agent';
export interface LiveWallet {
  address: Address;
  kind: WalletKind;
}

export interface RunnerOptions {
  /** repo root (results/, agent/, deployments/) */
  root: string;
  chainId: number;
  rpcUrl: string;
  usdc: Address;
  entryPoint: Address;
  /** the LEAKED agent key (throwaway, testnet) */
  agentKey: Hex;
  /** submits handleOps and token-side transactions for the attacker */
  relayerKey: Hex;
  /** receives the stolen funds */
  attackerAddress: Address;
  /** the attestor key, "leaked" in the compromised-attestor card */
  attestorKey?: Hex;
  wallets: Partial<Record<ConfigId, LiveWallet>>;
  /** the one listed merchant EOA (in-policy payee) */
  merchant?: Address;
  /** forge output dir under contracts/ (default 'out') */
  forgeOut?: string;
  /** per-attack spend cap in USDC base units (default 1 USDC) */
  maxAttack?: bigint;
  allowMainnet?: boolean;
}

export const ALLOWED_CHAINS = [84532, 31337];

export function assertChainAllowed(o: Pick<RunnerOptions, 'chainId' | 'allowMainnet'>): void {
  if (ALLOWED_CHAINS.includes(o.chainId)) return;
  if (o.chainId === 8453 && o.allowMainnet) {
    console.warn('[runner] WARNING: Base MAINNET with ALLOW_MAINNET=1. The contracts are unaudited; keep at most ~1 USDC in the wallets.');
    return;
  }
  throw new Error(`runner refuses chain ${o.chainId}: only Base Sepolia (84532) or a local chain (31337); Base mainnet needs ALLOW_MAINNET=1`);
}

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

const addr = (v?: string): Address | undefined => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : undefined);
const key = (v?: string): Hex | undefined => (v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : undefined);

export function loadRunnerOptions(env: NodeJS.ProcessEnv, root: string): RunnerOptions {
  const file = parseEnvFile(join(root, env.RUNNER_ENV_FILE ?? '.env.live'));
  const get = (k: string) => env[k] ?? file[k];
  const chainId = Number(get('CHAIN_ID') ?? 84532);
  const agentKey = key(get('AGENT_KEY'));
  const relayerKey = key(get('DEPLOYER_KEY'));
  if (!agentKey || !relayerKey) throw new Error('runner needs AGENT_KEY and DEPLOYER_KEY (relayer) in .env.live');
  const agentAddress = privateKeyToAccount(agentKey).address;
  const attackerKey = key(get('ATTACKER_KEY'));
  const attackerAddress = addr(get('ATTACKER_ADDRESS')) ?? (attackerKey ? privateKeyToAccount(attackerKey).address : privateKeyToAccount(relayerKey).address);

  const depFile = join(root, 'deployments', `${chainId}.json`);
  const live = existsSync(depFile) ? (JSON.parse(readFileSync(depFile, 'utf8')) as { live?: { wallets?: Record<string, { address: string; kind: WalletKind }>; merchant?: string } }).live : undefined;
  const wallets: Partial<Record<ConfigId, LiveWallet>> = {};
  for (const id of CONFIG_IDS) {
    const w = live?.wallets?.[id];
    const a = addr(w?.address);
    if (a && w) wallets[id] = { address: a, kind: w.kind };
  }
  if (!wallets.R1) wallets.R1 = { address: agentAddress, kind: 'eoa' };
  const account = addr(get('ACCOUNT'));
  if (!wallets.R4 && account) wallets.R4 = { address: account, kind: 'agent' };

  const opts: RunnerOptions = {
    root,
    chainId,
    rpcUrl: get('RPC_URL') ?? 'https://sepolia.base.org',
    usdc: addr(get('USDC')) ?? ('0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address),
    entryPoint: addr(get('ENTRYPOINT')) ?? ('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as Address),
    agentKey,
    relayerKey,
    attackerAddress,
    attestorKey: key(get('ATTESTOR_KEY')),
    wallets,
    merchant: addr(live?.merchant) ?? addr(get('MERCHANT_ADDRESS')),
    allowMainnet: get('ALLOW_MAINNET') === '1',
  };
  assertChainAllowed(opts);
  return opts;
}
