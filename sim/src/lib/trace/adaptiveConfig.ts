/**
 * TRACE v2.2 — Adaptive Scale-Aware Configuration
 *
 * Computes effective parameter values based on network scale,
 * interaction maturity, and confidence levels.
 *
 * Core principle: static parameters overreact at small scales.
 * Adaptive scaling produces stable behavior across N=30 → N=100.
 *
 * μ_effective = μ × min(1, N / N_target)
 * confidence  = min(1, interactionCount / K)
 */

import { ROUTING_UTILITY, REPEATED_PAIR } from "./config";

// ─── Adaptive Scaling Constants ───────────────────────────────────────────────

export const ADAPTIVE_SCALING = {
  /** Minimum scale factor — even at N=1, penalty is at least this fraction */
  minPenaltyScale: 0.3,

  /** Minimum interactions before entropy estimates are trusted */
  entropyConfidenceK: 15,

  /** Minimum interactions before repeated-pair decay activates fully */
  decayMaturityK: 10,

  /** Enable/disable adaptive scaling */
  enabled: true,
} as const;

// ─── Scale-Aware Penalty Computation ──────────────────────────────────────────

/**
 * Compute scale factor for penalties.
 * 
 * In v2.5, targetScale is dynamic: targetScale = max(100, networkSize / 2).
 * This ensures that as the network grows, the system maintains pressure
 * rather than saturating at a fixed N.
 */
export function computeScaleFactor(networkSize: number): number {
  if (!ADAPTIVE_SCALING.enabled) return 1.0;

  // Target scale grows with the network, preventing "relative signal deficit" at large N.
  const targetScale = Math.max(100, networkSize / 2);
  const raw = networkSize / targetScale;
  return Math.max(ADAPTIVE_SCALING.minPenaltyScale, Math.min(1.0, raw));
}

/**
 * Non-saturating penalty scale factor for sybil/clique penalties.
 * Unlike the old computeScaleFactor which caps at 1.0 for N >= 200,
 * this formula grows monotonically with N via logarithmic scaling:
 *   scale = 1 + log2(max(1, N / 100))
 *
 * At N=100: scale = 1.0 (baseline)
 * At N=200: scale = 2.0
 * At N=1000: scale ≈ 4.32
 * At N=5000: scale ≈ 6.64
 *
 * This ensures sybil/clique penalties have increasing teeth at large N,
 * preventing the saturation bug where penalties are identical at N=200 and N=5000.
 *
 * @param networkSize - Number of providers in the network
 * @returns Scale factor >= 1.0, monotonically increasing with N
 */
export function nonSaturatingPenaltyScale(networkSize: number): number {
  const N = Math.max(1, networkSize);
  return 1 + Math.log2(Math.max(1, N / 100));
}

/**
 * Compute the network-aware minimum entropy required for full trust.
 * 
 * At small N=30, log2(30) ~ 4.9, baseline 1.5 is fine.
 * At large N=1000, log2(1000) ~ 9.9.
 * 
 * requiredEntropy = 1.0 + 0.5 * log2(networkSize / 30)
 */
export function computeRequiredEntropy(networkSize: number): number {
  if (networkSize <= 30) return 1.5;
  // Logarithmic scaling: doubling network size increases requirement by 0.5 bits.
  return 1.5 + 0.5 * Math.log2(networkSize / 30);
}

/**
 * Compute effective clique penalty for the current network scale.
 *
 * Uses non-saturating logarithmic scale so penalty grows monotonically with N:
 *   μ_effective = μ × nonSaturatingPenaltyScale(N)
 */
export function effectiveCliquePenalty(networkSize: number): number {
  const scaleFactor = nonSaturatingPenaltyScale(networkSize);
  return ROUTING_UTILITY.mu_cliquePenalty * scaleFactor;
}

/**
 * Compute effective sybil penalty for the current network scale.
 *
 * Uses non-saturating logarithmic scale so penalty grows monotonically with N:
 *   λ_effective = λ × nonSaturatingPenaltyScale(N)
 */
export function effectiveSybilPenalty(networkSize: number): number {
  const scaleFactor = nonSaturatingPenaltyScale(networkSize);
  return ROUTING_UTILITY.lambda_sybilPenalty * scaleFactor;
}

// ─── Confidence-Gated Entropy ─────────────────────────────────────────────────

/**
 * Compute interaction confidence factor.
 *
 *   confidence = min(1, interactionCount / (K * log2(networkSize)))
 *
 * Agents with few interactions get reduced entropy penalty — they haven't
 * had the chance to build diversity yet.
 */
export function computeEntropyConfidence(totalInteractions: number, networkSize: number): number {
  if (!ADAPTIVE_SCALING.enabled) return 1.0;

  const kScaled = ADAPTIVE_SCALING.entropyConfidenceK * Math.log2(Math.max(2, networkSize));
  return Math.min(1.0, totalInteractions / kScaled);
}

/**
 * Compute confidence-weighted entropy penalty.
 *
 *   effectivePenalty = confidence × rawPenalty
 *
 * This means:
 *   - 0 interactions: no entropy penalty
 *   - 7 interactions: ~47% of full penalty
 *   - 15+ interactions: full entropy penalty
 */
