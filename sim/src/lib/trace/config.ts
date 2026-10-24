/**
 * TRACE v2.10 Configuration — Fixed Collusion-Ring Suppression
 *
 * v2.10 improvements (2026-05-13) - FIX: Increase penalty weights for collusion-ring:
 *   - Increased lambda_sybilPenalty: 0.28 → 0.35 (+25%)
 *   - Increased mu_cliquePenalty: 0.20 → 0.25 (+25%)
 *   - Rationale: Task 3.1 investigation found penalties were too weak for collusion-ring
 *   - Expected impact: Reduce collusion-ring fraud from ~80 sats to ~20 sats
 *
 *   Phase 1 (Quick Wins) - IMPLEMENTED:
 *   - DENSE SUBGRAPH DETECTION: Catches mesh topologies via local clustering coefficient
 *   - BEHAVIORAL ANOMALY DETECTION: Penalizes "too-good-to-be-true" patterns (high success + graph + defaults)
 *   - TIGHTENED MULTIPLICATIVE PENALTY: Threshold 0.4→0.25, power 2.5→3.0, floor 5%→3%
 *   
 *   Phase 2 (Advanced Detection) - IMPLEMENTED:
 *   - FAILURE CLUSTERING DETECTION: Tracks temporal clustering of failures (recentFailureWindow field)
 *   - CROSS-AGENT FAILURE CORRELATION: Detects coordinated fraud patterns (failureCorrelation field)
 *   
 *   Expected impact: 98 sats → 15-20 sats (80-85% reduction)
 *
 * v2.8 improvements (maintained):
 *   - EXPONENTIAL sybil dampening (cubic for sybilRisk > 0.25)
 *   - COMPOUND risk amplification (sybil × clique = up to 80% additional reduction)
 *   - GRAPH CENTRALITY penalty (high networkTrust + sybil risk = collusion)
 *   - SOPHISTICATED COLLUSION detection (high completion + moderate detection)
 *   - Increased penalty weights: lambda 0.35→0.50 (+43%), mu 0.25→0.35 (+40%)
 *
 * v2.7 improvements (maintained):
 *   - Aggressive sybil dampening for network trust (2x dampening for sybilRisk > 0.3)
 *   - Multiplicative penalty for high-confidence detections (up to 70% utility reduction)
 *   - Prevents colluding agents from offsetting penalties via mutual trust boosting
 *
 * v2.6 improvements (maintained):
 *   - Increased penalty weights: lambda_sybilPenalty 0.20→0.35, mu_cliquePenalty 0.15→0.25
 *   - Unconditional volatility penalty (no longer gated on completionRate)
 *   - Whitewash-suspect penalty for identity reset detection
 *
 * Validated 2026-05-09 via 120-experiment matrix (3 versions × 2 attacks × 20 seeds).
 * v2.1 won 4/4 criteria under collusion-ring: lowest fraud, lowest variance,
 * best honest routing, fewest catastrophic seeds.
 * See results/VALIDATION_RESULTS.md for full evidence.
 *
 * v2.1 features (ACTIVE):
 *   - Counterparty entropy diversity engine
 *   - Repeated-pair exponential suppression
 *   - Clique penalty for low-diversity patterns
 *   - Sybil-aware routing, trust saturation, progressive unlocking
 *
 * v2.2 extensions (ENABLED):
 *   - Adaptive scale-aware penalty scaling
 *   - Confidence-gated entropy activation
 *   - Causal graph integration
 *
 * v2.3 extensions (ENABLED):
 *   - Trust velocity & acceleration modeling
 *   - Entropy trajectory analysis
 *   - Reciprocal amplification detection
 *   - Economic trust maturation
 */

// ─── TRACE Score Weights ──────────────────────────────────────────────────────
// v2: increased sybilRisk weight (0.15 → 0.25) and defaultProbability (0.20 → 0.30)
export const TRACE_WEIGHTS = {
  w1_completionRate:       0.25,
  w2_repaymentRate:        0.20,
  w3_networkTrust:         0.10,  // v2: reduced from 0.15 (trust graph is exploitable)
  w4_stakeRatio:           0.10,
  w5_successfulEscrowRate: 0.15,
  w6_defaultProbability:   0.30,  // v2: increased from 0.20 (steeper penalty)
  w7_sybilRisk:            0.25,  // v2: increased from 0.15 (sybil is critical)
  w8_disputeRate:          0.10,
} as const;

// Base score: new providers start at 500/1000
export const TRACE_BASE_SCORE = 500;
export const TRACE_MAX_SCORE = 1000;
export const TRACE_MIN_SCORE = 0;

// ─── Risk Tiering ─────────────────────────────────────────────────────────────
export const RISK_TIERS = {
  A: { min: 850, max: 1000, label: "A — Prime" },
  B: { min: 700, max: 849,  label: "B — Standard" },
  C: { min: 550, max: 699,  label: "C — Elevated Risk" },
  D: { min: 0,   max: 549,  label: "D — High Risk" },
} as const;

