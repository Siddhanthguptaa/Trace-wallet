/**
 * Experiment Metrics — Aggregation engine for paper-ready metrics.
 *
 * Computes:
 *   - Task success rate (overall + per-policy)
 *   - Fraud exposure (sats lost to malicious defaults)
 *   - Dispute rate
 *   - Average provider utility
 *   - Routing concentration (Gini coefficient)
 *   - Recovery time after attack
 *   - Trust volatility
 *   - Malicious routing frequency
 */

export interface RoundMetrics {
  round: number;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  successRate: number;
  fraudExposureSats: number;        // Sats paid to agents that defaulted
  maliciousRoutingCount: number;    // Times a malicious agent was selected
  maliciousRoutingRate: number;     // maliciousRoutingCount / totalJobs
  postBurstMaliciousRoutingCount: number; // Number of routes to agents that have previously caused at least one fraud event
  honestRoutingCount: number;       // v3.0 Audit Fix F3: Times an honest agent was selected
  honestRoutingRate: number;        // v3.0 Audit Fix F3: honestRoutingCount / totalJobs
  avgTraceScore: number;            // Average TRACE score of routed providers
  avgMaliciousTraceScore: number;   // Average TRACE score of malicious providers
  avgHonestTraceScore: number;      // Average TRACE score of honest providers
  routingConcentration: number;     // Gini coefficient of routing distribution
  scoreVolatility: number;          // Average score volatility across providers
}

export interface ExperimentMetrics {
  experimentId: string;
  policy: string;
  attack: string;
  totalRounds: number;
  totalAgents: number;
  maliciousAgents: number;

  // Aggregate metrics
  overallSuccessRate: number;
  totalFraudExposureSats: number;
  totalJobsRouted: number;
  totalMaliciousRoutes: number;
  maliciousRoutingRate: number;

  // Recovery metrics
  recoveryTimeRounds: number;       // Rounds to recover success rate after attack
  preAttackSuccessRate: number;
  duringAttackSuccessRate: number;
  postAttackSuccessRate: number;

  // Score dynamics
  peakMaliciousTraceScore: number;
  finalMaliciousTraceScore: number;
  maliciousScoreDropMagnitude: number;

  // Routing quality
  avgRoutingConcentration: number;
  maxFraudExposureInSingleRound: number;

  // Per-round data
  rounds: RoundMetrics[];

  // R-RECOVERY (design D.3): Per-cell recovery metric from computeRecoveryMetric.
  // Records the first round at which the smoothed maliciousRoutingRate re-enters
  // the honest-only baseline tolerance band (mean ± 2σ).
  recoveryRound?: {
    fraudExposure: number | null;
    maliciousRoutingRate: number | null;
  };
}

/**
 * Compute round-level metrics from job outcomes.
 */
export function computeRoundMetrics(
  round: number,
  jobs: Array<{
    providerId: string;
    success: boolean;
    priceSats: number;
    traceScore: number;
  }>,
  maliciousIds: Set<string>,
  allProviderScores: Map<string, number>,
  defaultedMaliciousIds?: Set<string>
): RoundMetrics {
  const totalJobs = jobs.length;
  const successfulJobs = jobs.filter((j) => j.success).length;
  const failedJobs = totalJobs - successfulJobs;

  // Fraud exposure: sats paid to malicious agents that defaulted
  const fraudExposureSats = jobs
    .filter((j) => maliciousIds.has(j.providerId) && !j.success)
    .reduce((sum, j) => sum + j.priceSats, 0);

  // Malicious routing
  const maliciousRoutingCount = jobs.filter((j) => maliciousIds.has(j.providerId)).length;
  const honestRoutingCount = jobs.filter((j) => !maliciousIds.has(j.providerId)).length;
  const postBurstMaliciousRoutingCount = defaultedMaliciousIds 
    ? jobs.filter((j) => defaultedMaliciousIds.has(j.providerId)).length
    : 0;

  // Average TRACE scores
  const maliciousScores = [...allProviderScores.entries()]
    .filter(([id]) => maliciousIds.has(id))
    .map(([, s]) => s);
  const honestScores = [...allProviderScores.entries()]
    .filter(([id]) => !maliciousIds.has(id))
    .map(([, s]) => s);
  const allScores = [...allProviderScores.values()];

  const avgTraceScore = allScores.length > 0 ? allScores.reduce((s, v) => s + v, 0) / allScores.length : 0;
  const avgMaliciousTraceScore = maliciousScores.length > 0 ? maliciousScores.reduce((s, v) => s + v, 0) / maliciousScores.length : 0;
  const avgHonestTraceScore = honestScores.length > 0 ? honestScores.reduce((s, v) => s + v, 0) / honestScores.length : 0;

  // Routing concentration (Gini coefficient)
  const routingConcentration = computeGini(jobs.map((j) => j.providerId));

  // Score volatility: average absolute change would need history; use 0 for now (populated later)
  const scoreVolatility = 0;

  return {
    round,
    totalJobs,
    successfulJobs,
    failedJobs,
    successRate: totalJobs > 0 ? successfulJobs / totalJobs : 1,
    fraudExposureSats,
    maliciousRoutingCount,
    maliciousRoutingRate: totalJobs > 0 ? maliciousRoutingCount / totalJobs : 0,
    postBurstMaliciousRoutingCount,
    honestRoutingCount,
    honestRoutingRate: totalJobs > 0 ? honestRoutingCount / totalJobs : 0,
    avgTraceScore: round2(avgTraceScore),
    avgMaliciousTraceScore: round2(avgMaliciousTraceScore),
    avgHonestTraceScore: round2(avgHonestTraceScore),
    routingConcentration: round4(routingConcentration),
    scoreVolatility,
  };
}

