/**
 * TRACE v2.3 Router — Temporal-Causal Trust Evolution
 *
 * v2.3 changes:
 *   - Temporal risk penalty (trust velocity, acceleration, entropy trajectory)
 *   - Reciprocal amplification detection in utility
 *   - Diversity maturity weighting (organic vs artificial diversification)
 *   - Economic depth bonus (mature agents get routing preference)
 *
 * v2.2 features (maintained):
 *   - Scale-aware penalty scaling, confidence-gated entropy
 *   - Causal penalty multiplier (root-cause vs collateral)
 *
 * v2.1/v2 features (maintained):
 *   - Sybil-dampened network trust, clique penalty
 *   - Volatility penalty, progressive trust unlocking
 */

import { prisma } from "../db";
import type { Provider } from "@prisma/client";
import {
  ROUTING_UTILITY,
  ROUTING_CONSTRAINTS,
  PROGRESSIVE_TRUST,
  VOLATILITY,
  TRACE_MAX_SCORE,
  EXPLORATION_CONFIG,
  EIGENTRUST_CONFIG,
  TRUSTFLOW_CONFIG,
  GHOST_MODULE_FLAGS,
  TRACE_HARDENING,
  CUSUM_SENSITIVE_SUPPRESSION,
  V2_FLAGS,
  type RoutingPolicy,
} from "./config";
import {
  computeCounterpartyEntropy,
  computePersonalizedPageRank,
  computeWeightedEntropy,
  computeNeighborhoodContamination,
  buildEdgeCache,
  buildLocalTrustMatrix,
  computeTrustFlowScores,
  type EdgeCache,
} from "./trustGraph";
import { computeBayesianLCB, CUSUM_H, CUSUM_H_SENSITIVE } from "./traceScore";
import {
  computeScaleFactor,
  effectiveCliquePenalty,
  effectiveSybilPenalty,
  computeEntropyConfidence,
  computeRequiredEntropy,
} from "./adaptiveConfig";
import { causalGraph } from "./causalGraph";
import { temporalEngine, EMPTY_TEMPORAL_PROFILE } from "./temporalTrust";
import { velocityEngine } from "./scoreVelocity";
import { logEvent } from "../events";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CandidateScore {
  providerId: string;
  providerName: string;
  utility: number;
  rejected: boolean;
  reason?: string;
  breakdown: {
    traceContribution: number;
    defaultPenalty: number;
    costPenalty: number;
    networkBonus: number;
    sybilPenalty: number;
    cliquePenalty: number;
    causalSuspicion: number;
    temporalRiskPenalty: number;
    reciprocalRisk: number;
    volatilityPenalty: number;
    velocityAnomaly: number;
    capabilityBonus: number;
    coldStartBonus: number;
    progressiveTrustCap: number;
    diversityScore: number;
    diversityMaturity: number;
    economicDepth: number;
    entropyConfidence: number;
    scaleFactor: number;
    causalMultiplier: number;
    behavioralAnomalyPenalty: number;
    perfectionPenalty: number;
    neighborhoodContaminationPenalty: number;
  };
}

export interface RoutingResult {
  provider: Provider;
  utility: number;
  candidates: CandidateScore[];
  policy: RoutingPolicy;
  selectionMode: "utility" | "exploration" | "fallback";
  epsilon: number;
}

export interface RoutingExplorationOptions {
  enabled?: boolean;
  round?: number;
  /**
   * RNG slot used by the **exploit** branch of `selectWinnerWithExploration`
   * (Thompson Beta-sampling for TRACE) and by the per-call provider shuffle
   * in `selectProviderTRACE`. Existing seeded TRACE runs continue to use this
   * slot for Thompson reads, so bit-equality of historical seeded outputs is
   * preserved (R-INTEGRITY).
   */
  random?: () => number;
  /**
   * R-EXPLORE 4 (Task 4.3, design §5.3): RNG slot used **exclusively** by the
   * exploration arm of `selectWinnerWithExploration` — namely the ε
   * coin-flip and the subsequent uniform-pick over the eligible set.
   *
   * Decoupling this slot from `random` (which drives Thompson Beta sampling
   * and shuffle) is what makes the cell-level parity assertion in Property
   * P6 hold: TRACE consumes Thompson Beta draws from `random`, the three
   * baselines do not, so a single shared RNG would produce divergent
   * exploration draw sequences across policies. Routing the exploration
   * arm through its own slot eliminates that coupling.
   *
   * **Caller contract — cell-level parity invariant (R-EXPLORE 4 /
   * R-VERIFY-INTEGRITY 3-4 / Property P6).** When `exploreRandom` is
   * supplied, the caller MUST pass the **same function instance** (i.e.
   * the same RNG closure, sharing internal state) to all four
   * `selectProviderTRACE` invocations — `{TRACE, REPUTATION, PRICE,
   * EIGENTRUST}` — that constitute a single experiment cell at a
   * fixed seed. This is the runner harness's responsibility (Task 4.4
   * wires it up via `buildCellRngs`); the wrapper itself does no
   * cloning. Sharing a single instance is what guarantees the four
   * policies observe a bit-identical sequence of `{ε flip, uniform-pick
   * index}` draws, which is the property the Task 4.4 parity assertion
   * verifies via `exploreDrawHash`.
   *
   * Reusing the same RNG across multiple **cells** (different seeds) is a
   * caller bug — each cell must start from a fresh seed so per-cell RNG
   * isolation (R-VERIFY-INTEGRITY 4) holds. The wrapper cannot detect
   * this; it is enforced upstream by the seed-log integrity assertions.
   *
   * Backward compatibility: when this slot is omitted the wrapper falls
   * back to `random ?? Math.random`, matching pre-4.3 behaviour exactly
   * (single shared slot for both exploration and Thompson reads). Existing
   * seeded callers that pass only `{ random: rng }` reproduce identical
   * winners, in identical selection modes, with identical ε values.
   */
  exploreRandom?: () => number;
  /**
   * Risk-sensitive exploration (Task 5.1, design §5.1 / Requirement 2.3):
   * The value (in sats) of the job being routed. When provided alongside
   * `medianPrice`, and `EXPLORATION_CONFIG.riskSensitive` is true, the
   * exploration epsilon is reduced for high-value jobs:
   *
   *   ε_risk = ε_base × min(1, medianPrice / jobValue)
   *
   * For jobs at or below median price, ε is unchanged. For jobs above
   * median price, ε is proportionally reduced — limiting exploration
   * exposure on high-value routing decisions.
   *
   * When omitted, risk-sensitive adjustment is skipped and ε_base is used
   * directly (backward-compatible with pre-5.1 callers).
   */
  jobValue?: number;
  /**
   * Risk-sensitive exploration (Task 5.1): The median price (in sats) for
   * the capability being routed. Used together with `jobValue` to compute
   * the risk-sensitive epsilon adjustment. Typically derived from the
   * per-capability median of active provider prices.
   *
   * When omitted, risk-sensitive adjustment is skipped.
   */
  medianPrice?: number;
  /** v4.0: Ablation config — selectively disable TRACE subsystems */
  ablation?: {
    disablePPR?: boolean;
    disableBayesianLCB?: boolean;
    disableWeightedEntropy?: boolean;
    disableCUSUM?: boolean;
    disableThompsonSampling?: boolean;
    disableAllGraph?: boolean;
    useCleanVariant?: boolean;
    /**
     * v5.0 / Proposal 1 (SFSC — Selection-Frequency Soft Cap).
     *
     * When enabled together with `disableThompsonSampling`, the no-bandit
     * greedy branch demotes `eligible[0]` to `eligible[1]` whenever
     * `eligible[0]` has been selected at least `selectionFreqCapMax` times
     * in the last `selectionFreqCapWindow` routing calls (default: 4 of 20).
     *
     * Motivation: proportional-fairness scheduling (Kelly et al. 1998).
     * The cap is a soft demotion, never a permanent ban; it recovers as
     * the window slides. Selection stays inside the post-filter eligible
     * set so fraud-defense (which lives in the trace-score filter) is
     * unchanged by construction.
     *
     * Has no effect unless `disableThompsonSampling` is also true.
     *
     * Caller MUST call `resetRoutingWindowTracker()` between cells so the
     * window state does not leak across experiments.
     *
     * See `paper/newfindings/Trace_NoBandit.md` §13 Proposal 1.
     */
    enableSelectionFreqCap?: boolean;
    /** Max selections of any single provider within the window. Default 4. */
    selectionFreqCapMax?: number;
    /** Sliding-window size in routing calls. Default 20 (matches ROUTING_WINDOW_K). */
    selectionFreqCapWindow?: number;
    /**
     * v5.1 / Proposal 2 (Gap-Gated Thompson Sampling — GGTS).
     *
     * When enabled on TRACE (and `disableThompsonSampling` is false),
     * Thompson sampling is invoked only when the routing decision is
     * genuinely uncertain — i.e. when the utility gap between the top two
     * eligible candidates is small relative to the within-cohort spread.
     *
     * Decision rule (per routing call, after the outer ε-greedy branch):
     *
     *   gap   = eligible[0].utility − eligible[1].utility
     *   sigma = std(utility | eligible)
     *
     *   if   eligible.length < 2                 → greedy (no second
     *                                              candidate to compare)
     *   else if sigma === 0                      → Thompson (genuinely
     *                                              uncertain, all utilities
     *                                              tied)
     *   else if gap > gapGateThresholdSigma * σ  → greedy (top candidate
     *                                              is decisively better)
     *   else                                     → Thompson (uncertain
     *                                              between top candidates)
     *
     * Motivation: gap-dependent regret bounds (Lai-Robbins 1985, Auer et
     * al. 2002, Bubeck & Cesa-Bianchi 2012). When the empirical gap is
     * large relative to noise, the cost of exploration exceeds the
     * information gain. When it is small, exploration is justified.
     *
     * Effect on existing variants:
     *   - TRACE-full (no ablation): unchanged.
     *   - TRACE-no-bandit (`disableThompsonSampling`): unchanged.
     *   - TRACE-gap-gated (this flag): a third variant that interpolates
     *     between the two by paying the exploration cost only when the
     *     proven candidate is not decisively ahead.
     *
     * Selection stays inside the post-filter eligible set in both the
     * greedy branch and the Thompson branch, so fraud-defense (which
     * lives in the trace-score filter) is unchanged by construction.
     *
     * Compatibility:
     *   - Mutually exclusive with `disableThompsonSampling` — if both
     *     are true, GGTS is silently ignored (no-bandit takes precedence
     *     because GGTS's branches both end at exploit-branch behavior
     *     that no-bandit already implements).
     *   - Independent of `enableSelectionFreqCap` — the two can compose
     *     but are not designed to (SFSC is no-bandit-only).
     *
     * Reproducibility note: enabling this flag changes the Beta draw
     * sequence consumed from `exploitRand` (Thompson is invoked on a
     * subset of routing calls), so seeded TRACE runs with this flag on
     * are NOT bit-identical to seeded runs with the flag off. This is
     * by design — GGTS is a new exploit-branch policy, not a passthrough.
     */
    gapGatedThompson?: boolean;
    /**
     * Threshold τ in units of within-cohort utility std for the GGTS
     * gate (above). Default 0.5 (explore when the top-vs-runner-up gap
     * is smaller than half a std of the eligible utilities). Larger
     * values explore more often (gate fires less); smaller values
     * approach pure greedy. No effect unless `gapGatedThompson` is true.
     */
    gapGateThresholdSigma?: number;
    /**
     * TRACE-GGR: winsorize each eligible candidate's utility to
     * [median − κ·MAD, median + κ·MAD] before computing gap/σ for the
     * GGTS gate above. No effect unless `gapGatedThompson` is also true.
     *
     * Motivation: the raw gate is vulnerable to a small colluding cluster
     * inflating its own utility. gap = eligible[0] − eligible[1] grows
     * linearly in the manipulation δ, while population σ (computed over
     * the whole cohort, including the manipulated candidate) only grows
     * like δ/√n — so for a cohort of n candidates, gap/σ ~ √n · (a
     * constant), which clears ANY fixed τ once δ is large enough,
     * regardless of τ. This is a real vulnerability, not a tuning problem
     * (confirmed against regime_matrix_N1000_noCR_tau0.5only_partial73.jsonl:
     * gap-gated loses to the better of full/no-bandit on every sparse-
     * density attack×mode combination, most severely on collusion-ring,
     * which manufactures exactly this kind of inflated top candidate).
     *
     * Median and MAD (median absolute deviation) have a 50% breakdown
     * point — up to just under half the cohort can be arbitrarily
     * corrupted before either statistic is meaningfully displaced — versus
     * 0% for mean/stdev, where a SINGLE unbounded outlier can move the
     * estimate arbitrarily far. Capping each candidate's utility at
     * median + κ·MAD before computing gap/σ bounds how far a manipulated
     * candidate (including a manipulated top-1) can move either quantity,
     * independent of how large the raw manipulation actually is.
     *
     * top-1/top-2 selection for ROUTING (which candidate wins) still uses
     * raw utility rank — only the VALUES fed into the gap/σ decision are
     * clipped. Citation: Huber (1964) — robust statistics under bounded
     * contamination.
     */
    gapGateRobust?: boolean;
    /**
     * κ (kappa): winsorization width in units of MAD. Default 3.0.
     * No effect unless `gapGateRobust` is also true.
     */
    gapGateRobustKappa?: number;
    /**
     * External-family baseline: corruption-robust successive elimination
     * with a corruption-widened confidence radius, in the spirit of
     * Gupta-Koren-Talwar (COLT 2019, "BARBAR") and Lykouris-Mirrokni-Paes
     * Leme (STOC 2018) — NOT a byte-exact reproduction of BARBAR's specific
     * phase schedule (that requires working from the primary source's exact
     * algorithm box), but a faithful representative of the core technique
     * this literature is built on: widen each arm's confidence interval by
     * an additive term proportional to the corruption budget C, so a
     * bounded number of corrupted outcomes (which can shift an empirical
     * mean by at most O(C/n)) cannot cause the true best arm to be wrongly
     * eliminated. Existing raw empirical means (successfulJobs/totalJobs)
     * are used directly — TRACE stores aggregate counts, not a raw
     * per-observation sequence, so a true median-of-means (which needs
     * observation-level bucket splitting) is not implementable without a
     * larger data-model change; the corruption-inflated-radius mechanism
     * below is the piece of this literature's toolkit that composes cleanly
     * with TRACE's existing aggregate stats.
     *
     * Selection rule per round: eliminate any eligible candidate whose
     * upper confidence bound falls below another candidate's lower bound;
     * select uniformly at random among the surviving (non-eliminated) set
     * (standard successive-elimination exploration — naturally converges to
     * greedy once elimination narrows the active set to one candidate).
     * Independent of `gapGatedThompson`/`gapGateRobust` — this replaces the
     * Thompson-sampling exploit branch entirely, it does not gate it.
     */
    corruptionRobustUCB?: boolean;
    /**
     * C, the corruption budget, as an additive confidence-radius inflation
     * (matching the Gupta-Koren-Talwar additive form). Operationalized via
     * TRACE's own adversary contract: default 0.3, matching the
     * `maliciousRatio` used throughout this experiment suite (not wired to
     * the live per-run `maliciousRatio` value — a scaffolding
     * simplification; see plans/ICLR.md §4 for the follow-up to make this
     * dynamic). No effect unless `corruptionRobustUCB` is also true.
     */
    corruptionBudgetFraction?: number;
  };
}