export type RiskTier = keyof typeof RISK_TIERS;

// ─── Default Probability Engine ───────────────────────────────────────────────
export const DEFAULT_PROB_WEIGHTS = {
  repaymentFailureWeight:  0.30,
  disputeWeight:           0.20,
  recentInstabilityWeight: 0.25,  // v2: increased from 0.20 (recent failures hit harder)
  stakePenaltyWeight:      0.10,
  historyWeight:           0.15,  // v2: increased from 0.10 (deeper history matters more)
} as const;

// Recency window for "recent instability"
export const INSTABILITY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── v2: Recent Failure Amplification ─────────────────────────────────────────
export const RECENT_FAILURE = {
  windowRounds: 5,            // Look at last 5 rounds for failure clustering
  amplificationMultiplier: 2.5, // Recent defaults are 2.5× more impactful
  decayPerRound: 0.3,         // Each round reduces the amplification
} as const;

// ─── Routing Utility ──────────────────────────────────────────────────────────
// v2.1: U = α·TRACE − β·defaultRisk − γ·cost
//         + δ·(adjustedTrust)                   ← diversity-weighted
//         − λ·sybilRisk                         ← DIRECT PENALTY
//         − μ·cliquePenalty                     ← v2.1: collusion penalty
//         + ε·capabilityMatch
export const ROUTING_UTILITY = {
  alpha_traceScore:     0.40,
  beta_defaultRisk:     0.30,
  gamma_cost:           0.15,
  delta_networkTrust:   0.10,
  epsilon_capability:   0.10,
  lambda_sybilPenalty:  0.35,  // v2.10: Increased from 0.28 (Task 3.1: needed for collusion-ring suppression)
  mu_cliquePenalty:     0.25,  // v2.10: Increased from 0.20 (Task 3.1: needed for collusion-ring suppression)
} as const;

export type TraceRoutingPreset = "baseline" | "guard_mid" | "guard_cost" | "guard_safe" | "guard_whitewash";
export type RoutingUtilityConfig = Record<keyof typeof ROUTING_UTILITY, number> & {
  minJobsForFullAccess?: number;
  volatilityPenaltyWeight?: number;
};

export const TRACE_ROUTING_PRESETS: Record<TraceRoutingPreset, RoutingUtilityConfig> = {
  baseline: {
    alpha_traceScore:     0.40,
    beta_defaultRisk:     0.30,
    gamma_cost:           0.15,
    delta_networkTrust:   0.10,
    epsilon_capability:   0.10,
    lambda_sybilPenalty:  0.35,  // v2.10: Increased for collusion-ring suppression
    mu_cliquePenalty:     0.25,  // v2.10: Increased for collusion-ring suppression
  },
  guard_mid: {
    alpha_traceScore:     0.46,   // v2.4: +0.02 to compensate for delta reduction
    beta_defaultRisk:     0.42,
    gamma_cost:           0.10,
    delta_networkTrust:   0.04,   // v2.4: 0.10→0.04 — limits collusion-ring's fake-trust routing boost
    epsilon_capability:   0.10,
    lambda_sybilPenalty:  0.38,
    mu_cliquePenalty:     0.20,
    minJobsForFullAccess: 15,
  },
  guard_cost: {
    alpha_traceScore:     0.42,
    beta_defaultRisk:     0.44,
    gamma_cost:           0.07,
    delta_networkTrust:   0.10,
    epsilon_capability:   0.10,
    lambda_sybilPenalty:  0.40,
    mu_cliquePenalty:     0.20,
    minJobsForFullAccess: 15,
  },
  guard_safe: {
    alpha_traceScore:     0.36,
    beta_defaultRisk:     0.60,
    gamma_cost:           0.18,
    delta_networkTrust:   0.06,
    epsilon_capability:   0.08,
    lambda_sybilPenalty:  0.70,
    mu_cliquePenalty:     0.30,
  },
  guard_whitewash: {
    alpha_traceScore:     0.46,
    beta_defaultRisk:     0.50,
    gamma_cost:           0.08,
    delta_networkTrust:   0.08,
    epsilon_capability:   0.08,
    lambda_sybilPenalty:  0.42,
    mu_cliquePenalty:     0.25,
    minJobsForFullAccess: 15,
    volatilityPenaltyWeight: 0.25,
  },
};

