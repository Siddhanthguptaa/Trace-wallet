/**
 * TRACE scoring port (BUILD.md M6 step 4, IDEA.md 7.5).
 *
 * Ported from the vendored Trace_CIKM fork @94c4b9f in sim/src/lib/trace (read-only), with the
 * Prisma I/O removed: every function here takes plain data. Formulas, constants and evaluation
 * order are copied verbatim; each block names its source as `fork: <file>#<function>`.
 * Settings are the paper's publication preset: ROUTING_UTILITY "baseline" (Eq. 1 weights),
 * V2 flags (DR/CR) off, temporal and causal ghost modules off, adaptive scaling on.
 *
 * services/attestor/test/port.test.ts runs the fork itself (through test/fork/oracle.ts) on fixed
 * inputs and checks that this port returns the same numbers.
 */

// ─── fork: config.ts ─────────────────────────────────────────────────────────

export const TRACE_WEIGHTS = {
  w1_completionRate: 0.25,
  w2_repaymentRate: 0.2,
  w3_networkTrust: 0.1,
  w4_stakeRatio: 0.1,
  w5_successfulEscrowRate: 0.15,
  w6_defaultProbability: 0.3,
  w7_sybilRisk: 0.25,
  w8_disputeRate: 0.1,
} as const;
export const TRACE_MAX_SCORE = 1000;
export const TRACE_MIN_SCORE = 0;
export const RISK_TIERS = {
  A: { min: 850 },
  B: { min: 700 },
  C: { min: 550 },
  D: { min: 0 },
} as const;
export type RiskTier = keyof typeof RISK_TIERS;
export const DEFAULT_PROB_WEIGHTS = {
  repaymentFailureWeight: 0.3,
  disputeWeight: 0.2,
  recentInstabilityWeight: 0.25,
  stakePenaltyWeight: 0.1,
  historyWeight: 0.15,
} as const;
export const RECENT_FAILURE = { windowRounds: 5, amplificationMultiplier: 2.5, decayPerRound: 0.3 } as const;
/** Paper Eq. 1 weights (preset "baseline"). */
export const ROUTING_UTILITY = {
  alpha_traceScore: 0.4,
  beta_defaultRisk: 0.3,
  gamma_cost: 0.15,
  delta_networkTrust: 0.1,
  epsilon_capability: 0.1,
  lambda_sybilPenalty: 0.35,
  mu_cliquePenalty: 0.25,
} as const;
export const ROUTING_CONSTRAINTS = {
  minTraceScore: 300,
  maxDefaultProbability: 0.55,
  maxSybilRisk: 0.5,
  maxActiveDisputes: 3,
  maxFailureRate: 0.3,
  minJobsForFailureFilter: 3,
} as const;
export const CUSUM_SENSITIVE_SUPPRESSION = { floor: 0.3, proportional: true, activationThreshold: 1.0 } as const;
export const TRACE_HARDENING = { cooldownRounds: 5, cooldownMultiplier: 0.01, adjustedTrustCap: 0.5, penaltyLogBase: 100 } as const;
export const SPECTRAL_GAP_CONFIG = {
  threshold: 0.85,
  gamma: 3,
  minSCCSize: 3,
  maxIterations: 30,
  convergenceThreshold: 1e-4,
  participationThreshold: 0.3,
} as const;
export const PROGRESSIVE_TRUST = { minJobsForFullAccess: 10, accessScalePerJob: 0.1, stakeBoostMultiplier: 1.5 } as const;
export const TRUST_GRAPH_VALIDATION = {
  maxNetworkTrust: 0.8,
  minDiverseEdges: 3,
  clusterInteractionPenalty: 0.5,
  circularPenaltyPerCycle: 0.15,
  maxCircularPenalty: 0.6,
  edgeWeightCap: 5.0,
} as const;
export const REPEATED_PAIR = { decayConstant: 3.0, maxSinglePairContribution: 0.15 } as const;
export const ECONOMIC_VOLUME_WEIGHTING = { minVolumeForFullWeight: 20 } as const;
export const TRUST_DECAY = { halfLifeMs: 5 * 24 * 60 * 60 * 1000 } as const;
export const VOLATILITY = { maxAcceptableVolatility: 80, volatilityPenaltyWeight: 0.15 } as const;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── fork: adaptiveConfig.ts ─────────────────────────────────────────────────

export const ADAPTIVE_SCALING = { minPenaltyScale: 0.3, entropyConfidenceK: 15, decayMaturityK: 10, enabled: true } as const;

export function computeScaleFactor(networkSize: number): number {
  const targetScale = Math.max(100, networkSize / 2);
  const raw = networkSize / targetScale;
  return Math.max(ADAPTIVE_SCALING.minPenaltyScale, Math.min(1.0, raw));
}
export function nonSaturatingPenaltyScale(networkSize: number): number {
  const N = Math.max(1, networkSize);
  return 1 + Math.log2(Math.max(1, N / 100));
}
export function computeRequiredEntropy(networkSize: number): number {
  if (networkSize <= 30) return 1.5;
  return 1.5 + 0.5 * Math.log2(networkSize / 30);
}
export function effectiveCliquePenalty(networkSize: number): number {
  return ROUTING_UTILITY.mu_cliquePenalty * nonSaturatingPenaltyScale(networkSize);
}
export function effectiveSybilPenalty(networkSize: number): number {
  return ROUTING_UTILITY.lambda_sybilPenalty * nonSaturatingPenaltyScale(networkSize);
}
export function computeEntropyConfidence(totalInteractions: number, networkSize: number): number {
  const kScaled = ADAPTIVE_SCALING.entropyConfidenceK * Math.log2(Math.max(2, networkSize));
  return Math.min(1.0, totalInteractions / kScaled);
}
export function computeMaturityFactor(networkSize: number, diversityScore: number): number {
  const scaleFactor = computeScaleFactor(networkSize);
  const rawMaturity = 1.5 - scaleFactor * 0.5 - diversityScore * 0.5;
  return Math.max(0.5, Math.min(1.5, rawMaturity));
}
export function effectiveDecayConstant(networkSize: number, diversityScore: number): number {
  return REPEATED_PAIR.decayConstant * computeMaturityFactor(networkSize, diversityScore);
}
export function trustPropagationDepth(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(4, Math.ceil(Math.log2(N)));
}
export function pprMaxIter(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(50, Math.ceil(Math.log2(N) * 5));
}
export function edgeWeightCapForN(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(5, Math.log2(N));
}
export function computeEntropyConfidenceFloor(networkSize: number): number {
  const N = Math.max(2, networkSize);
  return Math.max(10, Math.ceil(Math.log2(N) * 2));
}

// ─── fork: traceScore.ts ─────────────────────────────────────────────────────

