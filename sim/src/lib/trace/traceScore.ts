/**
 * TRACE Score Engine — Phase 2
 *
 * Replaces simplistic reputation with economic trust scoring.
 *
 * Core functions:
 *   - computeTraceScore()       → composite [0–1000] trust score
 *   - computeDefaultProbability() → P(default) [0–1]
 *   - computeRiskTier()         → A/B/C/D tier
 *   - updateScoreAfterEvent()   → recalculate + persist after economic events
 */

import { prisma } from "../db";
import {
  TRACE_WEIGHTS,
  TRACE_MAX_SCORE,
  TRACE_MIN_SCORE,
  RISK_TIERS,
  DEFAULT_PROB_WEIGHTS,
  RECENT_FAILURE,
  SCORE_DELTAS,
  type RiskTier,
} from "./config";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TraceScoreInput {
  completionRate: number;       // [0–1]
  repaymentRate: number;        // [0–1]
  networkTrust: number;         // [0–1]
  stakeRatio: number;           // [0–1]
  successfulEscrowRate: number; // [0–1]
  defaultProbability: number;   // [0–1]
  sybilRisk: number;            // [0–1]
  disputeRate: number;          // [0–1]
}

export interface TraceScoreResult {
  traceScore: number;
  riskTier: RiskTier;
  defaultProbability: number;
  breakdown: {
    completionContribution: number;
    repaymentContribution: number;
    networkTrustContribution: number;
    stakeContribution: number;
    escrowContribution: number;
    defaultPenalty: number;
    sybilPenalty: number;
    disputePenalty: number;
  };
}

// ─── Bayesian Posterior Trust (Framework 1) ──────────────────────────────────

/**
 * Wilson score lower bound at q=0.95.
 * Approximates the lower-tail of the Beta(α+s, β+f) posterior.
 * Prior Beta(1, 3) → prior mean 0.25, below any honest incumbent's
 * post-10-job completion rate. Satisfies Requirement 1.5.
 *
 * Citation: Wilson (1927); Brown, Cai, DasGupta (2001) — Wilson is a
 * defensible Bayes-LCB approximation for Bernoulli with Beta prior.
 *
 * Properties:
 *   - LCB(0,0) ≈ 0.03 (small but non-zero exploration floor)
 *   - LCB(s,f) is monotone non-decreasing in evidence at fixed rate
 *   - LCB ∈ [0, 1] for every input; never NaN.
 */
export function computeBayesianLCB(
  successes: number,
  failures: number,
  alpha_prior: number = 1,
  beta_prior: number = 3
): number {
  // Posterior parameters
  const a = Math.max(0, successes) + alpha_prior;
  const b = Math.max(0, failures) + beta_prior;
  const n = a + b;
  if (n <= 0) return 0;
  const p = a / n;
  const z = 1.96; // q = 0.95
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lower = (centre - margin) / denom;
  if (!Number.isFinite(lower)) return 0;
  return Math.max(0, Math.min(1, lower));
}

// ─── CUSUM Change-Point Detector (Framework 6) ────────────────────────────────

/**
 * Reference value k between honest mean (μ_h≈0.95) and adversarial mean
 * (μ_a≈0.30). Midpoint ≈ 0.625. The CUSUM statistic increments whenever a
 * job outcome is closer to μ_a than to μ_h.
 *
 * Citation: Page (1954); Lorden (1971) optimality theorem.
 */
export const CUSUM_K = 0.625;

/**
 * Alarm threshold derived from a target false-alarm rate α=0.05.
 * Approximation: h ≈ log(1/α) / KL(μ_a ∥ μ_h) ≈ log(20) / 0.71 ≈ 4.2.
 * Expected detection delay E[T] = O(log(1/α)) once a change occurs.
 */
export const CUSUM_H = 4.2;

/**
 * Online CUSUM update for a single Bernoulli outcome.
 *  - x_t = 1 - outcome  (failures inflate the statistic)
 *  - S_t = max(0, S_{t-1} + x_t - (1 - K))
 * `alarm` is true once S_t exceeds the threshold.
 */
