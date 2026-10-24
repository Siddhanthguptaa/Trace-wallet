/** Attestor env config. The service refuses to start on a key-separation violation [A20]. */
import { type Address, type Hex, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import type { Tier } from '../../../packages/shared/src/attestor/tier.ts';

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte 0x private key');
const addrList = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => getAddress(x)),
  );
const json = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .string()
    .default('{}')
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);

export const AttestorEnv = z.object({
  ATTESTOR_PRIVATE_KEY: hexKey,
  /** agent addresses (comma list); AGENT_PRIVATE_KEY adds its address. Never equal to the attestor. */
  AGENT_ADDRESSES: addrList,
  AGENT_PRIVATE_KEY: hexKey.optional(),
  VERIFIER_ADDRESSES: addrList,
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  RPC_URL: z.string().regex(/^https?:\/\/\S+$/).optional(),
  ATTESTOR_PORT: z.coerce.number().int().min(0).max(65535).default(8789),
  ATTESTOR_DB: z.string().default(':memory:'),
  ATTESTOR_MODE: z.enum(['trace', 'scripted']).default('trace'),
  SCRIPTED_TIERS: json(z.record(z.enum(['PROVEN', 'UNPROVEN', 'FLAGGED']))),
  ATTEST_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  ROUND_SECONDS: z.coerce.number().int().positive().default(3600),
  /** only used without RPC_URL (local tests / scripted demo). */
  DEFAULT_EPOCH: z.coerce.bigint().default(1n),
  /** only used without RPC_URL: wallet -> owner map. */
  OWNERS: json(z.record(z.string().regex(/^0x[0-9a-fA-F]{40}$/))),
  /** wallets served from the start (more are learned from /v1/attest and outcomes). */
  WALLETS: addrList,
});

export interface AttestorConfig {
  attestorKey: Hex;
  agents: Address[];
  verifiers: Address[];
  chainId: number;
  rpcUrl?: string;
  port: number;
  dbPath: string;
  mode: 'trace' | 'scripted';
  scriptedTiers: Record<string, Tier>;
  ttlSeconds: number;
  roundSeconds: number;
  defaultEpoch: bigint;
  owners: Record<string, Address>;
  wallets: Address[];
}

export function loadAttestorConfig(env: NodeJS.ProcessEnv = process.env): AttestorConfig {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const e = AttestorEnv.parse(clean);
  const agents = [...e.AGENT_ADDRESSES];
  if (e.AGENT_PRIVATE_KEY) agents.push(privateKeyToAccount(e.AGENT_PRIVATE_KEY as Hex).address);
  return {
    attestorKey: e.ATTESTOR_PRIVATE_KEY as Hex,
    agents,
    verifiers: e.VERIFIER_ADDRESSES,
    chainId: e.CHAIN_ID,
    rpcUrl: e.RPC_URL,
    port: e.ATTESTOR_PORT,
    dbPath: e.ATTESTOR_DB,
    mode: e.ATTESTOR_MODE,
    scriptedTiers: e.SCRIPTED_TIERS as Record<string, Tier>,
    ttlSeconds: e.ATTEST_TTL_SECONDS,
    roundSeconds: e.ROUND_SECONDS,
    defaultEpoch: e.DEFAULT_EPOCH,
    owners: Object.fromEntries(Object.entries(e.OWNERS).map(([k, v]) => [k.toLowerCase(), getAddress(v)])),
    wallets: e.WALLETS,
  };
}
