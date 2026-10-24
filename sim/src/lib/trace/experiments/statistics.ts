/**
 * TRACE — Statistical Analysis Module
 *
 * Publication-grade statistical functions for experiment analysis:
 *   - Descriptive statistics (mean, std, median, quartiles, min/max)
 *   - Mann-Whitney U test (non-parametric, handles skewed distributions)
 *   - Effect size (rank-biserial correlation)
 *   - Outlier detection (IQR method)
 *   - Formatted tables for paper
 */

// ─── Descriptive Statistics ───────────────────────────────────────────────────

export interface DescriptiveStats {
  mean: number;
  std: number;
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
  n: number;
  /** Formatted as "mean ± std" */
  formatted: string;
}

export function descriptiveStats(values: number[]): DescriptiveStats {
  if (values.length === 0) {
    return { mean: 0, std: 0, median: 0, q1: 0, q3: 0, min: 0, max: 0, n: 0, formatted: "N/A" };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  const std = Math.sqrt(variance);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);

  return {
    mean: round(mean, 2),
    std: round(std, 2),
    median: round(median, 2),
    q1: round(q1, 2),
    q3: round(q3, 2),
    min: round(sorted[0], 2),
    max: round(sorted[n - 1], 2),
    n,
    formatted: `${round(mean, 1)} ± ${round(std, 1)}`,
  };
}

function percentile(sorted: number[], p: number): number {
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ─── Mann-Whitney U Test ──────────────────────────────────────────────────────

export interface MannWhitneyResult {
  U: number;
  z: number;
  pValue: number;
  effectSize: number; // Rank-biserial correlation r
  significant: boolean; // p < 0.05
  interpretation: string;
}

/**
 * Non-parametric test comparing two independent groups.
 * Returns U statistic, z-score, p-value, and effect size.
 *
 * Effect size interpretation (rank-biserial r):
 *   - |r| < 0.1: negligible
 *   - 0.1 ≤ |r| < 0.3: small
 *   - 0.3 ≤ |r| < 0.5: medium
 *   - |r| ≥ 0.5: large
 */
export function mannWhitneyU(groupA: number[], groupB: number[]): MannWhitneyResult {
  const nA = groupA.length;
  const nB = groupB.length;

  if (nA < 2 || nB < 2) {
    return {
      U: 0, z: 0, pValue: 1, effectSize: 0,
      significant: false, interpretation: "insufficient data (n < 2)",
    };
  }

  // Combine and rank
  const combined: Array<{ value: number; group: "A" | "B" }> = [
    ...groupA.map((v) => ({ value: v, group: "A" as const })),
    ...groupB.map((v) => ({ value: v, group: "B" as const })),
  ];
  combined.sort((a, b) => a.value - b.value);

  // Assign ranks (handle ties with average rank)
  const ranks = assignRanks(combined.map((c) => c.value));

  // Sum of ranks for group A
  let rankSumA = 0;
  let rankIdx = 0;
  for (const item of combined) {
    if (item.group === "A") {
      rankSumA += ranks[rankIdx];
    }
    rankIdx++;
  }

  // U statistics
  const UA = rankSumA - (nA * (nA + 1)) / 2;
  const UB = nA * nB - UA;
  const U = Math.min(UA, UB);

  // Normal approximation (valid for n ≥ 10, reasonable for n ≥ 5)
  const meanU = (nA * nB) / 2;
  const stdU = Math.sqrt((nA * nB * (nA + nB + 1)) / 12);
  const z = stdU > 0 ? (UA - meanU) / stdU : 0;

  // Two-tailed p-value from normal approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  // Rank-biserial correlation (effect size)
  const effectSize = 1 - (2 * U) / (nA * nB);

  const interpretation = interpretEffectSize(effectSize);

  return {
    U: round(U, 2),
    z: round(z, 4),
    pValue: round(Math.max(pValue, 0.0001), 4), // Floor at 0.0001
    effectSize: round(effectSize, 4),
    significant: pValue < 0.05,
    interpretation,
  };
}

function assignRanks(sorted: number[]): number[] {
  const n = sorted.length;
  const ranks = new Array(n);
  let i = 0;

  while (i < n) {
    let j = i;
    // Find group of tied values
    while (j < n && sorted[j] === sorted[i]) j++;
    // Assign average rank to all tied values
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[k] = avgRank;
    i = j;
  }

  return ranks;
}

function normalCDF(x: number): number {
  // Approximation using error function
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const p =
    d *
    Math.exp((-x * x) / 2) *
    (t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));

  return x >= 0 ? 1 - p : p;
}

