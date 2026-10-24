/**
 * Agent-op encodings shared by the approval service and the agent tools (docs/api.md section 4):
 *   callData  = 0x8dd7712f (executeUserOp) ++ abi.encode(uint8 kind, address target, uint256 value, bytes data)
 *   signature = abi.encode(uint8 role, bytes sig, bytes attestation, bytes approval)   (role 1 = AGENT)
 *   nonce     = (nonceKey << 64) | seq,  nonceKey = agentKey << 32 | salt24 << 8 | lane
 * plus the reason-code table (docs/api.md 7.1) and payee derivation from the account's rules.
 * Lane APPS (M5).
 */
import {
  type Address,
  type Hex,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  size,
  slice,
} from 'viem';

export const EXECUTE_USER_OP_SELECTOR: Hex = '0x8dd7712f';
export const OP_KIND = { CALL: 0, REGISTER_VOUCHER: 1 } as const;
export const ROLE = { OWNER: 0, AGENT: 1 } as const;
export const LANE = { NORMAL: 0, APPROVAL: 1 } as const;
export const TARGET_ARG = 0xff;
/** lib/PolicyTypes.sol RuleOp. */
export const RULE_OP = { EQ_SELF: 0, IN_RECIPIENTS: 1, PAYEE: 2, LTE: 3, EQ: 4 } as const;
export const ANY_TARGET: Address = '0x0000000000000000000000000000000000000000';
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
export const ZERO_SELECTOR: Hex = '0x00000000';

/** docs/api.md 7.1: uint16 reason = code | (detail << 8). */
export const REASONS = [
  'OK',
  'REVOKED',
  'EXPIRED',
  'TARGET',
  'ARG_RULE',
  'RECIPIENT',
  'FLAGGED',
  'PER_TX',
  'EXPLORE_PER_TX',
  'KEY_BUCKET',
  'GLOBAL_BUCKET',
  'EXPLORE_BUCKET',
  'GAS_CREDIT',
  'NO_SESSION',
  'NONCE_KEY',
  'OP_SHAPE',
  'GAS_CAP',
  'APPROVAL',
  'ASSET',
  'FROZEN',
  'PAYMASTER',
] as const;
export type ReasonName = (typeof REASONS)[number];
export const REASON = Object.fromEntries(REASONS.map((n, i) => [n, i])) as Record<ReasonName, number>;

/** "ARG_RULE(2)" style name; detail only for the argument-rule codes. */
export function reasonName(reason: number): string {
  const code = reason & 0xff;
  const detail = reason >> 8;
  const name = REASONS[code] ?? `UNKNOWN_${code}`;
  return detail && (code === REASON.ARG_RULE || code === REASON.RECIPIENT || code === REASON.FLAGGED) ? `${name}(${detail})` : name;
}

export interface AgentCall {
  kind: number;
  target: Address;
  value: bigint;
  data: Hex;
  /** first 4 bytes of data, 0x00000000 for a plain value send. */
  selector: Hex;
}

const OP_PARAMS = [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] as const;

export function encodeAgentOp(c: { kind?: number; target: Address; value?: bigint; data?: Hex }): Hex {
  return concat([EXECUTE_USER_OP_SELECTOR, encodeAbiParameters(OP_PARAMS, [c.kind ?? OP_KIND.CALL, c.target, c.value ?? 0n, c.data ?? '0x'])]);
}

/** Mirrors PolicyCheck.decode: throws on anything the account would refuse as OP_SHAPE. */
export function decodeAgentOp(callData: Hex): AgentCall {
  if (size(callData) < 4 + 128 || slice(callData, 0, 4).toLowerCase() !== EXECUTE_USER_OP_SELECTOR) {
    throw new Error('OP_SHAPE: callData is not executeUserOp ++ agent op body');
  }
  const kindWord = hexToBigInt(slice(callData, 4, 36));
  const targetWord = hexToBigInt(slice(callData, 36, 68));
  if (kindWord > 1n || targetWord >> 160n !== 0n) throw new Error('OP_SHAPE: bad kind or target word');
  const [kind, target, value, data] = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }],
    slice(callData, 4),
  );
  const n = size(data);
  if (n !== 0 && n < 4) throw new Error('OP_SHAPE: data shorter than a selector');
  return { kind: Number(kind), target: getAddress(target), value, data, selector: n >= 4 ? slice(data, 0, 4) : ZERO_SELECTOR };
}

