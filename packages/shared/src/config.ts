import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Build root: packages/shared/src -> ../../.. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte 0x address');
const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'expected an http(s) URL');

/** Defaults are the values checked in M0 (BUILD.md Machine check, results/toolchain.json). */
export const ConfigSchema = z.object({
  CHAIN_MODE: z.enum(['local', 'fork']).default('local'),
  ANVIL_PORT: z.coerce.number().int().min(1).max(65535).default(8545),
  BASE_RPC: httpUrl.default('https://mainnet.base.org'),
  BASE_SEPOLIA_RPC: httpUrl.default('https://sepolia.base.org'),
  FORK_BLOCK: z.coerce.number().int().positive().default(53026000),
  ENTRYPOINT_V08: address.default('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'),
  USDC_BASE: address.default('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  USDC_BASE_SEPOLIA: address.default('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  PERMIT2: address.default('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  LLM_BASE_URL: httpUrl.default('http://localhost:11434/v1'),
  LLM_MODEL: z.string().min(1).default('qwen2.5-coder:7b'),
  FOUNDRY_BIN: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema> & {
  root: string;
  /** Chain id the local anvil runs with: 31337 in local mode, Base (8453) in fork mode. */
  chainId: number;
  anvilRpcUrl: string;
};

export const BASE_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const ANVIL_CHAIN_ID = 31337;

/** Parse a dotenv-style file: KEY=VALUE lines, # comments, optional quotes. No interpolation. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? '';
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? '';
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1] as string] = value;
  }
  return out;
}

/** Read `<root>/.env` if present. Never throws. */
export function readRootEnv(root: string = ROOT): Record<string, string> {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  try {
    return parseEnvFile(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export interface LoadConfigOptions {
  /** Merge `<root>/.env` under the given env (process env wins). Default true. */
  useEnvFile?: boolean;
  root?: string;
}

/**
 * Load and validate the config. Precedence: `env` argument (default process.env) over `<root>/.env`
 * over schema defaults. Empty strings count as unset.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): Config {
  const root = opts.root ?? ROOT;
  const fileEnv = opts.useEnvFile === false ? {} : readRootEnv(root);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(fileEnv)) if (v !== '') merged[k] = v;
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') merged[k] = v;
  const keys = Object.keys(ConfigSchema.shape) as (keyof typeof ConfigSchema.shape)[];
  const picked: Record<string, string> = {};
  for (const k of keys) if (merged[k] !== undefined) picked[k] = merged[k] as string;
  const parsed = ConfigSchema.parse(picked);
  return {
    ...parsed,
    root,
    chainId: parsed.CHAIN_MODE === 'fork' ? BASE_CHAIN_ID : ANVIL_CHAIN_ID,
    anvilRpcUrl: `http://127.0.0.1:${parsed.ANVIL_PORT}`,
  };
}
