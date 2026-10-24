/**
 * Demo policy + R1-R4 configs (agent/configs). Pure: label -> address resolution and the
 * on-chain structs (PolicyInput for AgentAccount.setPolicy, R2Config for NaiveAccount.configure).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Address, type Hex, getAddress, keccak256, toFunctionSelector, toHex } from 'viem';
import { z } from 'zod';
import { CONFIGS_DIR, FIXTURES_DIR } from '../env.ts';

const big = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
const bucket = z.object({ burst: big, ratePerDay: big });
export const RULE_OPS = ['EQ_SELF', 'IN_RECIPIENTS', 'PAYEE', 'LTE', 'EQ'] as const;
export type RuleOpName = (typeof RULE_OPS)[number];

export const DemoPolicySchema = z.object({
  asset: z.object({ symbol: z.string(), decimals: z.number() }),
  globalCap: bucket,
  keyBucket: bucket,
  perTxCap: big,
  exploreCap: bucket,
  explorePerTxCap: big,
  recipients: z.array(z.string()),
  validForSeconds: z.number().int().positive(),
  gasCredit: big,
  gas: z.object({ maxCallGas: z.number(), maxVerificationGas: z.number(), maxPreVerificationGas: z.number(), maxFeePerGas: big }),
  opGas: z.object({ verificationGasLimit: z.number(), callGasLimit: z.number(), preVerificationGas: z.number(), maxFeePerGas: big, maxPriorityFeePerGas: big }),
  sig1271Mode: z.enum(['OWNER_ONLY', 'OWNER_PLUS_X402_VOUCHER']),
  shops: z.object({ ticketPrice: big, apiPrice: big, greedyPrice: big }),
  funding: z.object({ usdc: big, eth: big, deposit: big }),
  rules: z.array(
    z.object({
      target: z.string(),
      signature: z.string(),
      rules: z.array(z.object({ argIndex: z.number().int().min(0).max(255), op: z.enum(RULE_OPS), bound: big })),
    }),
  ),
  trackedSpenders: z.array(z.string()),
  trackedNFTs: z.array(z.string()),
  r2: z.object({ perTxCap: big, dailyCap: big }),
});
export type DemoPolicy = z.infer<typeof DemoPolicySchema>;

export const ConfigIds = ['R1', 'R2', 'R3', 'R4'] as const;
export type ConfigId = (typeof ConfigIds)[number];

export const WalletConfigSchema = z.object({
  id: z.string(),
  kind: z.enum(['eoa', 'naive', 'agent']),
  description: z.string(),
  attestor: z.boolean().optional(),
  exploration: z.boolean().optional(),
  sig1271Mode: z.enum(['OWNER_ONLY', 'OWNER_PLUS_X402_VOUCHER']).optional(),
  watcher: z.boolean().optional(),
  guardians: z.object({ count: z.number().int(), threshold: z.number().int() }).optional(),
  paymaster: z.string().optional(),
});
export type WalletConfig = z.infer<typeof WalletConfigSchema>;

export function loadDemoPolicy(dir = CONFIGS_DIR): DemoPolicy {
  return DemoPolicySchema.parse(JSON.parse(readFileSync(join(dir, 'demo_policy.json'), 'utf8')));
}

export function loadWalletConfig(id: string, dir = CONFIGS_DIR): WalletConfig {
  return WalletConfigSchema.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
}

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as T;
}

/** keccak256(label) low 20 bytes: the fixture's labelled addresses. */
export function labelAddress(label: string): Address {
  return getAddress(`0x${keccak256(toHex(label)).slice(-40)}`);
}

export type Labels = Record<string, Address>;

export const SEL = {
  transfer: toFunctionSelector('transfer(address,uint256)'),
  approve: toFunctionSelector('approve(address,uint256)'),
  transferFrom: toFunctionSelector('transferFrom(address,address,uint256)'),
  setApprovalForAll: toFunctionSelector('setApprovalForAll(address,bool)'),
  buy: toFunctionSelector('buy(uint256,address)'),
  greedyBuy: toFunctionSelector('buy()'),
  order: toFunctionSelector('order(uint256,address)'),
  executeUserOp: '0x8dd7712f' as Hex,
} as const;

export interface RuleInput {
  target: Address;
  selector: Hex;
  rules: { argIndex: number; op: number; bound: bigint }[];
}

export function resolve(labels: Labels, name: string): Address {
  const a = labels[name];
  if (!a) throw new Error(`unknown label ${name}`);
  return a;
}

/** Demo rules with labels resolved; `extra` appends card-specific (target, selector) entries. */
export function demoRules(p: DemoPolicy, labels: Labels, extra: RuleInput[] = []): RuleInput[] {
  const base = p.rules.map((r) => ({
    target: resolve(labels, r.target),
    selector: toFunctionSelector(r.signature),
    rules: r.rules.map((x) => ({ argIndex: x.argIndex, op: RULE_OPS.indexOf(x.op), bound: x.bound })),
  }));
  return [...base, ...extra];
}

/** AgentAccount PolicyInput (docs/api.md 2.4). */
export function policyInput(p: DemoPolicy, labels: Labels, now: number, extra: RuleInput[] = []) {
  return {
    validAfter: now - 1, // EntryPoint v0.8: valid iff validAfter < now
    validUntil: now + p.validForSeconds,
    gas: {
      maxCallGas: p.gas.maxCallGas,
      maxVerificationGas: p.gas.maxVerificationGas,
      maxPreVerificationGas: p.gas.maxPreVerificationGas,
      maxFeePerGas: p.gas.maxFeePerGas,
      gasCredit: p.gasCredit,
    },
    assets: [{ asset: resolve(labels, 'USDC'), perTxCap: p.perTxCap, burst: p.keyBucket.burst, ratePerDay: p.keyBucket.ratePerDay }],
    calls: demoRules(p, labels, extra),
  };
}

/** NaiveAccount R2Config (docs/api.md 10): same pairs, no argument rules. */
export function r2Config(p: DemoPolicy, labels: Labels, extra: { target: Address; selector: Hex }[] = [], extraRecipients: Address[] = []) {
  const pairs = [...demoRules(p, labels), ...extra];
  return {
    targets: pairs.map((r) => r.target),
    selectors: pairs.map((r) => r.selector),
    recipients: [...p.recipients.map((r) => resolve(labels, r)), ...extraRecipients],
    tokens: [resolve(labels, 'USDC')],
    perTxCaps: [p.r2.perTxCap],
    dailyCaps: [p.r2.dailyCap],
  };
}

export const SIG1271 = { OWNER_ONLY: 0, OWNER_PLUS_X402_VOUCHER: 1 } as const;

/**
 * The freeze-tripwire thresholds pinned on dev seeds 1-3 (hijack/thresholds.json, or X6_THRESHOLDS).
 * Every AgentAccount config applies them, not just the X6 harness: the shared legit stream spends
 * 9.1 USDC inside one hour and would trip the on-chain default (velocityBps 4000) mid-stream.
 */
export interface FreezeThresholds {
  onchain: { velocityBps: number; sprayMax: number; strikeMax: number };
}
export function loadFreezeThresholds(): FreezeThresholds {
  const path = process.env.X6_THRESHOLDS ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hijack', 'thresholds.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FreezeThresholds;
}
