/** checkPolicy reason codes (IDEA.md 7.2), each with one plain sentence. Single source of truth. */
export const REASONS = {
  OK: { label: 'Within policy', sentence: 'Every check passed.' },
  REVOKED: { label: 'Key revoked', sentence: 'The owner revoked this agent key.' },
  EXPIRED: { label: 'Key expired', sentence: 'The session key is outside its valid time window.' },
  TARGET: { label: 'Target not allowed', sentence: 'This contract or function is not on the allowed list.' },
  ARG_RULE: { label: 'Argument rule', sentence: 'An argument (recipient, spender or amount) breaks a rule.' },
  RECIPIENT: { label: 'Recipient not allowed', sentence: 'The money would go to an address the policy does not allow.' },
  FLAGGED: { label: 'Payee flagged', sentence: 'The payee is flagged, so only an owner approval can pay it.' },
  PER_TX: { label: 'Per-payment cap', sentence: 'This single payment is larger than the per-payment cap.' },
  EXPLORE_PER_TX: { label: 'Unproven per-payment cap', sentence: 'Unproven payees can receive only a small amount per payment.' },
  KEY_BUCKET: { label: "Key's daily budget", sentence: "This key's 24-hour budget is used up." },
  GLOBAL_BUCKET: { label: 'Account daily cap', sentence: 'The account-wide 24-hour cap is used up.' },
  EXPLORE_BUCKET: { label: 'Exploration budget', sentence: 'The shared budget for unproven payees is used up.' },
  GAS_CREDIT: { label: 'Gas credit', sentence: 'The key has no gas credit left; the owner must refill it.' },
  SIG_1271: { label: 'Signature refused', sentence: 'The wallet refused to treat the agent key’s signature as its own (0xffffffff).' },
  MEASURED_OUTFLOW: { label: 'Measured outflow', sentence: 'More left the wallet than allowed, so the call reverted.' },
  NFT_DROP: { label: 'NFT protected', sentence: 'A protected NFT would have left the wallet.' },
} as const;

export type ReasonKey = keyof typeof REASONS;

/** Accepts "ARG_RULE(2)" style codes. */
export function describeReason(code: string | null | undefined): { code: string; label: string; sentence: string } {
  if (!code) return { code: 'UNKNOWN', label: 'Unknown', sentence: 'No reason was reported.' };
  const m = /^([A-Z0-9_]+)(?:\((\d+)\))?$/.exec(code.trim());
  const key = (m?.[1] ?? code) as ReasonKey;
  const r = REASONS[key];
  if (!r) return { code, label: code, sentence: 'Refused by the wallet.' };
  const idx = m?.[2];
  return {
    code,
    label: idx ? `${r.label} #${idx}` : r.label,
    sentence: r.sentence,
  };
}