// ─── R-EXPLORE: Principled exploration epsilon schedule (design §5.1) ─────────

/**
 * Decaying exploration probability for epsilon-greedy selection.
 *
 *   ε(t, n_i) = clamp(c / √(t + n_i), εmin, εmax)
 *
 * where `t` is the global round count and `n_i` is the per-agent evidence
 * volume (e.g. `provider.totalJobs`). The O(1/√(t + n_i)) decay rate matches
 * the regret-optimal bandit family (design §5.1).
 *
 * Stability invariants (R-STABILITY):
 *   - When `round + agentEvidence === 0`, the formula would divide by zero;
 *     this function returns `epsilonMax` instead (the maximum exploration
 *     pressure when no evidence has accrued).
 *   - The result is always finite and clamped to `[epsilonMin, epsilonMax]`.
 *   - Negative or non-finite inputs are coerced to a safe range so the
 *     function is total over all numeric inputs.
 *
 * Note (Task 4.1): this function is exported but not yet wired into the
 * selection path — that wiring is deferred to Task 4.2 / 4.3.
 */
export function computeEpsilon(
  round: number,
  agentEvidence: number,
  cfg: typeof EXPLORATION_CONFIG = EXPLORATION_CONFIG,
  jobValue?: number,
  medianPrice?: number,
): number {
  const safeRound = Number.isFinite(round) ? Math.max(0, round) : 0;
  const safeEvidence = Number.isFinite(agentEvidence) ? Math.max(0, agentEvidence) : 0;
  const denominator = safeRound + safeEvidence;

  let epsilon: number;
  if (denominator <= 0) {
    epsilon = cfg.epsilonMax;
  } else {
    const raw = cfg.c / Math.sqrt(denominator);
    if (!Number.isFinite(raw)) {
      epsilon = cfg.epsilonMax;
    } else {
      epsilon = Math.min(cfg.epsilonMax, Math.max(cfg.epsilonMin, raw));
    }
  }

  // Risk-sensitive adjustment (Task 5.1, design §5.1 / Requirement 2.3):
  // For high-value jobs, reduce exploration probability proportionally.
  //   ε_risk = ε_base × min(1, medianPrice / jobValue)
  // Jobs at or below median price are unchanged; jobs above median get
  // proportionally reduced ε. This limits fraud exposure on high-value
  // routing decisions while preserving full exploration on typical jobs.
  if (cfg.riskSensitive && jobValue !== undefined && medianPrice !== undefined && jobValue > 0) {
    const riskFactor = Math.min(1, medianPrice / jobValue);
    epsilon *= riskFactor;
    // Re-clamp: allow epsilon to go below epsilonMin for very high-value
    // jobs (the risk factor can drive it toward zero), but floor at
    // epsilonMin × riskFactor to maintain proportional exploration.
    epsilon = Math.max(epsilon, cfg.epsilonMin * riskFactor);
  }

  return epsilon;
}

// ─── R-EXPLORE: Shared exploration wrapper (design §5.2 / §C.4) ───────────────

/**
 * Single exploration entry-point in the router (Task 4.2).
 *
 * Applies epsilon-greedy at the outer level — with probability
 * `ε(t, n) = clamp(c / √(t + n), εmin, εmax)` the winner is replaced by a
 * uniformly random pick from the eligible set — and policy-specific
 * exploitation otherwise:
 *   - `TRACE`: Thompson sampling over Beta(1+s, 3+f) posteriors weighted by
 *     `0.5 + 0.5 · max(0, utility)` (the existing TRACE selection logic,
 *     lifted from `selectProviderTRACE` unchanged so existing seeds reproduce
 *     the same Beta read order).
 *   - `REPUTATION` / `PRICE` / `EIGENTRUST`: greedy argmax — i.e.
 *     `eligible[0]`, since callers pre-sort the list by utility descending.
 *
 * The wrapper is **policy-agnostic** in its exploration arm: every policy
 * consumes the same exploration draws given the same RNG seed (R-EXPLORE 4 /
 * Property P6). It is the **only** exploration entry-point in the router —
 * no other selection path bypasses it.
 *
 * The baseline scoring functions (`computeReputationUtility`,
 * `computePriceUtility`, `computeEigenTrustUtility`) are NOT modified by
 * this wrapper; the wrapper applies AFTER scoring, on the sorted eligible
 * list (R-INTEGRITY 2, R-VERIFY-INTEGRITY 1).
 *
 * **Per-cell agent-evidence proxy.** `n` in the ε formula is the maximum
 * `totalJobs` across eligible providers — a global-maturity signal for the
 * routing cell. Per-agent evidence would yield a different ε for every
 * candidate, which is incoherent for a single coin-flip decision: the
 * coin-flip is over the cell, not over an individual provider.
 *
 * **RNG slots (Task 4.3, R-EXPLORE 4 / Property P6).** The wrapper consumes
 * **two** RNG slots from `exploration`:
 *
 *   - `exploreRandom` — drives the ε coin-flip and the uniform-pick over
 *     `eligible`. The harness shares the **same** `exploreRandom` function
 *     across all four policies in a cell, so the exploration draw sequence
 *     is bit-identical across `{TRACE, REPUTATION, PRICE, EIGENTRUST}`
 *     for the same seed. When `exploreRandom` is omitted, the wrapper falls
 *     back to `random ?? Math.random` (backward-compatible).
 *
 *   - `random` — drives the Thompson Beta-sampling reads in the TRACE
 *     exploit branch. This slot is **not** used by the exploration arm, so
 *     pre-4.3 seeded TRACE runs continue to consume identical Thompson
 *     draws and reproduce identical winners.
 *
 * Decoupling the two slots is what discharges R-EXPLORE 4 at the API level:
 * the exploration-arm draw count is independent of the exploit-arm draw
 * count, so policies that consume different numbers of Thompson draws
 * (TRACE: many; baselines: zero) still observe parity-bit-identical
 * `exploreRandom` sequences.
 *
 * @param eligible    Filtered, utility-sorted (descending) candidates.
 *                    MUST be non-empty — the caller handles the empty case
 *                    via its own `fallback` branch.
 * @param providerMap Lookup from `providerId → Provider`, used by Thompson
 *                    sampling for Beta posterior parameters and by the
 *                    agent-evidence proxy above.
 * @param exploration Optional RNG and round number. When `undefined` the
 *                    wrapper uses round 0 and `Math.random`.
 * @param policy      Routing policy. Only `"TRACE"` triggers the Thompson
 *                    exploit; baselines greedy-argmax `eligible[0]`.
 * @param round       Current routing round (drives ε's denominator).
 *
 * @returns The chosen candidate, the selection mode (`"exploration"` when
 *          the ε-branch fired, `"utility"` otherwise), and the ε actually
 *          used so callers can record it accurately in routing telemetry.
 */