function interpretEffectSize(r: number): string {
  const absR = Math.abs(r);
  if (absR < 0.1) return "negligible";
  if (absR < 0.3) return "small";
  if (absR < 0.5) return "medium";
  return "large";
}

// ─── Outlier Detection ────────────────────────────────────────────────────────

export interface OutlierReport {
  outliers: Array<{ value: number; index: number; direction: "high" | "low" }>;
  iqr: number;
  lowerFence: number;
  upperFence: number;
  cleanValues: number[];
}

/**
 * IQR-based outlier detection (1.5× IQR rule).
 */
export function detectOutliers(values: number[]): OutlierReport {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;

  const outliers: OutlierReport["outliers"] = [];
  const cleanValues: number[] = [];

  values.forEach((v, i) => {
    if (v < lowerFence) {
      outliers.push({ value: v, index: i, direction: "low" });
    } else if (v > upperFence) {
      outliers.push({ value: v, index: i, direction: "high" });
    } else {
      cleanValues.push(v);
    }
  });

  return { outliers, iqr: round(iqr, 2), lowerFence: round(lowerFence, 2), upperFence: round(upperFence, 2), cleanValues };
}

// ─── Formatted Output Helpers ─────────────────────────────────────────────────

/** Format a percentage with mean±std: "95.3 ± 2.1%" */
export function formatPctStat(values: number[]): string {
  const stats = descriptiveStats(values.map((v) => v * 100));
  return `${stats.mean.toFixed(1)} ± ${stats.std.toFixed(1)}%`;
}

/** Format a sats amount with mean±std: "12.3 ± 5.1 sats" */
export function formatSatsStat(values: number[]): string {
  const stats = descriptiveStats(values);
  return `${stats.mean.toFixed(1)} ± ${stats.std.toFixed(1)} sats`;
}

/** Format significance result: "p=0.003 *" or "p=0.42 ns" */
export function formatSignificance(result: MannWhitneyResult): string {
  const stars = result.pValue < 0.001 ? "***" : result.pValue < 0.01 ? "**" : result.pValue < 0.05 ? "*" : "ns";
  return `p=${result.pValue.toFixed(4)} ${stars} (r=${result.effectSize.toFixed(2)}, ${result.interpretation})`;
}

// ─── Multi-Seed Aggregation ───────────────────────────────────────────────────

export interface MultiSeedMetrics {
  successRate: DescriptiveStats;
  fraudExposure: DescriptiveStats;
  maliciousRouting: DescriptiveStats;
  recoveryTime: DescriptiveStats;
  duringAttackSuccess: DescriptiveStats;
  postAttackSuccess: DescriptiveStats;
  routingConcentration: DescriptiveStats;
}

export interface ExperimentResult {
  overallSuccessRate: number;
  totalFraudExposureSats: number;
  maliciousRoutingRate: number;
  recoveryTimeRounds: number;
  duringAttackSuccessRate: number;
  postAttackSuccessRate: number;
  avgRoutingConcentration: number;
  [key: string]: number;
}

export function aggregateMultiSeed(results: ExperimentResult[]): MultiSeedMetrics {
  return {
    successRate: descriptiveStats(results.map((r) => r.overallSuccessRate)),
    fraudExposure: descriptiveStats(results.map((r) => r.totalFraudExposureSats)),
    maliciousRouting: descriptiveStats(results.map((r) => r.maliciousRoutingRate)),
    recoveryTime: descriptiveStats(results.map((r) => r.recoveryTimeRounds)),
    duringAttackSuccess: descriptiveStats(results.map((r) => r.duringAttackSuccessRate)),
    postAttackSuccess: descriptiveStats(results.map((r) => r.postAttackSuccessRate)),
    routingConcentration: descriptiveStats(results.map((r) => r.avgRoutingConcentration)),
  };
}

// ─── Comparison Table Generator ───────────────────────────────────────────────

export interface ComparisonRow {
  attack: string;
  metric: string;
  trace: string;
  reputation: string;
  price: string;
  traceVsRep: string;
  traceVsPrice: string;
}

