// Hypnexis: the pre-registered X4 / D3 tier rule (EXPERIMENTS.md X4, BUILD.md M6 step 3).
//
//   FLAGGED  = the Sybil/clique flag fires (in the simulator: the router's existing
//              Sybil hard filters; for the attestor: its decision-code adapter).
//   PROVEN   = not flagged AND 95% LCB(s, f | Beta(1,3)) >= 95% LCB(3, 0 | Beta(1,3)).
//   UNPROVEN = everything else, cold start included.
//
// Self-contained on purpose (no fork imports) so the attestor can port it verbatim;
// hx/test.ts checks lcb95 against the fork's computeBayesianLCB and writes
// hx/tier_vectors.json for cross-implementation checks.
export type Tier = "PROVEN" | "UNPROVEN" | "FLAGGED";

/** Same formula as Trace_CIKM src/lib/trace/traceScore.ts computeBayesianLCB (z = 1.96). */
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

/** LCB of a provider with 3 successes and 0 failures under Beta(1,3). */
export const PROVEN_LCB_THRESHOLD = lcb95(3, 0);

export interface TierEvidence {
  successes: number;
  failures: number;
  flagged: boolean;
}

export function tierFromEvidence(e: TierEvidence): Tier {
  if (e.flagged) return "FLAGGED";
  return lcb95(e.successes, e.failures) >= PROVEN_LCB_THRESHOLD ? "PROVEN" : "UNPROVEN";
}

// ── Simulator flag adapter ──────────────────────────────────────────────────
// The router's existing Sybil hard filters (traceRouter.ts scoreAllCandidates):
//   sybil_risk_too_high        : sybilRisk > ROUTING_CONSTRAINTS.maxSybilRisk (0.5)
//   sybil_failure_interaction  : sybilRisk > 0.15 / max(densityFactor, 0.1) and failedJobs > 0
// densityFactor is 1.0 with the paper's V2 flags off (DR disabled), so the second
// threshold is 0.15. The simulator's clique/ring/dense-subgraph/spectral signals are
// all folded into sybilRisk by updateSybilRiskScores; the utility's cliquePenalty is a
// continuous entropy-deficit term with no flag of its own.
export const SIM_MAX_SYBIL_RISK = 0.5;
export const SIM_SYBIL_FAILURE_THRESHOLD = 0.15;

export interface SimProviderStats {
  successfulJobs: number;
  failedJobs: number;
  sybilRisk: number;
}

export function simFlagged(p: SimProviderStats): boolean {
  return p.sybilRisk > SIM_MAX_SYBIL_RISK || (p.sybilRisk > SIM_SYBIL_FAILURE_THRESHOLD && p.failedJobs > 0);
}

export function simTier(p: SimProviderStats): Tier {
  return tierFromEvidence({ successes: p.successfulJobs, failures: p.failedJobs, flagged: simFlagged(p) });
}

// ── Attestor adapter (IDEA 7.5 decision codes) ──────────────────────────────
// ROUTE -> PROVEN; ROUTE_WITH_CAUTION and cold start -> no attestation (UNPROVEN);
// HOLD, INVESTIGATE, REFER, QUARANTINE and unknown codes -> FLAGGED.
export function tierFromDecisionCode(code: string | null | undefined): Tier {
  if (code === "ROUTE") return "PROVEN";
  if (code === "ROUTE_WITH_CAUTION" || code === null || code === undefined || code === "") return "UNPROVEN";
  return "FLAGGED";
}
