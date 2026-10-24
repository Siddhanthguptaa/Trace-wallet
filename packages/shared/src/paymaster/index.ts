import { concat, getAddress, hexToBigInt, isAddress, numberToHex, pad, parseAbi, size, slice, type Address, type Hex } from 'viem';
import type { UserOperationV08 } from '../userop.ts';

/**
 * AgentPaymaster helpers (lane PM, M12). Mirrors contracts/src/paymaster/AgentPaymaster.sol:
 * - paymasterAndData in the EntryPoint v0.8 layout: paymaster (20) | verificationGasLimit (uint128) |
 *   postOpGasLimit (uint128) | data (ignored by AgentPaymaster; may be empty);
 * - the maxCost the paymaster reserves (EntryPoint requiredPrefund), the gas caps it enforces and its
 *   admission rule (validAfter = first second the agent's bucket holds pending + maxCost, minus 1).
 * Not re-exported from the package root (src/index.ts is frozen during waves); import this file directly.
 */

export const PAYMASTER_VALIDATION_GAS_OFFSET = 20;
export const PAYMASTER_POSTOP_GAS_OFFSET = 36;
export const PAYMASTER_DATA_OFFSET = 52;

/** AgentPaymaster.MIN_POSTOP_GAS: paymasterPostOpGasLimit below this is refused. */
export const AGENT_PAYMASTER_MIN_POSTOP_GAS = 30_000n;
/** AgentPaymaster.POSTOP_OVERHEAD_GAS: added to the postOp limit when the quota is charged. */
export const AGENT_PAYMASTER_POSTOP_OVERHEAD_GAS = 15_000n;
/** Defaults that fit AgentPaymaster's validation and postOp with room to spare (tests use these). */
export const DEFAULT_PM_VERIFICATION_GAS = 80_000n;
export const DEFAULT_PM_POSTOP_GAS = 50_000n;

const DAY = 86_400n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

function u128(name: string, v: bigint): bigint {
  if (v < 0n || v > MAX_UINT128) throw new RangeError(`${name} does not fit in uint128: ${v}`);
  return v;
}

export interface PaymasterAndDataInput {
  paymaster: Address;
  verificationGasLimit?: bigint;
  postOpGasLimit?: bigint;
  data?: Hex;
}

export interface DecodedPaymasterAndData {
  paymaster: Address;
  verificationGasLimit: bigint;
  postOpGasLimit: bigint;
  data: Hex;
}

/** paymaster | uint128 verificationGasLimit | uint128 postOpGasLimit | data (abi.encodePacked). */
export function buildPaymasterAndData(i: PaymasterAndDataInput): Hex {
  if (!isAddress(i.paymaster)) throw new Error(`bad paymaster address: ${i.paymaster}`);
  const verification = u128('verificationGasLimit', i.verificationGasLimit ?? DEFAULT_PM_VERIFICATION_GAS);
  const postOp = u128('postOpGasLimit', i.postOpGasLimit ?? DEFAULT_PM_POSTOP_GAS);
  return concat([
    getAddress(i.paymaster),
    pad(numberToHex(verification), { size: 16 }),
    pad(numberToHex(postOp), { size: 16 }),
    i.data ?? '0x',
  ]);
}

export function decodePaymasterAndData(h: Hex): DecodedPaymasterAndData {
  const len = size(h);
  if (len < PAYMASTER_DATA_OFFSET) throw new Error(`paymasterAndData shorter than ${PAYMASTER_DATA_OFFSET} bytes`);
  return {
    paymaster: getAddress(slice(h, 0, PAYMASTER_VALIDATION_GAS_OFFSET)),
    verificationGasLimit: hexToBigInt(slice(h, PAYMASTER_VALIDATION_GAS_OFFSET, PAYMASTER_POSTOP_GAS_OFFSET)),
    postOpGasLimit: hexToBigInt(slice(h, PAYMASTER_POSTOP_GAS_OFFSET, PAYMASTER_DATA_OFFSET)),
    data: len > PAYMASTER_DATA_OFFSET ? slice(h, PAYMASTER_DATA_OFFSET) : '0x',
  };
}