/** fork: traceScore.ts#computeBayesianLCB (Wilson 95% LCB, Beta(1,3) prior). */
export function computeBayesianLCB(successes: number, failures: number, alpha_prior = 1, beta_prior = 3): number {
  const a = Math.max(0, successes) + alpha_prior;
  const b = Math.max(0, failures) + beta_prior;
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

export const CUSUM_K = 0.625;
export const CUSUM_H = 4.2;
export const CUSUM_K_SENSITIVE = 0.9;
export const CUSUM_H_SENSITIVE = 2.5;

/** fork: traceScore.ts#updateCUSUMScore */
export function updateCUSUMScore(current: number, outcome: 0 | 1): { newScore: number; alarm: boolean } {
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
  const x = outcome === 1 ? 0 : 1;
  const newScore = Math.max(0, safeCurrent + x - (1 - CUSUM_K));
  return { newScore: round4(newScore), alarm: newScore > CUSUM_H };
}

/** fork: traceScore.ts#updateCUSUMSensitive */
export function updateCUSUMSensitive(current: number, outcome: 0 | 1): { newScore: number; alarm: boolean } {
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
  const x = outcome === 1 ? 0 : 1;
  const newScore = Math.max(0, safeCurrent + x - (1 - CUSUM_K_SENSITIVE));
  return { newScore: round4(newScore), alarm: newScore > CUSUM_H_SENSITIVE };
}

export interface TraceScoreInput {
  completionRate: number;
  repaymentRate: number;
  networkTrust: number;
  stakeRatio: number;
  successfulEscrowRate: number;
  defaultProbability: number;
  sybilRisk: number;
  disputeRate: number;
}

export function computeRiskTier(traceScore: number): RiskTier {
  if (traceScore >= RISK_TIERS.A.min) return 'A';
  if (traceScore >= RISK_TIERS.B.min) return 'B';
  if (traceScore >= RISK_TIERS.C.min) return 'C';
  return 'D';
}

/** fork: traceScore.ts#computeTraceScore (composite [0, 1000]); returns the score and tier. */
export function computeTraceScore(input: TraceScoreInput): { traceScore: number; riskTier: RiskTier; defaultProbability: number } {
  const w = TRACE_WEIGHTS;
  const completionContribution = w.w1_completionRate * input.completionRate;
  const repaymentContribution = w.w2_repaymentRate * input.repaymentRate;
  const networkTrustContribution = w.w3_networkTrust * input.networkTrust;
  const stakeContribution = w.w4_stakeRatio * input.stakeRatio;
  const escrowContribution = w.w5_successfulEscrowRate * input.successfulEscrowRate;
  const defaultPenalty = w.w6_defaultProbability * input.defaultProbability;
  const sybilPenalty = w.w7_sybilRisk * input.sybilRisk;
  const disputePenalty = w.w8_disputeRate * input.disputeRate;
  const positiveSum =
    completionContribution + repaymentContribution + networkTrustContribution + stakeContribution + escrowContribution;
  const negativeSum = defaultPenalty + sybilPenalty + disputePenalty;
  const netSignal = positiveSum - negativeSum;
  const signalRange = 0.85 + 0.45;
  const normalized = (netSignal + 0.45) / signalRange;
  const rawScore = normalized * TRACE_MAX_SCORE;
  const traceScore = clamp(Math.round(rawScore * 100) / 100, TRACE_MIN_SCORE, TRACE_MAX_SCORE);
  return { traceScore, riskTier: computeRiskTier(traceScore), defaultProbability: input.defaultProbability };
}

export interface DefaultProbabilityInput {
  totalJobs: number;
  failedJobs: number;
  defaultedJobs: number;
  disputedJobs: number;
  scoreVolatility: number;
  stakeSats: number;
  totalEconomicVolume: number;
  repaymentRate: number;
  recentFailureSignal?: number;
}

/** fork: traceScore.ts#computeDefaultProbability */
export function computeDefaultProbability(provider: DefaultProbabilityInput): number {
  if (provider.totalJobs === 0) return 0.2;
  const w = DEFAULT_PROB_WEIGHTS;
  const repaymentFailure = 1.0 - provider.repaymentRate;
  const disputeSignal = provider.totalJobs > 0 ? provider.disputedJobs / provider.totalJobs : 0;
  const instabilitySignal = Math.min(provider.scoreVolatility / 100, 1.0);
  const stakeRatio =
    provider.totalEconomicVolume > 0 ? provider.stakeSats / provider.totalEconomicVolume : provider.stakeSats > 0 ? 0.5 : 0;
  const stakePenalty = 1.0 - Math.min(stakeRatio * 10, 1.0);
  const historyDepth = Math.min(provider.totalJobs / 20, 1.0);
  const historyPenalty = 1.0 - historyDepth;
  const recentFailureSignal = provider.recentFailureSignal ?? 0;
  const amplifiedRepaymentFailure = Math.min(
    repaymentFailure * (1 + recentFailureSignal * (RECENT_FAILURE.amplificationMultiplier - 1)),
    1.0,
  );
  const rawProb =
    w.repaymentFailureWeight * amplifiedRepaymentFailure +
    w.disputeWeight * disputeSignal +
    w.recentInstabilityWeight * instabilitySignal +
    w.stakePenaltyWeight * stakePenalty +
    w.historyWeight * historyPenalty;
  return clamp(Math.round(rawProb * 10000) / 10000, 0, 1);
}

/** fork: traceScore.ts#computeVolatility (std of the last scores plus the new one). */
export function computeVolatility(recentScores: number[], newScore: number): number {
  const scores = [...recentScores, newScore];
  if (scores.length < 2) return 0;
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
  return round4(Math.sqrt(variance));
}

/** fork: traceScore.ts#computeRecentFailureSignal (jobs carry their round directly). */
export function computeRecentFailureSignal(jobs: Array<{ failed: boolean; round: number | null }>): number {
  const roundJobs = jobs.filter((j): j is { failed: boolean; round: number } => j.round !== null);
  if (roundJobs.length === 0) return 0;
  const latestRound = Math.max(...roundJobs.map((j) => j.round));
  let weightedFailures = 0;
  let weightedTotal = 0;
  for (const job of roundJobs) {
    const age = latestRound - job.round;
    if (age < 0 || age >= RECENT_FAILURE.windowRounds) continue;
    const weight = Math.max(0, 1 - age * RECENT_FAILURE.decayPerRound);
    weightedTotal += weight;
    if (job.failed) weightedFailures += weight;
  }
  return weightedTotal > 0 ? Math.min(weightedFailures / weightedTotal, 1.0) : 0;
}

/** One job of a payee, as the fork's Job + EconomicEvent rows would hold it. */
export interface PortJob {
  success: boolean;
  /** price in volume units (the fork's sats). */
  price: number;
  round: number | null;
  /** a DEFAULT economic event was logged for this job (the runner logs one per failure). */
  defaulted: boolean;
}

export interface RecomputedMetrics {
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  defaultedJobs: number;
  disputedJobs: number;
  completionRate: number;
  repaymentRate: number;
  successfulEscrowRate: number;
  disputeRate: number;
  stakeRatio: number;
  recentFailureSignal: number;
  totalEconomicVolume: number;
}

/**
 * fork: traceScore.ts#recomputeMetrics. Escrow follows the runner: success -> "released",
 * failure -> "refunded". No stake and no disputes exist on this rail, so both are 0.
 */
export function recomputeMetrics(jobs: PortJob[], stakeSats = 0): RecomputedMetrics {
  const totalJobs = jobs.length;
  const successfulJobs = jobs.filter((j) => j.success).length;
  const failedJobs = jobs.filter((j) => !j.success).length;
  const defaultedJobs = jobs.filter((j) => j.defaulted).length;
  const disputedJobs = 0;
  const totalEconomicVolume = jobs.reduce((s, j) => s + j.price, 0);
  const successfulVolume = jobs.filter((j) => j.success).reduce((s, j) => s + j.price, 0);
  const completionRate = totalEconomicVolume > 0 ? successfulVolume / totalEconomicVolume : 1.0;
  const defaultedVolume = jobs.filter((j) => j.defaulted).reduce((s, j) => s + j.price, 0);
  const repaymentRate = totalEconomicVolume > 0 ? 1.0 - defaultedVolume / totalEconomicVolume : 1.0;
  const releasedEscrowVolume = jobs.filter((j) => j.success).reduce((s, j) => s + j.price, 0);
  const totalEscrowVolume = totalEconomicVolume;
  const successfulEscrowRate = totalEscrowVolume > 0 ? releasedEscrowVolume / totalEscrowVolume : 1.0;
  const disputeRate = 0.0;
  const recentFailureSignal = computeRecentFailureSignal(jobs.map((j) => ({ failed: !j.success, round: j.round })));
  const stakeRatio = totalEconomicVolume > 0 ? Math.min(stakeSats / totalEconomicVolume, 1.0) : stakeSats > 0 ? 0.5 : 0.0;
  return {
    totalJobs,
    successfulJobs,
    failedJobs,
    defaultedJobs,
    disputedJobs,
    completionRate: round4(completionRate),
    repaymentRate: round4(repaymentRate),
    successfulEscrowRate: round4(successfulEscrowRate),
    disputeRate: round4(disputeRate),
    stakeRatio: round4(stakeRatio),
    recentFailureSignal: round4(recentFailureSignal),
    totalEconomicVolume,
  };
}

export interface ScoreState {
  traceScore: number;
  riskTier: RiskTier;
  defaultProbability: number;
  scoreVolatility: number;
  cusumScore: number;
  cusumSensitive: number;
  metrics: RecomputedMetrics;
  /** traceScore after every economic event, oldest first (the fork's ScoreHistory). */
  history: number[];
}

/**
 * Replays one payee's jobs through the fork's per-job event sequence
 * (experiments/runner.ts + traceScore.ts#updateScoreAfterEvent):
 *   success: JOB_SUCCESS then PAYMENT_SETTLED; failure: JOB_FAILURE then DEFAULT.
 * Each event recomputes metrics, default probability (with the previous volatility), the score
 * and the volatility over the last 10 history rows. Both CUSUMs update once per job.
 * networkTrust and sybilRisk are the graph-derived values (computed separately, as in the fork).
 */
export function replayScore(jobs: PortJob[], graph: { networkTrust: number; sybilRisk: number }, stakeSats = 0): ScoreState {
  const seen: PortJob[] = [];
  const history: number[] = [];
  let scoreVolatility = 0;
  let cusumScore = 0;
  let cusumSensitive = 0;
  let last = { traceScore: 500, riskTier: 'C' as RiskTier, defaultProbability: 0.05 };
  let metrics = recomputeMetrics([], stakeSats);

  const event = () => {
    metrics = recomputeMetrics(seen, stakeSats);
    const defaultProbability = computeDefaultProbability({
      totalJobs: metrics.totalJobs,
      failedJobs: metrics.failedJobs,
      defaultedJobs: metrics.defaultedJobs,
      disputedJobs: metrics.disputedJobs,
      scoreVolatility,
      stakeSats,
      totalEconomicVolume: metrics.totalEconomicVolume,
      repaymentRate: metrics.repaymentRate,
      recentFailureSignal: metrics.recentFailureSignal,
    });
    const result = computeTraceScore({
      completionRate: metrics.completionRate,
      repaymentRate: metrics.repaymentRate,
      networkTrust: graph.networkTrust,
      stakeRatio: metrics.stakeRatio,
      successfulEscrowRate: metrics.successfulEscrowRate,
      defaultProbability,
      sybilRisk: graph.sybilRisk,
      disputeRate: metrics.disputeRate,
    });
    const recent = history.slice(-10).reverse();
    scoreVolatility = computeVolatility(recent, result.traceScore);
    history.push(result.traceScore);
    last = result;
  };

  for (const job of jobs) {
    seen.push({ ...job, defaulted: false });
    event(); // JOB_SUCCESS | JOB_FAILURE
    if (job.success) {
      event(); // PAYMENT_SETTLED
    } else {
      seen[seen.length - 1] = { ...job, defaulted: true };
      event(); // DEFAULT
    }
    cusumScore = updateCUSUMScore(cusumScore, job.success ? 1 : 0).newScore;
    cusumSensitive = updateCUSUMSensitive(cusumSensitive, job.success ? 1 : 0).newScore;
  }
  return { ...last, scoreVolatility, cusumScore, cusumSensitive, metrics, history };
}

// ─── fork: trustGraph.ts ─────────────────────────────────────────────────────

export interface Edge {
  source: string;
  target: string;
  successfulCoJobs: number;
  economicVolume: number;
  weight: number;
  escrowReliability: number;
  /** unix ms of the last interaction (network-trust decay). */
  lastInteraction: number;
}

/** fork: trustGraph.ts#EdgeCache */
export interface EdgeCache {
  bySource: Map<string, Array<{ targetProviderId: string; successfulCoJobs: number; economicVolume: number; weight: number; escrowReliability: number }>>;
  byTarget: Map<string, Array<{ sourceProviderId: string; successfulCoJobs: number; economicVolume: number; weight: number; escrowReliability: number }>>;
}

/** fork: trustGraph.ts#buildEdgeCache (from rows instead of the DB). */
export function buildEdgeCache(edges: Edge[]): EdgeCache {
  const bySource: EdgeCache['bySource'] = new Map();
  const byTarget: EdgeCache['byTarget'] = new Map();
  for (const e of edges) {
    const fields = { successfulCoJobs: e.successfulCoJobs, economicVolume: e.economicVolume, weight: e.weight, escrowReliability: e.escrowReliability };
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source)!.push({ targetProviderId: e.target, ...fields });
    if (!byTarget.has(e.target)) byTarget.set(e.target, []);
    byTarget.get(e.target)!.push({ sourceProviderId: e.source, ...fields });
  }
  return { bySource, byTarget };
}

