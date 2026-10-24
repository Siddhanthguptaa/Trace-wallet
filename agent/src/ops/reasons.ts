/** Reason codes (docs/api.md 7.1): `uint16 reason = code | (detail << 8)`. Pure. */

export const REASONS = [
  'OK', 'REVOKED', 'EXPIRED', 'TARGET', 'ARG_RULE', 'RECIPIENT', 'FLAGGED', 'PER_TX', 'EXPLORE_PER_TX',
  'KEY_BUCKET', 'GLOBAL_BUCKET', 'EXPLORE_BUCKET', 'GAS_CREDIT', 'NO_SESSION', 'NONCE_KEY', 'OP_SHAPE',
  'GAS_CAP', 'APPROVAL', 'ASSET', 'FROZEN', 'PAYMASTER',
] as const;
export type ReasonName = (typeof REASONS)[number] | `UNKNOWN_${number}`;
export const R = Object.fromEntries(REASONS.map((n, i) => [n, i])) as Record<(typeof REASONS)[number], number>;

export function decodeReason(reason: number): { code: number; detail: number; name: ReasonName } {
  const code = reason & 0xff;
  const detail = reason >> 8;
  return { code, detail, name: (REASONS[code] ?? `UNKNOWN_${code}`) as ReasonName };
}

/**
 * Reasons the owner can waive with an OutcomeApproval (docs/api.md 9 APPC: approvals waive tier
 * refusals, per-tx caps and buckets, never TARGET / ARG_RULE / shape / session problems).
 * Only for ops that carry a payee (an unlisted payee shows up as RECIPIENT from the tier hook);
 * a RECIPIENT from an argument rule (approve / setApprovalForAll operator) is not approvable.
 */
const APPROVABLE = new Set<number>([R.RECIPIENT, R.PER_TX, R.EXPLORE_PER_TX, R.KEY_BUCKET, R.GLOBAL_BUCKET, R.EXPLORE_BUCKET]);

export function approvable(reason: number, hasPayee: boolean): boolean {
  const { code } = decodeReason(reason);
  return hasPayee && APPROVABLE.has(code);
}

export const TIER = ['NONE', 'PROVEN', 'UNPROVEN', 'FLAGGED'] as const;
export const TRACK = ['NORMAL', 'EXPLORE', 'APPROVAL'] as const;
