/**
 * D3 tier rule: one implementation for the attestor and the tools (BUILD.md M6 step 3).
 *
 *   FLAGGED  = a flag fires (the decision-code adapter below; in the simulator: the router's
 *              Sybil hard filters, see SYBIL_* below).
 *   PROVEN   = not flagged AND 95% LCB(s, f | Beta(1,3)) >= 95% LCB(3, 0 | Beta(1,3)).
 *   UNPROVEN = everything else, cold start included.
 *
 * Ported verbatim from sim/hx/tierRule.ts (the pre-registered X4 rule, SIM lane). sim/ is a
 * standalone npm project, so it keeps its own copy; services/attestor/test/tier.test.ts checks
 * this file against sim/hx/tier_vectors.json so the two cannot drift.
 */
export type Tier = 'PROVEN' | 'UNPROVEN' | 'FLAGGED';

/** On-chain `Tier` enum numbering (contracts/src/lib/PolicyTypes.sol). Only PROVEN is ever signed. */
export const TIER_ENUM = { NONE: 0, PROVEN: 1, UNPROVEN: 2, FLAGGED: 3 } as const;

/** IDEA.md 7.5 decision codes. `null` = cold start (no evidence). */
export type DecisionCode = 'ROUTE' | 'ROUTE_WITH_CAUTION' | 'HOLD' | 'INVESTIGATE' | 'REFER' | 'QUARANTINE';

/** Same formula as Trace_CIKM src/lib/trace/traceScore.ts computeBayesianLCB (Wilson, z = 1.96). */
export function lcb95(successes: number, failures: number, alphaPrior = 1, betaPrior = 3): number {
  const a = Math.max(0, successes) + alphaPrior;
  const b = Math.max(0, failures) + betaPrior;
  const n = a + b;
  if (n <= 0) return 0;
  const p = a / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lower = (centre - margin) / denom;
  if (!Number.isFinite(lower)) return 0;
  return Math.max(0, Math.min(1, lower));
}

/** LCB of a payee with 3 successes and 0 failures under Beta(1,3) (~0.2505). */
export const PROVEN_LCB_THRESHOLD = lcb95(3, 0);

export interface TierEvidence {
  successes: number;
  failures: number;
  flagged: boolean;
}

export function tierFromEvidence(e: TierEvidence): Tier {
  if (e.flagged) return 'FLAGGED';
  return lcb95(e.successes, e.failures) >= PROVEN_LCB_THRESHOLD ? 'PROVEN' : 'UNPROVEN';
}

/**
 * The router's Sybil hard filters (Trace_CIKM traceRouter.ts scoreAllCandidates), with the
 * paper's V2 flags off (density factor 1.0): sybilRisk > 0.5, or > 0.15 with any failure.
 */
export const SYBIL_MAX_RISK = 0.5;
export const SYBIL_FAILURE_THRESHOLD = 0.15;

export function sybilFlagged(p: { sybilRisk: number; failedJobs: number }): boolean {
  return p.sybilRisk > SYBIL_MAX_RISK || (p.sybilRisk > SYBIL_FAILURE_THRESHOLD && p.failedJobs > 0);
}

/**
 * IDEA.md 7.5 adapter: ROUTE -> PROVEN; ROUTE_WITH_CAUTION and cold start -> UNPROVEN (no
 * attestation); HOLD, INVESTIGATE, REFER, QUARANTINE and any unknown code -> FLAGGED.
 * Fail-closed: a code we do not recognise can never produce PROVEN.
 */
export function tierFromDecisionCode(code: string | null | undefined): Tier {
  if (code === 'ROUTE') return 'PROVEN';
  if (code === 'ROUTE_WITH_CAUTION' || code === null || code === undefined || code === '') return 'UNPROVEN';
  return 'FLAGGED';
}