const SIG_PARAMS = [{ type: 'uint8' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }] as const;

export interface SignatureEnvelope {
  role: number;
  sig: Hex;
  attestation: Hex;
  approval: Hex;
}

export function encodeSignatureEnvelope(e: { role?: number; sig: Hex; attestation?: Hex; approval?: Hex }): Hex {
  return encodeAbiParameters(SIG_PARAMS, [e.role ?? ROLE.AGENT, e.sig, e.attestation ?? '0x', e.approval ?? '0x']);
}

/** A raw 65-byte signature is the owner role (AgentAccount._decodeSig). */
export function decodeSignatureEnvelope(signature: Hex): SignatureEnvelope {
  if (size(signature) === 65) return { role: ROLE.OWNER, sig: signature, attestation: '0x', approval: '0x' };
  const [role, sig, attestation, approval] = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }],
    signature,
  );
  return { role: Number(role), sig, attestation, approval };
}

// ---- nonces (docs/api.md 4.5)

export function nonceKeyOfNonce(nonce: bigint): bigint {
  return nonce >> 64n;
}
export function sequenceOfNonce(nonce: bigint): bigint {
  return nonce & ((1n << 64n) - 1n);
}
export function laneOfNonce(nonce: bigint): number {
  return Number(nonceKeyOfNonce(nonce) & 0xffn);
}
export function agentOfNonce(nonce: bigint): Address {
  return getAddress(`0x${(nonceKeyOfNonce(nonce) >> 32n).toString(16).padStart(40, '0')}`);
}
export function makeNonce(nonceKey: bigint, seq: bigint): bigint {
  return (nonceKey << 64n) | seq;
}

// ---- payee (PolicyCheck.evalRules: the PAYEE argument rule fills call.payee)

export interface ArgRuleView {
  argIndex: number;
  op: number;
  bound: bigint;
}

/**
 * The payee the account will see for this call: the address under the entry's PAYEE rule
 * (TARGET_ARG = the call target), else the zero address (the op has no payee argument).
 * `rules` = account.ruleOf(agentKey, target, selector) (or the ANY_TARGET entry for a plain value send).
 */
export function payeeFromRules(call: AgentCall, rules: readonly ArgRuleView[]): Address {
  let payee: Address = ZERO_ADDRESS;
  for (const r of rules) {
    if (r.op !== RULE_OP.PAYEE) continue;
    if (r.argIndex === TARGET_ARG) payee = call.target;
    else {
      const at = 4 + 32 * r.argIndex;
      if (size(call.data) < at + 32) throw new Error('OP_SHAPE: calldata too short for the PAYEE argument');
      const w = hexToBigInt(slice(call.data, at, at + 32));
      payee = getAddress(`0x${(w & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`);
    }
  }
  return payee;
}

/** Fallback when the account's rules cannot be read: ERC-20 transfer arg 0, plain value send target. */
export function payeeHeuristic(call: AgentCall): Address {
  if (call.selector === '0xa9059cbb') return payeeFromRules(call, [{ argIndex: 0, op: RULE_OP.PAYEE, bound: 0n }]);
  if (size(call.data) === 0) return call.target;
  return ZERO_ADDRESS;
}

/** Decoded asset amount of transfer / approve / increaseAllowance (PolicyCheck.checkPerTx), else native value. */
export function declaredAmount(call: AgentCall): { asset: Address; amount: bigint; spender?: Address } | null {
  const sel = call.selector.toLowerCase();
  if ((sel === '0xa9059cbb' || sel === '0x095ea7b3' || sel === '0x39509351') && size(call.data) >= 68) {
    const who = getAddress(`0x${(hexToBigInt(slice(call.data, 4, 36)) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`);
    const amount = hexToBigInt(slice(call.data, 36, 68));
    return sel === '0xa9059cbb' ? { asset: call.target, amount } : { asset: call.target, amount, spender: who };
  }
  if (call.value > 0n) return { asset: ZERO_ADDRESS, amount: call.value };
  return null;
}