/** The paymaster fields of an unpacked v0.8 UserOperation (for packUserOp in ../userop.ts). */
export function agentPaymasterFields(
  i: PaymasterAndDataInput,
): Required<Pick<UserOperationV08, 'paymaster' | 'paymasterVerificationGasLimit' | 'paymasterPostOpGasLimit' | 'paymasterData'>> {
  return {
    paymaster: getAddress(i.paymaster),
    paymasterVerificationGasLimit: i.verificationGasLimit ?? DEFAULT_PM_VERIFICATION_GAS,
    paymasterPostOpGasLimit: i.postOpGasLimit ?? DEFAULT_PM_POSTOP_GAS,
    paymasterData: i.data ?? '0x',
  };
}

export type GasFieldsV08 = Pick<
  UserOperationV08,
  'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
> & { paymasterVerificationGasLimit?: bigint; paymasterPostOpGasLimit?: bigint };

/** EntryPoint v0.8 requiredPrefund = the maxCost AgentPaymaster reserves from the agent's quota. */
export function requiredPrefund(op: GasFieldsV08): bigint {
  const gas =
    op.verificationGasLimit +
    op.callGasLimit +
    (op.paymasterVerificationGasLimit ?? 0n) +
    (op.paymasterPostOpGasLimit ?? 0n) +
    op.preVerificationGas;
  return gas * op.maxFeePerGas;
}

/** AgentPaymaster.GasCaps. */
export interface AgentPaymasterGasCaps {
  maxFeePerGas: bigint;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}

/** Field index in AgentPaymaster.GasFieldAboveCap(field, value, cap). */
export const GAS_FIELD = {
  MAX_FEE_PER_GAS: 0,
  CALL_GAS: 1,
  VERIFICATION_GAS: 2,
  PRE_VERIFICATION_GAS: 3,
  PM_VERIFICATION_GAS: 4,
  PM_POSTOP_GAS: 5,
} as const;

export interface GasCapViolation {
  field: number;
  value: bigint;
  cap: bigint;
  /** 'cap' = GasFieldAboveCap; 'postOpFloor' = PostOpGasTooLow (cap holds MIN_POSTOP_GAS). */
  kind: 'cap' | 'postOpFloor';
}

/** The refusals AgentPaymaster validation would raise for these gas fields, in its check order. */
export function gasCapViolations(op: GasFieldsV08, caps: AgentPaymasterGasCaps): GasCapViolation[] {
  const postOp = op.paymasterPostOpGasLimit ?? 0n;
  const checks: [number, bigint, bigint][] = [
    [GAS_FIELD.MAX_FEE_PER_GAS, op.maxFeePerGas, caps.maxFeePerGas],
    [GAS_FIELD.CALL_GAS, op.callGasLimit, caps.callGasLimit],
    [GAS_FIELD.VERIFICATION_GAS, op.verificationGasLimit, caps.verificationGasLimit],
    [GAS_FIELD.PRE_VERIFICATION_GAS, op.preVerificationGas, caps.preVerificationGas],
    [GAS_FIELD.PM_VERIFICATION_GAS, op.paymasterVerificationGasLimit ?? 0n, caps.paymasterVerificationGasLimit],
    [GAS_FIELD.PM_POSTOP_GAS, postOp, caps.paymasterPostOpGasLimit],
  ];
  const out: GasCapViolation[] = checks
    .filter(([, value, cap]) => value > cap)
    .map(([field, value, cap]) => ({ field, value, cap, kind: 'cap' as const }));
  if (postOp < AGENT_PAYMASTER_MIN_POSTOP_GAS) {
    out.push({ field: GAS_FIELD.PM_POSTOP_GAS, value: postOp, cap: AGENT_PAYMASTER_MIN_POSTOP_GAS, kind: 'postOpFloor' });
  }
  return out;
}