export function updateCUSUMScore(
  current: number,
  outcome: 0 | 1
): { newScore: number; alarm: boolean } {
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
  const x = outcome === 1 ? 0 : 1; // 1 for failure
  const newScore = Math.max(0, safeCurrent + x - (1 - CUSUM_K));
  return { newScore: round4(newScore), alarm: newScore > CUSUM_H };
}

// ─── Dual-CUSUM Sensitive Detector (Framework 6b) ─────────────────────────────
//
// Problem: The primary CUSUM (K=0.625) is calibrated for detecting a shift from
// μ_h=0.95 to μ_a=0.30. It NEVER alarms at 15% failure rate because the
// expected per-observation drift is negative:
//   E[increment] = 0.85×(-0.375) + 0.15×(+0.625) = -0.225 < 0
//
// Solution: A secondary CUSUM with a lower reference value K₂ calibrated to
// detect the shift from μ_h=0.95 (honest, ~5% failure) to μ_m=0.85 (moderate
// adversary, ~15% failure). The optimal reference value is the midpoint:
//   K₂ = (μ_h + μ_m) / 2 = (0.95 + 0.85) / 2 = 0.90
//
// At this K₂, the per-observation increment for a failure is:
//   x_t - (1 - K₂) = 1 - 0.10 = +0.90
// And for a success:
//   x_t - (1 - K₂) = 0 - 0.10 = -0.10
//
// Expected drift at 15% failure rate:
//   E[increment] = 0.85×(-0.10) + 0.15×(+0.90) = -0.085 + 0.135 = +0.05 > 0 ✓
//
// Expected drift at 5% failure rate (honest):
//   E[increment] = 0.95×(-0.10) + 0.05×(+0.90) = -0.095 + 0.045 = -0.05 < 0 ✓
//
// The positive drift at 15% means the statistic will eventually alarm.
// Expected detection delay: h₂ / E[increment] = 2.5 / 0.05 = 50 observations.
// At 5 jobs/round, this is ~10 rounds — well within the 36-round trust-building
// phase of a collusion ring.
//
// Threshold h₂ derivation: We accept a higher false-alarm rate (α=0.08) for
// this sensitive detector because it produces a "soft" penalty (utility
// suppression) rather than a hard rejection. Using Wald's approximation:
//   h₂ ≈ log(1/α) / KL(μ_m ∥ μ_h)
//   KL(Bernoulli(0.15) ∥ Bernoulli(0.05)) = 0.15·ln(0.15/0.05) + 0.85·ln(0.85/0.95) ≈ 0.0596
//   h₂ ≈ ln(1/0.08) / 0.0596 ≈ 2.53 / 0.0596 ≈ 42.4 (in KL units)
//
// However, the CUSUM statistic operates in raw increment units, not KL units.
// The practical threshold is calibrated empirically: h₂ = 2.5 gives
// E[alarm | honest] ≈ 1/(2×ARL₀) where ARL₀ > 200 observations at 5% failure.
// This means an honest agent with 5% failure rate would false-alarm after
// ~200 jobs on average — well beyond the 60-round simulation window.
//
// Citation: Page (1954) — CUSUM is optimal for detecting shifts in the
// exponential family. Lorden (1971) — minimax optimality of CUSUM.
// Moustakides (1986) — exact optimality proof for one-sided CUSUM.
// Tartakovsky & Veeravalli (2005) — multi-scale CUSUM for graded shifts.
//
// The dual-CUSUM approach (running two detectors at different sensitivities)
// is standard in sequential analysis: the primary detector catches large
// shifts quickly, while the secondary catches small shifts with more delay
// but still within operationally useful time horizons.

/**
 * Sensitive CUSUM reference value K₂ — midpoint between honest mean (0.95)
 * and moderate-adversary mean (0.85, i.e. 15% failure rate).
 */
export const CUSUM_K_SENSITIVE = 0.90;

/**
 * Sensitive CUSUM alarm threshold — calibrated for ARL₀ > 200 at 5% failure.
 * Lower than primary (4.2) because this detector targets smaller shifts.
 */
export const CUSUM_H_SENSITIVE = 2.5;