/** fork: trustGraph.ts#computeEdgeWeight (called without networkSize/diversity, as updateTrustEdge does). */
export function computeEdgeWeight(coJobs: number, volume: number, reliability: number, networkSize?: number, diversityScore?: number): number {
  const frequencyFactor = Math.log2(1 + coJobs);
  const volumeFactor = 1 + Math.log10(1 + volume / 100);
  const k_eff = effectiveDecayConstant(networkSize ?? 50, diversityScore ?? 0.5);
  const repeatedPairDecay = Math.exp(-coJobs / k_eff);
  const minVol = ECONOMIC_VOLUME_WEIGHTING.minVolumeForFullWeight;
  const volumeWeight = Math.min(Math.log2(1 + volume / minVol), 1.0);
  return frequencyFactor * volumeFactor * reliability * repeatedPairDecay * volumeWeight;
}

/** fork: trustGraph.ts#updateTrustEdge, in memory. Returns the new edge row. */
export function updateTrustEdge(
  existing: Edge | undefined,
  source: string,
  target: string,
  jobAmount: number,
  escrowSuccess: boolean,
  at: number,
  networkSize?: number,
): Edge | undefined {
  if (source === target) return existing;
  const dynamicEdgeWeightCap = edgeWeightCapForN(networkSize ?? 32);
  if (existing) {
    const newCoJobs = existing.successfulCoJobs + 1;
    const newVolume = existing.economicVolume + jobAmount;
    const newReliability = escrowSuccess
      ? (existing.escrowReliability * existing.successfulCoJobs + 1.0) / newCoJobs
      : (existing.escrowReliability * existing.successfulCoJobs + 0.0) / newCoJobs;
    let weight = computeEdgeWeight(newCoJobs, newVolume, newReliability);
    weight = Math.min(weight, dynamicEdgeWeightCap);
    return {
      source,
      target,
      successfulCoJobs: newCoJobs,
      economicVolume: newVolume,
      escrowReliability: round4(newReliability),
      weight: round4(weight),
      lastInteraction: at,
    };
  }
  let weight = computeEdgeWeight(1, jobAmount, escrowSuccess ? 1.0 : 0.0);
  weight = Math.min(weight, dynamicEdgeWeightCap);
  return {
    source,
    target,
    successfulCoJobs: 1,
    economicVolume: jobAmount,
    escrowReliability: escrowSuccess ? 1.0 : 0.0,
    weight: round4(weight),
    lastInteraction: at,
  };
}