/**
 * Aggregate round metrics into experiment-level metrics.
 */
export function aggregateMetrics(
  experimentId: string,
  policy: string,
  attack: string,
  totalAgents: number,
  maliciousAgents: number,
  rounds: RoundMetrics[],
  attackStartRound: number
): ExperimentMetrics {
  const totalRounds = rounds.length;
  const totalJobsRouted = rounds.reduce((s, r) => s + r.totalJobs, 0);
  const totalSuccessful = rounds.reduce((s, r) => s + r.successfulJobs, 0);
  const totalFraudExposureSats = rounds.reduce((s, r) => s + r.fraudExposureSats, 0);
  const totalMaliciousRoutes = rounds.reduce((s, r) => s + r.maliciousRoutingCount, 0);

  // Pre/during/post attack success rates
  const preAttackRounds = rounds.filter((r) => r.round < attackStartRound);
  const duringAttackRounds = rounds.filter((r) => r.round >= attackStartRound && r.round < attackStartRound + 5);
  const postAttackRounds = rounds.filter((r) => r.round >= attackStartRound + 5);

  const preAttackSuccessRate = avg(preAttackRounds.map((r) => r.successRate));
  const duringAttackSuccessRate = avg(duringAttackRounds.map((r) => r.successRate));
  const postAttackSuccessRate = avg(postAttackRounds.map((r) => r.successRate));

  // Recovery time: rounds after attack start until success rate returns to 90% of pre-attack
  // F4 fix: For always-on attacks (attackStartRound=0), use theoretical honest baseline
  const effectiveBaseline = preAttackRounds.length > 0
    ? preAttackSuccessRate
    : 0.95; // theoretical honest success rate (1 - 0.05 honestFailureRate)
  const threshold = effectiveBaseline * 0.9;
  let recoveryTimeRounds = -1;
  for (let i = attackStartRound; i < rounds.length; i++) {
    if (rounds[i].successRate >= threshold) {
      recoveryTimeRounds = i - attackStartRound;
      break;
    }
  }
  if (recoveryTimeRounds === -1) recoveryTimeRounds = totalRounds - attackStartRound; // Never recovered

  // Malicious score dynamics
  const maliciousScores = rounds.map((r) => r.avgMaliciousTraceScore);
  const peakMaliciousTraceScore = Math.max(...maliciousScores, 0);
  const finalMaliciousTraceScore = maliciousScores[maliciousScores.length - 1] ?? 0;

  // Routing quality
  const avgRoutingConcentration = avg(rounds.map((r) => r.routingConcentration));
  const maxFraudExposureInSingleRound = Math.max(...rounds.map((r) => r.fraudExposureSats), 0);

  return {
    experimentId,
    policy,
    attack,
    totalRounds,
    totalAgents,
    maliciousAgents,
    overallSuccessRate: round4(totalJobsRouted > 0 ? totalSuccessful / totalJobsRouted : 1),
    totalFraudExposureSats,
    totalJobsRouted,
    totalMaliciousRoutes,
    maliciousRoutingRate: round4(totalJobsRouted > 0 ? totalMaliciousRoutes / totalJobsRouted : 0),
    recoveryTimeRounds,
    preAttackSuccessRate: round4(preAttackSuccessRate),
    duringAttackSuccessRate: round4(duringAttackSuccessRate),
    postAttackSuccessRate: round4(postAttackSuccessRate),
    peakMaliciousTraceScore: round2(peakMaliciousTraceScore),
    finalMaliciousTraceScore: round2(finalMaliciousTraceScore),
    maliciousScoreDropMagnitude: round2(peakMaliciousTraceScore - finalMaliciousTraceScore),
    avgRoutingConcentration: round4(avgRoutingConcentration),
    maxFraudExposureInSingleRound,
    rounds,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Compute Gini coefficient of routing distribution.
 * 0 = perfectly equal (all providers get same jobs)
 * 1 = maximally concentrated (one provider gets all jobs)
 */
function computeGini(providerIds: string[]): number {
  if (providerIds.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const id of providerIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const values = [...counts.values()].sort((a, b) => a - b);
  const n = values.length;
  const total = values.reduce((s, v) => s + v, 0);

  if (total === 0 || n === 0) return 0;

  let sumOfDifferences = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumOfDifferences += Math.abs(values[i] - values[j]);
    }
  }

  return sumOfDifferences / (2 * n * total);
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Convert metrics to CSV format.
 */
export function roundMetricsToCSV(rounds: RoundMetrics[]): string {
  const headers = [
    "round", "totalJobs", "successfulJobs", "failedJobs", "successRate",
    "fraudExposureSats", "maliciousRoutingCount", "maliciousRoutingRate",
    "postBurstMaliciousRoutingCount", "honestRoutingCount", "honestRoutingRate",
    "avgTraceScore", "avgMaliciousTraceScore", "avgHonestTraceScore",
    "routingConcentration", "scoreVolatility",
  ];

  const rows = rounds.map((r) =>
    headers.map((h) => String((r as unknown as Record<string, unknown>)[h] ?? "")).join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

/**
 * Convert score history to CSV format.
 */
export function scoreHistoryToCSV(
  history: Array<{
    round: number;
    providerId: string;
    providerName: string;
    traceScore: number;
    riskTier: string;
    isMalicious: boolean;
  }>
): string {
  const headers = ["round", "providerId", "providerName", "traceScore", "riskTier", "isMalicious"];
  const rows = history.map((h) =>
    [h.round, h.providerId, h.providerName, h.traceScore, h.riskTier, h.isMalicious].join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}
