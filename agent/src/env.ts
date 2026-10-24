/**
 * Harness environment (M7, lane HARN). Every knob has a default that works on a laptop with anvil;
 * nothing here is a measurement. Ports follow docs/api.md section 12.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mnemonicToAccount } from 'viem/accounts';
import { bytesToHex, type Address, type Hex } from 'viem';
import { loadConfig, type Config } from '@hypnexis/shared';

export const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD_ROOT = resolve(AGENT_ROOT, '..');
export const CONTRACTS_DIR = join(BUILD_ROOT, 'contracts');
export const RESULTS_DIR = join(BUILD_ROOT, 'results');
export const CONFIGS_DIR = join(AGENT_ROOT, 'configs');
export const FIXTURES_DIR = join(AGENT_ROOT, 'fixtures');
/** Smoke / dev outputs (never the scored results files). */
export const OUT_DIR = join(AGENT_ROOT, 'out');

export interface HarnessEnv {
  cfg: Config;
  toolsPort: number;
  sellerPort: number;
  attestorUrl: string;
  approvalUrl: string;
  forgeOut: string;
  /** Genesis timestamp of the harness anvil (the Foundry fixture warps to the same value). */
  genesisTs: number;
}

export function harnessEnv(env: NodeJS.ProcessEnv = process.env): HarnessEnv {
  const cfg = loadConfig(env);
  return {
    cfg,
    toolsPort: Number(env.TOOLS_PORT ?? 8787),
    sellerPort: Number(env.SELLER_PORT ?? 8790),
    attestorUrl: env.ATTESTOR_URL ?? 'http://127.0.0.1:8789',
    approvalUrl: env.APPROVAL_URL ?? 'http://127.0.0.1:8788',
    forgeOut: env.HARN_FORGE_OUT ?? 'out',
    genesisTs: Number(env.HARN_GENESIS_TS ?? 1_800_000_000),
  };
}

/** anvil's public test mnemonic: dev keys only, never real funds. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export function devKey(index: number): Hex {
  const acct = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  const pk = acct.getHdKey().privateKey;
  if (!pk) throw new Error(`no private key for dev index ${index}`);
  return bytesToHex(pk);
}

/**
 * Roles (BUILD.md Conventions: owner, agent, attacker, attestor and relayer all distinct).
 * Indices 0-5 match services/attestor/scripts/lib/devchain.ts so both harnesses agree.
 */
export const ROLE_INDEX = {
  owner: 0,
  agent: 1,
  attacker: 2,
  verifier: 3,
  attestor: 4,
  relayer: 5,
  agent2: 6,
  agent3: 7,
  facilitator: 8,
  watcher: 9,
  guardian0: 10,
  guardian1: 11,
  guardian2: 12,
  guardian3: 13,
  guardian4: 14,
  attackerAttestor: 15,
} as const;
export type Role = keyof typeof ROLE_INDEX;
export const ANVIL_ACCOUNTS = 20;

export function roleKey(role: Role): Hex {
  return devKey(ROLE_INDEX[role]);
}

export type Keys = Record<Role, Hex>;
export function allKeys(): Keys {
  const out = {} as Keys;
  for (const r of Object.keys(ROLE_INDEX) as Role[]) out[r] = roleKey(r);
  return out;
}

/** Deterministic labelled address (legit new payees, Sybil payees): keccak(label) low 20 bytes. */
export type { Address };
