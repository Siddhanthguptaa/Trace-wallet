import { z } from 'zod';
import type { Address, Hex } from 'viem';

/** Wire contract the frontend expects. Paths live in endpoints.ts. Confirm with the backend team (O3). */

export const big = z
  .union([z.string().regex(/^-?\d+$/), z.number().int(), z.bigint()])
  .transform((v) => BigInt(v));
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'not an address')
  .transform((v) => v as Address);
export const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'not hex')
  .transform((v) => v as Hex);
export const unix = z.number().int().nonnegative();

export const asset = z.object({ address, symbol: z.string(), decimals: z.number().int().min(0).max(36) });
export type Asset = z.infer<typeof asset>;

export const argRule = z.object({
  index: z.number().int(),
  name: z.string().optional(),
  op: z.enum(['EQ_SELF', 'IN_RECIPIENTS', 'PAYEE', 'LTE', 'EQ']),
  value: z.string().optional(),
});
export const callRule = z.object({
  target: address,
  targetLabel: z.string().optional(),
  selector: hex,
  signature: z.string().optional(),
  args: z.array(argRule),
});
export type CallRule = z.infer<typeof callRule>;

export const sessionKey = z.object({
  agentKey: address,
  label: z.string().optional(),
  validAfter: unix,
  validUntil: unix,
  revoked: z.boolean(),
  nonceKey: big,
  assets: z.array(z.object({ asset: address, perTxCap: big, cap: big })),
  rules: z.array(callRule),
  gas: z.object({
    maxCallGas: big,
    maxVerificationGas: big,
    maxPreVerificationGas: big,
    maxFeePerGas: big,
    gasCredit: big,
  }),
});
export type SessionKey = z.infer<typeof sessionKey>;

export const policy = z.object({
  wallet: address,
  owner: address,
  chainId: z.number().int(),
  sig1271Mode: z.enum(['OWNER_ONLY', 'OWNER_PLUS_X402_VOUCHER']),
  attestor: address.nullable(),
  attestEpoch: z.number().int(),
  assets: z.array(z.object({ asset, globalCap: big, exploreCap: big, explorePerTxCap: big })),
  recipients: z.array(address),
  flagged: z.array(address),
  trackedSpenders: z.array(z.object({ address, label: z.string().optional() })),
  trackedNFTs: z.array(z.object({ address, label: z.string().optional() })),
  keys: z.array(sessionKey),
});
export type Policy = z.infer<typeof policy>;

export const bucket = z.object({
  scope: z.enum(['key', 'global', 'explore']),
  agentKey: address.optional(),
  asset: address,
  level: big,
  cap: big,
  refillPerDay: big,
  fullAt: unix,
});
export type Bucket = z.infer<typeof bucket>;
export const budget = z.object({ at: unix, buckets: z.array(bucket) });
export type Budget = z.infer<typeof budget>;

export const payResult = z.object({
  status: z.enum(['executed', 'reverted', 'refused', 'approval_requested']),
  track: z.enum(['proven', 'unproven', 'flagged']).optional(),
  reasonCode: z.string().optional(),
  outflow: big.optional(),
  txHash: hex.optional(),
  userOpHash: hex.optional(),
  approvalId: z.string().optional(),
});
export type PayResult = z.infer<typeof payResult>;

/* ---------- Approval service ---------- */
export const approvalStatus = z.enum(['pending', 'signed', 'relayed', 'executed', 'reverted', 'declined', 'expired', 'used']);
export type ApprovalStatus = z.infer<typeof approvalStatus>;

export const typedData = z.object({
  domain: z.object({
    name: z.string(),
    version: z.string(),
    chainId: z.number().int(),
    verifyingContract: address,
  }),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});
export type TypedData = z.infer<typeof typedData>;

export const approvalSummary = z.object({
  id: z.string(),
  wallet: address,
  createdAt: unix,
  expiresAt: unix,
  status: approvalStatus,
  payee: address,
  payeeTrack: z.enum(['proven', 'unproven', 'flagged']),
  asset,
  maxOutflow: big,
  targetLabel: z.string().optional(),
  functionName: z.string().optional(),
  rateLimited: z.boolean().optional(),
});
export type ApprovalSummary = z.infer<typeof approvalSummary>;