export function selectWinnerWithExploration(
  eligible: CandidateScore[],
  providerMap: Map<string, Provider>,
  exploration: RoutingExplorationOptions | undefined,
  policy: RoutingPolicy,
  round: number,
): { winner: CandidateScore; selectionMode: "utility" | "exploration"; epsilon: number } {
  // ── R-EXPLORE 4 / Task 4.3: separate RNG slots for exploration vs exploit ─
  //
  //   `exploreRand` — drives the ε coin-flip AND the uniform-pick draw.
  //                   The harness shares the same instance across all four
  //                   policies in a cell, so for a fixed seed the sequence
  //                   {ε flip, uniform-pick} is bit-identical across
  //                   {TRACE, REPUTATION, PRICE, EIGENTRUST} (Property
  //                   P6, R-VERIFY-INTEGRITY 3).
  //
  //   `exploitRand` — drives the Thompson Beta-sampling reads (TRACE only).
  //                   Continues to read from `exploration?.random`, so
  //                   existing seeded TRACE runs reproduce the historical
  //                   Beta read order verbatim (R-INTEGRITY).
  //
  // Backward compatibility: when `exploreRandom` is omitted the wrapper
  // falls back to `random ?? Math.random` — the pre-4.3 single-slot
  // behaviour — so callers that have not yet been migrated still work.
  const exploreRand = exploration?.exploreRandom ?? exploration?.random ?? Math.random;
  const exploitRand = exploration?.random ?? Math.random;
  const ablation = exploration?.ablation;

  // Per-cell agent-evidence proxy for ε (see docstring): max `totalJobs`
  // across eligible providers. When all providers are cold-start (n = 0),
  // ε saturates at `epsilonMax` — i.e. maximum exploration pressure on a
  // young network.
  let maxEvidence = 0;
  for (const c of eligible) {
    const p = providerMap.get(c.providerId);
    const n = p?.totalJobs ?? 0;
    if (n > maxEvidence) maxEvidence = n;
  }
  let epsilon = computeEpsilon(
    round,
    maxEvidence,
    EXPLORATION_CONFIG,
    exploration?.jobValue,
    exploration?.medianPrice,
  );

  // ── TRACE-XS: Variance-conditioned exploration (WWW v2) ─────────────────
  // When XS is enabled, scale epsilon by cohort posterior variance.
  // In a mature market with low average variance (all agents well-known),
  // reduce exploration — there's little to learn. In a new market with
  // high variance, maintain full exploration.
  //
  // This specifically counters the behavioral adversary: agents who build
  // stable routing share during a build phase have LOW posterior variance.
  // By scaling epsilon with variance, XS reduces how often these agents
  // are explored, undermining the adversary's strategy.
  //
  // Citation: Russo & Van Roy (2018), "Learning to Optimize via
  // Posterior Sampling".
  let cohortBaselineVariance = 0.01; // calibration default
  if (V2_FLAGS.XS_ENABLED && policy === "TRACE" && eligible.length > 0) {
    let totalVariance = 0;
    for (const c of eligible) {
      const prov = providerMap.get(c.providerId);
      const a = 1 + Math.max(0, prov?.successfulJobs ?? 0);
      const b = 3 + Math.max(0, prov?.failedJobs ?? 0);
      const betaVariance = (a * b) / ((a + b) * (a + b) * (a + b + 1));
      // ── Contaminated posterior (WWW v2.1) ─────────────────────────────
      // If CR flags this agent as part of a suspicious community, inflate
      // variance to reflect that the Beta posterior's evidence may be
      // contaminated by collusive co-jobs. Bayesian justification: co-jobs
      // within a ring are NOT i.i.d., so the effective sample size should
      // be deflated, widening the posterior.
      // When sybilRisk=0: variance = betaVariance (unchanged).
      const crRisk = (prov?.sybilRisk ?? 0) * _currentDensityFactor;
      const PRIOR_VARIANCE = 0.0375; // Beta(1,3) prior variance
      const CONTAMINATION_LAMBDA = 2.0;
      const variance = betaVariance + CONTAMINATION_LAMBDA * crRisk * PRIOR_VARIANCE;
      totalVariance += variance;
    }
    cohortBaselineVariance = totalVariance / eligible.length;

    // Scale epsilon: low cohort variance → reduce exploration
    // varianceScale ∈ [0, 1], calibrated so variance=0.01 → scale=1.0
    const varianceScale = Math.min(1.0, cohortBaselineVariance / 0.01);
    epsilon *= (0.3 + 0.7 * varianceScale); // Floor at 30% of base epsilon
  }

  // ── Outer epsilon-greedy (R-EXPLORE 1, design §5.2) ─────────────────────────
  // Uniform-random pick from the eligible set with probability ε. Only fires
  // when there is a real choice (`eligible.length > 1`); a singleton eligible
  // set has nothing to explore over and falls through to the exploit branch.
  //
  // Both draws here come from `exploreRand` so that the entire exploration
  // arm consumes a single shared sequence — see the RNG-slot block above
  // and design §5.3.
  if (eligible.length > 1 && exploreRand() < epsilon) {
    // ── TRACE v2.1 Improvement #6: Risk-Budget Exploration ────────────────
    // When XS is enabled, direct exploration toward low-risk agents.
    // Standard epsilon-greedy picks uniformly; risk-budget preferentially
    // explores agents with low sybilRisk (genuinely unknown) rather than
    // agents in suspicious communities.
    // Citation: Lykouris et al. (2018) — restricting exploration to safe arms.
    let pool = eligible;
    if (V2_FLAGS.XS_ENABLED && providerMap) {
      // Density-conditioned threshold: on dense graphs, raise the safety
      // threshold because sybilRisk has more false positives.
      const safeThreshold = 0.2 / Math.max(_currentDensityFactor, 0.1);
      const safePool = eligible.filter(c => {
        const prov = providerMap.get(c.providerId);
        return (prov?.sybilRisk ?? 0) < safeThreshold;
      });
      if (safePool.length > 0) pool = safePool;
    }
    const idx = Math.floor(exploreRand() * pool.length);
    const safeIdx = Math.min(Math.max(0, idx), pool.length - 1);
    return { winner: pool[safeIdx], selectionMode: "exploration", epsilon };
  }

  // ── Exploit branch ──────────────────────────────────────────────────────────
  // Baselines and the v4.0 `disableThompsonSampling` ablation use greedy
  // argmax (the eligible list is already utility-sorted).
  if (policy !== "TRACE" || ablation?.disableThompsonSampling) {
    // ── v5.0 / Proposal 1: Selection-Frequency Soft Cap (SFSC) ─────────────
    // When enabled, walk the eligible list and pick the first provider whose
    // recent selection count (in the last `selectionFreqCapWindow` routing
    // calls) is BELOW `selectionFreqCapMax`. This is a CASCADING demotion:
    // if both eligible[0] and eligible[1] are saturated, we proceed to
    // eligible[2], eligible[3], ... until we find one with available
    // capacity. If every provider in the list is saturated (a degenerate
    // case that should not occur at typical N), fall back to eligible[0].
    //
    // Both the chosen and the fallback target stay inside the post-filter
    // eligible set, so fraud-defense is unchanged by construction. The cap
    // is a soft demotion, not a ban — once the count drops below the
    // threshold (the window slides) the provider is greedy-selected again.
    //
    // Citation: Kelly et al. 1998, proportional fairness scheduling.
    //
    // Window is in routing-call indices (`routingCallCounter`), not rounds.
    // The runner calls `resetRoutingWindowTracker()` per cell.
    const sfscOn = !!(ablation?.disableThompsonSampling && ablation?.enableSelectionFreqCap);
    let chosen: CandidateScore = eligible[0];
    if (sfscOn) {
      routingCallCounter++;
      const cap = Math.max(1, ablation!.selectionFreqCapMax ?? 4);
      const win = Math.max(1, ablation!.selectionFreqCapWindow ?? ROUTING_WINDOW_K);
      const cutoff = routingCallCounter - win;
      // Lazy-trim and read recent count for a single provider id.
      const recentCount = (id: string): number => {
        const h = routingWindowTracker.get(id);
        if (!h || h.length === 0) return 0;
        // Drop entries older than the window cutoff.
        let i = 0;
        while (i < h.length && h[i] <= cutoff) i++;
        if (i > 0) h.splice(0, i);
        return h.length;
      };
      // Walk the eligible list and pick the first non-saturated provider.
      // If everyone is saturated, fall back to eligible[0].
      let pickedIdx = -1;
      for (let i = 0; i < eligible.length; i++) {
        if (recentCount(eligible[i].providerId) < cap) {
          pickedIdx = i;
          break;
        }
      }
      chosen = pickedIdx >= 0 ? eligible[pickedIdx] : eligible[0];
      // Append the chosen provider's selection to its window.
      const id = chosen.providerId;
      const h = routingWindowTracker.get(id) ?? [];
      h.push(routingCallCounter);
      routingWindowTracker.set(id, h);
    }
    return { winner: chosen, selectionMode: "utility", epsilon };
  }

  // TRACE Thompson sampling — Bayesian regret `O(√(KT log T))` (Agrawal &
  // Goyal, 2012). Lifted verbatim from the legacy inline block so the Beta
  // read order observed by existing seeds is preserved. Reads from
  // `exploitRand` (i.e. `exploration?.random`) so the slot used by historic
  // seeded runs is unchanged (R-INTEGRITY).
  const sampleBeta = (a: number, b: number): number => {
    const mean = a / (a + b);
    const variance = (a * b) / ((a + b) * (a + b) * (a + b + 1));
    const std = Math.sqrt(Math.max(variance, 0));
    const u1 = Math.max(1e-10, exploitRand());
    const u2 = exploitRand();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const sample = mean + std * normal;
    return Math.max(0.001, Math.min(0.999, sample));
  };

  // ── v5.1 / Proposal 2: Gap-Gated Thompson Sampling (GGTS) ────────────────
  // When `ablation.gapGatedThompson` is on, decide between greedy and
  // Thompson based on the within-cohort utility gap. See the doc-comment
  // on `RoutingExplorationOptions.ablation.gapGatedThompson` for the rule.
  //
  // The gate is computed BEFORE any `sampleBeta` call so the Beta draw
  // sequence in the greedy branch consumes zero exploitRand reads — i.e.
  // greedy under GGTS is bit-identical to greedy under no-bandit, which
  // is the property that lets us interpret the third variant cleanly.
  // ── TRACE v2.1 Improvement #2: Gap-Gated Thompson (GG) ──────────────────
  // When GG_ENABLED or ablation.gapGatedThompson is on, decide between greedy
  // and Thompson based on the utility gap. Large gap → greedy (clear leader).
  // Small gap → Thompson (explore to break tie). This is the "visibility-
  // conditioned exploration" from the CIKM paper's Future Work section.
  // Citation: Audibert & Bubeck (2010) — gap-dependent stopping.
  if ((V2_FLAGS.GG_ENABLED || ablation?.gapGatedThompson) && eligible.length >= 2) {
    let gap: number;
    let sigma: number;
    if (ablation?.gapGateRobust) {
      // ── TRACE-GGR: winsorized gap/σ — see doc-comment on gapGateRobust ──
      const utils = eligible.map((c) => c.utility).slice().sort((a, b) => a - b);
      const med = (arr: number[]): number => {
        const n = arr.length;
        return n % 2 === 1 ? arr[(n - 1) / 2] : (arr[n / 2 - 1] + arr[n / 2]) / 2;
      };
      const median = med(utils);
      const mad = med(utils.map((u) => Math.abs(u - median)).sort((a, b) => a - b));
      const kappa = Math.max(0.1, ablation?.gapGateRobustKappa ?? 3.0);
      const ceiling = median + kappa * mad;
      const winsorized = eligible.map((c) => Math.min(c.utility, ceiling));
      gap = winsorized[0] - winsorized[1];
      let wMean = 0;
      for (const w of winsorized) wMean += w;
      wMean /= winsorized.length;
      let wVariance = 0;
      for (const w of winsorized) {
        const d = w - wMean;
        wVariance += d * d;
      }
      wVariance /= winsorized.length;
      sigma = Math.sqrt(Math.max(wVariance, 0));
    } else {
      gap = eligible[0].utility - eligible[1].utility;
      let mean = 0;
      for (const c of eligible) mean += c.utility;
      mean /= eligible.length;
      let variance = 0;
      for (const c of eligible) {
        const d = c.utility - mean;
        variance += d * d;
      }
      variance /= eligible.length;
      sigma = Math.sqrt(Math.max(variance, 0));
    }
    const baseTau = Math.max(0, ablation?.gapGateThresholdSigma ?? 0.5);
    // Density-aware gap gate: on dense graphs (densityFactor=0), keep baseTau
    // so Thompson exploration is preserved (v1 behavior, which wins on dense).
    // On sparse (densityFactor=1.0), use baseTau unchanged (v2.1 gap gate).
    // No density-based modification — the gap gate works correctly at baseTau
    // across both regimes. The density switch handles the mechanism gating.
    const tau = baseTau;

    // Decisive lead → greedy. Tied utilities (sigma === 0) fall through
    // to Thompson because there is genuine uncertainty between equally-
    // ranked candidates.
    if (sigma > 0 && gap > tau * sigma) {
      return { winner: eligible[0], selectionMode: "utility", epsilon };
    }
    // Otherwise: fall through into the Thompson loop below.
  }

  // ── External-family baseline: corruption-robust successive elimination ──
  // See the doc-comment on `RoutingExplorationOptions.ablation.corruptionRobustUCB`.
  // Independent of GGTS — replaces the Thompson exploit branch entirely.
  if (ablation?.corruptionRobustUCB && eligible.length >= 2) {
    const C = Math.max(0, ablation?.corruptionBudgetFraction ?? 0.3);
    const DELTA = 0.05; // 95% confidence, standard choice for this bound family
    const bound = (candidate: CandidateScore): { mean: number; lower: number; upper: number } => {
      const prov = providerMap.get(candidate.providerId)!;
      const n = Math.max(0, prov.totalJobs);
      const mean = n > 0 ? prov.successfulJobs / n : 0.5; // uninformative prior at n=0
      // Hoeffding radius (standard, from n observations) plus an ADDITIVE
      // corruption term C/√n — up to C·√n corrupted observations can shift
      // an empirical mean of n samples by O(C/√n), so widening the interval
      // by that same amount keeps the true best arm's interval overlapping
      // the (possibly corruption-shifted) empirical estimate, matching the
      // additive-in-C regret form this whole literature targets.
      const hoeffding = Math.sqrt(Math.log(2 / DELTA) / (2 * Math.max(1, n)));
      const corruptionRadius = C / Math.sqrt(Math.max(1, n));
      const radius = hoeffding + corruptionRadius;
      return { mean, lower: mean - radius, upper: mean + radius };
    };
    const bounds = eligible.map(bound);
    const bestLower = Math.max(...bounds.map((b) => b.lower));
    const survivors = eligible.filter((_, i) => bounds[i].upper >= bestLower);
    if (process.env.TRACE_DEBUG_UCB) {
      const ns = eligible.map((c) => Math.max(0, providerMap.get(c.providerId)!.totalJobs));
      console.error(`UCB_DEBUG C=${C} eligible=${eligible.length} survivors=${survivors.length} ns=${JSON.stringify(ns)} radii=${JSON.stringify(bounds.map(b=>(b.upper-b.lower)/2))}`);
    }
    // Successive-elimination exploration: uniform among survivors. Converges
    // to greedy once elimination narrows the active set to one candidate —
    // no separate greedy/explore branch needed, unlike GGTS.
    const survivorPool = survivors.length > 0 ? survivors : eligible;
    const idx = Math.min(survivorPool.length - 1, Math.floor(exploitRand() * survivorPool.length));
    return {
      winner: survivorPool[idx],
      selectionMode: survivorPool.length === 1 ? "utility" : "exploration",
      epsilon,
    };
  }

  let winner: CandidateScore = eligible[0];
  let bestSample = -Infinity;
  for (const candidate of eligible) {
    const prov = providerMap.get(candidate.providerId)!;
    const a = 1 + Math.max(0, prov.successfulJobs);
    const b = 3 + Math.max(0, prov.failedJobs);
    const sample = sampleBeta(a, b);
    const utilityFactor = 0.5 + 0.5 * Math.max(0, candidate.utility);

    // ── TRACE-XS: Per-candidate variance attenuation (WWW v2) ────────────
    // Low-variance candidates (behavioral adversary build-phase agents) get
    // their Thompson sample attenuated. High-variance new agents maintain
    // normal sampling weight.
    let xsFactor = 1.0;
    if (V2_FLAGS.XS_ENABLED) {
      const betaVariance = (a * b) / ((a + b) * (a + b) * (a + b + 1));
      const crRisk = (prov.sybilRisk ?? 0) * _currentDensityFactor;
      const PRIOR_VARIANCE = 0.0375;
      const CONTAMINATION_LAMBDA = 2.0;
      const candidateVariance = betaVariance + CONTAMINATION_LAMBDA * crRisk * PRIOR_VARIANCE;
      const varianceRatio = candidateVariance / (candidateVariance + cohortBaselineVariance);
      xsFactor = 0.5 + 0.5 * varianceRatio;
    }

    // ── TRACE v2.1 Improvement #3: Pessimistic Thompson (PT) ───────────────
    // Directly penalize Thompson samples for agents with high sybilRisk.
    // Unlike XS (which conditions on variance — an indirect proxy), PT
    // conditions directly on the detection signal. Colluders with
    // sybilRisk=0.75 get a 45% sample reduction.
    // When sybilRisk=0: no effect. Backward compatible.
    // Citation: Grünwald & van Ommen (2017) — pessimistic posteriors for
    // misspecified models.
    let ptFactor = 1.0;
    if (V2_FLAGS.PT_ENABLED) {
      // Density-conditioned: scale risk by density factor so pessimism
      // attenuates on dense graphs where sybilRisk has more false positives.
      const risk = (prov.sybilRisk ?? 0) * _currentDensityFactor;
      ptFactor = 1.0 - 0.6 * risk;
    }

    const weightedSample = sample * utilityFactor * xsFactor * ptFactor;
    if (weightedSample > bestSample) {
      bestSample = weightedSample;
      winner = candidate;
    }
  }
  return { winner, selectionMode: "utility", epsilon };
}