export function applyTraceRoutingPreset(preset: TraceRoutingPreset = "baseline"): void {
  const p = TRACE_ROUTING_PRESETS[preset];
  const utilityKeys = ["alpha_traceScore", "beta_defaultRisk", "gamma_cost", "delta_networkTrust", "epsilon_capability", "lambda_sybilPenalty", "mu_cliquePenalty"];
  const utilConfig: any = {};
  for (const k of utilityKeys) utilConfig[k] = (p as any)[k];
  Object.assign(ROUTING_UTILITY as Record<string, number>, utilConfig);

  // v5.0: Weight sensitivity override via env var (for runWeightSensitivity.ts).
  // When TRACE_WEIGHT_OVERRIDE is set to a JSON object like {"alpha_traceScore": 0.48},
  // those keys override the preset values. Used only in sensitivity analysis cells.
  const overrideEnv = process.env.TRACE_WEIGHT_OVERRIDE;
  if (overrideEnv && overrideEnv.trim().length > 2) {
    try {
      const overrides = JSON.parse(overrideEnv);
      for (const k of utilityKeys) {
        if (k in overrides && typeof overrides[k] === "number") {
          (ROUTING_UTILITY as any)[k] = overrides[k];
        }
      }
    } catch { /* ignore malformed override */ }
  }

  // Apply optional guard overrides
  if (p.minJobsForFullAccess !== undefined) {
    (PROGRESSIVE_TRUST as any).minJobsForFullAccess = p.minJobsForFullAccess;
  } else {
    (PROGRESSIVE_TRUST as any).minJobsForFullAccess = 10; // reset to default
  }
  
  if (p.volatilityPenaltyWeight !== undefined) {
    (VOLATILITY as any).volatilityPenaltyWeight = p.volatilityPenaltyWeight;
  } else {
    (VOLATILITY as any).volatilityPenaltyWeight = 0.15; // reset to default
  }
}

// ─── Routing Constraints ──────────────────────────────────────────────────────
export const ROUTING_CONSTRAINTS = {
  minTraceScore:        300,
  maxDefaultProbability: 0.55, // v2.6: tightened from 0.6 — balanced to not filter honest agents
  maxSybilRisk:         0.5,  // v2.6: tightened from 0.6 — earlier sybil detection
  maxActiveDisputes:    3,
  maxFailureRate:       0.30, // v4.1: tightened from 0.50 — honest agents have ≤12% failure; 30% catches exploiters earlier
  minJobsForFailureFilter: 3, // v4.1: require 3+ jobs before applying (avoids penalizing 1-job agents with 1 failure)
} as const;

// ─── Sensitive CUSUM Soft-Suppression Config ──────────────────────────────────
// When the sensitive CUSUM (K₂=0.90, H₂=2.5) alarms, the provider's utility
// is multiplicatively suppressed rather than hard-rejected. This catches
// moderate adversaries (15% failure) who evade the primary CUSUM (K=0.625).
//
// Citation: Tartakovsky & Veeravalli (2005) — graded response to multi-scale
// shifts. The soft-suppression approach avoids the binary alarm/no-alarm
// dichotomy and instead applies proportional penalty based on the CUSUM
// statistic's magnitude relative to the threshold.
//
// Suppression formula:
//   suppressionFactor = max(floor, 1 - (cusumSensitive / H₂) × (1 - floor))
//
// At cusumSensitive = 0: factor = 1.0 (no suppression)
// At cusumSensitive = H₂: factor = floor (maximum suppression)
// At cusumSensitive > H₂: factor = floor (capped)
//
// The floor of 0.30 means a provider under sensitive-CUSUM alarm retains
// 30% of their utility — enough to still be selected if they're the only
// capable provider, but low enough to lose to any clean competitor.
export const CUSUM_SENSITIVE_SUPPRESSION = {
  /** Minimum utility multiplier when sensitive CUSUM is at/above threshold */
  floor: 0.30,
  /** Whether to apply proportional suppression below the alarm threshold */
  proportional: true,
  /** Minimum CUSUM score before any proportional suppression begins */
  activationThreshold: 1.0,
} as const;

// ─── R-EXPLORE: Principled exploration constants (design §5.1) ───────────────
// Epsilon-greedy with O(1/√(t + n_i)) decay, where t is the round count and
// n_i is per-agent evidence volume (provider.totalJobs). The schedule is
// regret-optimal in the bandit sense and is shared across all four routing
// policies via the same RNG slot (R-EXPLORE 4, R-VERIFY-INTEGRITY 3).
//
//   ε(t, n_i) = clamp(c / √(t + n_i), epsilonMin, epsilonMax)
//
// Rationale for c = 0.5 (design §5.1): at t + n_i = 25, ε = 0.10, which
// matches the historical empirical default; ε then decays as evidence accrues.
//
// Replaces the legacy fixed-schedule {epsilonStart, epsilonEnd, decayRounds,
// minExplorationCandidates} constant — that scheme is forbidden by R-EXPLORE 2.
export const EXPLORATION_CONFIG: Readonly<{
  c: number;
  epsilonMin: number;
  epsilonMax: number;
  riskSensitive: boolean;
}> = {
  c: 0.5,
  epsilonMin: 0.01,
  epsilonMax: 0.20,
  // When true, exploration epsilon is reduced for high-value jobs: ε_risk = ε_base × min(1, medianPrice / jobValue)
  riskSensitive: true,
};