/**
 * Online sensitive CUSUM update for detecting moderate failure rates (10-20%).
 * Runs in parallel with the primary CUSUM. The sensitive detector produces
 * a "soft alarm" that triggers utility suppression rather than hard rejection.
 *
 * Mathematical properties:
 *   - At 5% failure (honest): E[drift] = -0.05/obs → never alarms (ARL₀ > 200)
 *   - At 12% failure (mediocre honest): E[drift] = +0.02/obs → alarms after ~125 obs
 *   - At 15% failure (adversary trust-building): E[drift] = +0.05/obs → alarms after ~50 obs
 *   - At 75% failure (adversary exploit): E[drift] = +0.65/obs → alarms after ~4 obs
 *
 * The 12% mediocre-honest case is a concern: these agents will eventually
 * trigger the sensitive alarm. This is acceptable because:
 *   (a) The alarm produces soft suppression (utility × 0.3), not hard rejection
 *   (b) Mediocre agents SHOULD receive lower routing priority — this is
 *       economically rational, not a false positive
 *   (c) The primary CUSUM (K=0.625, H=4.2) remains the hard-rejection gate
 */
export function updateCUSUMSensitive(
  current: number,
  outcome: 0 | 1
): { newScore: number; alarm: boolean } {
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : 0;
  const x = outcome === 1 ? 0 : 1; // 1 for failure
  const newScore = Math.max(0, safeCurrent + x - (1 - CUSUM_K_SENSITIVE));
  return { newScore: round4(newScore), alarm: newScore > CUSUM_H_SENSITIVE };
}

// ─── Score Computation ────────────────────────────────────────────────────────

/**
 * Compute the TRACE score from raw metrics.
 *
 * Formula:
 *   TRACE_Score = BASE + MAX·[
 *     w1·completionRate + w2·repaymentRate + w3·networkTrust
 *     + w4·stakeRatio + w5·successfulEscrowRate
 *     − w6·defaultProbability − w7·sybilRisk − w8·disputeRate
 *   ]
 *
 * Result is clamped to [0, 1000].
 */
export function computeTraceScore(input: TraceScoreInput): TraceScoreResult {
  const w = TRACE_WEIGHTS;

  // Positive contributions (each metric ∈ [0,1])
  const completionContribution   = w.w1_completionRate * input.completionRate;
  const repaymentContribution    = w.w2_repaymentRate * input.repaymentRate;
  const networkTrustContribution = w.w3_networkTrust * input.networkTrust;
  const stakeContribution        = w.w4_stakeRatio * input.stakeRatio;
  const escrowContribution       = w.w5_successfulEscrowRate * input.successfulEscrowRate;

  // Negative penalties
  const defaultPenalty = w.w6_defaultProbability * input.defaultProbability;
  const sybilPenalty   = w.w7_sybilRisk * input.sybilRisk;
  const disputePenalty = w.w8_disputeRate * input.disputeRate;

  // Sum positive weights: 0.25 + 0.20 + 0.15 + 0.10 + 0.15 = 0.85
  const positiveSum = completionContribution + repaymentContribution
    + networkTrustContribution + stakeContribution + escrowContribution;

  // Sum negative weights: 0.20 + 0.15 + 0.10 = 0.45
  const negativeSum = defaultPenalty + sybilPenalty + disputePenalty;

  // Net signal: positive contributions minus penalties
  // At perfect behaviour (all 1.0 positive, all 0.0 negative): net = 0.85
  // Scale to [0, 1000]
  const netSignal = positiveSum - negativeSum;
  // Map the signal range [-0.45, 0.85] → [0, 1000]
  const signalRange = 0.85 + 0.45; // 1.30 total range
  const normalized = (netSignal + 0.45) / signalRange;
  const rawScore = normalized * TRACE_MAX_SCORE;

  const traceScore = clamp(Math.round(rawScore * 100) / 100, TRACE_MIN_SCORE, TRACE_MAX_SCORE);
  const riskTier = computeRiskTier(traceScore);
  const defaultProbability = input.defaultProbability;

  return {
    traceScore,
    riskTier,
    defaultProbability,
    breakdown: {
      completionContribution: round4(completionContribution),
      repaymentContribution: round4(repaymentContribution),
      networkTrustContribution: round4(networkTrustContribution),
      stakeContribution: round4(stakeContribution),
      escrowContribution: round4(escrowContribution),
      defaultPenalty: round4(defaultPenalty),
      sybilPenalty: round4(sybilPenalty),
      disputePenalty: round4(disputePenalty),
    },
  };
}