// ── Fix 2: Anti-concentration tracker for Thompson Sampling ───────────────────
// Prevents any single provider from receiving disproportionate routing share.
// Tracks selections in a sliding window of K=20 routing calls per provider.
// Cleared between experiment cells via resetRoutingWindowTracker().
//
// v5.0 / Proposal 1 (SFSC): the same tracker now also serves the
// Selection-Frequency Soft Cap on the no-bandit greedy branch. SFSC
// increments `routingCallCounter` on every routing call where SFSC is
// active and uses the counter as a monotonic timestamp for the per-provider
// history. Window is in routing-call indices, NOT rounds.
const routingWindowTracker = new Map<string, number[]>();
const ROUTING_WINDOW_K = 20;
let routingCallCounter = 0;
// Density-conditioned mechanism calibration (v2.1).
// Updated once per scoring round by scoreAllCandidates; consumed by
// computeTraceUtility and selectWinnerWithExploration.
let _currentDensityFactor = 1.0;

/** Clear the routing concentration tracker between experiment cells. */
export function resetRoutingWindowTracker(): void {
  routingWindowTracker.clear();
  routingCallCounter = 0;
}

// ── Trust Inertia Tracker (v4.4, Fix #6) ──────────────────────────────────────
// Maintains an exponentially-smoothed TRACE score per provider to prevent
// rapid score gaming. Agents can't rapidly recover from bad behavior, and
// good agents can't be rapidly crashed by a single bad round.
//
// Formula: smoothedScore = α × currentScore + (1 - α) × previousSmoothed
// With α = 0.3, it takes ~7 rounds for the smoothed score to converge to
// a new steady state (0.3^7 ≈ 0.0002 residual from old state).
//
// Citation: Holt (1957), Winters (1960) — exponential smoothing.
// Jøsang et al. (2007) "A Survey of Trust and Reputation Systems" —
// temporal discounting with momentum prevents gaming through alternating behavior.
//
// Attack-agnostic: applies identically to all providers regardless of identity.
//
// v5.0 / Proposal 3 (AI-α — Adaptive Inertia α). Optional per-provider
// schedule that replaces the fixed α=0.3 with α(n) = max(α_floor, 1/√(1+n))
// where n is the provider's totalJobs. Cold-start providers (n=0) get
// α=1.0 (no smoothing — fresh score), mature providers (n≥30) saturate
// near α_floor=0.3 (current behaviour). Robbins-Monro stochastic
// approximation step-size schedule.
//
// Citation: Robbins & Monro (1951), "A stochastic approximation method",
// Annals of Mathematical Statistics 22.
const trustInertiaTracker = new Map<string, number>();

const TRUST_INERTIA_ALPHA_FIXED = 0.3;
const TRUST_INERTIA_ALPHA_FLOOR = 0.3;

let trustInertiaAdaptive = false;
/**
 * v5.0 / Proposal 3: enable Robbins-Monro adaptive α(n) schedule for the
 * trust inertia smoother. Affects all subsequent getSmoothedTraceScore
 * calls until disabled. Reset by resetTrustInertiaTracker (which also
 * clears the adaptive flag).
 */
export function enableAdaptiveInertiaAlpha(on: boolean): void {
  trustInertiaAdaptive = !!on;
}

function inertiaAlpha(totalJobs: number): number {
  if (!trustInertiaAdaptive) return TRUST_INERTIA_ALPHA_FIXED;
  const n = Math.max(0, totalJobs);
  const a = 1 / Math.sqrt(1 + n);
  return Math.max(TRUST_INERTIA_ALPHA_FLOOR, Math.min(1, a));
}

/**
 * Get the inertia-smoothed TRACE score for a provider.
 * On first call, initializes to the current raw score (no penalty).
 * On subsequent calls, applies EMA smoothing.
 *
 * v5.0: when adaptive mode is on (via enableAdaptiveInertiaAlpha), the
 * smoothing factor depends on totalJobs: cold-start providers get a
 * fresh score read, mature providers saturate at the floor.
 */
function getSmoothedTraceScore(providerId: string, currentScore: number, totalJobs: number = 30): number {
  const previous = trustInertiaTracker.get(providerId);
  if (previous === undefined) {
    // First observation — initialize without penalty
    trustInertiaTracker.set(providerId, currentScore);
    return currentScore;
  }
  const alpha = inertiaAlpha(totalJobs);
  const smoothed = alpha * currentScore + (1 - alpha) * previous;
  trustInertiaTracker.set(providerId, smoothed);
  return smoothed;
}

/** Clear trust inertia tracker between experiment cells. */
export function resetTrustInertiaTracker(): void {
  trustInertiaTracker.clear();
  trustInertiaAdaptive = false;
}

// ── Round-Level Anomaly Detection (v4.4, Fix #3) ──────────────────────────────
// Tracks per-round failure rates and detects collective anomalies (rounds where
// the failure rate is significantly above the running mean). Agents who failed
// in anomalous rounds receive temporary suspicion that suppresses their utility.
//
// Citation: Shewhart (1931) — statistical process control charts.
// Chandola et al. (2009) — collective anomaly detection where individual
// observations are normal but the aggregate is anomalous.
//
// Attack-agnostic: reads only the aggregate failure rate per round, not
// individual agent identities.
const roundFailureHistory: number[] = [];
const roundSuspicionTracker = new Map<string, number>();

/**
 * Record a round's failure rate and return suspicion for agents who failed
 * in anomalous rounds. Called from the experiment runner after each round.
 */
export function recordRoundFailureRate(rate: number, failedProviderIds: string[], round: number): void {
  roundFailureHistory.push(rate);

  // Need at least 5 rounds of history to compute meaningful statistics
  if (roundFailureHistory.length < 5) return;

  // Compute running mean and stddev
  const mean = roundFailureHistory.reduce((s, r) => s + r, 0) / roundFailureHistory.length;
  const variance = roundFailureHistory.reduce((s, r) => s + (r - mean) ** 2, 0) / roundFailureHistory.length;
  const stddev = Math.sqrt(variance);

  if (stddev < 0.01) return; // No variance — can't detect anomalies

  // Z-score for this round
  const z = (rate - mean) / stddev;

  // If z > 2.0, this round is anomalous — flag all agents who failed
  if (z > 2.0) {
    const suspicion = 0.10 * (z - 2.0); // Proportional to severity
    for (const pid of failedProviderIds) {
      const current = roundSuspicionTracker.get(pid) ?? 0;
      roundSuspicionTracker.set(pid, Math.min(0.5, current + suspicion));
    }
  }

  // Decay all suspicion by 20% per round (5-round half-life)
  for (const [pid, susp] of roundSuspicionTracker) {
    const decayed = susp * 0.8;
    if (decayed < 0.01) {
      roundSuspicionTracker.delete(pid);
    } else {
      roundSuspicionTracker.set(pid, decayed);
    }
  }
}

/**
 * Get the round-level suspicion for a provider (0 if none).
 */
export function getRoundSuspicion(providerId: string): number {
  return roundSuspicionTracker.get(providerId) ?? 0;
}

/** Clear round-level anomaly tracker between experiment cells. */
export function resetRoundAnomalyTracker(): void {
  roundFailureHistory.length = 0;
  roundSuspicionTracker.clear();
}
// Tracks the last round in which each provider defaulted. Providers within
// the cooldown window (TRACE_HARDENING.cooldownRounds) have their utility
// multiplied by TRACE_HARDENING.cooldownMultiplier (0.01) — soft exclusion
// that prevents immediate re-routing after fraud without a hard ban.
// Attack-agnostic: applies to ANY provider that defaulted recently.
// Cleared between experiment cells via resetCooldownTracker().
//
// v4.4: Exponential cooldown escalation — cooldown duration doubles with each
// successive default. First default: 5 rounds. Second: 10. Third: 20.
// This distinguishes honest bad luck (rare, single defaults) from persistent
// adversarial behavior (repeated defaults).
//
// Citation: Metcalfe & Boggs (1976) — Exponential backoff for Ethernet
// collision resolution. Proven optimal for distinguishing transient errors
// from persistent adversarial behavior in shared-medium systems.
// Also: TCP congestion control (Jacobson 1988) — multiplicative decrease
// after loss events is the standard mechanism for penalizing repeated failures.
//
// False positive analysis: An honest agent with 5% failure rate has
// P(2 defaults in 60 rounds) ≈ C(60,2)×0.05²×0.95⁵⁸ ≈ 0.14 (14%).
// These agents get 10-round cooldown (2× base) which is acceptable —
// they still recover and get routed after the cooldown expires.
// P(3 defaults) ≈ 0.03 (3%) — 20-round cooldown, still recoverable.
// P(4+ defaults) < 0.5% — at this point, even honest agents with this
// many failures SHOULD receive reduced routing priority.
const cooldownTracker = new Map<string, number>();
const defaultCountTracker = new Map<string, number>();

/**
 * Record that a provider defaulted at the given round.
 * Called from the experiment runner (or any caller) when a DEFAULT event occurs.
 * v4.4: Also increments the default count for exponential cooldown scaling.
 */
export function recordProviderDefault(providerId: string, round: number): void {
  cooldownTracker.set(providerId, round);
  defaultCountTracker.set(providerId, (defaultCountTracker.get(providerId) ?? 0) + 1);
}

/**
 * Get the last default round for a provider, or undefined if never defaulted.
 */
export function getLastDefaultRound(providerId: string): number | undefined {
  return cooldownTracker.get(providerId);
}

/**
 * v4.4: Get the effective cooldown duration for a provider based on their
 * default count. Base cooldown × 2^(defaultCount - 1), capped at 40 rounds.
 *
 * defaultCount=1: 5 rounds (base)
 * defaultCount=2: 10 rounds
 * defaultCount=3: 20 rounds
 * defaultCount=4+: 40 rounds (cap)
 */
export function getEffectiveCooldownRounds(providerId: string): number {
  const count = defaultCountTracker.get(providerId) ?? 0;
  if (count <= 0) return TRACE_HARDENING.cooldownRounds;
  const escalated = TRACE_HARDENING.cooldownRounds * Math.pow(2, Math.min(count - 1, 3));
  return Math.min(escalated, 40); // Cap at 40 rounds
}

/** Clear the cooldown tracker between experiment cells. */
export function resetCooldownTracker(): void {
  cooldownTracker.clear();
  defaultCountTracker.clear();
}

// ─── R-SCALE: PPR honest-seed thresholds (design §2.3 — Task 2.3 rewire) ──────
//
// The Personalized PageRank seed in `scoreAllCandidates` selects providers
// whose Beta-Binomial posterior over the per-job completion rate is mature
// enough to discriminate honest behavior from chance. Two thresholds gate
// admission to the seed:
//
//   1. PPR_SEED_MIN_TOTAL_JOBS — minimum sample size of completed jobs.
//   2. PPR_SEED_MAX_FAILURE_RATE — maximum empirical failure rate.
//
// Both are classified as **scale-invariant** in the constants registry:
// they are per-agent-history thresholds (calibrated on Beta-Binomial
// posterior maturity), not per-network thresholds. They do NOT scale with
// the live network size N because the underlying posterior is a property
// of the individual agent's job ledger, not of the network. The dynamic
// quantities in this audit (R-SCALE) scale signals that aggregate over the
// graph — these thresholds apply per-agent and so are correctly static.
//
// Bayesian justification (per design §2.3 row "PPR seed thresholds"):
//
//   PPR_SEED_MIN_TOTAL_JOBS = 30
//     Sample-size threshold for posterior maturity. The success-rate
//     posterior is Beta(α + s, β + f) with the project-wide prior
//     Beta(1, 3) used by `computeBayesianLCB`. After n = s + f = 30
//     observations the effective sample size α + β + n = 34, beyond which
//     the LCB-vs-mean gap is small enough (≤ ~0.15 at the 95% lower
//     confidence bound) that the seed-admission decision is dominated by
//     observed behavior rather than the prior. Below n = 30 the posterior
//     is prior-dominated and admitting such agents would seed PPR mass on
//     cold-start defaults instead of demonstrated reliability.
//
//   PPR_SEED_MAX_FAILURE_RATE = 0.10
//     Failure-rate cutoff calibrated against the Beta(1, 3) prior. A truly
//     honest agent with population failure rate ≈ 0.05 has, after n = 30
//     observations, a 95% credible upper bound on its empirical failure
//     rate below ~0.12; the cutoff at 0.10 is the conservative decision
//     boundary between "consistent with the honest prior" and "tail
//     evidence of unreliability". v4.1 tightened the cutoff from 0.20 to
//     0.10 on this basis: an empirical 12% failure rate at n = 30 is
//     INCONSISTENT with a true honest agent under the prior LCB, so the
//     looser threshold was admitting agents whose history dilutes the
//     seed's discriminative power.
//
// These constants are intentionally NOT routed through `adaptiveConfig.ts`
// because the dynamic-formula registry is reserved for N-dependent
// quantities (R-SCALE criterion 2), and these are per-job-history
// thresholds (R-SCALE criterion 5: "scale-invariant" classification). Any
// future re-derivation of these values must update the Bayesian
// justification above; ad-hoc tuning is forbidden by R-INTEGRITY.
const PPR_SEED_MIN_TOTAL_JOBS = 30;
const PPR_SEED_MAX_FAILURE_RATE = 0.10;

// ─── TRACE Provider Selection ─────────────────────────────────────────────────

// ─── TRACE Provider Selection ─────────────────────────────────────────────────

