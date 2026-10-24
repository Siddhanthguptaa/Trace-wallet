/**
 * Owner-side policy builders for the real AgentAccount (docs/api.md 2.4, 8): PolicyInput objects
 * for `setPolicy`, the agent-op calldata encoding (4.1) and the reason / tier names.
 */
import { type Address, type Hex, concat, encodeAbiParameters, getAddress, toFunctionSelector } from 'viem';

export const RULE_OP = { EQ_SELF: 0, IN_RECIPIENTS: 1, PAYEE: 2, LTE: 3, EQ: 4 } as const;
export const TARGET_ARG = 255;
export const ANY_TARGET: Address = '0x0000000000000000000000000000000000000000';
export const NATIVE: Address = '0x0000000000000000000000000000000000000000';
export const EXECUTE_USER_OP: Hex = '0x8dd7712f';
export const TRANSFER: Hex = '0xa9059cbb';
export const APPROVE: Hex = '0x095ea7b3';
export const TIER = { NONE: 0, PROVEN: 1, UNPROVEN: 2, FLAGGED: 3 } as const;
export const TRACK = { NORMAL: 0, EXPLORE: 1, APPROVAL: 2 } as const;
export const sel = (sig: string): Hex => toFunctionSelector(sig);

/** userOp.callData of an agent op: executeUserOp selector ++ abi.encode(kind, target, value, data). */
export function agentOpCallData(target: Address, value: bigint, data: Hex, kind = 0): Hex {
  return concat([
    EXECUTE_USER_OP,
    encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [kind, getAddress(target), value, data]),
  ]);
}

export interface RuleSpec {
  argIndex: number;
  op: number;
  bound?: bigint;
}
export interface CallSpec {
  target: Address;
  selector: Hex;
  rules?: RuleSpec[];
}
export interface AssetSpec {
  asset: Address;
  perTxCap: bigint;
  burst: bigint;
  ratePerDay: bigint;
}
export interface GasSpec {
  maxCallGas: number;
  maxVerificationGas: number;
  maxPreVerificationGas: number;
  maxFeePerGas: bigint;
  gasCredit: bigint;
}

/** Caps that fit the services' default agent-op gas (400k call, 280k verification, 60k pvg, 1 gwei). */
export const DEFAULT_GAS_POLICY: GasSpec = {
  maxCallGas: 500_000,
  maxVerificationGas: 300_000,
  maxPreVerificationGas: 100_000,
  maxFeePerGas: 1_000_000_000n,
  gasCredit: 100_000_000_000_000_000n, // 0.1 ETH
};

export function policyInput(o: { validAfter: number; validUntil: number; gas?: GasSpec; assets: AssetSpec[]; calls: CallSpec[] }) {
  return {
    validAfter: o.validAfter,
    validUntil: o.validUntil,
    gas: o.gas ?? DEFAULT_GAS_POLICY,
    assets: o.assets,
    calls: o.calls.map((c) => ({ target: c.target, selector: c.selector, rules: (c.rules ?? []).map((r) => ({ argIndex: r.argIndex, op: r.op, bound: r.bound ?? 0n })) })),
  };
}