// ─── EigenTrust Baseline Configuration ─────────────────────────────────────────
/** EigenTrust baseline configuration (Kamvar et al., 2003).
 * Used by computeEigenTrustUtility for the clean EigenTrust baseline.
 * - alpha: damping/teleportation probability (probability of jumping to pre-trust)
 * - maxIterations: power iteration cap (convergence guaranteed for stochastic matrices)
 * - convergenceThreshold: L1 norm stopping criterion between iterations
 * - costWeight: how much normalized cost penalizes the final utility score
 */
export const EIGENTRUST_CONFIG = {
  alpha: 0.1,           // Damping factor (teleportation probability)
  maxIterations: 20,    // Power iteration cap
  convergenceThreshold: 1e-6,  // L1 norm stopping criterion
  costWeight: 0.2,      // Cost penalty weight in final utility
  preTrustedIds: new Set<string>(), // Pre-Trusted Peer set
};

/**
 * TrustFlow baseline config (Seliuchenko 2026, arXiv:2603.19452).
 * Reproduction of the paper's contraction-mapping reputation propagation with
 * topic-gated transfer operators, for a direct empirical comparison against
 * TRACE and EIGENTRUST under this codebase's adversarial attack suite.
 *
 * Parameters taken directly from the paper where stated (alpha, convergence
 * threshold, blind-edge discount). This simulation has no interaction-content
 * signal to derive real topic embeddings from, so every edge is treated as a
 * "blind edge" per the paper's own terminology, using the paper's own
 * documented fallback (mean-of-profile-embedding proxy, 0.3x discount) rather
 * than an invented shortcut. See computeTrustFlowScores in trustGraph.ts.
 */
export const TRUSTFLOW_CONFIG = {
  alpha: 0.85,               // Damping/propagation weight (paper's stated default)
  embeddingDim: 8,            // Profile/topic embedding dimensionality
  blindEdgeDiscount: 0.3,     // Paper's stated discount for blind (no-content) edges
  convergenceThreshold: 1e-4, // Paper's stated epsilon (L2 residual)
  maxIterations: 80,          // Safety cap; alpha=0.85 contracts to 1e-4 by ~57 iters
  costWeight: 0.2,            // Cost-blend weight in final utility (same as EIGENTRUST,
                               // for a fair comparison — TrustFlow itself is a pure
                               // ranking system with no native cost term)
};

// ─── TRACE Hardening Constants ────────────────────────────────────────────────
/** TRACE hardening constants for fraud exposure reduction.
 * These parameters control post-fraud cooldown, graph feature capping,
 * and penalty scaling to minimize fraud exposure at large N.
 * - cooldownRounds: number of rounds after a default where provider is suppressed
 * - cooldownMultiplier: utility multiplier during cooldown (soft exclusion, not hard ban)
 * - adjustedTrustCap: maximum value for adjustedTrust (ensures graph features are non-boosting)
 * - penaltyLogBase: denominator for logarithmic penalty scaling formula
 */
export const TRACE_HARDENING = {
  cooldownRounds: 5,           // Post-fraud cooldown duration (rounds)
  cooldownMultiplier: 0.01,    // Utility multiplier during cooldown (near-zero but not excluded)
  adjustedTrustCap: 0.5,       // Non-boosting cap on graph features
  penaltyLogBase: 100,         // Denominator for log2 penalty scaling: 1 + log2(max(1, N/penaltyLogBase))
} as const;

// ─── Spectral Gap Anomaly Detection ──────────────────────────────────────────
/**
 * Spectral gap detection for collusion ring suppression.
 *
 * Theoretical basis: A sparse directed cycle of length k has eigenvalues
 * equal to the k-th roots of unity — all with magnitude exactly 1. The
 * second-largest eigenvalue |λ₂| of the row-stochastic submatrix restricted
 * to an SCC is therefore ≈ 1 for ring topologies, while legitimate trust
 * clusters exhibit hierarchical eigenvalue decay (|λ₂| ≈ 0.3–0.6).
 *
 * Citations:
 *   - Chung (1997) "Spectral Graph Theory" — |λ₂| ≈ 1 indicates bottleneck
 *   - Kamvar et al. (2003) §4.2 — EigenTrust convergence governed by |λ₂|
 *   - Andersen et al. (2006) — spectral gap for Sybil detection
 *
 * Parameters:
 *   - threshold: |λ₂| above this triggers attenuation (0.85 provides massive
 *     separation from honest clusters which have |λ₂| < 0.6)
 *   - gamma: exponent for attenuation formula: (1 - |λ₂|)^γ
 *   - minSCCSize: minimum SCC size to run spectral analysis (avoids noise on tiny SCCs)
 *   - maxIterations: power iteration cap for λ₂ computation
 *   - convergenceThreshold: stopping criterion for power iteration
 */
