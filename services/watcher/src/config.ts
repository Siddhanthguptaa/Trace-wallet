/** Watcher env config (no zod: the package only needs viem). */
import { type Address, type Hex, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ConfigOverride } from './service.ts';

export interface WatcherEnv {
  watcherKey: Hex | null;
  watcher: Address | null;
  rpcUrl: string | null;
  chainId: number;
  accounts: Address[];
  entryPoint: Address | null;
  agentAddresses: Address[];
  port: number;
  pollMs: number;
  fromBlock: bigint | null;
  config: ConfigOverride | undefined;
  caps: Record<string, bigint>;
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

function list(s: string | undefined): Address[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => getAddress(x));
}

function json(name: string, s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`${name}: invalid JSON`);
  }
}

/**
 * WATCHER_PRIVATE_KEY  watcher role key (escalate-only; must differ from every agent key)
 * RPC_URL, CHAIN_ID    chain (default 31337)
 * WATCHER_ACCOUNTS     comma list of AgentAccount addresses to watch
 * ENTRYPOINT           EntryPoint address (failed UserOps); default v0.8 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
 * AGENT_ADDRESSES      optional comma list; the service refuses to start if the watcher is one of them
 * WATCHER_PORT         HTTP port (default 8790)
 * POLL_MS              chain poll interval (default 2000)
 * FROM_BLOCK           first block to scan (default: the head at start)
 * WATCHER_CONFIG       JSON override of DEFAULT_CONFIG, e.g. {"spend":{"h":0.25}}
 * WATCHER_CAPS         JSON {asset: cap} pinning 24 h caps (else read globalBucket on-chain)
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): WatcherEnv {
  const key = env.WATCHER_PRIVATE_KEY;
  if (key && !HEX_KEY.test(key)) throw new Error('WATCHER_PRIVATE_KEY: expected a 32-byte 0x private key');
  const watcherKey = (key as Hex | undefined) ?? null;
  const watcher = watcherKey ? privateKeyToAccount(watcherKey).address : null;
  const agentAddresses = list(env.AGENT_ADDRESSES);
  if (watcher && agentAddresses.some((a) => a.toLowerCase() === watcher.toLowerCase())) {
    throw new Error('key separation: the watcher key must not be an agent key');
  }
  const capsRaw = (json('WATCHER_CAPS', env.WATCHER_CAPS) ?? {}) as Record<string, string | number>;
  const caps = Object.fromEntries(Object.entries(capsRaw).map(([a, v]) => [getAddress(a), BigInt(v)]));
  return {
    watcherKey,
    watcher,
    rpcUrl: env.RPC_URL ?? null,
    chainId: Number(env.CHAIN_ID ?? 31337),
    accounts: list(env.WATCHER_ACCOUNTS),
    entryPoint: env.ENTRYPOINT === '' ? null : getAddress(env.ENTRYPOINT ?? '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'),
    agentAddresses,
    port: Number(env.WATCHER_PORT ?? 8790),
    pollMs: Number(env.POLL_MS ?? 2000),
    fromBlock: env.FROM_BLOCK ? BigInt(env.FROM_BLOCK) : null,
    config: json('WATCHER_CONFIG', env.WATCHER_CONFIG) as ConfigOverride | undefined,
    caps,
  };
}
