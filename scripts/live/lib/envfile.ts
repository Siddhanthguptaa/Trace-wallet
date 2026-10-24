/**
 * `.env.live`: read, render from `.env.live.example`, update in place, and a typed view (`Live`).
 * Node only. The OWNER's private key is never read or written here: only OWNER_ADDRESS.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Address, type Hex, getAddress, isAddress, parseEther, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MAINNET_IDS, chainByKey } from './chains.ts';
import type { PublicConfig } from './config.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** LIVE_ENV_FILE / LIVE_STATE_DIR let the anvil rehearsal run without touching the real .env.live. */
export const ENV_LIVE = process.env.LIVE_ENV_FILE ?? join(ROOT, '.env.live');
export const ENV_EXAMPLE = join(ROOT, '.env.live.example');
export const WEB_ENV = process.env.LIVE_WEB_ENV_FILE ?? join(ROOT, 'web', '.env');
export const LIVE_DIR = join(ROOT, 'scripts', 'live');
/** git-ignored runtime state (pids, sqlite files, spray addresses, logs). */
export const STATE_DIR = process.env.LIVE_STATE_DIR ?? join(LIVE_DIR, '.state');
export const LOG_DIR = join(STATE_DIR, 'logs');

export type Raw = Record<string, string>;

export function parseEnv(text: string): Raw {
  const out: Raw = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** Replace `KEY=...` lines of `template` with `values`; keys the template lacks are appended. */
export function renderEnv(template: string, values: Raw): string {
  const seen = new Set<string>();
  const lines = template.split(/\r?\n/).map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && m[1]! in values) {
      seen.add(m[1]!);
      return `${m[1]}=${values[m[1]!]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  return lines.join('\n');
}

export function readRaw(path = ENV_LIVE): Raw {
  if (!existsSync(path)) throw new Error(`${path} not found: run \`live.ts init --owner 0x<your MetaMask address>\` first`);
  return parseEnv(readFileSync(path, 'utf8'));
}

/** Update keys of `.env.live` in place (comments and order preserved). */
export function updateEnv(patch: Raw, path = ENV_LIVE): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(ENV_EXAMPLE, 'utf8');
  writeFileSync(path, renderEnv(text, patch));
}

const must = (r: Raw, k: string): string => {
  const v = process.env[k] || r[k];
  if (!v) throw new Error(`${k} is empty in .env.live`);
  return v;
};
const opt = (r: Raw, k: string): string => process.env[k] || r[k] || '';
const addrOrEmpty = (s: string): Address | '' => (s ? getAddress(s) : '');

export interface Live {
  raw: Raw;
  chainKey: string;
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  entryPoint: Address;
  usdc: Address;
  usdcDecimals: number;
  owner: Address | '';
  deployerKey: Hex;
  agentKey: Hex;
  attestorKey: Hex;
  watcherKey: Hex;
  attackerKey: Hex;
  verifierKey: Hex;
  guardianAddresses: Address[];
  guardianKeys: Hex[];
  merchant: Address;
  /** salt of R4 (the full product account) */
  salt: bigint;
  r3Salt: bigint;
  factory: Address | '';
  implementation: Address | '';
  admin: Address | '';
  lens: Address | '';
  /** the full-product account (R4); the CLI attacks and the watcher default to it */
  account: Address | '';
  /** the four demo wallets the runner attacks: R1 agent EOA, R2 naive allowlist, R3 ours without D3, R4 ours with D3 */
  wallets: { R1: Address | ''; R2: Address | ''; R3: Address | ''; R4: Address | '' };
  fundUsdc: bigint;
  policy: { burst: bigint; rate: bigint; perTx: bigint; days: number; depositWei: bigint; gasCreditWei: bigint };
  freeze: { velocityBps: number; sprayMax: number; strikeMax: number };
  ports: { gateway: number; attestor: number; approval: number; watcher: number };
  urls: { gateway: string; attestor: string; approval: string; watcher: string };
  watcherPollMs: number;
  addr: { deployer: Address; agent: Address; attestor: Address; watcher: Address; attacker: Address; verifier: Address };
}