export const SPECTRAL_GAP_CONFIG = {
  threshold: 0.85,             // |λ₂| above this → ring-like structure
  gamma: 3,                    // Attenuation exponent: (1 - |λ₂|)^γ
  minSCCSize: 3,              // Minimum SCC size for spectral analysis
  maxIterations: 30,          // Power iteration cap for deflated λ₂
  convergenceThreshold: 1e-4, // L1 norm stopping criterion
  // v4.3: Lowered participation threshold from 0.5 to 0.3.
  //
  // Problem: The collusion ring's 30% honest-interleaving (R-ATTACK-RING 2)
  // creates edges from ring members to random honest agents. This dilutes
  // the "internal edge fraction" below 0.5 for ring members who also
  // accumulate natural co-job edges from being routed. Result: spectral
  // gap detection fires on the SCC but the per-node penalty is not applied
  // because participation < 0.5.
  //
  // Fix: Lower the threshold to 0.3. Theoretical justification:
  //   - In a random graph G(N, p), the expected fraction of a node's edges
  //     that fall within any subset S of size k is k/N (uniform distribution).
  //   - At N=1000 with a ring of k=20, the expected internal fraction for
  //     a node with NO ring affiliation is 20/1000 = 0.02.
  //   - A threshold of 0.3 is 15× the random baseline, providing massive
  //     separation between ring members (participation ≈ 0.4-0.7) and
  //     innocent bystanders (participation ≈ 0.02).
  //   - The previous threshold of 0.5 was overly conservative: it required
  //     MORE than half of all edges to be internal, which fails when the
  //     ring deliberately creates external edges (honest-interleaving).
  //
  // Citation: Leskovec et al. (2010) "Empirical analysis of network
  // community structure" — community membership is typically identified
  // at internal density > 2× random baseline, not > 50%.
  //
  // False positive analysis: An honest agent with 100 total edges would
  // need 30+ edges to ring members to trigger. At N=1000 with 20 ring
  // members, the probability of 30+ edges to ring members by chance is
  // Binomial(100, 20/1000) → P(X≥30) ≈ 0 (expected value = 2).
  participationThreshold: 0.3,
} as const;

// ─── R-GHOST: Experimental-feature flags (design §3.4, Task 5.1) ─────────────
/**
 * Experimental-feature flags for the temporal-trust and causal-graph
 * subsystems.
 *
 * Both modules are wired into the TRACE scoring pipeline (call sites in
 * `computeTraceUtility` and runner snapshots) but their numeric impact at
 * N=1000 is suspect. Task 5.3 runs a 48-cell ablation matrix
 * (`scripts/runGhostAudit.ts`, design §3.1) to determine whether either
 * module's marginal contribution to `Fraud_Exposure` / `Malicious_Routing_Rate`
 * exceeds the per-cell `Noise_Floor` (R-GHOST 3, design §3.2). If it does
 * not, the module is classified as a `Ghost_Module` per the glossary and
 * remains gated behind this flag.
 *
 * Publication_Preset default (R-GHOST 4): both flags are FALSE. The published
 * TRACE preset does NOT consume `temporalTrust` or `causalGraph` signals
 * unless the audit's ablation evidence (Task 5.3) demonstrates they exceed
 * `Noise_Floor` for at least one attack at the audited N. R-GHOST 6 then
 * requires that, while a flag is `false`, scoring output is bit-equal
 * within `1e-9` to a build with the call sites removed (Property P5,
 * design §3.5).
 *
 * Mutability contract: `let`-style mutation via `applyGhostModuleFlags(...)`
 * is supported so the ablation harness (Task 5.3) and the experiment runner
 * can toggle each flag per-cell. Do NOT change the binding to `const`-with-
 * `as const` literal types — that breaks the ablation contract.
 *
 * The actual call-site gating in `computeTraceUtility` and runner snapshots
 * is implemented in Task 5.2; Task 5.1 introduces only the flags themselves
 * and the matching `EMPTY_TEMPORAL_PROFILE` identity constant in
 * `temporalTrust.ts`.
 */
export const GHOST_MODULE_FLAGS: {
  TEMPORAL_ENABLED: boolean;
  CAUSAL_ENABLED: boolean;
} = {
  TEMPORAL_ENABLED: false,
  CAUSAL_ENABLED: false,
};