/** fork: trustGraph.ts#runTarjanSCC (iterative). */
export function runTarjanSCC(adj: Map<string, Set<string>>): string[][] {
  const nodes = [...adj.keys()];
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;
  type Frame = { v: string; iterator: IterableIterator<string> };
  for (const root of nodes) {
    if (indexMap.has(root)) continue;
    const workStack: Frame[] = [];
    const pushNode = (v: string) => {
      indexMap.set(v, counter);
      lowlink.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
      workStack.push({ v, iterator: (adj.get(v) ?? new Set<string>())[Symbol.iterator]() });
    };
    pushNode(root);
    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1]!;
      const { value: w, done } = frame.iterator.next();
      if (!done && w !== undefined) {
        if (!indexMap.has(w)) {
          pushNode(w);
        } else if (onStack.has(w)) {
          lowlink.set(frame.v, Math.min(lowlink.get(frame.v)!, indexMap.get(w)!));
        }
      } else {
        workStack.pop();
        if (workStack.length > 0) {
          const parent = workStack[workStack.length - 1]!;
          lowlink.set(parent.v, Math.min(lowlink.get(parent.v)!, lowlink.get(frame.v)!));
        }
        if (lowlink.get(frame.v) === indexMap.get(frame.v)) {
          const scc: string[] = [];
          let w2: string;
          do {
            w2 = stack.pop()!;
            onStack.delete(w2);
            scc.push(w2);
          } while (w2 !== frame.v);
          sccs.push(scc);
        }
      }
    }
  }
  return sccs;
}

/** fork: trustGraph.ts#computeSpectralGap (|lambda2| of the SCC's random-walk matrix). */
export function computeSpectralGap(scc: string[], edgeWeightMap: Map<string, number>): number {
  const k = scc.length;
  if (k < SPECTRAL_GAP_CONFIG.minSCCSize) return 0;
  const T = new Float64Array(k * k);
  for (let i = 0; i < k; i++) {
    const src = scc[i]!;
    let rowSum = 0;
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const tgt = scc[j]!;
      const w = edgeWeightMap.get(`${src}→${tgt}`) ?? 0;
      if (w > 0) {
        T[i * k + j] = w;
        rowSum += w;
      }
    }
    if (rowSum > 0) {
      for (let j = 0; j < k; j++) T[i * k + j]! /= rowSum;
    } else {
      for (let j = 0; j < k; j++) T[i * k + j] = 1 / k;
    }
  }
  let v = new Float64Array(k);
  for (let i = 0; i < k; i++) v[i] = Math.sin(i * 2.39996323 + 1.0) * 0.5 + 0.5;
  let mean = 0;
  for (let i = 0; i < k; i++) mean += v[i]!;
  mean /= k;
  for (let i = 0; i < k; i++) v[i]! -= mean;
  let norm = 0;
  for (let i = 0; i < k; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return 0;
  for (let i = 0; i < k; i++) v[i]! /= norm;
  let lambda2 = 0;
  for (let iter = 0; iter < SPECTRAL_GAP_CONFIG.maxIterations; iter++) {
    const w = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += T[i * k + j]! * v[j]!;
      w[i] = sum;
    }
    mean = 0;
    for (let i = 0; i < k; i++) mean += w[i]!;
    mean /= k;
    for (let i = 0; i < k; i++) w[i]! -= mean;
    norm = 0;
    for (let i = 0; i < k; i++) norm += w[i]! * w[i]!;
    norm = Math.sqrt(norm);
    if (norm < 1e-12) {
      lambda2 = 0;
      break;
    }
    const newLambda2 = norm;
    if (Math.abs(newLambda2 - lambda2) < SPECTRAL_GAP_CONFIG.convergenceThreshold) {
      lambda2 = newLambda2;
      break;
    }
    lambda2 = newLambda2;
    for (let i = 0; i < k; i++) v[i] = w[i]! / norm;
  }
  return Math.min(1.0, Math.max(0, lambda2));
}

/** fork: trustGraph.ts#detectDenseSubgraphRisk (greedy peeling; density = edges per node vs random). */
export function detectDenseSubgraphRisk(adj: Map<string, Set<string>>): Map<string, number> {
  const riskScores = new Map<string, number>();
  const N = Math.max(2, adj.size);
  const nodes = Array.from(adj.keys());
  const remaining = new Set(nodes);
  const degree = new Map<string, number>();
  let edgeCount = 0;
  for (const v of nodes) {
    let deg = 0;
    for (const u of adj.get(v) ?? []) if (remaining.has(u)) deg++;
    degree.set(v, deg);
    edgeCount += deg;
  }
  let bestDensity = remaining.size > 0 ? edgeCount / remaining.size : 0;
  let bestMembers = new Set(remaining);
  while (remaining.size > 1) {
    let minV = '';
    let minDeg = Infinity;
    for (const v of remaining) {
      const d = degree.get(v) ?? 0;
      if (d < minDeg) {
        minDeg = d;
        minV = v;
      }
    }
    remaining.delete(minV);
    for (const nbr of adj.get(minV) ?? []) {
      if (remaining.has(nbr)) {
        degree.set(nbr, (degree.get(nbr) ?? 1) - 1);
        edgeCount--;
      }
    }
    for (const v of remaining) {
      if (adj.get(v)?.has(minV)) {
        degree.set(v, (degree.get(v) ?? 1) - 1);
        edgeCount--;
      }
    }
    const density = remaining.size > 0 ? edgeCount / remaining.size : 0;
    if (density > bestDensity) {
      bestDensity = density;
      bestMembers = new Set(remaining);
    }
  }
  let totalEdgeCount = 0;
  for (const [, nbrs] of adj) totalEdgeCount += nbrs.size;
  const expectedRandomDensity = N > 1 ? totalEdgeCount / N : 1;
  const densityRatio = expectedRandomDensity > 0 ? bestDensity / expectedRandomDensity : 0;
  const isDense = densityRatio > 2.0 && bestMembers.size >= 3;
  for (const nodeId of nodes) {
    if (isDense && bestMembers.has(nodeId)) {
      const baseRisk = Math.min(1.0, Math.log2(densityRatio) / 3);
      const neighbors = adj.get(nodeId) ?? new Set();
      const denseNeighbors = Array.from(neighbors).filter((n) => bestMembers.has(n));
      let clusterBonus = 0;
      if (denseNeighbors.length >= 2) {
        let triangles = 0;
        for (let i = 0; i < denseNeighbors.length; i++) {
          for (let j = i + 1; j < denseNeighbors.length; j++) {
            if (adj.get(denseNeighbors[i]!)?.has(denseNeighbors[j]!) || adj.get(denseNeighbors[j]!)?.has(denseNeighbors[i]!)) {
              triangles++;
            }
          }
        }
        const possibleTriangles = (denseNeighbors.length * (denseNeighbors.length - 1)) / 2;
        clusterBonus = possibleTriangles > 0 ? (triangles / possibleTriangles) * 0.2 : 0;
      }
      riskScores.set(nodeId, Math.min(1.0, baseRisk + clusterBonus));
    } else {
      riskScores.set(nodeId, 0);
    }
  }
  return riskScores;
}