export const approvalRequest = approvalSummary.extend({
  chainId: z.number().int(),
  agentKey: address,
  agentNote: z.string().nullable(),
  decoded: z.object({
    target: address,
    targetLabel: z.string().optional(),
    selector: hex,
    functionSignature: z.string(),
    args: z.array(z.object({ name: z.string(), type: z.string(), value: z.string() })),
  }),
  simulated: z
    .object({
      outflow: big,
      deltas: z.array(
        z.object({ label: z.string(), kind: z.enum(['erc20', 'nft', 'allowance', 'native']), delta: big, decimals: z.number().int().optional() }),
      ),
    })
    .nullable(),
  nonce: big,
  validUntil: unix,
  typedData: typedData.nullable(),
  txHash: hex.optional(),
  revertReason: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof approvalRequest>;

/* ---------- TRACE attestor ---------- */
export const attestation = z.union([
  z.object({
    tier: z.enum(['PROVEN', 'FLAGGED']),
    validUntil: unix,
    epoch: z.number().int(),
    signature: hex,
  }),
  z.object({ attestation: z.null() }),
]);
export type Attestation = z.infer<typeof attestation>;

/* ---------- Runner (attack cards, X1 results) ---------- */
export const configId = z.enum(['R1', 'R2', 'R3', 'R4']);
export const card = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  guard: z.enum(['D1', 'D2', 'D3', 'core']),
});
export type Card = z.infer<typeof card>;

export const walletConfig = z.object({ id: configId, label: z.string().optional(), wallet: address });
export type WalletConfig = z.infer<typeof walletConfig>;

export const bounty = z.object({
  agentPrivateKey: hex,
  agentAddress: address,
  wallet: address,
  chainId: z.number().int(),
});
export type Bounty = z.infer<typeof bounty>;

export const cell = z.object({
  outcome: z.enum(['lost', 'refused', 'bounded', 'na', 'pending']),
  amount: big.optional(),
  asset: asset.optional(),
  reasonCode: z.string().optional(),
  txHash: hex.optional(),
  test: z.string().optional(),
  runs: z.object({ k: z.number().int(), n: z.number().int() }).optional(),
});
export type Cell = z.infer<typeof cell>;

export const metric2Cell = z.object({
  outcome: z.enum(['paid', 'blocked', 'ping', 'pending']),
  paid: z.number().int().optional(),
  total: z.number().int().optional(),
});
export type Metric2Cell = z.infer<typeof metric2Cell>;

export const x1Table = z.object({
  generatedAt: unix.nullable(),
  rows: z.array(
    z.object({
      cardId: z.string(),
      title: z.string(),
      guard: z.enum(['D1', 'D2', 'D3', 'core']),
      attack: z.string().optional(),
      defense: z.string().optional(),
      test: z.string().optional(),
      cells: z.object({ R1: cell, R2: cell, R3: cell, R4: cell }),
    }),
  ),
  metric2: z.object({ R1: metric2Cell, R2: metric2Cell, R3: metric2Cell, R4: metric2Cell }).nullable(),
});
export type X1Table = z.infer<typeof x1Table>;

export const runStarted = z.object({ runId: z.string() });

export const runEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attempt'),
    runId: z.string(),
    config: configId,
    outcome: z.enum(['lost', 'refused', 'bounded', 'paid', 'pending']),
    amount: big.optional(),
    asset: asset.optional(),
    reasonCode: z.string().optional(),
    txHash: hex.optional(),
    k: z.number().int().optional(),
    n: z.number().int().optional(),
    note: z.string().optional(),
    at: unix,
  }),
  z.object({ type: z.literal('log'), runId: z.string(), message: z.string(), at: unix }),
  z.object({ type: z.literal('done'), runId: z.string(), at: unix }),
]);
export type RunEvent = z.infer<typeof runEvent>;
