/** Approval service config (env). Defaults: docs/api.md section 16.6. */
import { type Address, type Hex, getAddress } from 'viem';
import { z } from 'zod';
import { ENTRYPOINT_V08_ADDRESS } from '@hypnexis/shared';

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const Schema = z.object({
  APPROVAL_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  APPROVAL_DB: z.string().default(':memory:'),
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  RPC_URL: z.string().optional(),
  ENTRYPOINT: addr.optional(),
  RELAYER_PRIVATE_KEY: key.optional(),
  BUNDLER_URL: z.string().optional(),
  APPROVAL_TTL_SECONDS: z.coerce.number().int().min(30).default(3600),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(3600),
  MAX_PENDING_PER_KEY: z.coerce.number().int().min(1).default(5),
  SIMULATION_MODE: z.enum(['eth_call', 'declared']).default('eth_call'),
  EXTRA_TRACKED_ASSETS: z.string().default(''),
  MAX_NOTE_CHARS: z.coerce.number().int().min(0).default(280),
});

export interface ApprovalConfig {
  port: number;
  db: string;
  chainId: number;
  rpcUrl?: string;
  /** fallback when account.entryPoint() cannot be read. */
  entryPoint: Address;
  relayerKey?: Hex;
  bundlerUrl?: string;
  ttlSeconds: number;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  maxPendingPerKey: number;
  simulationMode: 'eth_call' | 'declared';
  extraTrackedAssets: Address[];
  maxNoteChars: number;
}

export function loadApprovalConfig(env: Record<string, string | undefined> = process.env): ApprovalConfig {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') clean[k] = v;
  const p = Schema.parse(clean);
  return {
    port: p.APPROVAL_PORT,
    db: p.APPROVAL_DB,
    chainId: p.CHAIN_ID,
    rpcUrl: p.RPC_URL,
    entryPoint: getAddress(p.ENTRYPOINT ?? ENTRYPOINT_V08_ADDRESS),
    relayerKey: p.RELAYER_PRIVATE_KEY as Hex | undefined,
    bundlerUrl: p.BUNDLER_URL,
    ttlSeconds: p.APPROVAL_TTL_SECONDS,
    rateLimitMax: p.RATE_LIMIT_MAX,
    rateLimitWindowSeconds: p.RATE_LIMIT_WINDOW_SECONDS,
    maxPendingPerKey: p.MAX_PENDING_PER_KEY,
    simulationMode: p.SIMULATION_MODE,
    extraTrackedAssets: p.EXTRA_TRACKED_ASSETS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => getAddress(s)),
    maxNoteChars: p.MAX_NOTE_CHARS,
  };
}