/** fork: trustGraph.ts#computeEdgeDiversityFromGraph */
export function computeEdgeDiversityFromGraph(
  providerId: string,
  adj: Map<string, Set<string>>,
  reverseAdj: Map<string, Set<string>>,
  sccMembership: Map<string, number>,
  edgeVolumes: Map<string, number>,
): number {
  const outNeighbours = adj.get(providerId) ?? new Set<string>();
  const inNeighbours = reverseAdj.get(providerId) ?? new Set<string>();
  const counterparties = new Set<string>([...outNeighbours, ...inNeighbours]);
  const uniqueCount = counterparties.size;
  const totalEdges = outNeighbours.size + inNeighbours.size;
  if (totalEdges === 0) return 0;
  const rawDiversity = uniqueCount / totalEdges;
  const mySCC = sccMembership.get(providerId) ?? -1;
  let externalOut = 0;
  for (const tgt of outNeighbours) if ((sccMembership.get(tgt) ?? -2) !== mySCC) externalOut++;
  const externalRatio = outNeighbours.size > 0 ? externalOut / outNeighbours.size : 1.0;
  const volumes = [...outNeighbours].map((tgt) => edgeVolumes.get(`${providerId}→${tgt}`) ?? 0);
  const totalVol = volumes.reduce((s, v) => s + v, 0);
  let concentrationPenalty = 0;
  if (totalVol > 0 && volumes.length > 1) {
    const hhi = volumes.reduce((s, v) => s + (v / totalVol) ** 2, 0);
    concentrationPenalty = Math.max(0, hhi - 1 / volumes.length);
  }
  return Math.max(0, Math.min(1, rawDiversity * externalRatio - concentrationPenalty));
}

/** fork: trustGraph.ts#detectCircularPatternsFromGraph (bounded DFS cycle count). */
export function detectCircularPatternsFromGraph(startId: string, adj: Map<string, Set<string>>, maxDepth?: number, cycleCap?: number): number {
  const effectiveMaxDepth = maxDepth ?? trustPropagationDepth(adj.size);
  const effectiveCycleCap = cycleCap ?? 8;
  let cycles = 0;
  type Frame = { node: string; iterator: IterableIterator<string>; depth: number };
  const visited = new Set<string>([startId]);
  const workStack: Frame[] = [{ node: startId, iterator: (adj.get(startId) ?? new Set<string>())[Symbol.iterator](), depth: 1 }];
  while (workStack.length > 0) {
    const frame = workStack[workStack.length - 1]!;
    const step = frame.iterator.next();
    if (step.done) {
      workStack.pop();
      visited.delete(frame.node);
      continue;
    }
    const next = step.value;
    if (next === startId && frame.depth >= 2) {
      cycles++;
      if (cycles >= effectiveCycleCap) return cycles;
      continue;
    }
    if (!visited.has(next) && frame.depth + 1 <= effectiveMaxDepth) {
      visited.add(next);
      workStack.push({ node: next, iterator: (adj.get(next) ?? new Set<string>())[Symbol.iterator](), depth: frame.depth + 1 });
    }
  }
  return cycles;
}

/**
 * fork: trustGraph.ts#updateSybilRiskScores, in memory. Steps 4a (SCC suspicion), spectral gap
 * (absolute threshold, DR off), 4b (cycles, edge diversity, dense subgraph; CR off) and the
 * failure-round correlation propagation (exact Jaccard; MinHash only above 5000 nodes).
 * `nodes` = the fork's active providers; `failureRounds` = rounds of each node's failed jobs.
 */