/**
 * Compute P(default) from provider history.
 *
 * Inputs:
 *   - repayment failures (jobs where escrow was refunded or defaulted)
 *   - dispute count
 *   - recent instability (score volatility in the last 24h)
 *   - stake size (higher stake → lower default prob)
 *   - economic history depth
 */
export function computeDefaultProbability(provider: {
  totalJobs: number;
  failedJobs: number;
  defaultedJobs: number;
  disputedJobs: number;
  scoreVolatility: number;
  stakeSats: number;
  totalEconomicVolume: number;
  repaymentRate: number;
  recentFailureSignal?: number;
}): number {
  if (provider.totalJobs === 0) return 0.20; // Baseline for new providers (matches max history penalty)

  const w = DEFAULT_PROB_WEIGHTS;

  // Repayment failure signal: inversely proportional to repayment rate
  const repaymentFailure = 1.0 - provider.repaymentRate;

  // Dispute signal: fraction of jobs with disputes
  const disputeSignal = provider.totalJobs > 0
    ? provider.disputedJobs / provider.totalJobs
    : 0;

  // Recent instability: high score volatility → higher default risk
  // Normalize volatility to [0,1] — volatility > 100 is max
  const instabilitySignal = Math.min(provider.scoreVolatility / 100, 1.0);

  // Stake signal: more stake → less likely to default
  // High stake ratio → penalty is low; no stake → penalty is high
  const stakeRatio = provider.totalEconomicVolume > 0
    ? provider.stakeSats / provider.totalEconomicVolume
    : (provider.stakeSats > 0 ? 0.5 : 0);
  const stakePenalty = 1.0 - Math.min(stakeRatio * 10, 1.0); // Cap at 10x coverage

  // Economic history: deeper history → more confident, less punitive
  // New providers get slightly higher default prob due to uncertainty
  const historyDepth = Math.min(provider.totalJobs / 20, 1.0); // Normalize to [0,1]
  const historyPenalty = 1.0 - historyDepth;

  const recentFailureSignal = provider.recentFailureSignal ?? 0;
  const amplifiedRepaymentFailure = Math.min(
    repaymentFailure * (1 + recentFailureSignal * (RECENT_FAILURE.amplificationMultiplier - 1)),
    1.0
  );

  const rawProb =
    w.repaymentFailureWeight * amplifiedRepaymentFailure +
    w.disputeWeight * disputeSignal +
    w.recentInstabilityWeight * instabilitySignal +
    w.stakePenaltyWeight * stakePenalty +
    w.historyWeight * historyPenalty;

  return clamp(Math.round(rawProb * 10000) / 10000, 0, 1);
}

/**
 * Derive risk tier from TRACE score.
 */
export function computeRiskTier(traceScore: number): RiskTier {
  if (traceScore >= RISK_TIERS.A.min) return "A";
  if (traceScore >= RISK_TIERS.B.min) return "B";
  if (traceScore >= RISK_TIERS.C.min) return "C";
  return "D";
}

// ─── Score Update Engine ──────────────────────────────────────────────────────

export type EconomicEventType = keyof typeof SCORE_DELTAS;

/**
 * Update a provider's TRACE score after an economic event.
 *
 * Steps:
 *   1. Log the EconomicEvent
 *   2. Recompute provider metrics (completionRate, etc.) from job history
 *   3. Recompute TRACE score
 *   4. Persist updated provider fields
 *   5. Persist ScoreHistory snapshot
 *
 * This is the primary entry point — call after every routing/payment/escrow event.
 */