export async function selectProviderTRACE(
  capability: string,
  policy: RoutingPolicy = "TRACE",
  experimentId?: string,
  jobId?: string,
  exploration?: RoutingExplorationOptions
): Promise<RoutingResult | null> {
  const providers = await prisma.provider.findMany({
    where: {
      capability,
      isActive: true,
    },
    // Explicit, deterministic fetch order is required for the shuffle below
    // to be reproducible. A Fisher-Yates shuffle with a FIXED seed does NOT
    // make the output independent of input order -- output = f(seed,
    // input_order), and a different input_order gives a different result
    // even with the identical seed. Without this orderBy, SQLite returns
    // rows in unspecified physical order, which depends on dev.db's
    // accumulated history (VACUUM state, prior deletes/inserts from
    // unrelated cells sharing the same file) -- NOT on the experiment seed
    // alone. This silently broke the "same seed, same config -> same
    // result" guarantee every reproducibility claim in this codebase
    // depends on (found via a standalone-vs-batched-run discrepancy: 30 vs
    // 33 sats for an otherwise identical cell, chased down and fixed here).
    orderBy: { id: "asc" },
  });

  if (providers.length === 0) return null;

  // v2.6: Shuffle providers (now from a deterministically-ordered fetch,
  // see orderBy above) so a fixed seed always reshuffles the same starting
  // order into the same result, regardless of dev.db's physical history.
  const shuffleRng = exploration?.random ?? Math.random;
  for (let i = providers.length - 1; i > 0; i--) {
    const j = Math.floor(shuffleRng() * (i + 1));
    [providers[i], providers[j]] = [providers[j], providers[i]];
  }

  const edgeCache = (policy === "TRACE" || policy === "EIGENTRUST" || policy === "TRUSTFLOW") ? await buildEdgeCache() : undefined;

  const candidates = await scoreAllCandidates(providers, policy, providers.length, edgeCache, exploration?.ablation, exploration?.round ?? 0);

  const eligible = candidates.filter((c) => !c.rejected && c.utility >= 0);

  if (process.env.TRACE_DEBUG_ELIGIBLE) {
    // Diagnostic only, zero-cost when the env var is unset. Measures the
    // regret bound's central assumption directly (paper/latex/iclr2027/
    // main.tex Section 4, "Scope"): what fraction of the eligible cohort --
    // the population the gap-gate's decision statistic is computed over --
    // is actually malicious, versus the 30% population-wide rate. Ground
    // truth is the same "[M]" name-tag convention every worker in this
    // codebase already filters on (see scripts/ml/export_edges.ts).
    const maliciousIds = new Set(providers.filter((p) => p.name.includes("[M]")).map((p) => p.id));
    const eligibleMalicious = eligible.filter((c) => maliciousIds.has(c.providerId)).length;
    console.error(`ELIGIBLE_DEBUG total=${eligible.length} malicious=${eligibleMalicious}`);
  }

  if (eligible.length === 0) {
    await logEvent("route", `⚠️ TRACE v2: All ${providers.length} providers filtered out for ${capability} — falling back`, {
      capability,
      policy,
      candidateCount: providers.length,
      allRejected: true,
      rejectionReasons: candidates.map((c) => ({ id: c.providerId, reason: c.reason })),
    });

    candidates.sort((a, b) => b.utility - a.utility);
    const fallback = candidates[0];
    if (fallback) {
      const provider = providers.find((p) => p.id === fallback.providerId)!;
      fallback.rejected = false;
      fallback.reason = "constraint_relaxed";

      if (!experimentId) {
        await logRoutingDecision(capability, provider.id, fallback.utility, candidates, policy, experimentId, jobId);
      }
      return { provider, utility: fallback.utility, candidates, policy, selectionMode: "fallback", epsilon: 0 };
    }
    return null;
  }

  eligible.sort((a, b) => b.utility - a.utility);

  // ─── R-EXPLORE: shared exploration wrapper (Task 4.2) ───────────────────────
  // The wrapper is the ONLY exploration entry-point in the router; it applies
  // epsilon-greedy at the outer level and Thompson sampling on the exploit
  // branch (for TRACE) / greedy argmax (for baselines). Baseline scoring
  // functions are unchanged (R-INTEGRITY); the wrapper runs AFTER scoring on
  // the sorted eligible list. See `selectWinnerWithExploration` above.
  const providerMap = new Map(providers.map(p => [p.id, p]));
  const { winner, selectionMode, epsilon } = selectWinnerWithExploration(
    eligible,
    providerMap,
    exploration,
    policy,
    exploration?.round ?? 0,
  );

  const provider = providerMap.get(winner.providerId)!;

  if (!experimentId) {
    await logRoutingDecision(capability, provider.id, winner.utility, candidates, policy, experimentId, jobId);

    await logEvent("route", `🎯 TRACE v2 routed ${capability} → ${provider.name} (utility: ${winner.utility.toFixed(2)}, tier: ${provider.riskTier})`, {
      capability,
      providerId: provider.id,
      providerName: provider.name,
      traceScore: provider.traceScore,
      riskTier: provider.riskTier,
      utility: winner.utility,
      policy,
      selectionMode,
      epsilon,
      candidatesEvaluated: candidates.length,
      candidatesRejected: candidates.filter((c) => c.rejected).length,
      sybilRisk: provider.sybilRisk,
    });
  }

  return { provider, utility: winner.utility, candidates, policy, selectionMode, epsilon };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

async function scoreAllCandidates(
  providers: Provider[],
  policy: RoutingPolicy,
  networkSize: number,
  edgeCache?: EdgeCache,
  ablation?: RoutingExplorationOptions["ablation"],
  round: number = 0,
): Promise<CandidateScore[]> {
  const maxPrice = Math.max(...providers.map((p) => p.priceSats), 1);

  // ── TRACE v2.1: Density-Conditioned Mechanism Calibration ─────────────────
  // On dense graphs, structural signals (SCC, spectral gap) have high false-
  // positive rates because most agents are in large SCCs. Scale sybilRisk-based
  // mechanisms by a density factor so they attenuate on dense graphs.
  //
  // densityFactor = min(1.0, calibrationPoint / density)
  //   sparse (0.1%): factor ≈ 1.0 → full mechanism strength
  //   dense  (1.85%): factor ≈ 0.27 → 73% attenuation
  //
  // Citation: Leskovec et al. (2010) — graph density affects community detection
  // false-positive rates. Adaptive calibration is a standard correction.
  let densityFactor = 1.0;
  if (V2_FLAGS.DR_ENABLED && edgeCache && networkSize > 1) {
    let edgeCount = 0;
    for (const edges of edgeCache.bySource.values()) edgeCount += edges.length;
    const maxPossibleEdges = networkSize * (networkSize - 1);
    const density = edgeCount / maxPossibleEdges;

    // Phase-transition boundary: the CIKM paper shows a sharp transition at
    // ~1.2% density where the greedy advantage disappears. Above this, v2
    // mechanisms become net-harmful because sybilRisk ≈ 0 on dense graphs.
    //
    // Below 0.5%: full mechanism strength (densityFactor = 1.0)
    // 0.5%–1.2%: linear ramp-down (smooth transition)
    // Above 1.2%: mechanisms fully OFF (densityFactor = 0.0)
    const SPARSE_CEILING = 0.005;  // 0.5% — mechanisms at full strength
    const DENSE_FLOOR = 0.012;     // 1.2% — phase transition, mechanisms OFF
    if (density >= DENSE_FLOOR) {
      densityFactor = 0.0;
    } else if (density > SPARSE_CEILING) {
      // Linear interpolation in the transition zone
      densityFactor = 1.0 - (density - SPARSE_CEILING) / (DENSE_FLOOR - SPARSE_CEILING);
    }
    // else: density <= SPARSE_CEILING → densityFactor stays 1.0
  }
  // Store module-level for use in Thompson sampling (selectWinnerWithExploration)
  _currentDensityFactor = densityFactor;

  // v2.9: Compute neighborhood contamination for TRACE policy
  // v4.1 Perf: Use direct import instead of dynamic import (avoids module resolution per call)
  let neighborhoodContamination: Map<string, number> | undefined;
  if (policy === "TRACE" && edgeCache) {
    const providerSybilRisks = new Map(providers.map(p => [p.id, p.sybilRisk]));
    neighborhoodContamination = computeNeighborhoodContamination(edgeCache, providerSybilRisks);
  }

  // ─── Personalized PageRank from honest seed (Framework 3) ───────────────────
  // v4.0: Ablation-gated — disabled when disablePPR or disableAllGraph is set.
  let pprScores: Map<string, number> = new Map();
  if (policy === "TRACE" && edgeCache && !ablation?.disablePPR && !ablation?.disableAllGraph) {
    const seedIds = new Set<string>();
    for (const pr of providers) {
      const failureRate = pr.totalJobs > 0 ? pr.failedJobs / pr.totalJobs : 1;
      // Task 2.3 (R-SCALE): the per-agent-history thresholds for seed
      // admission are extracted into the named scale-invariant constants
      // `PPR_SEED_MIN_TOTAL_JOBS` and `PPR_SEED_MAX_FAILURE_RATE` declared
      // above with documented Bayesian justification. They are NOT
      // N-dependent and therefore do NOT route through `adaptiveConfig.ts`.
      if (pr.totalJobs >= PPR_SEED_MIN_TOTAL_JOBS && failureRate < PPR_SEED_MAX_FAILURE_RATE) {
        seedIds.add(pr.id);
      }
    }
    // Fallback: top-3 by totalJobs (creation-time proxy, not behavior-based)
    if (seedIds.size < 3 && providers.length >= 3) {
      const top3 = [...providers]
        .sort((a, b) => b.totalJobs - a.totalJobs)
        .slice(0, 3);
      for (const pr of top3) seedIds.add(pr.id);
    }
    pprScores = computePersonalizedPageRank(edgeCache, seedIds);
  }

  // Posterior-mean trust map (Beta(1,3) prior) — used by weighted entropy.
  const providerTrustMap = new Map<string, number>(
    providers.map((pr) => {
      const a = 1 + Math.max(0, pr.successfulJobs);
      const b = 3 + Math.max(0, pr.failedJobs);
      const denom = a + b;
      return [pr.id, denom > 0 ? a / denom : 0.25];
    })
  );

  // ─── EigenTrust scores (computed ONCE per routing call for EIGENTRUST policy) ─
  // The EigenTrust baseline needs global trust scores from power iteration.
  // Compute them here so the per-candidate utility function can look up its score.
  let eigenTrustScores: Map<string, number> = new Map();
  if (policy === "EIGENTRUST" && edgeCache) {
    const providerIds = providers.map(p => p.id);
    eigenTrustScores = computeEigenTrustScores(edgeCache, providerIds);
  }

  // ─── TrustFlow scores (computed ONCE per routing call for TRUSTFLOW policy) ──
  let trustFlowScores: Map<string, number> = new Map();
  if (policy === "TRUSTFLOW" && edgeCache) {
    const providerIds = providers.map(p => p.id);
    trustFlowScores = computeTrustFlowScores(edgeCache, providerIds);
  }

  const candidatePromises = providers.map(async (p) => {
    const candidate: CandidateScore = {
      providerId: p.id,
      providerName: p.name,
      utility: 0,
      rejected: false,
      breakdown: {
        traceContribution: 0,
        defaultPenalty: 0,
        costPenalty: 0,
        networkBonus: 0,
        sybilPenalty: 0,
        cliquePenalty: 0,
        causalSuspicion: 0,
        temporalRiskPenalty: 0,
        reciprocalRisk: 0,
        volatilityPenalty: 0,
        velocityAnomaly: 0,
        capabilityBonus: 0,
        coldStartBonus: 0,
        progressiveTrustCap: 1.0,
        diversityScore: 1.0,
        diversityMaturity: 1.0,
        economicDepth: 0,
        entropyConfidence: 1.0,
        scaleFactor: 1.0,
        causalMultiplier: 1.0,
        behavioralAnomalyPenalty: 0,
        perfectionPenalty: 0,
        neighborhoodContaminationPenalty: 0,
      },
    };

    if (policy === "TRACE") {
      if (p.traceScore < ROUTING_CONSTRAINTS.minTraceScore) {
        candidate.rejected = true;
        candidate.reason = `trace_score_too_low: ${p.traceScore} < ${ROUTING_CONSTRAINTS.minTraceScore}`;
        return candidate;
      }

      if (p.defaultProbability > ROUTING_CONSTRAINTS.maxDefaultProbability) {
        candidate.rejected = true;
        candidate.reason = `default_prob_too_high: ${p.defaultProbability} > ${ROUTING_CONSTRAINTS.maxDefaultProbability}`;
        return candidate;
      }

      if (p.sybilRisk > ROUTING_CONSTRAINTS.maxSybilRisk) {
        candidate.rejected = true;
        candidate.reason = `sybil_risk_too_high: ${p.sybilRisk} > ${ROUTING_CONSTRAINTS.maxSybilRisk}`;
        return candidate;
      }

      if (p.disputedJobs > ROUTING_CONSTRAINTS.maxActiveDisputes) {
        candidate.rejected = true;
        candidate.reason = `too_many_disputes: ${p.disputedJobs} > ${ROUTING_CONSTRAINTS.maxActiveDisputes}`;
        return candidate;
      }

      if (p.totalJobs < PROGRESSIVE_TRUST.minJobsForFullAccess && p.defaultProbability > 0.3) {
        candidate.rejected = true;
        candidate.reason = "cold_start_high_risk";
        return candidate;
      }

      // v2.6: Whitewash identity-reset hard filter.
      if (p.totalJobs === 0) {
        const historyCount = await prisma.scoreHistory.count({
          where: { providerId: p.id },
        });
        if (historyCount > 0) {
          candidate.rejected = true;
          candidate.reason = `whitewash_detected: history=${historyCount}, jobs=${p.totalJobs}`;
          return candidate;
        }
      }

      // v2.6: Failure rate hard filter.
      if (p.totalJobs >= ROUTING_CONSTRAINTS.minJobsForFailureFilter) {
        const failureRate = p.failedJobs / p.totalJobs;
        if (failureRate > ROUTING_CONSTRAINTS.maxFailureRate) {
          candidate.rejected = true;
          candidate.reason = `failure_rate_too_high: ${(failureRate * 100).toFixed(0)}% > ${(ROUTING_CONSTRAINTS.maxFailureRate * 100).toFixed(0)}%`;
          return candidate;
        }
      }

      // v2.6: Sybil + failure interaction.
      // Theoretical basis: a provider with ANY detected sybil risk AND any failures
      // has demonstrated both (a) artificial graph manipulation and (b) willingness
      // to default. The conjunction is strong evidence of adversarial intent.
      // Density-conditioned: on dense graphs, raise threshold because sybilRisk
      // has higher false-positive rate (honest agents naturally form SCCs).
      const sybilFailureThreshold = 0.15 / Math.max(_currentDensityFactor, 0.1);
      if (p.sybilRisk > sybilFailureThreshold && p.failedJobs > 0) {
        candidate.rejected = true;
        candidate.reason = `sybil_failure_interaction: sybilRisk=${p.sybilRisk.toFixed(2)}, failures=${p.failedJobs}`;
        return candidate;
      }

      // CUSUM change-point hard filter (Framework 6).
      // v4.0: Ablation-gated — disabled when disableCUSUM is set.
      if (!ablation?.disableCUSUM) {
        const cusumScore = p.cusumScore ?? 0;
        if (Number.isFinite(cusumScore) && cusumScore > CUSUM_H) {
          candidate.rejected = true;
          candidate.reason = `cusum_alarm: score=${cusumScore.toFixed(2)} > h=${CUSUM_H}`;
          return candidate;
        }
      }
    }

    switch (policy) {
      case "TRACE":
        await computeTraceUtility(candidate, p, maxPrice, networkSize, edgeCache, neighborhoodContamination, pprScores, providerTrustMap, ablation, round);
        break;
      case "REPUTATION":
        computeReputationUtility(candidate, p, maxPrice);
        break;
      case "PRICE":
        computePriceUtility(candidate, p, maxPrice);
        break;
      case "EIGENTRUST":
        computeEigenTrustUtility(candidate, p, maxPrice, eigenTrustScores);
        break;
      case "TRUSTFLOW":
        computeTrustFlowUtility(candidate, p, maxPrice, trustFlowScores);
        break;
    }

    return candidate;
  });

  return Promise.all(candidatePromises);
}

async function computeTraceUtility(
  candidate: CandidateScore,
  p: Provider,
  maxPrice: number,
  networkSize?: number,
  edgeCache?: EdgeCache,
  neighborhoodContamination?: Map<string, number>,
  pprScores?: Map<string, number>,
  providerTrustMap?: Map<string, number>,
  ablation?: RoutingExplorationOptions["ablation"],
  round: number = 0,
): Promise<void> {
  const u = ROUTING_UTILITY;
  const N = networkSize ?? 50;

  // v4.4: Trust inertia — use smoothed score to prevent rapid gaming.
  const smoothedScore = getSmoothedTraceScore(p.id, p.traceScore, p.totalJobs);
  const normalizedTrace = smoothedScore / TRACE_MAX_SCORE;
  const effectivePrice = p.priceSats * (p.bidMultiplier ?? 1.0);
  const normalizedCost = effectivePrice / maxPrice;
  const capabilityMatch = 1.0;

  // ── Bayesian posterior LCB (Framework 1) ────────────────────────────────────
  // v4.0: Ablation-gated. When disabled, use point estimate (s/(s+f)) as fallback.
  // ── TRACE v2.1 Improvement #1: Evidence Discounting ───────────────────────
  // When CR is enabled and sybilRisk > 0, discount the effective success count.
  // Co-jobs within a collusion ring are correlated (not i.i.d.), so the
  // effective sample size should be deflated by the contamination fraction.
  // Formula: effective_s = s × (1 - sybilRisk × 0.8)
  // When sybilRisk=0: no discounting. When sybilRisk=0.75: s reduced by 60%.
  // Citation: Berger (1985) — correlated samples reduce effective N.
  // Density-conditioned sybilRisk: attenuate on dense graphs where structural
  // detection (SCC) has high false-positive rate.
  const effectiveSybilRisk = p.sybilRisk * _currentDensityFactor;

  let effectiveSuccess = p.successfulJobs;
  if (V2_FLAGS.CR_ENABLED && effectiveSybilRisk > 0) {
    const discountFactor = 1.0 - effectiveSybilRisk * 0.8;
    effectiveSuccess = Math.max(0, Math.round(p.successfulJobs * discountFactor));
  }
  const bayesianLCB = ablation?.disableBayesianLCB
    ? Math.max(0.1, p.totalJobs > 0 ? p.successfulJobs / p.totalJobs : 0.5)
    : computeBayesianLCB(effectiveSuccess, p.failedJobs);

  const { entropy: rawEntropy } = await computeCounterpartyEntropy(p.id, edgeCache);

  const totalInteractions = p.totalJobs;
  const entropyConfidence = computeEntropyConfidence(totalInteractions, N);
  const scaleFactor = computeScaleFactor(N);

  // ── R-GHOST 4 / R-GHOST 6 (design §3.4, §C.6) — call-site flag gating ─────
  //
  // The temporal-trust and causal-graph subsystems are gated behind
  // `GHOST_MODULE_FLAGS` (`config.ts`, Task 5.1). When a flag is `false` —
  // the Publication_Preset default — the matching call sites here are
  // bypassed entirely and the surrounding utility arithmetic consumes the
  // identity contribution for that arm:
  //
  //   - causal arm OFF:  causalMultiplier = 1.0  (neutral multiplicand on
  //                      `cliquePenalty`); `causalSuspicion = 0` (neutral
  //                      additive in the utility sum).
  //   - temporal arm OFF: `temporalProfile = EMPTY_TEMPORAL_PROFILE`
  //                       (`reciprocalAmplificationRisk = 0`,
  //                       `diversityMaturity = 1.0`, `economicDepth = 0`)
  //                       and `temporalRiskPenalty = 0`. Every downstream
  //                       consumption flows through a neutral element of
  //                       its arithmetic operation, so the resulting
  //                       `breakdown` and `utility` are bit-equal — within
  //                       1e-9 — to a build with the call sites physically
  //                       removed (R-GHOST 6, Property P5, design §3.5).
  //
  // The engines themselves also short-circuit when their internal `enabled`
  // config flag is `false` (e.g. `TemporalTrustEngine.computeProfile` ⇒
  // `neutralProfile()`, `causalGraph.getCausalPenaltyMultiplier` ⇒ `1.0`).
  // `applyGhostModuleFlags()` mirrors `GHOST_MODULE_FLAGS` onto those
  // configs so the engines no-op as defense in depth, but the call-site
  // bypass is the contract: it discharges R-GHOST 6 directly without
  // depending on any engine-internal behaviour, eliminates the function-
  // call overhead, and makes the gating explicit and auditable.
  const causalMultiplier = GHOST_MODULE_FLAGS.CAUSAL_ENABLED
    ? causalGraph.getCausalPenaltyMultiplier(p.id)
    : 1.0;

  const temporalProfile = GHOST_MODULE_FLAGS.TEMPORAL_ENABLED
    ? temporalEngine.computeProfile(p.id)
    : EMPTY_TEMPORAL_PROFILE;
  const temporalRiskPenalty = GHOST_MODULE_FLAGS.TEMPORAL_ENABLED
    ? temporalEngine.getTemporalPenalty(p.id)
    : 0;
  const reciprocalRisk = temporalProfile.reciprocalAmplificationRisk * 0.1;
  const diversityMaturity = temporalProfile.diversityMaturity;
  const economicDepth = temporalProfile.economicDepth;

  // ── Diversity: trust-weighted entropy preferred when available (Framework 5)
  // v4.0: Ablation-gated — disabled when disableWeightedEntropy or disableAllGraph is set.
  const requiredEntropy = computeRequiredEntropy(N);
  let weightedEntropy = 0;
  if (edgeCache && providerTrustMap && !ablation?.disableWeightedEntropy && !ablation?.disableAllGraph) {
    weightedEntropy = computeWeightedEntropy(p.id, edgeCache, providerTrustMap);
  }
  // Use the larger of raw and weighted entropy so honest interactions with
  // trusted counterparties never receive *less* diversity credit than the
  // unweighted Shannon entropy would award.
  const effectiveEntropy = Math.max(rawEntropy, weightedEntropy);
  const diversityScore = Math.min(effectiveEntropy / requiredEntropy, 1.0);
  candidate.breakdown.diversityScore = round4(diversityScore);

  // Confidence-gated diversity: low-confidence entropy must not penalise
  // honest agents (Requirement 5.6).
  const weightedDiversityScore = 1.0 - (1.0 - diversityScore) * entropyConfidence;

  // ── PPR-from-honest-seed gating (Framework 3) ───────────────────────────────
  // v4.0: Ablation-gated. When PPR or all-graph disabled, pprFactor = 1.0 (no effect).
  // v4.1: Strengthened PPR gating — providers far from honest seed get stronger
  // suppression. Theoretical basis: PPR concentration inequality (Andersen et al. 2006)
  // guarantees that Sybil nodes require edge weight proportional to desired PPR score.
  const pprScore = pprScores?.get(p.id) ?? 0;
  const pprFactor = (ablation?.disablePPR || ablation?.disableAllGraph)
    ? 1.0
    : 0.3 + 0.7 * Math.max(0, Math.min(1, pprScore));

  // Non-boosting cap (Task 5.3, Requirement 2.6): graph features can only penalize, never reward.
  // When adjustedTrust > 0.5, networkDeficit would be 0, effectively boosting providers with high graph trust.
  const adjustedTrust = ablation?.disableAllGraph
    ? 0
    : Math.min(TRACE_HARDENING.adjustedTrustCap, p.networkTrust * weightedDiversityScore * diversityMaturity * pprFactor);
  const sybilPenalty = ablation?.disableAllGraph
    ? 0
    : effectiveSybilPenalty(N) * p.sybilRisk;

  let cliquePenalty = 0;
  if (p.totalJobs >= 3) {
    const entropyDeficit = Math.max(0, 1 - diversityScore);
    const confidenceGatedDeficit = entropyConfidence * entropyDeficit;
    const mu_eff = effectiveCliquePenalty(N);
    cliquePenalty = mu_eff * confidenceGatedDeficit * causalMultiplier;
  }

  // ── R-GHOST: causal-suspicion arm gated by `CAUSAL_ENABLED` (§3.4, §C.6) ──
  // When the flag is off, contribute `0` — the neutral additive for the
  // utility sum — so the call site is bit-equal to a build with this term
  // removed (R-GHOST 6, Property P5).
  const causalSuspicion = GHOST_MODULE_FLAGS.CAUSAL_ENABLED
    ? causalGraph.getCausalSuspicion(p.id) * scaleFactor * 0.1
    : 0;

  // Volatility penalty retained: it operates on the score-stddev signal,
  // which is independent of attack identity.
  // v4.0: Disabled in clean variant (redundant with CUSUM).
  let volatilityPenalty = 0;
  if (!ablation?.useCleanVariant) {
    const normalizedVolatility = Math.min(p.scoreVolatility / VOLATILITY.maxAcceptableVolatility, 1.0);
    volatilityPenalty = VOLATILITY.volatilityPenaltyWeight * normalizedVolatility;
  }

  // ── Velocity / acceleration anomaly term (R-VOLATILITY, design §7.2) ───────
  //
  // Generic non-stationarity penalty consumed from `velocityEngine` (Task 7.1).
  // The engine returns the raw first/second discrete derivatives of the
  // recent score sequence; here we normalise both against the score range
  // (TRACE_MAX_SCORE − TRACE_MIN_SCORE = 1000) and combine them as a
  // half-weighted sum so the contribution is capped at `α_velocity = 0.05`
  // even when both `|v|` and `|a|` saturate to 1.0.
  //
  // Bound derivation (R-VOLATILITY 4 / design §7.2 / Property P8):
  //   The closed-form residual from R-CONFIDENCE 3.2 leaves additive
  //   bonuses on TRACE bounded above by ≈ 0.31 before an honest 50-job
  //   agent can be re-ranked below a zero-history adversary at identical
  //   evidence and price. The velocity anomaly term is a *penalty* (sign
  //   reversed) but the same bound applies in magnitude: `α_velocity = 0.05`
  //   is well below 0.31 and well below `α_traceScore = 0.40`. Even with
  //   both `normV` and `normA` saturating, `velocityAnomaly ≤ 0.05`, so
  //   the term cannot reverse a Bayesian-LCB margin of 0.10 (Property P8).
  //
  // Generalisability (R-VOLATILITY 5, R-INTEGRITY 4): the term reads only
  // |Δscore| and |Δ²score| from the engine; no attack-identity branch.
  // Below `MIN_SAMPLES_FOR_SIGNAL = 3`, `compute(...)` returns null and
  // the contribution is 0 (R-VOLATILITY 6, Property P9 — total below the
  // sample threshold, never throws).
  const velocityResult = velocityEngine.compute(p.id);
  let velocityAnomaly = 0;
  if (velocityResult !== null) {
    const { velocity, acceleration } = velocityResult;
    const scoreRange = TRACE_MAX_SCORE; // TRACE_MIN_SCORE = 0
    const normV = Math.min(1, Math.abs(velocity) / scoreRange);
    const normA = Math.min(1, Math.abs(acceleration) / scoreRange);
    const ALPHA_VELOCITY = 0.05;
    velocityAnomaly = ALPHA_VELOCITY * 0.5 * (normV + normA);
  }

  const economicDepthBonus = ablation?.useCleanVariant ? 0 : economicDepth * 0.03;

  // Neighborhood contamination retained — measured from sybilRisk
  // propagation, not adversary identity (Requirement 15.1/15.2).
  // v4.0: Disabled in clean variant (redundant with PPR).
  const neighborhoodContaminationRisk = (ablation?.useCleanVariant || ablation?.disableAllGraph)
    ? 0
    : (neighborhoodContamination?.get(p.id) ?? 0);
  const neighborhoodContaminationPenalty = neighborhoodContaminationRisk * 0.40;

  // ── Fix 1: Graph trust is evidence of non-suspicion, not evidence of quality.
  // Agents with LOW graph trust are penalized; HIGH graph trust gives no
  // additional routing advantage. Prevents graph inflation attacks from
  // translating into routing preference.
  // Citation: asymmetric information design, Kamenica & Gentzkow (2011).
  //
  // adjustedTrust >= 0.5 → no penalty, no bonus
  // adjustedTrust = 0.0  → penalty of delta_networkTrust * 0.5
  // adjustedTrust = 0.25 → penalty of delta_networkTrust * 0.25
  const networkDeficit = u.delta_networkTrust * Math.max(0, 0.5 - adjustedTrust);

  candidate.breakdown = {
    traceContribution:  round4(u.alpha_traceScore * normalizedTrace),
    defaultPenalty:     round4(u.beta_defaultRisk * p.defaultProbability),
    costPenalty:        round4(u.gamma_cost * normalizedCost),
    networkBonus:       round4(-networkDeficit),
    sybilPenalty:       round4(sybilPenalty),
    cliquePenalty:      round4(cliquePenalty),
    causalSuspicion:    round4(causalSuspicion),
    temporalRiskPenalty: round4(temporalRiskPenalty),
    reciprocalRisk:     round4(reciprocalRisk),
    volatilityPenalty:  round4(volatilityPenalty),
    velocityAnomaly:    round4(velocityAnomaly),
    capabilityBonus:    round4(u.epsilon_capability * capabilityMatch),
    coldStartBonus:     0, // Removed — Bayesian LCB prior provides cold-start floor (Framework 4)
    progressiveTrustCap: 1.0,
    diversityScore:     round4(diversityScore),
    diversityMaturity:  round4(diversityMaturity),
    economicDepth:      round4(economicDepth),
    entropyConfidence:  round4(entropyConfidence),
    scaleFactor:        round4(scaleFactor),
    causalMultiplier:   round4(causalMultiplier),
    behavioralAnomalyPenalty: 0, // Removed — no attack-specific branches (Requirement 15.1)
    perfectionPenalty:  0,        // Removed — perfection is not evidence of fraud
    neighborhoodContaminationPenalty: round4(neighborhoodContaminationPenalty),
  };

  let rawUtility =
    candidate.breakdown.traceContribution
    - candidate.breakdown.defaultPenalty
    - candidate.breakdown.costPenalty
    - networkDeficit
    - candidate.breakdown.sybilPenalty
    - candidate.breakdown.cliquePenalty
    - candidate.breakdown.causalSuspicion
    - candidate.breakdown.temporalRiskPenalty
    - candidate.breakdown.reciprocalRisk
    - candidate.breakdown.volatilityPenalty
    - candidate.breakdown.velocityAnomaly
    + candidate.breakdown.capabilityBonus
    + economicDepthBonus
    - neighborhoodContaminationPenalty;

  // Progressive trust unlocking retained (theoretically grounded as a
  // breakdown-point safeguard — see audit-report Framework 6).
  // v4.0: Disabled in clean variant (redundant with Bayesian LCB).
  const progressiveCap = ablation?.useCleanVariant ? 1.0 : computeProgressiveTrustCap(p);
  candidate.breakdown.progressiveTrustCap = round4(progressiveCap);
  rawUtility *= progressiveCap;

  // Bayesian LCB scaling — Requirement 1.3: rank by a monotone function of
  // the posterior LCB, not a point estimate of the success rate.
  rawUtility *= bayesianLCB;

  // ── Sybil suppression factor (Framework 3 + 6) ─────────────────────────────
  // Theoretical basis: breakdown-point argument. When sybilRisk > 0, the
  // provider's evidence is partially contaminated by artificial interactions.
  // The breakdown point of the Beta posterior is inversely proportional to
  // evidence volume — but sybilRisk indicates the *fraction* of evidence that
  // may be fabricated. Multiplicative suppression ensures that contaminated
  // evidence cannot inflate utility regardless of volume.
  // This replaces the removed exponential dampening with a theoretically
  // grounded mechanism: utility × (1 - sybilRisk)^2.
  if (!(ablation?.disableAllGraph)) {
    const sybilSuppression = Math.pow(Math.max(0, 1 - p.sybilRisk), 2);
    rawUtility *= sybilSuppression;
  }

  // ── TRACE v2.1 Improvement #4: Community Utility Clipping ─────────────────
  // When CR is enabled and sybilRisk > 0.3, cap utility so colluders with
  // inflated scores can never be the top-ranked candidate.
  // The cap scales with (1 - sybilRisk): at risk=0.75, utility is ×0.25.
  // This is a hard ceiling that works regardless of Thompson vs greedy.
  if (V2_FLAGS.CR_ENABLED && effectiveSybilRisk > 0.3) {
    const clipFactor = Math.max(0.05, 1.0 - effectiveSybilRisk);
    rawUtility *= clipFactor;
  }

  // ── TRACE v2.1: Behavioral Failure-Rate Anomaly Penalty ─────────────────
  // Density-independent defense: penalize providers whose failure rate
  // significantly exceeds the honest baseline (5%). This catches adversaries
  // on dense graphs where sybilRisk ≈ 0 (structural detection fails).
  //
  // penalty = (excessRate)^2 → quadratic: gentle for small deviations,
  // harsh for adversaries with 20%+ failure rates.
  // At 10% failure: penalty = 0.0025 (negligible)
  // At 20% failure: penalty = 0.0225 → utility × 0.977
  // At 40% failure: penalty = 0.1225 → utility × 0.878
  // At 60% failure: penalty = 0.3025 → utility × 0.698
  //
  // Only applies after sufficient jobs (≥5) to avoid penalizing newcomers.
  // Citation: Auer et al. (2002) — UCB with empirical penalty terms.
  if (V2_FLAGS.DR_ENABLED && _currentDensityFactor > 0 && p.totalJobs >= 5) {
    const HONEST_BASELINE_FAILURE = 0.05;
    const failureRate = p.failedJobs / p.totalJobs;
    const excessRate = Math.max(0, failureRate - HONEST_BASELINE_FAILURE);
    const behavioralPenalty = excessRate * excessRate;
    rawUtility *= Math.max(0.05, 1.0 - behavioralPenalty * 10);
  }

  if (!Number.isFinite(rawUtility)) rawUtility = 0;
  candidate.utility = round4(rawUtility);

  // ── Post-fraud cooldown (Task 5.2, Requirement 2.4) ─────────────────────────
  // Providers who defaulted within the last N rounds have their utility
  // heavily suppressed (×0.01) to prevent immediate re-routing after fraud.
  // This is soft exclusion — the provider is technically eligible but with
  // near-zero utility, so it will almost never win the selection.
  // Attack-agnostic: applies to ANY provider that defaulted recently,
  // regardless of attack type or adversary identity.
  // v4.4: Exponential cooldown escalation — duration doubles per successive default.
  const lastDefaultRound = getLastDefaultRound(p.id);
  if (lastDefaultRound !== undefined) {
    const effectiveCooldown = getEffectiveCooldownRounds(p.id);
    if (round - lastDefaultRound <= effectiveCooldown) {
      candidate.utility = round4(candidate.utility * TRACE_HARDENING.cooldownMultiplier);
    }
  }

  // ── Sensitive CUSUM soft suppression (Framework 6b, v4.3) ───────────────────
  //
  // The primary CUSUM (K=0.625, H=4.2) only alarms when failure rate exceeds
  // ~37.5%. The sensitive CUSUM (K₂=0.90, H₂=2.5) detects moderate failure
  // rates (10-20%) that characterize the trust-building phase of coordinated
  // attacks. Instead of hard rejection, it applies proportional utility
  // suppression based on the statistic's magnitude.
  //
  // This addresses the root cause: at N=1000, 90% of ring agents have zero
  // graph edges and sybilRisk=0, but they DO have elevated failure rates
  // (15% vs honest 5%) that the sensitive CUSUM can detect.
  //
  // Citation: Tartakovsky & Veeravalli (2005) "General asymptotic Bayesian
  // theory of quickest change detection" — multi-scale CUSUM with graded
  // response is optimal for detecting shifts of unknown magnitude.
  //
  // Attack-agnostic: reads only the cusumSensitive statistic, which is
  // updated identically for all providers regardless of identity.
  if (!ablation?.disableCUSUM) {
    const cusumSensitive = p.cusumSensitive ?? 0;
    if (Number.isFinite(cusumSensitive) && cusumSensitive > CUSUM_SENSITIVE_SUPPRESSION.activationThreshold) {
      // Proportional suppression: linearly interpolate between 1.0 and floor
      // based on how far the statistic has progressed toward the alarm threshold.
      const progress = Math.min(1.0, cusumSensitive / CUSUM_H_SENSITIVE);
      const suppressionFactor = Math.max(
        CUSUM_SENSITIVE_SUPPRESSION.floor,
        1.0 - progress * (1.0 - CUSUM_SENSITIVE_SUPPRESSION.floor)
      );
      candidate.utility = round4(candidate.utility * suppressionFactor);
    }
  }

  // ── Round-level anomaly suppression (v4.4, Fix #3) ──────────────────────────
  // Agents who failed in anomalous rounds (z > 2.0 above mean failure rate)
  // receive temporary utility suppression. Decays over 5 rounds.
  // Citation: Shewhart (1931); Chandola et al. (2009).
  const roundSusp = getRoundSuspicion(p.id);
  if (roundSusp > 0) {
    candidate.utility = round4(candidate.utility * (1.0 - roundSusp));
  }

  // ── Record this round's score sample for the velocity engine ──────────────
  // Pushed AFTER the utility is finalised so the engine accumulates the agent's
  // current TRACE score for the NEXT round's anomaly computation. Honest agents
  // with smooth score trajectories produce near-zero |Δ| / |Δ²|; non-stationary
  // sequences (whitewash recovery, collusion-driven inflation, sybil-burst
  // crashes) produce a bounded penalty per the algebra above. Below the
  // sample threshold (HISTORY_LENGTH < 3) the next compute() returns null
  // and the consumer maps it to anomalyTerm = 0 (Property P9).
  velocityEngine.push(p.id, round, p.traceScore, networkSize ?? 50);
}

/**
 * v2: Progressive trust unlocking.
 * Returns a multiplier in [0.05, 1.0].
 */
function computeProgressiveTrustCap(p: Provider): number {
  if (p.totalJobs >= PROGRESSIVE_TRUST.minJobsForFullAccess) {
    const matureFailureRate = p.totalJobs > 0 ? p.failedJobs / p.totalJobs : 0;
    if (matureFailureRate > 0.25) {
      return Math.max(0.10, 1.0 - (matureFailureRate - 0.25));
    }
    return 1.0;
  }

  const effectiveJobs = Math.max(0, p.successfulJobs - p.failedJobs * 2);
  let access = effectiveJobs * PROGRESSIVE_TRUST.accessScalePerJob;

  if (p.stakeSats > 0) {
    access *= PROGRESSIVE_TRUST.stakeBoostMultiplier;
  }

  if (p.scoreVolatility > VOLATILITY.maxAcceptableVolatility * 1.5) {
    return 0.05;
  }

  // v2.6: Whitewash-suspect — suppress utility hard
  if (p.totalJobs < 3 && p.scoreVolatility > 0) {
    return 0.03;
  }

  return Math.min(Math.max(access, 0.10), 1.0);
}

/**
 * Baseline: reputation-only routing.
 * v3.0 Audit Fix A3: Added hard filter (reject rep < 2.0 or failure rate > 50%).
 */
function computeReputationUtility(
  candidate: CandidateScore,
  p: Provider,
  maxPrice: number
): void {
  // v3.0 Audit Fix A3: Hard filter for REPUTATION baseline.
  // Reject providers with very low reputation or high failure rate.
  if (p.reputationScore < 2.0) {
    candidate.rejected = true;
    candidate.reason = `reputation_too_low: ${p.reputationScore.toFixed(2)} < 2.0`;
    return;
  }
  if (p.totalJobs >= 3 && p.failedJobs / p.totalJobs > 0.5) {
    candidate.rejected = true;
    candidate.reason = `baseline_failure_rate_too_high: ${((p.failedJobs / p.totalJobs) * 100).toFixed(0)}%`;
    return;
  }

  const normalizedRep = p.reputationScore / 5.0;
  const effectivePrice = p.priceSats * (p.bidMultiplier ?? 1.0);
  const normalizedCost = effectivePrice / maxPrice;

  const stakeBonus = p.stakeStatus === "staked" ? 0.06 : 0;
  const coldStart = p.totalJobs < 3 ? 0.10 : 0;

  candidate.breakdown = {
    traceContribution: round4(normalizedRep),
    defaultPenalty: 0,
    costPenalty: round4(normalizedCost * 0.3),
    networkBonus: round4(stakeBonus),
    sybilPenalty: 0,
    cliquePenalty: 0,
    causalSuspicion: 0,
    temporalRiskPenalty: 0,
    reciprocalRisk: 0,
    volatilityPenalty: 0,
    velocityAnomaly: 0,
    capabilityBonus: 0,
    coldStartBonus: round4(coldStart),
    progressiveTrustCap: 1.0,
    diversityScore: 1.0,
    diversityMaturity: 1.0,
    economicDepth: 0,
    entropyConfidence: 1.0,
    scaleFactor: 1.0,
    causalMultiplier: 1.0,
    behavioralAnomalyPenalty: 0,
    perfectionPenalty: 0,
    neighborhoodContaminationPenalty: 0,
  };

  // v2.6: Observation uncertainty jitter
  const uncertainty = p.totalJobs < 8 ? (1.0 - p.totalJobs / 8) * 0.3 : 0;
  const jitter = uncertainty > 0 ? (Math.random() - 0.5) * 2 * uncertainty : 0;

  candidate.utility = round4(
    normalizedRep + stakeBonus + coldStart - normalizedCost * 0.3 + jitter
  );
}

/**
 * Baseline: price-only routing.
 * v3.0 Audit Fix A3: Added hard filter (reject failure rate > 50%).
 */
function computePriceUtility(
  candidate: CandidateScore,
  p: Provider,
  maxPrice: number
): void {
  // v3.0 Audit Fix A3: Hard filter for PRICE baseline.
  if (p.totalJobs >= 3 && p.failedJobs / p.totalJobs > 0.5) {
    candidate.rejected = true;
    candidate.reason = `baseline_failure_rate_too_high: ${((p.failedJobs / p.totalJobs) * 100).toFixed(0)}%`;
    return;
  }

  const effectivePrice = p.priceSats * (p.bidMultiplier ?? 1.0);
  const normalizedCost = effectivePrice / maxPrice;

  candidate.breakdown = {
    traceContribution: 0,
    defaultPenalty: 0,
    costPenalty: round4(normalizedCost),
    networkBonus: 0,
    sybilPenalty: 0,
    cliquePenalty: 0,
    causalSuspicion: 0,
    temporalRiskPenalty: 0,
    reciprocalRisk: 0,
    volatilityPenalty: 0,
    velocityAnomaly: 0,
    capabilityBonus: 0,
    coldStartBonus: 0,
    progressiveTrustCap: 1.0,
    diversityScore: 1.0,
    diversityMaturity: 1.0,
    economicDepth: 0,
    entropyConfidence: 1.0,
    scaleFactor: 1.0,
    causalMultiplier: 1.0,
    behavioralAnomalyPenalty: 0,
    perfectionPenalty: 0,
    neighborhoodContaminationPenalty: 0,
  };

  // v2.6: Observation uncertainty jitter
  const uncertainty = p.totalJobs < 8 ? (1.0 - p.totalJobs / 8) * 0.3 : 0;
  const jitter = uncertainty > 0 ? (Math.random() - 0.5) * 2 * uncertainty : 0;

  candidate.utility = round4((1 - normalizedCost) + jitter);
}

// ─── EigenTrust Score Computation (Power Iteration) ───────────────────────────

/**
 * Compute global EigenTrust scores via power iteration on the transpose of
 * the row-stochastic local trust matrix (Kamvar et al., 2003).
 *
 * Algorithm:
 *   t^(k+1) = (1-α)·C^T·t^(k) + α·e
 * where:
 *   - C is the row-stochastic local trust matrix from `buildLocalTrustMatrix`
 *   - α is the damping/teleportation probability (EIGENTRUST_CONFIG.alpha)
 *   - e is the uniform pre-trust vector (1/N for all providers)
 *
 * Sparse implementation: O(E + Z×N) per iteration where E is the number of
 * edges and Z is the number of zero-row nodes.
 *
 * Stopping criteria:
 *   - L1 norm change < EIGENTRUST_CONFIG.convergenceThreshold
 *   - OR maxIterations reached
 *
 * @param edgeCache - Pre-built in-memory edge cache
 * @param providerIds - List of all provider IDs to include
 * @returns Map<string, number> — EigenTrust scores summing to ~1.0, all in [0,1]
 *
 * _Requirements: 2.1_
 */
export function computeEigenTrustScores(
  edgeCache: EdgeCache,
  providerIds: string[]
): Map<string, number> {
  const N = providerIds.length;
  const result = new Map<string, number>();

  if (N === 0) return result;

  const alpha = EIGENTRUST_CONFIG.alpha;
  const maxIter = EIGENTRUST_CONFIG.maxIterations;
  const threshold = EIGENTRUST_CONFIG.convergenceThreshold;
  const uniformPreTrust = 1 / N;

  // Build the local trust matrix (sparse, row-stochastic)
  const { matrix } = buildLocalTrustMatrix(edgeCache, providerIds);

  // Index providers for array-based iteration
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    idToIdx.set(providerIds[i], i);
  }

  // Initialize trust vector: uniform t^(0) = 1/N
  let tCurrent = new Float64Array(N).fill(uniformPreTrust);
  let tNext = new Float64Array(N);

  // Power iteration
  for (let iter = 0; iter < maxIter; iter++) {
    // Step 1: Initialize t^(k+1) to α/N for all providers (pre-trust component)
    tNext.fill(alpha * uniformPreTrust);

    // Step 2: For each provider i, distribute trust to targets
    // Sparse matrix-vector multiply: t_j^(k+1) += (1-α) × C_ij × t_i^(k)
    // Also track which providers have rows in the matrix (non-zero-row nodes)
    const oneMinusAlpha = 1 - alpha;

    // Accumulate trust from zero-row nodes (uniform distribution)
    let zeroRowTrustMass = 0;

    for (let i = 0; i < N; i++) {
      const providerId = providerIds[i];
      const row = matrix.get(providerId);

      if (row && row.size > 0) {
        // Non-zero-row: distribute trust to specific targets
        for (const [targetId, c_ij] of row) {
          const j = idToIdx.get(targetId);
          if (j !== undefined) {
            tNext[j] += oneMinusAlpha * c_ij * tCurrent[i];
          }
        }
      } else {
        // Zero-row node: its trust mass is distributed uniformly
        zeroRowTrustMass += tCurrent[i];
      }
    }

    // Step 3: Distribute zero-row trust mass uniformly to all providers
    if (zeroRowTrustMass > 0) {
      const uniformShare = oneMinusAlpha * uniformPreTrust * zeroRowTrustMass;
      // Since uniformPreTrust = 1/N, this is (1-α) × (1/N) × Σ t_i for zero-row i
      // But we need (1-α) × (1/N) × t_i for EACH zero-row i summed over all j
      // Which equals (1-α) × (1/N) × zeroRowTrustMass for each j
      for (let j = 0; j < N; j++) {
        tNext[j] += uniformShare;
      }
    }

    // Step 4: Compute L1 norm of change
    let l1Norm = 0;
    for (let j = 0; j < N; j++) {
      l1Norm += Math.abs(tNext[j] - tCurrent[j]);
    }

    // Swap buffers
    const temp = tCurrent;
    tCurrent = tNext;
    tNext = temp;

    // Step 5: Check convergence
    if (l1Norm < threshold) {
      break;
    }
  }

  // Build result map
  for (let i = 0; i < N; i++) {
    result.set(providerIds[i], tCurrent[i]);
  }

  return result;
}