export function computeSybilRisk(nodes: string[], edges: Edge[], failureRounds: Map<string, Set<number>> = new Map()): Map<string, number> {
  const adj = new Map<string, Set<string>>();
  const reverseAdj = new Map<string, Set<string>>();
  const edgeWeightMap = new Map<string, number>();
  const edgeVolumeMap = new Map<string, number>();
  for (const p of nodes) {
    adj.set(p, new Set());
    reverseAdj.set(p, new Set());
  }
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    reverseAdj.get(e.target)?.add(e.source);
    edgeWeightMap.set(`${e.source}→${e.target}`, e.weight);
    edgeVolumeMap.set(`${e.source}→${e.target}`, e.economicVolume);
  }
  const allSCCs = runTarjanSCC(adj);
  const sccMembership = new Map<string, number>();
  allSCCs.forEach((scc, idx) => {
    for (const id of scc) sccMembership.set(id, idx);
  });
  const riskAccum = new Map<string, number>();
  for (const p of nodes) riskAccum.set(p, 0);

  // 4a. SCC suspicion
  for (const scc of allSCCs) {
    if (scc.length < 2) continue;
    const sccSet = new Set(scc);
    let suspicion = scc.length >= 10 ? 0.55 : scc.length >= 3 ? 0.4 : 0.2;
    let isolated = 0;
    for (const id of scc) {
      const out = adj.get(id) ?? new Set<string>();
      if (out.size > 0 && [...out].every((n) => sccSet.has(n))) isolated++;
    }
    const isolationRatio = isolated / scc.length;
    if (isolationRatio >= 0.6) suspicion += 0.3;
    else if (isolationRatio >= 0.3) suspicion += 0.15;
    const weights: number[] = [];
    for (const src of scc) {
      for (const tgt of scc) {
        const w = edgeWeightMap.get(`${src}→${tgt}`);
        if (w !== undefined) weights.push(w);
      }
    }
    if (weights.length >= 3) {
      const mean = weights.reduce((s, w) => s + w, 0) / weights.length;
      const cv = Math.sqrt(weights.reduce((s, w) => s + (w - mean) ** 2, 0) / weights.length) / (mean || 1);
      if (cv < 0.15) suspicion += 0.2;
    }
    const score = Math.min(suspicion, 1.0);
    for (const pid of scc) riskAccum.set(pid, Math.max(riskAccum.get(pid) ?? 0, score));
  }

  // Spectral gap (DR off: absolute threshold and participation threshold)
  const sccLambdas: Array<{ scc: string[]; lambda2: number }> = [];
  for (const scc of allSCCs) {
    if (scc.length < SPECTRAL_GAP_CONFIG.minSCCSize) continue;
    sccLambdas.push({ scc, lambda2: computeSpectralGap(scc, edgeWeightMap) });
  }
  const spectralThreshold: number = SPECTRAL_GAP_CONFIG.threshold;
  const adaptiveParticipation: number = SPECTRAL_GAP_CONFIG.participationThreshold;
  for (const { scc, lambda2 } of sccLambdas) {
    if (lambda2 > spectralThreshold) {
      const attenuation = Math.pow(1 - lambda2, SPECTRAL_GAP_CONFIG.gamma);
      const spectralRisk = 1 - attenuation;
      const sccSet = new Set(scc);
      for (const pid of scc) {
        const outEdges = adj.get(pid) ?? new Set<string>();
        const inEdges = reverseAdj.get(pid) ?? new Set<string>();
        const totalEdges = outEdges.size + inEdges.size;
        if (totalEdges === 0) continue;
        let internalEdges = 0;
        for (const tgt of outEdges) if (sccSet.has(tgt)) internalEdges++;
        for (const src of inEdges) if (sccSet.has(src)) internalEdges++;
        const participation = internalEdges / totalEdges;
        if (participation > adaptiveParticipation) {
          const scaledRisk = spectralRisk * participation;
          riskAccum.set(pid, Math.min(1.0, Math.max(riskAccum.get(pid) ?? 0, scaledRisk)));
        }
      }
    }
  }

  // 4b. Secondary signals
  const denseSubgraphRisks = detectDenseSubgraphRisk(adj);
  for (const p of nodes) {
    let additional = 0;
    const cycles = detectCircularPatternsFromGraph(p, adj, 5);
    if (cycles > 0) {
      additional += Math.min(cycles * TRUST_GRAPH_VALIDATION.circularPenaltyPerCycle, TRUST_GRAPH_VALIDATION.maxCircularPenalty);
    }
    const diversity = computeEdgeDiversityFromGraph(p, adj, reverseAdj, sccMembership, edgeVolumeMap);
    if (diversity < 0.3) additional += 0.1;
    const collusionRisk = denseSubgraphRisks.get(p) ?? 0;
    if (collusionRisk > 0) additional += collusionRisk;
    if (additional > 0) riskAccum.set(p, Math.min((riskAccum.get(p) ?? 0) + additional, 1.0));
  }

  // Failure-round correlation propagation
  const detectedAgents = [...riskAccum.entries()].filter(([, risk]) => risk >= 0.3).map(([id]) => id);
  if (detectedAgents.length > 0) {
    const CORRELATION_THRESHOLD = 0.2;
    const MIN_FAILURES_FOR_CORRELATION = 3;
    const MAX_PROPAGATED_RISK = 0.5;
    const estimateJaccard = (setA: Set<number> | undefined, setB: Set<number> | undefined): number => {
      if (!setA || !setB) return 0;
      if (setA.size < MIN_FAILURES_FOR_CORRELATION || setB.size < MIN_FAILURES_FOR_CORRELATION) return 0;
      let intersectionSize = 0;
      for (const r of setA) if (setB.has(r)) intersectionSize++;
      const unionSize = setA.size + setB.size - intersectionSize;
      return unionSize > 0 ? intersectionSize / unionSize : 0;
    };
    for (const p of nodes) {
      if ((riskAccum.get(p) ?? 0) >= 0.2) continue;
      const pFailures = failureRounds.get(p);
      if (!pFailures || pFailures.size < MIN_FAILURES_FOR_CORRELATION) continue;
      let maxCorrelation = 0;
      let maxSourceRisk = 0;
      for (const detectedId of detectedAgents) {
        const jaccard = estimateJaccard(pFailures, failureRounds.get(detectedId));
        if (jaccard > maxCorrelation) {
          maxCorrelation = jaccard;
          maxSourceRisk = riskAccum.get(detectedId) ?? 0;
        }
      }
      if (maxCorrelation > CORRELATION_THRESHOLD && maxSourceRisk > 0) {
        const propagatedRisk = Math.min(maxSourceRisk * maxCorrelation * MAX_PROPAGATED_RISK, maxSourceRisk * MAX_PROPAGATED_RISK);
        riskAccum.set(p, Math.min(1.0, Math.max(riskAccum.get(p) ?? 0, propagatedRisk)));
      }
    }
  }

  const out = new Map<string, number>();
  for (const [id, risk] of riskAccum) out.set(id, risk <= 0 ? 0 : round4(risk));
  return out;
}

/** fork: trustGraph.ts#computeAllNetworkTrustWithMeta (weighted PageRank, 5-day edge half-life, cap 0.8). */
export function computeAllNetworkTrust(nodes: string[], edges: Edge[], now: number): Map<string, number> {
  const DAMPING = 0.85;
  const EPSILON = 0.0001;
  const N = nodes.length;
  if (N === 0) return new Map();
  const MAX_ITER = pprMaxIter(N);
  const idToIndex = new Map(nodes.map((id, i) => [id, i]));
  const dynamicEdgeWeightCap = edgeWeightCapForN(N);
  const decayedEdges = edges
    .map((e) => {
      const age = now - e.lastInteraction;
      const decayFactor = Math.pow(0.5, age / TRUST_DECAY.halfLifeMs);
      const weight = Math.min(e.weight * decayFactor, dynamicEdgeWeightCap);
      return { source: idToIndex.get(e.source), target: idToIndex.get(e.target), weight };
    })
    .filter((e): e is { source: number; target: number; weight: number } => e.source !== undefined && e.target !== undefined);
  const outEdges = new Map<number, Array<{ target: number; weight: number }>>();
  const outWeightSum: number[] = new Array(N).fill(0);
  for (const e of decayedEdges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source)!.push({ target: e.target, weight: e.weight });
    outWeightSum[e.source]! += e.weight;
  }
  const trust: number[] = new Array(N).fill(1 / N);
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const prevTrust = [...trust];
    trust.fill((1 - DAMPING) / N);
    for (let i = 0; i < N; i++) {
      const edges_i = outEdges.get(i);
      if (!edges_i || outWeightSum[i] === 0) continue;
      // Verbatim: the fork reads the vector being rebuilt (trust[i]), not prevTrust[i].
      for (const e of edges_i) trust[e.target]! += DAMPING * (e.weight / outWeightSum[i]!) * trust[i]!;
    }
    let maxDelta = 0;
    for (let i = 0; i < N; i++) maxDelta = Math.max(maxDelta, Math.abs(trust[i]! - prevTrust[i]!));
    if (maxDelta < EPSILON) break;
  }
  const maxTrust = Math.max(...trust, 0.0001);
  const result = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const cappedTrust = Math.min(trust[i]! / maxTrust, TRUST_GRAPH_VALIDATION.maxNetworkTrust);
    result.set(nodes[i]!, round4(cappedTrust));
  }
  return result;
}

/** fork: trustGraph.ts#computePersonalizedPageRank (PPR from an honest seed set). */
export function computePersonalizedPageRank(edgeCache: EdgeCache, seedIds: Set<string>, alpha = 0.15): Map<string, number> {
  if (seedIds.size === 0) return new Map();
  const allProviders = new Set<string>();
  for (const id of edgeCache.bySource.keys()) allProviders.add(id);
  for (const id of edgeCache.byTarget.keys()) allProviders.add(id);
  for (const id of seedIds) allProviders.add(id);
  if (allProviders.size === 0) return new Map();
  const seedSize = seedIds.size;
  const teleportShare = alpha / seedSize;
  const scores = new Map<string, number>();
  for (const id of allProviders) scores.set(id, seedIds.has(id) ? 1 / seedSize : 0);
  const EPSILON = 0.001;
  const MAX_ITER = pprMaxIter(allProviders.size);
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const next = new Map<string, number>();
    for (const id of allProviders) next.set(id, seedIds.has(id) ? teleportShare : 0);
    for (const [srcId, outEdges] of edgeCache.bySource) {
      let totalWeight = 0;
      for (const e of outEdges) totalWeight += e.weight;
      if (totalWeight <= 0) continue;
      const srcScore = scores.get(srcId) ?? 0;
      if (srcScore <= 0) continue;
      for (const edge of outEdges) {
        const contribution = (1 - alpha) * srcScore * (edge.weight / totalWeight);
        next.set(edge.targetProviderId, (next.get(edge.targetProviderId) ?? 0) + contribution);
      }
    }
    let maxDelta = 0;
    for (const id of allProviders) {
      const prev = scores.get(id) ?? 0;
      const cur = next.get(id) ?? 0;
      const d = Math.abs(cur - prev);
      if (d > maxDelta) maxDelta = d;
      scores.set(id, cur);
    }
    if (maxDelta < EPSILON) break;
  }
  let maxScore = 0;
  for (const v of scores.values()) if (v > maxScore) maxScore = v;
  const denom = maxScore > 1e-10 ? maxScore : 1e-10;
  const normalized = new Map<string, number>();
  for (const [id, v] of scores) {
    const ratio = v / denom;
    normalized.set(id, round4(Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0));
  }
  return normalized;
}