/**
 * Mutate `GHOST_MODULE_FLAGS` in place from a partial flag set and return
 * the new flag state. Used by the ablation harness (Task 5.3,
 * `scripts/runGhostAudit.ts`) and by the experiment runner when a cell
 * specifies a non-default ghost-module configuration. Partial updates are
 * supported (omitted keys retain their current value).
 *
 * Defense-in-depth: this mutator also mirrors the flag values onto each
 * engine's internal `enabled` config (`TEMPORAL_CONFIG.enabled`,
 * `CAUSAL_CONFIG.enabled`) so the engines themselves no-op while a flag is
 * `false`. The call-site bypass in `traceRouter.ts::computeTraceUtility`
 * (Task 5.2) is the primary contract — it discharges R-GHOST 6 directly
 * by routing every consumer through an identity value (`1.0` for the
 * causal multiplier; `EMPTY_TEMPORAL_PROFILE` plus `0` for the temporal
 * arm) — but mirroring onto the engine configs is cheap and guarantees
 * that any path which still reaches the engines (e.g. legacy snapshots,
 * test-only call sites, or `getReputationInertia`) also short-circuits.
 *
 * Flag-state contract for the Publication_Preset (R-GHOST 4): the literal
 * values declared on `GHOST_MODULE_FLAGS` are the contract — both default
 * to `false`. The runner (Task 14.x / 15.x) is responsible for invoking
 * `applyGhostModuleFlags(...)` to materialise that contract onto the
 * engine configs. Module-init does NOT auto-apply the defaults: callers
 * that want the engines to keep their historical `enabled: true` defaults
 * (e.g. ablation cells that turn the modules ON for comparison) can
 * simply omit the call entirely. To pin the Publication_Preset state
 * across the engines, the caller invokes
 * `applyGhostModuleFlags({ TEMPORAL_ENABLED: false, CAUSAL_ENABLED: false })`
 * once at run start.
 *
 * The `require()` calls below are the documented escape hatch for the
 * `temporalTrust` / `causalGraph` ⇄ `config` import cycle (matching the
 * existing pattern in `snapshotConfig`). The `try/catch` guards against
 * test contexts where the engine modules are unavailable; in that case
 * the literal flags on `GHOST_MODULE_FLAGS` are still mutated, so the
 * call-site bypass in `computeTraceUtility` continues to work.
 */
export function applyGhostModuleFlags(
  partial: Partial<typeof GHOST_MODULE_FLAGS> = {},
): typeof GHOST_MODULE_FLAGS {
  if (partial.TEMPORAL_ENABLED !== undefined) {
    GHOST_MODULE_FLAGS.TEMPORAL_ENABLED = partial.TEMPORAL_ENABLED;
  }
  if (partial.CAUSAL_ENABLED !== undefined) {
    GHOST_MODULE_FLAGS.CAUSAL_ENABLED = partial.CAUSAL_ENABLED;
  }

  // Mirror onto engine-internal `enabled` flags (Task 5.2, design §3.4).
  // The `as { enabled: boolean }` cast is the same `as any`-style escape
  // hatch used elsewhere in this file (see `applyTraceRoutingPreset`'s
  // mutation of `PROGRESSIVE_TRUST.minJobsForFullAccess`); the engine
  // configs are declared `as const` for documentation but are intended to
  // be runtime-mutable for ablation.
  /* eslint-disable @typescript-eslint/no-require-imports -- runtime require breaks the engine ⇄ config import cycle. */
  try {
    const { TEMPORAL_CONFIG } = require("./temporalTrust");
    const { CAUSAL_CONFIG } = require("./causalGraph");
    (TEMPORAL_CONFIG as { enabled: boolean }).enabled = GHOST_MODULE_FLAGS.TEMPORAL_ENABLED;
    (CAUSAL_CONFIG as { enabled: boolean }).enabled = GHOST_MODULE_FLAGS.CAUSAL_ENABLED;
  } catch {
    // Engine modules not loadable in some test contexts — the literal
    // flags on `GHOST_MODULE_FLAGS` are still mutated above, so the
    // call-site bypass in `computeTraceUtility` continues to operate.
  }
  /* eslint-enable @typescript-eslint/no-require-imports */

  return GHOST_MODULE_FLAGS;
}

// ─── WWW v2: Mechanism Feature Flags ─────────────────────────────────────────
/**
 * Feature flags for the four TRACE-v2 mechanisms (WWW 2027).
 *
 * Each flag gates a distinct v2 contribution. When all four are false,
 * TRACE behavior is bit-identical to v1 (the CIKM submission). The runner
 * and ablation harness can toggle flags per-cell via `applyV2Flags(...)`.
 *
 * DR — Distribution-Robust adaptive thresholds (addresses dense-graph gate)
 * CR — Community-Refined sybil detection (addresses OTC sybil regression)
 * XS — Exploration-Scaled risk-conditioned Thompson (addresses behavioral cost)
 * LG — L402 Gossip verifiable evidence sharing (addresses partitioned-view)
 */
export const V2_FLAGS: {
  DR_ENABLED: boolean;  // Distribution-Robust adaptive thresholds
  CR_ENABLED: boolean;  // Community-Refined sybil detection
  XS_ENABLED: boolean;  // Exploration-Scaled risk-conditioned Thompson
  LG_ENABLED: boolean;  // L402 Gossip evidence sharing
  GG_ENABLED: boolean;  // Gap-Gated Thompson (explore only when tied)
  PT_ENABLED: boolean;  // Pessimistic Thompson (penalize high-sybilRisk samples)
} = {
  DR_ENABLED: false,
  CR_ENABLED: false,
  XS_ENABLED: false,
  LG_ENABLED: false,
  GG_ENABLED: false,
  PT_ENABLED: false,
};