/**
 * Baseline: EigenTrust routing — clean EigenTrust baseline for valid scientific comparison.
 *
 * Computes utility as: eigenTrustScore × (1 - costWeight × normalizedCost) × failureFilter
 *
 * NO TRACE-specific penalties: no sybil, no clique, no CUSUM, no PPR, no behavioral anomaly.
 * This ensures the EigenTrust baseline is a clean implementation of Kamvar et al. (2003)
 * for valid scientific comparison against TRACE.
 *
 * v3.0 Audit Fix A3: Added hard filter (reject unstaked + failures, or failure rate > 50%).
 *
 * _Bug_Condition: condA — STAKE_WEIGHTED used linear formula instead of EigenTrust_
 * _Expected_Behavior: EigenTrust scores via power iteration with convergence guarantees_
 * _Preservation: No TRACE penalties applied — clean baseline_
 * _Requirements: 2.1, 2.2_
 */
export function computeEigenTrustUtility(
  candidate: CandidateScore,
  p: Provider,
  maxPrice: number,
  eigenTrustScores: Map<string, number>
): void {
  // v3.0 Audit Fix A3: Hard filter for EIGENTRUST baseline.
  if (p.totalJobs >= 3 && p.failedJobs / p.totalJobs > 0.5) {
    candidate.rejected = true;
    candidate.reason = `baseline_failure_rate_too_high: ${((p.failedJobs / p.totalJobs) * 100).toFixed(0)}%`;
    return;
  }
  if (p.stakeSats === 0 && p.failedJobs > 0) {
    candidate.rejected = true;
    candidate.reason = `unstaked_with_failures: stake=0, failures=${p.failedJobs}`;
    return;
  }

  // Look up pre-computed EigenTrust score for this provider
  const eigenTrustScore = eigenTrustScores.get(p.id) ?? 0;

  // Normalized cost: priceSats / maxPrice ∈ [0, 1]
  const normalizedCost = p.priceSats / maxPrice;

  // Failure filter: same basic filter as other baselines.
  // Only penalize providers with sufficient history (≥ 8 jobs) using their
  // defaultProbability. Providers with fewer jobs get no failure penalty.
  const failureFilter = p.totalJobs >= 8 ? (1 - p.defaultProbability) : 1.0;

  // Final utility: eigenTrustScore × (1 - costWeight × normalizedCost) × failureFilter
  // NO TRACE-specific penalties: no sybil, no clique, no CUSUM, no PPR, no behavioral anomaly.
  const costPenalty = EIGENTRUST_CONFIG.costWeight * normalizedCost;
  const utility = eigenTrustScore * (1 - costPenalty) * failureFilter;

  candidate.breakdown = {
    traceContribution: round4(eigenTrustScore),
    defaultPenalty: round4(p.defaultProbability),
    costPenalty: round4(costPenalty),
    networkBonus: 0,
    sybilPenalty: 0,
    cliquePenalty: 0,
    causalSuspicion: 0,
    temporalRiskPenalty: 0,
    reciprocalRisk: 0,
    volatilityPenalty: 0,
    velocityAnomaly: 0,
    capabilityBonus: 0,
    coldStartBonus: 0,
    progressiveTrustCap: 1.0,
    diversityScore: 1.0,
    diversityMaturity: 1.0,
    economicDepth: 0,
    entropyConfidence: 1.0,
    scaleFactor: 1.0,
    causalMultiplier: 1.0,
    behavioralAnomalyPenalty: 0,
    perfectionPenalty: 0,
    neighborhoodContaminationPenalty: 0,
  };

  candidate.utility = round4(utility);
}