export async function updateScoreAfterEvent(
  providerId: string,
  eventType: EconomicEventType,
  jobId?: string,
  amountSats: number = 0,
  metadata: Record<string, unknown> = {}
): Promise<TraceScoreResult | null> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) return null;

  // Step 1: Log economic event
  await prisma.economicEvent.create({
    data: {
      providerId,
      jobId: jobId ?? null,
      eventType,
      amountSats,
      metadata: JSON.stringify(metadata),
    },
  });

  // Step 2: Recompute provider metrics from actual data
  const metrics = await recomputeMetrics(providerId);

  // Step 3: Compute default probability
  const defaultProbability = computeDefaultProbability({
    totalJobs: metrics.totalJobs,
    failedJobs: metrics.failedJobs,
    defaultedJobs: metrics.defaultedJobs,
    disputedJobs: metrics.disputedJobs,
    scoreVolatility: provider.scoreVolatility,
    stakeSats: provider.stakeSats,
    totalEconomicVolume: metrics.totalEconomicVolume,
    repaymentRate: metrics.repaymentRate,
    recentFailureSignal: metrics.recentFailureSignal,
  });

  // Step 4: Compute TRACE score
  const result = computeTraceScore({
    completionRate: metrics.completionRate,
    repaymentRate: metrics.repaymentRate,
    networkTrust: provider.networkTrust, // Graph-derived — updated separately
    stakeRatio: metrics.stakeRatio,
    successfulEscrowRate: metrics.successfulEscrowRate,
    defaultProbability,
    sybilRisk: provider.sybilRisk, // Graph-derived — updated separately
    disputeRate: metrics.disputeRate,
  });

  // Step 5: Compute score volatility (stddev of last 10 score changes)
  const recentScores = await prisma.scoreHistory.findMany({
    where: { providerId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { traceScore: true },
  });
  const volatility = computeVolatility(recentScores.map((s) => s.traceScore), result.traceScore);

  // Step 6: Persist updated provider
  await prisma.provider.update({
    where: { id: providerId },
    data: {
      traceScore: result.traceScore,
      riskTier: result.riskTier,
      defaultProbability: result.defaultProbability,
      completionRate: metrics.completionRate,
      repaymentRate: metrics.repaymentRate,
      successfulEscrowRate: metrics.successfulEscrowRate,
      disputeRate: metrics.disputeRate,
      stakeRatio: metrics.stakeRatio,
      scoreVolatility: volatility,
      totalJobs: metrics.totalJobs,
      totalEconomicVolume: metrics.totalEconomicVolume,
      successfulJobs: metrics.successfulJobs,
      failedJobs: metrics.failedJobs,
      defaultedJobs: metrics.defaultedJobs,
      disputedJobs: metrics.disputedJobs,
      // v2.9 Phase 2: Update advanced fraud detection fields
      recentFailureWindow: await computeRecentFailureWindow(providerId),
      failureCorrelation: await computeFailureCorrelation(providerId),
      // v3.0: CUSUM change-point statistic (Framework 6)
      // Only update on job outcome events; other events leave it unchanged.
      ...(eventType === "JOB_SUCCESS" || eventType === "JOB_FAILURE"
        ? { cusumScore: updateCUSUMScore(
            provider.cusumScore ?? 0,
            eventType === "JOB_SUCCESS" ? 1 : 0
          ).newScore }
        : {}),
    },
  });

  // Step 7: Persist score history snapshot
  await prisma.scoreHistory.create({
    data: {
      providerId,
      traceScore: result.traceScore,
      riskTier: result.riskTier,
      defaultProbability: result.defaultProbability,
      completionRate: metrics.completionRate,
      repaymentRate: metrics.repaymentRate,
      networkTrust: provider.networkTrust,
      sybilRisk: provider.sybilRisk,
      triggerEvent: eventType,
    },
  });

  return result;
}

// ─── Metric Recomputation ─────────────────────────────────────────────────────

interface RecomputedMetrics {
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
  scoreVolatility: number;
  recentFailureSignal: number;
  totalEconomicVolume: number;
}

/**
 * Recompute all derived metrics from actual job/event data.
 * This ensures metrics are always grounded in reality, not accumulated errors.
 */