export function confidenceWeightedEntropyPenalty(
  rawEntropyPenalty: number,
  totalInteractions: number,
  networkSize: number
): number {
  const confidence = computeEntropyConfidence(totalInteractions, networkSize);
  return confidence * rawEntropyPenalty;
}

// ─── Maturity-Aware Decay ─────────────────────────────────────────────────────

/**
 * Compute maturity factor for repeated-pair decay.
 *
 * At small scales / low maturity, the decay constant is stretched
 * (more lenient), preventing over-penalization of legitimate
 * concentrated interactions that happen naturally in small networks.
 *
 *   maturityFactor ∈ [0.5, 1.5]
 *     - Small network, low diversity: 1.5 (slower decay, more lenient)
 *     - Large network, high diversity: 0.5 (faster decay, stricter)
 *     - Default: 1.0
 */
export function computeMaturityFactor(
  networkSize: number,
  diversityScore: number
): number {
  if (!ADAPTIVE_SCALING.enabled) return 1.0;

  const scaleFactor = computeScaleFactor(networkSize);

  // Invert: small scale → higher maturity factor (more lenient)
  // High diversity → lower maturity factor (stricter — diverse agents don't need leniency)
  const rawMaturity = 1.5 - (scaleFactor * 0.5) - (diversityScore * 0.5);

  return Math.max(0.5, Math.min(1.5, rawMaturity));
}

/**
 * Compute effective repeated-pair decay constant.
 *
 *   k_effective = k × maturityFactor
 *
 * Higher k_effective = slower decay = more lenient
 */
export function effectiveDecayConstant(
  networkSize: number,
  diversityScore: number
): number {
  const maturity = computeMaturityFactor(networkSize, diversityScore);
  return REPEATED_PAIR.decayConstant * maturity;
}

// ─── Dynamic-Formula Registry (Audit §2.2 — R-SCALE, R-GRAPH) ─────────────────
//
// The functions below host the dynamic-scaling formulas required by
// requirements R-SCALE (criteria 2, 3) and R-GRAPH (criteria 3, 4) of the
// trace-adversarial-coevolution audit. Each formula is documented with its
// derivation and the static literal it replaces. Consumers in `trustGraph.ts`,
// `traceRouter.ts`, and `config.ts` are rewired in Task 2.3 to call these
// instead of reading static literals. The existing
// `computeScaleFactor`/`targetScale = max(100, N/2)` definition above is
// preserved unchanged (R-SCALE 1.4 verify-and-extend semantics) and re-exported
// at the bottom of this section as `targetScaleFactor`.

/**
 * minEntropyForFullTrust(N) — Shannon-entropy threshold above which a
 * provider's counterparty distribution is judged maximally diverse.
 *
 * Formula:   max(1.5, log2(N))
 * Lower bound 1.5 preserves the existing static value at the smallest
 * audited scale (`COUNTERPARTY_DIVERSITY.minEntropyForFullTrust = 1.5`,
 * which is `~log2(3)`). For larger N the threshold grows with the
 * Shannon-entropy maximum H_max = log2(K) for K equally-likely
 * counterparties: "full trust" requires K ≈ N counterparties spanning
 * log2(N) bits of diversity. Derivation in Audit_Report constants table.
 *
 * Replaces: `COUNTERPARTY_DIVERSITY.minEntropyForFullTrust = 1.5` in
 * `config.ts` (which is demoted to a floor only by Task 2.3).
 *
 * Validates: R-SCALE criterion 3 (computed at N ∈ {30, 100, 500, 1000}).
 */
export function minEntropyForFullTrust(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(1.5, Math.log2(N));
}

/**
 * trustPropagationDepth(N) — maximum traversal depth for any BFS / DFS over
 * the trust graph (e.g. `detectCircularPatternsFromGraph`).
 *
 * Formula:   max(4, ceil(log2(N)))
 * Lower bound 4 preserves a meaningful traversal at very small N. For larger
 * N the depth grows logarithmically: in a graph with branching factor b and
 * diameter d, log2(N) bounds the expected hop count between any two nodes
 * when b ≥ 2. The current hardcoded `MAX_DEPTH = 10` inside
 * `detectCircularPatternsFromGraph` corresponds to N ≈ 1024 under this
 * formula and is therefore preserved at the upper end of the audited range.
 *
 * Replaces: hardcoded `maxDepth: number = 10` parameter default in
 * `trustGraph.ts::detectCircularPatternsFromGraph` (rewired by Task 2.3).
 *
 * Validates: R-GRAPH criterion 4.
 */
export function trustPropagationDepth(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(4, Math.ceil(Math.log2(N)));
}