/**
 * Baseline: TrustFlow routing — reproduction of Seliuchenko 2026
 * (arXiv:2603.19452)'s contraction-mapping propagation for direct comparison
 * against TRACE and EIGENTRUST. See computeTrustFlowScores (trustGraph.ts)
 * for the mechanism and TRUSTFLOW_CONFIG (config.ts) for parameter
 * provenance and fidelity notes.
 *
 * Same architectural treatment as EIGENTRUST: identical hard filters, same
 * cost-blend weight, no TRACE-specific penalties (no sybil/clique/CUSUM/PPR/
 * behavioral anomaly) — a clean baseline for valid comparison.
 */
export function computeTrustFlowUtility(
  candidate: CandidateScore,
  p: Provider,
  maxPrice: number,
  trustFlowScores: Map<string, number>
): void {
  if (p.totalJobs >= 3 && p.failedJobs / p.totalJobs > 0.5) {
    candidate.rejected = true;
    candidate.reason = `baseline_failure_rate_too_high: ${((p.failedJobs / p.totalJobs) * 100).toFixed(0)}%`;
    return;
  }
  if (p.stakeSats === 0 && p.failedJobs > 0) {
    candidate.rejected = true;
    candidate.reason = `unstaked_with_failures: stake=0, failures=${p.failedJobs}`;
    return;
  }

  const trustFlowScore = trustFlowScores.get(p.id) ?? 0;
  const normalizedCost = p.priceSats / maxPrice;
  const failureFilter = p.totalJobs >= 8 ? (1 - p.defaultProbability) : 1.0;
  const costPenalty = TRUSTFLOW_CONFIG.costWeight * normalizedCost;
  const utility = trustFlowScore * (1 - costPenalty) * failureFilter;

  candidate.breakdown = {
    traceContribution: round4(trustFlowScore),
    defaultPenalty: round4(p.defaultProbability),
    costPenalty: round4(costPenalty),
    networkBonus: 0,
    sybilPenalty: 0,
    cliquePenalty: 0,
    causalSuspicion: 0,
    temporalRiskPenalty: 0,
    reciprocalRisk: 0,
    volatilityPenalty: 0,
    velocityAnomaly: 0,
    capabilityBonus: 0,
    coldStartBonus: 0,
    progressiveTrustCap: 1.0,
    diversityScore: 1.0,
    diversityMaturity: 1.0,
    economicDepth: 0,
    entropyConfidence: 1.0,
    scaleFactor: 1.0,
    causalMultiplier: 1.0,
    behavioralAnomalyPenalty: 0,
    perfectionPenalty: 0,
    neighborhoodContaminationPenalty: 0,
  };

  candidate.utility = round4(utility);
}

// ─── Routing Decision Instrumentation ─────────────────────────────────────────

async function logRoutingDecision(
  capability: string,
  selectedProviderId: string,
  utilityScore: number,
  candidates: CandidateScore[],
  policy: RoutingPolicy,
  experimentId?: string,
  jobId?: string
): Promise<void> {
  // v4.1 Perf: Skip logging entirely during experiments (saves N×rounds×jobs DB writes)
  if (experimentId) return;
  await prisma.routingDecision.create({
    data: {
      jobId: jobId ?? null,
      capability,
      selectedProviderId,
      utilityScore: round4(utilityScore),
      candidateScores: candidates.length >= 50 ? "[]" : JSON.stringify(candidates),
      routingPolicy: policy,
      experimentId: experimentId ?? null,
    },
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}