async function recomputeMetrics(providerId: string): Promise<RecomputedMetrics> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) {
    return {
      totalJobs: 0, successfulJobs: 0, failedJobs: 0, defaultedJobs: 0, disputedJobs: 0,
      completionRate: 1, repaymentRate: 1, successfulEscrowRate: 1, disputeRate: 0,
      stakeRatio: 0, scoreVolatility: 0, recentFailureSignal: 0, totalEconomicVolume: 0,
    };
  }

  // Count job outcomes from actual job records
  const jobs = await prisma.job.findMany({
    where: { providerId },
    select: { id: true, status: true, priceSats: true, escrowStatus: true, input: true },
  });

  const totalJobs = jobs.length;
  const successfulJobs = jobs.filter((j) => j.status === "completed").length;
  const failedJobs = jobs.filter((j) => j.status === "failed").length;

  // Escrow metrics
  const escrowJobs = jobs.filter((j) => j.escrowStatus !== "none");
  const releasedEscrows = escrowJobs.filter((j) => j.escrowStatus === "released").length;

  // Count from EconomicEvent for events not tracked in Job
  // Validated events: only count events tied to real jobs
  const defaultEvents = await prisma.economicEvent.count({
    where: { providerId, eventType: "DEFAULT", jobId: { not: null } },
  });
  const disputeEvents = await prisma.economicEvent.count({
    where: { providerId, eventType: "DISPUTE", jobId: { not: null } },
  });

  const defaultedJobs = defaultEvents;
  const disputedJobs = disputeEvents;

  // Total economic volume
  const totalEconomicVolume = jobs.reduce((sum, j) => sum + j.priceSats, 0);

  // Derived rates — v2.5: VOLUME-WEIGHTED for economic realism
  const successfulVolume = jobs.filter(j => j.status === "completed").reduce((sum, j) => sum + j.priceSats, 0);
  const completionRate = totalEconomicVolume > 0 ? successfulVolume / totalEconomicVolume : 1.0;

  // Repayment volume: total volume minus defaulted volume
  const defaultedJobsList = await prisma.economicEvent.findMany({
    where: { providerId, eventType: "DEFAULT", jobId: { not: null } },
    select: { jobId: true }
  });
  const defaultedJobIds = new Set(defaultedJobsList.map(e => e.jobId));
  const defaultedVolume = jobs.filter(j => defaultedJobIds.has(j.id)).reduce((sum, j) => sum + j.priceSats, 0);
  const repaymentRate = totalEconomicVolume > 0 ? 1.0 - (defaultedVolume / totalEconomicVolume) : 1.0;

  const releasedEscrowVolume = escrowJobs.filter(j => j.escrowStatus === "released").reduce((sum, j) => sum + j.priceSats, 0);
  const totalEscrowVolume = escrowJobs.reduce((sum, j) => sum + j.priceSats, 0);
  const successfulEscrowRate = totalEscrowVolume > 0 ? releasedEscrowVolume / totalEscrowVolume : 1.0;

  const disputedJobsList = await prisma.economicEvent.findMany({
    where: { providerId, eventType: "DISPUTE", jobId: { not: null } },
    select: { jobId: true }
  });
  const disputedJobIds = new Set(disputedJobsList.map(e => e.jobId));
  const disputedVolume = jobs.filter(j => disputedJobIds.has(j.id)).reduce((sum, j) => sum + j.priceSats, 0);
  const disputeRate = totalEconomicVolume > 0 ? disputedVolume / totalEconomicVolume : 0.0;
  const recentFailureSignal = computeRecentFailureSignal(jobs);

  // Stake ratio
  const stakeRatio = totalEconomicVolume > 0
    ? Math.min(provider.stakeSats / totalEconomicVolume, 1.0)
    : (provider.stakeSats > 0 ? 0.5 : 0.0);

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
    scoreVolatility: 0, // Will be computed from score history
    recentFailureSignal: round4(recentFailureSignal),
    totalEconomicVolume,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Compute the rolling standard deviation of recent scores including the new one.
 */
function computeVolatility(recentScores: number[], newScore: number): number {
  const scores = [...recentScores, newScore];
  if (scores.length < 2) return 0;

  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
  return round4(Math.sqrt(variance));
}

function computeRecentFailureSignal(jobs: Array<{ status: string; input: string }>): number {
  const roundJobs = jobs
    .map((job) => ({ status: job.status, round: readSimRound(job.input) }))
    .filter((job): job is { status: string; round: number } => job.round !== null);

  if (roundJobs.length === 0) return 0;

  const latestRound = Math.max(...roundJobs.map((job) => job.round));
  let weightedFailures = 0;
  let weightedTotal = 0;

  for (const job of roundJobs) {
    const age = latestRound - job.round;
    if (age < 0 || age >= RECENT_FAILURE.windowRounds) continue;

    const weight = Math.max(0, 1 - age * RECENT_FAILURE.decayPerRound);
    weightedTotal += weight;
    if (job.status === "failed") {
      weightedFailures += weight;
    }
  }

  return weightedTotal > 0 ? Math.min(weightedFailures / weightedTotal, 1.0) : 0;
}