/**
 * Mutate V2_FLAGS in place. Follows the same pattern as `applyGhostModuleFlags`.
 */
export function applyV2Flags(
  partial: Partial<typeof V2_FLAGS> = {},
): typeof V2_FLAGS {
  for (const key of Object.keys(partial) as Array<keyof typeof V2_FLAGS>) {
    if (partial[key] !== undefined) V2_FLAGS[key] = partial[key]!;
  }
  return V2_FLAGS;
}

// ─── Cold Start / Progressive Trust ──────────────────────────────────────────
export const COLD_START = {
  maxJobsForBonus:      5,
  explorationBonus:     30,    // v2: reduced from 50 (less free trust for new agents)
  maxExposureSats:      30,    // v2: reduced from 50 (tighter exposure caps)
} as const;

// v2: Progressive Trust Unlocking — limits how much routing a new agent gets
export const PROGRESSIVE_TRUST = {
  minJobsForFullAccess: 10,    // Must complete 10 jobs before full routing access
  accessScalePerJob:    0.10,  // Each job unlocks 10% more routing access
  stakeBoostMultiplier: 1.5,   // Staked agents unlock 50% faster
} as const;

// v2.5: Score deltas are replaced by volume-weighted recomputation for economic realism.
// These values are preserved for backward compatibility in event logging.
export const SCORE_DELTAS = {
  JOB_SUCCESS:      +30,
  JOB_FAILURE:      -50,
  ESCROW_RELEASED:  +20,
  ESCROW_REFUNDED:  -30,
  DISPUTE:          -60,
  DEFAULT:          -100,
  STAKE_ADDED:      +15,
  STAKE_SLASHED:    -80,
  PAYMENT_SETTLED:  +10,
  HUMAN_VERIFIED:   +5,
} as const;

// ─── v2/v2.1: Trust Graph Validation ──────────────────────────────────────────
export const TRUST_GRAPH_VALIDATION = {
  // Trust saturation cap: networkTrust cannot exceed this via any mechanism
  maxNetworkTrust: 0.8,

  // Edge diversity: minimum unique counterparties for full trust benefit
  minDiverseEdges: 3,

  // Same-cluster suppression: reduce trust gain when interactions are within a dense cluster
  clusterInteractionPenalty: 0.5,

  // Circular trust detection: A→B→C→A patterns
  circularPenaltyPerCycle: 0.15,
  maxCircularPenalty: 0.6,

  // Edge weight saturation: diminishing returns on repeated interactions.
  //
  // FLOOR-ONLY (Task 2.3, R-SCALE rewire — trace-adversarial-coevolution audit):
  // live consumers MUST read this value via `edgeWeightCap(N)` from
  // `adaptiveConfig.ts`, which evaluates `max(5, log2(N))` against the live
  // network size N. The static `5.0` here is preserved as the floor only —
  // `edgeWeightCap(32) = 5.0` matches it exactly — and is no longer read
  // directly in any scoring / trust-graph code path.
  edgeWeightCap: 5.0,
} as const;

// ─── v2.1: Counterparty Diversity Engine ──────────────────────────────────────
export const COUNTERPARTY_DIVERSITY = {
  // Entropy: H = -Σ pᵢ·log₂(pᵢ) — higher = more diverse
  // For N equally distributed counterparties: H = log₂(N)
  // 2 counterparties max entropy: 1.0, 4: 2.0, 8: 3.0
  //
  // FLOOR-ONLY (Task 2.3, R-SCALE rewire — trace-adversarial-coevolution audit):
  // live consumers MUST read this value via `minEntropyForFullTrust(N)` from
  // `adaptiveConfig.ts`, which evaluates `max(1.5, log2(N))` against the live
  // network size N. The static `1.5` here is preserved as the floor only and
  // is no longer read directly by any live scoring / trust-graph consumer.
  minEntropyForFullTrust: 1.5,    // ~3 diverse counterparties needed for full trust
  entropyPenaltyWeight: 0.3,      // How much low entropy dampens trust

  // diversityScore = clamp(entropy / minEntropyForFullTrust, 0, 1)
  // AdjustedTrust = networkTrust × diversityScore
} as const;

/** Simulation: retain only the last N rounds of co-job interactions for entropy (scales to large N). */
export const INTERACTION_HISTORY_WINDOW = {
  maxRounds: 200,
} as const;

// ─── v2.1: Repeated-Pair Suppression ──────────────────────────────────────────
export const REPEATED_PAIR = {
  // Trust gain decays exponentially with repeated interactions:
  //   trustGain *= exp(-interactionCount / decayConstant)
  decayConstant: 3.0,            // After 3 interactions, gain is ~37% of original
                                  // After 6 interactions, gain is ~14%
                                  // After 9 interactions, gain is ~5%

  // Maximum trust contribution from any single counterparty pair
  maxSinglePairContribution: 0.15, // No single pair can contribute > 15% of total trust
} as const;