export function readLive(path = ENV_LIVE): Live {
  const r = readRaw(path);
  const get = (k: string) => must(r, k);
  const key = (k: string) => {
    const v = get(k);
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${k} is not a 32-byte 0x private key`);
    return v as Hex;
  };
  const chainKey = get('CHAIN');
  const info = chainByKey(chainKey);
  const dec = Number(opt(r, 'USDC_DECIMALS') || '6');
  const ownerRaw = opt(r, 'OWNER_ADDRESS');
  if (ownerRaw && !isAddress(ownerRaw)) throw new Error('OWNER_ADDRESS is not an address');
  const guardianAddresses = opt(r, 'GUARDIAN_ADDRESSES').split(',').map((s) => s.trim()).filter(Boolean).map((a) => getAddress(a));
  const guardianKeys = opt(r, 'GUARDIAN_KEYS').split(',').map((s) => s.trim()).filter(Boolean) as Hex[];
  const L: Live = {
    raw: r,
    chainKey,
    chainId: Number(get('CHAIN_ID')),
    chainName: info.name,
    rpcUrl: get('RPC_URL'),
    explorer: opt(r, 'EXPLORER_URL'),
    entryPoint: getAddress(get('ENTRYPOINT')),
    usdc: getAddress(get('USDC')),
    usdcDecimals: dec,
    owner: addrOrEmpty(ownerRaw),
    deployerKey: key('DEPLOYER_KEY'),
    agentKey: key('AGENT_KEY'),
    attestorKey: key('ATTESTOR_KEY'),
    watcherKey: key('WATCHER_KEY'),
    attackerKey: key('ATTACKER_KEY'),
    verifierKey: key('VERIFIER_KEY'),
    guardianAddresses,
    guardianKeys,
    merchant: getAddress(get('MERCHANT_ADDRESS')),
    salt: BigInt(opt(r, 'R4_SALT') || '4'),
    r3Salt: BigInt(opt(r, 'R3_SALT') || '3'),
    factory: addrOrEmpty(opt(r, 'FACTORY')),
    implementation: addrOrEmpty(opt(r, 'IMPLEMENTATION')),
    admin: addrOrEmpty(opt(r, 'ADMIN')),
    lens: addrOrEmpty(opt(r, 'LENS')),
    account: addrOrEmpty(opt(r, 'ACCOUNT')),
    wallets: { R1: addrOrEmpty(opt(r, 'R1_ADDRESS')), R2: addrOrEmpty(opt(r, 'R2_ADDRESS')), R3: addrOrEmpty(opt(r, 'R3_ADDRESS')), R4: addrOrEmpty(opt(r, 'R4_ADDRESS')) },
    fundUsdc: parseUnits(opt(r, 'FUND_USDC') || '3', dec),
    policy: {
      burst: parseUnits(opt(r, 'DAILY_BURST_USDC') || '1', dec),
      rate: parseUnits(opt(r, 'DAILY_RATE_USDC') || '1', dec),
      perTx: parseUnits(opt(r, 'PER_TX_USDC') || '1', dec),
      days: Number(opt(r, 'POLICY_DAYS') || '7'),
      depositWei: parseEther(opt(r, 'DEPOSIT_ETH') || '0.0001'),
      gasCreditWei: parseEther(opt(r, 'GAS_CREDIT_ETH') || '0.0005'),
    },
    freeze: {
      velocityBps: Number(opt(r, 'FREEZE_VELOCITY_BPS') || '6000'),
      sprayMax: Number(opt(r, 'FREEZE_SPRAY_MAX') || '5'),
      strikeMax: Number(opt(r, 'FREEZE_STRIKE_MAX') || '3'),
    },
    ports: {
      gateway: Number(opt(r, 'GATEWAY_PORT') || '8800'),
      approval: Number(opt(r, 'APPROVAL_PORT') || '8801'),
      attestor: Number(opt(r, 'ATTESTOR_PORT') || '8802'),
      watcher: Number(opt(r, 'WATCHER_PORT') || '8803'),
    },
    urls: {
      gateway: opt(r, 'GATEWAY_URL') || `http://localhost:${opt(r, 'GATEWAY_PORT') || '8800'}`,
      approval: opt(r, 'APPROVAL_URL') || `http://127.0.0.1:${opt(r, 'APPROVAL_PORT') || '8801'}`,
      attestor: opt(r, 'ATTESTOR_URL') || `http://127.0.0.1:${opt(r, 'ATTESTOR_PORT') || '8802'}`,
      watcher: opt(r, 'WATCHER_URL') || `http://127.0.0.1:${opt(r, 'WATCHER_PORT') || '8803'}`,
    },
    watcherPollMs: Number(opt(r, 'WATCHER_POLL_MS') || '3000'),
    addr: {
      deployer: privateKeyToAccount(key('DEPLOYER_KEY')).address,
      agent: privateKeyToAccount(key('AGENT_KEY')).address,
      attestor: privateKeyToAccount(key('ATTESTOR_KEY')).address,
      watcher: privateKeyToAccount(key('WATCHER_KEY')).address,
      attacker: privateKeyToAccount(key('ATTACKER_KEY')).address,
      verifier: privateKeyToAccount(key('VERIFIER_KEY')).address,
    },
  };
  return L;
}

/** Mainnet guard: every command that touches a chain calls this. */
export function guardMainnet(L: Pick<Live, 'chainId' | 'chainKey'>, allow: boolean): void {
  if (MAINNET_IDS.has(L.chainId) && !allow) {
    throw new Error(`chain ${L.chainKey} (${L.chainId}) is a MAINNET. Refused. Pass --allow-mainnet to proceed: the contracts are UNAUDITED, keep at most ~1 USDC in the account.`);
  }
  if (MAINNET_IDS.has(L.chainId) && allow) {
    console.warn('\n  !!  MAINNET: the contracts are UNAUDITED. The account must hold ~1 USDC at most. You are responsible for any loss.\n');
  }
}

/** The public view the owner console receives: addresses and policy numbers, NEVER a key. */
export function publicConfig(L: Live, account: Address | '' = L.account): PublicConfig {
  return {
    chainId: L.chainId,
    chainName: L.chainName,
    rpcUrl: L.rpcUrl,
    explorer: L.explorer,
    entryPoint: L.entryPoint,
    usdc: L.usdc,
    usdcDecimals: L.usdcDecimals,
    owner: L.owner || '',
    factory: L.factory || '',
    account: account || '',
    salt: L.salt.toString(),
    agent: L.addr.agent,
    attestor: L.addr.attestor,
    watcher: L.addr.watcher,
    attacker: L.addr.attacker,
    guardians: L.guardianAddresses,
    merchant: L.merchant,
    policy: {
      burst: L.policy.burst.toString(),
      rate: L.policy.rate.toString(),
      perTx: L.policy.perTx.toString(),
      days: L.policy.days,
      depositWei: L.policy.depositWei.toString(),
      gasCreditWei: L.policy.gasCreditWei.toString(),
    },
    freeze: L.freeze,
    urls: { attestor: L.urls.attestor, approval: L.urls.approval, watcher: L.urls.watcher },
    outcomeVouches: 3,
  };
}