/** fork: trustGraph.ts#computeWeightedEntropy (trust-weighted counterparty entropy). */
export function computeWeightedEntropy(providerId: string, edgeCache: EdgeCache, providerTrustMap: Map<string, number>): number {
  const outEdges = edgeCache.bySource.get(providerId) ?? [];
  const inEdges = edgeCache.byTarget.get(providerId) ?? [];
  const interactionMap = new Map<string, number>();
  for (const e of outEdges) interactionMap.set(e.targetProviderId, (interactionMap.get(e.targetProviderId) ?? 0) + e.successfulCoJobs);
  for (const e of inEdges) interactionMap.set(e.sourceProviderId, (interactionMap.get(e.sourceProviderId) ?? 0) + e.successfulCoJobs);
  let total = 0;
  for (const v of interactionMap.values()) total += v;
  const networkSize = edgeCache.bySource.size;
  const confidenceFloor = computeEntropyConfidenceFloor(networkSize);
  if (total < confidenceFloor) return 0;
  let H = 0;
  for (const [cpId, count] of interactionMap) {
    const p = count / total;
    if (p <= 0) continue;
    const w = providerTrustMap.get(cpId) ?? 0.25;
    H -= w * p * Math.log2(p);
  }
  return Number.isFinite(H) ? round4(H) : 0;
}