// ─── v2.1: Economic Volume Weighting ──────────────────────────────────────────
export const ECONOMIC_VOLUME_WEIGHTING = {
  // Minimum volume for full trust gain (below this, trust gain is dampened)
  minVolumeForFullWeight: 20,     // 20 sats minimum for meaningful trust

  // Trust gain multiplier: log₂(1 + volume / minVolume) capped at 1.0
  // This means tiny fake transactions (1-5 sats) contribute very little trust
} as const;

// ─── v2: Economic Event Validation ────────────────────────────────────────────
export const EVENT_VALIDATION = {
  // Require job existence for trust-affecting events
  requireJobForTrustUpdate: true,

  // Suppress duplicate events within this window
  deduplicationWindowMs: 5000, // 5 seconds

  // Event authenticity weighting: scale trust gains by event quality
  weightByPaymentSize: true,   // Larger payments = more trust contribution
  weightByDiversity: true,     // Diverse counterparties = more trust
  maxEventsPerProviderPerRound: 10, // Anti-spam: cap events per round
} as const;

// ─── Temporal Trust Decay ─────────────────────────────────────────────────────
export const TRUST_DECAY = {
  halfLifeMs: 5 * 24 * 60 * 60 * 1000, // v2: 5 days (was 7) — faster decay
  inactivityPenaltyMs: 3 * 24 * 60 * 60 * 1000, // v2: NEW — 3 days without activity → penalty
  inactivityPenaltyRate: 0.1, // 10% trust reduction per inactivity period
} as const;

// ─── v2: Volatility Penalties ─────────────────────────────────────────────────
export const VOLATILITY = {
  // Highly volatile providers lose routing priority
  maxAcceptableVolatility: 80,  // Score stddev
  volatilityPenaltyWeight: 0.15, // Applied to utility function
} as const;

// ─── Experiment Registry ──────────────────────────────────────────────────────
export type RoutingPolicy = "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST" | "TRUSTFLOW";

/**
 * Snapshot the entire v2 config for experiment reproducibility.
 */
export function snapshotConfig() {
  /* eslint-disable @typescript-eslint/no-require-imports -- runtime require breaks import cycle (adaptiveConfig → config). */
  const { ADAPTIVE_SCALING } = require("./adaptiveConfig");
  const { CAUSAL_CONFIG } = require("./causalGraph");
  const { TEMPORAL_CONFIG } = require("./temporalTrust");
  /* eslint-enable @typescript-eslint/no-require-imports */

  return {
    version: "v4.3",
    traceWeights: { ...TRACE_WEIGHTS },
    riskTiers: { ...RISK_TIERS },
    defaultProbWeights: { ...DEFAULT_PROB_WEIGHTS },
    recentFailure: { ...RECENT_FAILURE },
    routingUtility: { ...ROUTING_UTILITY },
    traceRoutingPresets: { ...TRACE_ROUTING_PRESETS },
    routingConstraints: { ...ROUTING_CONSTRAINTS },
    explorationConfig: { ...EXPLORATION_CONFIG },
    // R-GHOST 4 / R-INTEGRITY: snapshot the live ghost-module flag state so
    // any reproducer can replay the cell with the same gating in effect. The
    // flag's existence in the snapshot is intentional and required — the
    // runner snapshot path MUST emit the current boolean for both arms even
    // when both are `false` (the Publication_Preset default), because
    // reproducibility (R-VERIFY-INTEGRITY) demands the snapshot record the
    // state, not hide it.
    ghostModuleFlags: { ...GHOST_MODULE_FLAGS },
    coldStart: { ...COLD_START },
    progressiveTrust: { ...PROGRESSIVE_TRUST },
    scoreDeltas: { ...SCORE_DELTAS },
    trustGraphValidation: { ...TRUST_GRAPH_VALIDATION },
    spectralGapConfig: { ...SPECTRAL_GAP_CONFIG },
    cusumSensitiveSuppression: { ...CUSUM_SENSITIVE_SUPPRESSION },
    counterpartyDiversity: { ...COUNTERPARTY_DIVERSITY },
    repeatedPair: { ...REPEATED_PAIR },
    economicVolumeWeighting: { ...ECONOMIC_VOLUME_WEIGHTING },
    eventValidation: { ...EVENT_VALIDATION },
    trustDecay: { ...TRUST_DECAY },
    volatility: { ...VOLATILITY },
    adaptiveScaling: { ...ADAPTIVE_SCALING },
    causalConfig: { ...CAUSAL_CONFIG },
    temporalConfig: { ...TEMPORAL_CONFIG },
    snapshotAt: new Date().toISOString(),
    v2Flags: { ...V2_FLAGS },
  };
}