/** AgentPaymaster.agentOf(account): bucket (level at lastRefill) + pending holds. */
export interface AgentQuotaState {
  burst: bigint;
  ratePerDay: bigint;
  level: bigint;
  lastRefill: bigint;
  pending: bigint;
}

export class QuotaExceededError extends Error {
  constructor(
    readonly needed: bigint,
    readonly burst: bigint,
  ) {
    super(`AgentPaymaster QuotaExceeded: needs ${needed} wei, burst ${burst} wei (or no refill)`);
  }
}

/** lib/Buckets.availableAt(bucket, now) minus the pending holds (AgentPaymaster.available). */
export function quotaAvailableAt(q: AgentQuotaState, now: bigint): bigint {
  let level = q.level;
  if (now > q.lastRefill) level += (q.ratePerDay * (now - q.lastRefill)) / DAY;
  if (level > q.burst) level = q.burst;
  return level > q.pending ? level - q.pending : 0n;
}

/**
 * AgentPaymaster admission (validation, no TIMESTAMP): the validAfter an op of `maxCost` gets.
 * 0n = valid now; otherwise the op is valid once block.timestamp > validAfter (EntryPoint v0.8).
 * Throws QuotaExceededError where validation reverts with QuotaExceeded.
 */
export function quotaValidAfter(q: AgentQuotaState, maxCost: bigint): bigint {
  const needed = q.pending + maxCost;
  if (needed > q.burst) throw new QuotaExceededError(needed, q.burst);
  if (needed <= q.level) return 0n;
  if (q.ratePerDay === 0n) throw new QuotaExceededError(needed, q.burst);
  const dt = ((needed - q.level) * DAY + q.ratePerDay - 1n) / q.ratePerDay;
  const readyAt = q.lastRefill + dt;
  return readyAt > MAX_UINT48 ? MAX_UINT48 : readyAt - 1n;
}

export const agentPaymasterAbi = parseAbi([
  'struct GasCaps { uint64 maxFeePerGas; uint32 callGasLimit; uint32 verificationGasLimit; uint32 preVerificationGas; uint32 paymasterVerificationGasLimit; uint32 paymasterPostOpGasLimit; }',
  'struct Bucket { uint128 burst; uint128 ratePerDay; uint128 level; uint48 lastRefill; }',
  'constructor(address entryPoint, address owner, GasCaps caps)',
  'function registerAgent(address account, uint128 burst, uint128 ratePerDay)',
  'function deregisterAgent(address account)',
  'function setGasCaps(GasCaps caps)',
  'function deposit() payable',
  'function addStake(uint32 unstakeDelaySec) payable',
  'function withdrawTo(address withdrawAddress, uint256 amount)',
  'function gasCaps() view returns (GasCaps)',
  'function agentOf(address account) view returns (bool registered, Bucket quota, uint256 pending)',
  'function available(address account) view returns (uint256)',
  'function previewValidAfter(address account, uint256 maxCost) view returns (uint48)',
  'function maxSponsoredOver(uint256 window) view returns (uint256)',
  'function isStaked() view returns (bool)',
  'function getDeposit() view returns (uint256)',
  'function totalBurst() view returns (uint256)',
  'function totalRatePerDay() view returns (uint256)',
  'function agentCount() view returns (uint256)',
  'function owner() view returns (address)',
  'function entryPoint() view returns (address)',
  'event AgentRegistered(address indexed account, uint128 burst, uint128 ratePerDay)',
  'event AgentDeregistered(address indexed account)',
  'event GasCapsSet(GasCaps caps)',
  'event GasSponsored(address indexed account, bytes32 indexed userOpHash, uint256 reserved, uint256 charged, bool opSucceeded)',
  'error ZeroAddress()',
  'error NotRegistered(address account)',
  'error GasFieldAboveCap(uint8 field, uint256 value, uint256 cap)',
  'error PostOpGasTooLow(uint256 value, uint256 min)',
  'error QuotaExceeded(address account, uint256 needed, uint256 burst)',
]);