export function generateComparisonTable(
  traceResults: ExperimentResult[],
  repResults: ExperimentResult[],
  priceResults: ExperimentResult[],
  attack: string
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  const metricDefs: Array<{
    name: string;
    extract: (r: ExperimentResult) => number;
    formatFn: (vals: number[]) => string;
  }> = [
    {
      name: "Success Rate",
      extract: (r) => r.overallSuccessRate,
      formatFn: formatPctStat,
    },
    {
      name: "Fraud Exposure",
      extract: (r) => r.totalFraudExposureSats,
      formatFn: formatSatsStat,
    },
    {
      name: "Mal. Routing",
      extract: (r) => r.maliciousRoutingRate,
      formatFn: formatPctStat,
    },
    {
      name: "Recovery Time",
      extract: (r) => r.recoveryTimeRounds,
      formatFn: (vals) => {
        const s = descriptiveStats(vals);
        return `${s.mean.toFixed(1)} ± ${s.std.toFixed(1)} rds`;
      },
    },
  ];

  for (const def of metricDefs) {
    const traceVals = traceResults.map(def.extract);
    const repVals = repResults.map(def.extract);
    const priceVals = priceResults.map(def.extract);

    const traceVsRep = mannWhitneyU(traceVals, repVals);
    const traceVsPrice = mannWhitneyU(traceVals, priceVals);

    rows.push({
      attack,
      metric: def.name,
      trace: def.formatFn(traceVals),
      reputation: def.formatFn(repVals),
      price: def.formatFn(priceVals),
      traceVsRep: formatSignificance(traceVsRep),
      traceVsPrice: formatSignificance(traceVsPrice),
    });
  }

  return rows;
}

// ─── Tail-risk stats & Cliff's δ with bootstrap CI (Final_implementation.md) ───

export interface DetailedFraudStats {
  mean: number;
  std: number;
  median: number;
  p95: number;
  p99: number;
  skewness: number;
  catastrophicSeeds: number;
}

export function computeDetailedStats(fraudValues: number[]): DetailedFraudStats {
  if (fraudValues.length === 0) {
    return {
      mean: 0,
      std: 0,
      median: 0,
      p95: 0,
      p99: 0,
      skewness: 0,
      catastrophicSeeds: 0,
    };
  }

  const sorted = [...fraudValues].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = fraudValues.reduce((s, v) => s + v, 0) / n;
  const variance =
    n > 1 ? fraudValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);

  let skewness = 0;
  if (n >= 3 && std > 1e-12) {
    skewness =
      fraudValues.reduce((s, v) => s + ((v - mean) / std) ** 3, 0) *
      (n / ((n - 1) * (n - 2)));
  }

  const p95 = sorted[Math.min(Math.floor(0.95 * n), n - 1)];
  const p99 = sorted[Math.min(Math.floor(0.99 * n), n - 1)];
  const catastrophicThreshold = mean + 2 * std;
  const catastrophicSeeds = fraudValues.filter((v) => v > catastrophicThreshold).length;

  return {
    mean: round(mean, 4),
    std: round(std, 4),
    median: round(n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)], 4),
    p95: round(p95, 4),
    p99: round(p99, 4),
    skewness: round(skewness, 4),
    catastrophicSeeds,
  };
}

/** Cliff's delta — pairwise dominance of group A vs B, in [–1, 1]. */
export function cliffsDelta(groupA: number[], groupB: number[]): number {
  if (groupA.length === 0 || groupB.length === 0) return 0;
  let gt = 0;
  let lt = 0;
  for (const x of groupA) {
    for (const y of groupB) {
      if (x > y) gt += 1;
      else if (x < y) lt += 1;
    }
  }
  return (gt - lt) / (groupA.length * groupB.length);
}

function bootstrapSample<T>(arr: T[]): T[] {
  return Array.from({ length: arr.length }, () => arr[Math.floor(Math.random() * arr.length)]);
}

export interface CliffsDeltaCI {
  delta: number;
  ci_lower: number;
  ci_upper: number;
}

/** Bootstrap confidence interval for Cliff's delta. */
export function cliffsDeltaCI(
  groupA: number[],
  groupB: number[],
  alpha: number = 0.05,
  nBootstrap: number = 1000
): CliffsDeltaCI {
  const deltas: number[] = [];
  for (let i = 0; i < nBootstrap; i += 1) {
    deltas.push(cliffsDelta(bootstrapSample(groupA), bootstrapSample(groupB)));
  }
  deltas.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * nBootstrap);
  const hiIdx = Math.floor((1 - alpha / 2) * nBootstrap) - 1;
  return {
    delta: cliffsDelta(groupA, groupB),
    ci_lower: deltas[Math.max(0, loIdx)] ?? deltas[0] ?? 0,
    ci_upper: deltas[Math.min(nBootstrap - 1, Math.max(0, hiIdx))] ?? deltas[deltas.length - 1] ?? 0,
  };
}