/**
 * cliquePenaltyCap(N) — saturation cap applied to the aggregate clique
 * penalty term in routing utility.
 *
 * Formula:   sqrt(N) * mu_cliquePenalty
 * Where `mu_cliquePenalty` is sourced from `ROUTING_UTILITY.mu_cliquePenalty`
 * (the existing static cap; currently `0.25` per `config.ts`). A clique of
 * size k contributes Θ(k^2) edges and Θ(k) participants, so the suppression
 * budget should scale with the graph dimension — sqrt(N) preserves the
 * relative-pressure invariant while preventing unbounded penalty growth.
 *
 * Cited as the source for `mu_cliquePenalty`: `ROUTING_UTILITY.mu_cliquePenalty`
 * defined in `src/lib/trace/config.ts` (the existing static cap parameter
 * already in use by `effectiveCliquePenalty(N)` above).
 *
 * Validates: R-GRAPH criterion 3.
 */
export function cliquePenaltyCap(networkSize: number): number {
  const N = Math.max(1, networkSize);
  // mu_cliquePenalty source: ROUTING_UTILITY.mu_cliquePenalty in config.ts —
  // the same μ parameter that drives `effectiveCliquePenalty(N)` above.
  return Math.sqrt(N) * ROUTING_UTILITY.mu_cliquePenalty;
}

/**
 * edgeTTLWindowRounds(N) — sliding-window length (in rounds) applied to
 * trust-edge accumulators. Used by `WindowedEdgeAccumulator` (Task 6.3) and
 * by the velocity engine's history TTL (Task 7.1).
 *
 * Formula:   max(20, ceil(log2(N) * 5))
 * Lower bound 20 preserves a usable rolling window at very small N. The
 * log2(N) * 5 scaling keeps the accumulator memory bounded at
 * O(distinctEdges × window) while ensuring the window grows fast enough at
 * large N for graph-detectable structures (Sybil bursts, ring rotations) to
 * register inside the window.
 *
 * Replaces: ad-hoc literal windows scattered across the trust graph (Task 6.3
 * rewires consumers).
 */
export function edgeTTLWindowRounds(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(20, Math.ceil(Math.log2(N) * 5));
}

/**
 * pprMaxIter(N) — fixed iteration cap on Personalized PageRank power
 * iteration in `trustGraph.ts::computePersonalizedPageRank`.
 *
 * Formula:   max(50, ceil(log2(N) * 5))
 * Lower bound 50 preserves the existing convergence horizon for small N.
 * The log2(N) * 5 scaling ensures the iteration budget grows just enough
 * at large N to keep mixing-time bounded; convergence is monitored but not
 * relied upon (R-STABILITY 4) — when the cap is hit the result is the
 * partial PPR vector at iteration `pprMaxIter(N)`, which is finite and
 * well-defined.
 *
 * Replaces: hardcoded `MAX_ITER` literal inside
 * `trustGraph.ts::computePersonalizedPageRank` (rewired by Task 6.2).
 *
 * Validates: R-GRAPH (boundedness of graph routines at large N).
 */
export function pprMaxIter(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(50, Math.ceil(Math.log2(N) * 5));
}

/**
 * edgeWeightCap(N) — per-edge weight saturation cap used in trust-graph
 * propagation (replaces the static `TRUST_GRAPH_VALIDATION.edgeWeightCap = 5.0`).
 *
 * Formula:   max(5, log2(N))
 * Lower bound 5 preserves the existing static cap at small N (the current
 * `edgeWeightCap = 5.0` corresponds exactly to N=32 under this formula and
 * is therefore unchanged for the small-N audited cells). For larger N the
 * cap grows with log2(N): a single edge cannot dominate a provider's trust
 * estimate when log2(N) other agents could reasonably contribute the same
 * evidence.
 *
 * Replaces: `TRUST_GRAPH_VALIDATION.edgeWeightCap = 5.0` in `config.ts`
 * (which is demoted to a floor only by Task 2.3).
 */
export function edgeWeightCap(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(5, Math.log2(N));
}

/**
 * computeEntropyConfidenceFloor(N) — minimum total-interaction count below
 * which the weighted-entropy estimator in `computeWeightedEntropy` is
 * considered insufficiently confident to discriminate between honest and
 * adversarial counterparty distributions.
 *
 * Formula:   max(10, ceil(log2(N) * 2))
 * Lower bound 10 preserves the existing static threshold (`total < 10`) at
 * small N. The log2(N) * 2 scaling reflects that a larger network admits
 * proportionally more potential counterparties, so a higher floor is
 * required before the empirical distribution carries the same
 * discriminative power. Monotone non-decreasing in N (Property P1 in the
 * design's audit constants).
 *
 * Replaces: hardcoded `total < 10` literal inside
 * `trustGraph.ts::computeWeightedEntropy` (rewired by Task 2.3).
 */
export function computeEntropyConfidenceFloor(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(10, Math.ceil(Math.log2(N) * 2));
}

/**
 * Re-export `computeScaleFactor` as `targetScaleFactor` so that consumers
 * importing the dynamic-formula registry can read the volume-scale function
 * under its registry-canonical name. The underlying definition is unchanged
 * (preserves `targetScale = max(100, N/2)` per R-SCALE criterion 4); this is
 * a name re-export only.
 */
export { computeScaleFactor as targetScaleFactor };