/** fork: trustGraph.ts#computeCounterpartyEntropy (edge-cache path; the interaction window is off). */
export function computeCounterpartyEntropy(
  providerId: string,
  edgeCache: EdgeCache,
): { entropy: number; diversityScore: number; uniqueCounterparties: number } {
  const outEdges = edgeCache.bySource.get(providerId) ?? [];
  const inEdges = edgeCache.byTarget.get(providerId) ?? [];
  const interactionMap = new Map<string, number>();
  for (const e of outEdges) interactionMap.set(e.targetProviderId, (interactionMap.get(e.targetProviderId) ?? 0) + e.successfulCoJobs);
  for (const e of inEdges) interactionMap.set(e.sourceProviderId, (interactionMap.get(e.sourceProviderId) ?? 0) + e.successfulCoJobs);
  const uniqueCounterparties = interactionMap.size;
  if (uniqueCounterparties === 0) return { entropy: 0, diversityScore: 0, uniqueCounterparties: 0 };
  const totalInteractions = [...interactionMap.values()].reduce((s, v) => s + v, 0);
  if (totalInteractions === 0) return { entropy: 0, diversityScore: 0, uniqueCounterparties };
  let entropy = 0;
  for (const count of interactionMap.values()) {
    const p = count / totalInteractions;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const networkSize = edgeCache.bySource.size;
  const requiredEntropy = computeRequiredEntropy(networkSize);
  const diversityScore = Math.min(entropy / requiredEntropy, 1.0);
  return { entropy: round4(entropy), diversityScore: round4(diversityScore), uniqueCounterparties };
}

/** fork: trustGraph.ts#computeNeighborhoodContamination */
export function computeNeighborhoodContamination(edgeCache: EdgeCache, providerSybilRisks: Map<string, number>): Map<string, number> {
  const contaminationScores = new Map<string, number>();
  for (const [providerId, outEdges] of edgeCache.bySource) {
    const inEdges = edgeCache.byTarget.get(providerId) ?? [];
    const neighbors = new Set<string>();
    for (const edge of outEdges) neighbors.add(edge.targetProviderId);
    for (const edge of inEdges) neighbors.add(edge.sourceProviderId);
    if (neighbors.size === 0) {
      contaminationScores.set(providerId, 0);
      continue;
    }
    let totalRisk = 0;
    let totalWeight = 0;
    for (const neighborId of neighbors) {
      const neighborRisk = providerSybilRisks.get(neighborId) ?? 0;
      let edgeWeight = 0;
      const outEdge = outEdges.find((e) => e.targetProviderId === neighborId);
      const inEdge = inEdges.find((e) => e.sourceProviderId === neighborId);
      if (outEdge) edgeWeight += outEdge.weight;
      if (inEdge) edgeWeight += inEdge.weight;
      totalRisk += neighborRisk * edgeWeight;
      totalWeight += edgeWeight;
    }
    const avgNeighborRisk = totalWeight > 0 ? totalRisk / totalWeight : 0;
    const contaminationFactor = 0.5;
    const threshold = 0.15;
    const contaminationRisk = avgNeighborRisk > threshold ? avgNeighborRisk * contaminationFactor : 0;
    contaminationScores.set(providerId, round4(Math.min(contaminationRisk, 0.5)));
  }
  for (const [providerId] of providerSybilRisks) if (!contaminationScores.has(providerId)) contaminationScores.set(providerId, 0);
  return contaminationScores;
}

// ─── fork: traceRouter.ts ────────────────────────────────────────────────────

export const PPR_SEED_MIN_TOTAL_JOBS = 30;
export const PPR_SEED_MAX_FAILURE_RATE = 0.1;

export interface ProviderView {
  id: string;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  disputedJobs: number;
  traceScore: number;
  defaultProbability: number;
  sybilRisk: number;
  networkTrust: number;
  scoreVolatility: number;
  cusumScore: number;
  cusumSensitive: number;
  stakeSats: number;
  /** mean price per job in volume units (the fork's priceSats * bidMultiplier). */
  price: number;
}

/** fork: traceRouter.ts#scoreAllCandidates PPR seed rule (>= 30 jobs, < 10% failures; else top-3 by jobs). */
export function pprSeeds(providers: ProviderView[]): Set<string> {
  const seedIds = new Set<string>();
  for (const pr of providers) {
    const failureRate = pr.totalJobs > 0 ? pr.failedJobs / pr.totalJobs : 1;
    if (pr.totalJobs >= PPR_SEED_MIN_TOTAL_JOBS && failureRate < PPR_SEED_MAX_FAILURE_RATE) seedIds.add(pr.id);
  }
  if (seedIds.size < 3 && providers.length >= 3) {
    const top3 = [...providers].sort((a, b) => b.totalJobs - a.totalJobs).slice(0, 3);
    for (const pr of top3) seedIds.add(pr.id);
  }
  return seedIds;
}

/** fork: traceRouter.ts#scoreAllCandidates TRACE hard filters, in order. null = passes. */
export function hardFilterReason(p: ProviderView): string | null {
  if (p.traceScore < ROUTING_CONSTRAINTS.minTraceScore) return 'trace_score_too_low';
  if (p.defaultProbability > ROUTING_CONSTRAINTS.maxDefaultProbability) return 'default_prob_too_high';
  if (p.sybilRisk > ROUTING_CONSTRAINTS.maxSybilRisk) return 'sybil_risk_too_high';
  if (p.disputedJobs > ROUTING_CONSTRAINTS.maxActiveDisputes) return 'too_many_disputes';
  if (p.totalJobs < PROGRESSIVE_TRUST.minJobsForFullAccess && p.defaultProbability > 0.3) return 'cold_start_high_risk';
  if (p.totalJobs >= ROUTING_CONSTRAINTS.minJobsForFailureFilter) {
    if (p.failedJobs / p.totalJobs > ROUTING_CONSTRAINTS.maxFailureRate) return 'failure_rate_too_high';
  }
  const sybilFailureThreshold = 0.15 / Math.max(1.0, 0.1); // density factor 1.0 (DR off)
  if (p.sybilRisk > sybilFailureThreshold && p.failedJobs > 0) return 'sybil_failure_interaction';
  if (Number.isFinite(p.cusumScore) && p.cusumScore > CUSUM_H) return 'cusum_alarm';
  return null;
}

/** fork: traceRouter.ts#computeProgressiveTrustCap */
export function computeProgressiveTrustCap(p: ProviderView): number {
  if (p.totalJobs >= PROGRESSIVE_TRUST.minJobsForFullAccess) {
    const matureFailureRate = p.totalJobs > 0 ? p.failedJobs / p.totalJobs : 0;
    if (matureFailureRate > 0.25) return Math.max(0.1, 1.0 - (matureFailureRate - 0.25));
    return 1.0;
  }
  const effectiveJobs = Math.max(0, p.successfulJobs - p.failedJobs * 2);
  let access = effectiveJobs * PROGRESSIVE_TRUST.accessScalePerJob;
  if (p.stakeSats > 0) access *= PROGRESSIVE_TRUST.stakeBoostMultiplier;
  if (p.scoreVolatility > VOLATILITY.maxAcceptableVolatility * 1.5) return 0.05;
  if (p.totalJobs < 3 && p.scoreVolatility > 0) return 0.03;
  return Math.min(Math.max(access, 0.1), 1.0);
}

export interface UtilityBreakdown {
  bayesianLCB: number;
  traceContribution: number;
  defaultPenalty: number;
  costPenalty: number;
  networkBonus: number;
  sybilPenalty: number;
  cliquePenalty: number;
  volatilityPenalty: number;
  capabilityBonus: number;
  diversityScore: number;
  entropyConfidence: number;
  pprScore: number;
  neighborhoodContaminationPenalty: number;
  progressiveTrustCap: number;
  utility: number;
}

/**
 * fork: traceRouter.ts#computeTraceUtility (paper Eq. 1). Stateless subset: the cross-round
 * trackers (trust inertia, velocity, post-fraud cooldown, round suspicion) have no state on this
 * rail and contribute their neutral element; temporal and causal arms are off in the paper preset.
 */
export function computeTraceUtility(
  p: ProviderView,
  maxPrice: number,
  networkSize: number,
  edgeCache: EdgeCache,
  neighborhoodContamination: Map<string, number>,
  pprScores: Map<string, number>,
  providerTrustMap: Map<string, number>,
): UtilityBreakdown {
  const u = ROUTING_UTILITY;
  const N = networkSize;
  const normalizedTrace = p.traceScore / TRACE_MAX_SCORE;
  const normalizedCost = maxPrice > 0 ? p.price / maxPrice : 0;
  const capabilityMatch = 1.0;
  const bayesianLCB = computeBayesianLCB(p.successfulJobs, p.failedJobs);
  const { entropy: rawEntropy } = computeCounterpartyEntropy(p.id, edgeCache);
  const entropyConfidence = computeEntropyConfidence(p.totalJobs, N);
  const diversityMaturity = 1.0; // temporal arm off
  const requiredEntropy = computeRequiredEntropy(N);
  const weightedEntropy = computeWeightedEntropy(p.id, edgeCache, providerTrustMap);
  const effectiveEntropy = Math.max(rawEntropy, weightedEntropy);
  const diversityScore = Math.min(effectiveEntropy / requiredEntropy, 1.0);
  const weightedDiversityScore = 1.0 - (1.0 - diversityScore) * entropyConfidence;
  const pprScore = pprScores.get(p.id) ?? 0;
  const pprFactor = 0.3 + 0.7 * Math.max(0, Math.min(1, pprScore));
  const adjustedTrust = Math.min(TRACE_HARDENING.adjustedTrustCap, p.networkTrust * weightedDiversityScore * diversityMaturity * pprFactor);
  const sybilPenalty = effectiveSybilPenalty(N) * p.sybilRisk;
  let cliquePenalty = 0;
  if (p.totalJobs >= 3) {
    const entropyDeficit = Math.max(0, 1 - diversityScore);
    cliquePenalty = effectiveCliquePenalty(N) * entropyConfidence * entropyDeficit * 1.0;
  }
  const normalizedVolatility = Math.min(p.scoreVolatility / VOLATILITY.maxAcceptableVolatility, 1.0);
  const volatilityPenalty = VOLATILITY.volatilityPenaltyWeight * normalizedVolatility;
  const neighborhoodContaminationPenalty = (neighborhoodContamination.get(p.id) ?? 0) * 0.4;
  const networkDeficit = u.delta_networkTrust * Math.max(0, 0.5 - adjustedTrust);
  const b = {
    traceContribution: round4(u.alpha_traceScore * normalizedTrace),
    defaultPenalty: round4(u.beta_defaultRisk * p.defaultProbability),
    costPenalty: round4(u.gamma_cost * normalizedCost),
    networkBonus: round4(-networkDeficit),
    sybilPenalty: round4(sybilPenalty),
    cliquePenalty: round4(cliquePenalty),
    volatilityPenalty: round4(volatilityPenalty),
    capabilityBonus: round4(u.epsilon_capability * capabilityMatch),
    neighborhoodContaminationPenalty: round4(neighborhoodContaminationPenalty),
  };
  let rawUtility =
    b.traceContribution -
    b.defaultPenalty -
    b.costPenalty -
    networkDeficit -
    b.sybilPenalty -
    b.cliquePenalty -
    b.volatilityPenalty +
    b.capabilityBonus -
    neighborhoodContaminationPenalty;
  const progressiveCap = computeProgressiveTrustCap(p);
  rawUtility *= progressiveCap;
  rawUtility *= bayesianLCB;
  rawUtility *= Math.pow(Math.max(0, 1 - p.sybilRisk), 2);
  if (!Number.isFinite(rawUtility)) rawUtility = 0;
  let utility = round4(rawUtility);
  const cusumSensitive = p.cusumSensitive ?? 0;
  if (Number.isFinite(cusumSensitive) && cusumSensitive > CUSUM_SENSITIVE_SUPPRESSION.activationThreshold) {
    const progress = Math.min(1.0, cusumSensitive / CUSUM_H_SENSITIVE);
    const suppressionFactor = Math.max(CUSUM_SENSITIVE_SUPPRESSION.floor, 1.0 - progress * (1.0 - CUSUM_SENSITIVE_SUPPRESSION.floor));
    utility = round4(utility * suppressionFactor);
  }
  return {
    bayesianLCB: round4(bayesianLCB),
    ...b,
    diversityScore: round4(diversityScore),
    entropyConfidence: round4(entropyConfidence),
    pprScore,
    progressiveTrustCap: round4(progressiveCap),
    utility,
  };
}