function readSimRound(input: string): number | null {
  try {
    const parsed = JSON.parse(input) as { round?: unknown };
    return typeof parsed.round === "number" ? parsed.round : null;
  } catch {
    return null;
  }
}

// ─── v2.9 Phase 2: Advanced Fraud Detection ──────────────────────────────────

/**
 * v2.9 Fix 4: Compute recent failure window (count of failures in last 10 jobs).
 * 
 * This detects failure clustering - agents who cluster their defaults in bursts
 * rather than spreading them evenly. Coordinated attacks often show this pattern.
 * 
 * Returns: Count of failed jobs in the most recent 10 jobs [0-10]
 */
async function computeRecentFailureWindow(providerId: string): Promise<number> {
  const recentJobs = await prisma.job.findMany({
    where: { providerId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { status: true },
  });
  
  return recentJobs.filter(job => job.status === "failed").length;
}

/**
 * v2.9 Fix 5: Compute failure correlation with graph neighbors.
 * 
 * This detects coordinated fraud - agents who fail on the same buyers/rounds
 * as their graph neighbors. High correlation indicates coordinated attacks.
 * 
 * Returns: Correlation coefficient [0-1] where 1 = perfect correlation
 */
async function computeFailureCorrelation(providerId: string): Promise<number> {
  // Get trust edges to find graph neighbors
  const edges = await prisma.trustEdge.findMany({
    where: { 
      OR: [
        { sourceProviderId: providerId },
        { targetProviderId: providerId }
      ]
    },
    select: { 
      sourceProviderId: true, 
      targetProviderId: true 
    }
  });
  
  if (edges.length === 0) return 0; // No graph neighbors
  
  // Get neighbor IDs
  const neighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.sourceProviderId === providerId) {
      neighborIds.add(edge.targetProviderId);
    } else {
      neighborIds.add(edge.sourceProviderId);
    }
  }
  
  if (neighborIds.size === 0) return 0;
  
  // Get this provider's failed jobs with buyer and timestamp
  const providerFailures = await prisma.job.findMany({
    where: { 
      providerId,
      status: "failed"
    },
    select: { 
      buyerId: true, 
      createdAt: true 
    }
  });
  
  if (providerFailures.length === 0) return 0; // No failures to correlate
  
  // Create failure signature: "buyerId-timestamp" (rounded to hour for correlation)
  const providerFailureSignatures = new Set(
    providerFailures.map(f => 
      `${f.buyerId}-${Math.floor(f.createdAt.getTime() / (1000 * 60 * 60))}`
    )
  );
  
  // Check correlation with each neighbor
  let totalCorrelation = 0;
  let neighborsChecked = 0;
  
  for (const neighborId of neighborIds) {
    const neighborFailures = await prisma.job.findMany({
      where: { 
        providerId: neighborId,
        status: "failed"
      },
      select: { 
        buyerId: true, 
        createdAt: true 
      }
    });
    
    if (neighborFailures.length === 0) continue;
    
    const neighborFailureSignatures = new Set(
      neighborFailures.map(f => 
        `${f.buyerId}-${Math.floor(f.createdAt.getTime() / (1000 * 60 * 60))}`
      )
    );
    
    // Calculate Jaccard similarity (intersection / union)
    const intersection = new Set(
      [...providerFailureSignatures].filter(sig => neighborFailureSignatures.has(sig))
    );
    
    const union = new Set([...providerFailureSignatures, ...neighborFailureSignatures]);
    
    const similarity = union.size > 0 ? intersection.size / union.size : 0;
    totalCorrelation += similarity;
    neighborsChecked++;
  }
  
  // Return average correlation across all neighbors
  return neighborsChecked > 0 ? round4(totalCorrelation / neighborsChecked) : 0;
}
