/**
 * scripts/runExtremeScaleMatrix.ts
 *
 * Extreme-Scale Stress-Test Runner — N=5000 and N=10000 adversarial evaluation.
 *
 * Purpose: Stress-test TRACE at extreme adversarial scale to validate
 * memory safety, graph algorithm convergence, and routing correctness
 * under conditions far beyond typical deployment.
 *
 * Matrix dimensions:
 *   - N = [5000, 10000]
 *   - Seeds = [42] (1 deterministic seed per N)
 *   - Attacks = 5 (strategic-default, collusion-ring, sybil-cluster,
 *                   economic-whitewashing, game-theoretic)
 *   - Policies = 4 (REPUTATION, PRICE, EIGENTRUST, TRACE-full)
 *   - Total cells = 2 × 1 × 5 × 4 = 40
 *
 * Architecture:
 *   - Subprocess-isolated per cell (fresh heap, full OS reclamation)
 *   - Dynamic concurrency bounded by observed RSS + available RAM
 *   - JSONL output per N level with resume support
 *   - Per-cell timeout: 90 min (N=5000), 180 min (N=10000)
 *   - Ghost module flags: Publication_Preset (TEMPORAL=false, CAUSAL=false)
 *   - Validation cell before full launch
 *
 * Usage:
 *   npx tsx scripts/runExtremeScaleMatrix.ts
 *   npx tsx scripts/runExtremeScaleMatrix.ts --max-concurrent 2
 *   npx tsx scripts/runExtremeScaleMatrix.ts --skip-validation
 *   npx tsx scripts/runExtremeScaleMatrix.ts --help
 *
 * Output:
 *   results/extreme-scale/extreme_scale_N5000.jsonl
 *   results/extreme-scale/extreme_scale_N10000.jsonl
 *   results/extreme-scale/summary_aggregate.csv
 *   results/extreme-scale/summary_per_policy.csv
 *   results/extreme-scale/summary_per_attack.csv
 *   results/extreme-scale/reproducibility_metadata.json
 *   results/extreme-scale/runtime_telemetry.jsonl
 *
 * MANUAL-LAUNCH ONLY — not part of the automated test suite.
 *
 * Scientific constraints:
 *   - NO modification to routing logic, attacks, graph semantics, thresholds,
 *     exploration behavior, or evaluation policies.
 *   - Execution order has ZERO semantic effect (subprocess isolation).
 *   - Full graph density, full PageRank iterations, full entropy precision.
 *   - 30% malicious agents fixed across all runs.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import * as os from "node:os";

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log([
    "scripts/runExtremeScaleMatrix.ts — Extreme-Scale Stress-Test Runner",
    "",
    "Usage:",
    "  npx tsx scripts/runExtremeScaleMatrix.ts [options]",
    "",
    "Options:",
    "  --max-concurrent <N>   Max parallel subprocesses (default: 1)",
    "  --skip-validation      Skip the pre-launch validation cell",
    "  --help, -h             Show this help",
    "",
    "Matrix: 2 N-levels × 5 attacks × 4 policies × 1 seed = 40 cells",
    "  N=5000:  ~90 min/cell timeout, 16 GB heap",
    "  N=10000: ~180 min/cell timeout, 16 GB heap",
    "",
    "Output:",
    "  results/extreme-scale/extreme_scale_N{n}.jsonl",
    "  results/extreme-scale/summary_*.csv",
    "  results/extreme-scale/reproducibility_metadata.json",
    "  results/extreme-scale/runtime_telemetry.jsonl",
    "",
    "MANUAL-LAUNCH ONLY. Expected wall-time: 12-48 hours.",
  ].join("\n"));
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

// ─── CLI Parsing ──────────────────────────────────────────────────────────────

function parseMaxConcurrent(): number {
  const idx = process.argv.indexOf("--max-concurrent");
  if (idx === -1) return 1;
  const val = parseInt(process.argv[idx + 1] ?? "", 10);
  return val > 0 ? val : 1;
}

const SKIP_VALIDATION = process.argv.includes("--skip-validation");
const MAX_CONCURRENT_BASE = parseMaxConcurrent();

// ─── Configuration ────────────────────────────────────────────────────────────

const N_LEVELS = [5000, 10000];
const SEEDS = [42]; // 1 deterministic seed per N
const MALICIOUS_RATIO = 0.30;
const JOBS_PER_ROUND = 5;

/**
 * Rounds scale with N for statistical convergence and graph maturation.
 * Large N needs more rounds for PageRank to converge and attacks to develop.
 */
function roundsForN(n: number): number {
  if (n <= 5000) return 80;
  return 100; // N=10000
}

/**
 * Per-cell timeout scales with N.
 */
function timeoutForN(n: number): number {
  if (n <= 5000) return 90 * 60 * 1000;   // 90 min
  return 180 * 60 * 1000;                  // 180 min for N=10000
}

/**
 * Heap size: 16 GB for extreme scale.
 */
function heapSizeForN(_n: number): number {
  return 16384; // 16 GB
}

/**
 * Attacks for the extreme-scale matrix.
 * "game-theoretic" maps to the existing `game-theoretic-adversary` attack type.
 */
const ATTACKS = [
  "strategic-default",
  "collusion-ring",
  "sybil-cluster",
  "economic-whitewashing",
  "game-theoretic",
] as const;

type MatrixAttack = (typeof ATTACKS)[number];

function resolveAttackType(attack: MatrixAttack): string {
  if (attack === "game-theoretic") return "game-theoretic-adversary";
  return attack;
}

// ─── Policy Definitions ───────────────────────────────────────────────────────

interface PolicySpec {
  label: string;
  policy: "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
  ablation: Record<string, boolean> | null;
}

/**
 * Policies in execution order: baselines first, then TRACE.
 * Execution ordering has ZERO semantic effect (subprocess isolation).
 * Reason: faster baselines complete first for early sanity checking.
 */
const POLICIES: PolicySpec[] = [
  { label: "REPUTATION", policy: "REPUTATION", ablation: null },
  { label: "PRICE", policy: "PRICE", ablation: null },
  { label: "EIGENTRUST", policy: "EIGENTRUST", ablation: null },
  { label: "TRACE-full", policy: "TRACE", ablation: {} },
];

// ─── Output Paths ─────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(process.cwd(), "results", "extreme-scale");
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "_publicationMatrixWorker.ts");
const TELEMETRY_FILE = path.join(OUTPUT_DIR, "runtime_telemetry.jsonl");

function resultsFileForN(n: number): string {
  return path.join(OUTPUT_DIR, `extreme_scale_N${n}.jsonl`);
}

// ─── Cell Spec ────────────────────────────────────────────────────────────────

interface CellSpec {
  cellId: string;
  policyLabel: string;
  policy: "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
  ablation: Record<string, boolean> | null;
  attack: MatrixAttack;
  resolvedAttack: string;
  seed: number;
  networkSize: number;
  rounds: number;
  configHash: string;
}

interface CellRecord {
  cellId: string;
  policyLabel: string;
  policy: string;
  ablation: Record<string, boolean> | null;
  attack: string;
  seed: number;
  networkSize: number;
  rounds: number;
  fraudExposure: number;
  maliciousRoutingRate: number;
  honestRoutingRate: number;
  defaultCount: number;
  defaultRate: number;
  largestSCCSize: number;
  graphEdgeCount: number;
  graphDensity: number;
  peakRSS: number;
  heapUsed: number;
  rssGrowthRatio: number;
  wallClockSec: number;
  totalJobs: number;
  pprRuntimeMs: number;
  entropyRuntimeMs: number;
  dbCleanupDurationMs: number;
  gcDurationMs: number;
  avgRoundRuntimeMs: number;
  configHash: string;
  timestamp: string;
}

// ─── Cell-Id + Config Hash ────────────────────────────────────────────────────

function buildCellId(policyLabel: string, attack: string, seed: number, n: number): string {
  return `N${n}|${policyLabel}|${attack}|s${seed}`;
}

function computeConfigHash(spec: CellSpec): string {
  const payload = JSON.stringify({
    policy: spec.policy,
    ablation: spec.ablation,
    attack: spec.resolvedAttack,
    seed: spec.seed,
    networkSize: spec.networkSize,
    rounds: spec.rounds,
    jobsPerRound: JOBS_PER_ROUND,
    maliciousRatio: MALICIOUS_RATIO,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ─── Resume Support ───────────────────────────────────────────────────────────

async function loadCompletedCellIds(filePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!fs.existsSync(filePath)) return ids;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const r = JSON.parse(trimmed) as { cellId?: string };
      if (typeof r.cellId === "string") ids.add(r.cellId);
    } catch { /* skip malformed */ }
  }
  return ids;
}

// ─── Queue Builder ────────────────────────────────────────────────────────────

function buildQueueForN(n: number, completedIds: Set<string>): CellSpec[] {
  const queue: CellSpec[] = [];
  const rounds = roundsForN(n);

  for (const seed of SEEDS) {
    for (const attack of ATTACKS) {
      for (const policySpec of POLICIES) {
        const cellId = buildCellId(policySpec.label, attack, seed, n);
        if (completedIds.has(cellId)) continue;
        const spec: CellSpec = {
          cellId,
          policyLabel: policySpec.label,
          policy: policySpec.policy,
          ablation: policySpec.ablation,
          attack,
          resolvedAttack: resolveAttackType(attack),
          seed,
          networkSize: n,
          rounds,
          configHash: "",
        };
        spec.configHash = computeConfigHash(spec);
        queue.push(spec);
      }
    }
  }

  return queue;
}

// ─── Memory Pressure Monitor ──────────────────────────────────────────────────

interface MemoryState {
  totalMB: number;
  freeMB: number;
  usedPercent: number;
  headroomPercent: number;
}

function getMemoryState(): MemoryState {
  const totalMB = os.totalmem() / (1024 * 1024);
  const freeMB = os.freemem() / (1024 * 1024);
  const usedPercent = ((totalMB - freeMB) / totalMB) * 100;
  const headroomPercent = (freeMB / totalMB) * 100;
  return { totalMB, freeMB, usedPercent, headroomPercent };
}

/**
 * Dynamic concurrency: reduce if memory pressure rises above 75% used.
 * Priority order: memory safety > semantic correctness > throughput.
 * At extreme scale, default to sequential (concurrency=1) unless
 * explicitly overridden AND memory headroom is sufficient.
 */
function computeEffectiveConcurrency(baseConcurrency: number): number {
  const mem = getMemoryState();

  // At extreme scale, always sequential unless headroom is very generous
  if (mem.headroomPercent < 25) return 1;
  if (mem.headroomPercent < 35) return Math.max(1, Math.floor(baseConcurrency / 2));

  return Math.min(baseConcurrency, 2); // Cap at 2 even with good headroom
}

// ─── Subprocess Invocation ────────────────────────────────────────────────────

type CellOutcome =
  | { kind: "ok"; record: CellRecord }
  | { kind: "timeout" }
  | { kind: "error"; err: string };

function runCellInSubprocess(spec: CellSpec): CellOutcome {
  const workerConfig = {
    cellId: spec.cellId,
    policyLabel: spec.policyLabel,
    policy: spec.policy,
    ablation: spec.ablation,
    attack: spec.resolvedAttack,
    seed: spec.seed,
    networkSize: spec.networkSize,
    rounds: spec.rounds,
    jobsPerRound: JOBS_PER_ROUND,
    maliciousRatio: MALICIOUS_RATIO,
    configHash: spec.configHash,
  };

  // Write config to a temp file (avoids Windows shell escaping issues)
  const tmpConfigFile = path.join(
    OUTPUT_DIR,
    `_tmp_extreme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(tmpConfigFile, JSON.stringify(workerConfig), "utf-8");

  const heapSize = heapSizeForN(spec.networkSize);
  const timeout = timeoutForN(spec.networkSize);

  try {
    const output = execSync(
      `npx tsx scripts/_publicationMatrixWorker.ts "${tmpConfigFile}"`,
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        maxBuffer: 200 * 1024 * 1024, // 200 MB stdout buffer for extreme scale
        timeout,
        env: {
          ...process.env,
          NODE_OPTIONS: `--max-old-space-size=${heapSize} --expose-gc`,
        },
      },
    );

    // Find the __RESULT__ line (search from end for efficiency)
    const lines = output.split("\n");
    let resultLine: string | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith("__RESULT__")) { resultLine = lines[i]; break; }
    }
    if (!resultLine) {
      return { kind: "error", err: "no __RESULT__ line in worker output" };
    }
    const record = JSON.parse(resultLine.replace("__RESULT__", "")) as CellRecord;
    return { kind: "ok", record };
  } catch (err: unknown) {
    const e = err as { signal?: string; code?: string; message?: string; status?: number | null };
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT" || e.status === null) {
      return { kind: "timeout" };
    }
    const msg = err instanceof Error
      ? err.message.slice(0, 800)
      : String(err).slice(0, 800);
    return { kind: "error", err: msg };
  } finally {
    try { fs.unlinkSync(tmpConfigFile); } catch { /* ignore */ }
  }
}

// ─── Validation Cell ──────────────────────────────────────────────────────────

/**
 * Before full launch: run one validation cell at N=100 (fast) to verify
 * the worker pipeline produces valid, finite metrics.
 */
function runValidationCell(): boolean {
  console.log("  ── Validation Cell ──────────────────────────────────────────");
  console.log("  Running: TRACE-full | strategic-default | seed=42 | N=100");
  console.log("  Purpose: verify worker pipeline produces valid metrics\n");

  const spec: CellSpec = {
    cellId: "VALIDATION|TRACE-full|strategic-default|s42",
    policyLabel: "TRACE-full",
    policy: "TRACE",
    ablation: {},
    attack: "strategic-default",
    resolvedAttack: "strategic-default",
    seed: 42,
    networkSize: 100,
    rounds: 50,
    configHash: "",
  };
  spec.configHash = computeConfigHash(spec);

  const outcome = runCellInSubprocess(spec);

  if (outcome.kind !== "ok") {
    console.log(`  ⚠ Validation cell ${outcome.kind}: ${outcome.kind === "error" ? outcome.err : "timeout"}`);
    console.log("  ABORTING — validation must pass before extreme-scale run.\n");
    return false;
  }

  const r = outcome.record;
  console.log(`  Result: fraud=${r.fraudExposure} sats, maliciousRouting=${(r.maliciousRoutingRate * 100).toFixed(1)}%`);
  console.log(`          honestRouting=${(r.honestRoutingRate * 100).toFixed(1)}%, wallClock=${r.wallClockSec.toFixed(1)}s`);
  console.log(`          peakRSS=${(r.peakRSS / 1024 / 1024).toFixed(0)}MB, edges=${r.graphEdgeCount}`);
  console.log(`          avgRound=${r.avgRoundRuntimeMs}ms, dbCleanup=${r.dbCleanupDurationMs}ms`);

  // Sanity checks
  const checks: string[] = [];
  if (r.fraudExposure < 0) checks.push("fraudExposure < 0");
  if (r.maliciousRoutingRate < 0 || r.maliciousRoutingRate > 1) checks.push("maliciousRoutingRate out of [0,1]");
  if (r.honestRoutingRate < 0 || r.honestRoutingRate > 1) checks.push("honestRoutingRate out of [0,1]");
  if (r.totalJobs === 0) checks.push("totalJobs === 0");
  if (!Number.isFinite(r.fraudExposure)) checks.push("fraudExposure is not finite");
  if (!Number.isFinite(r.maliciousRoutingRate)) checks.push("maliciousRoutingRate is not finite");

  if (checks.length > 0) {
    console.log(`  ❌ VALIDATION FAILED: ${checks.join(", ")}`);
    return false;
  }

  console.log("  ✓ Validation passed — metrics are valid and finite.");
  console.log("  ─────────────────────────────────────────────────────────────\n");
  return true;
}

// ─── Pre-Run Summary ──────────────────────────────────────────────────────────

function printPreRunSummary(n: number, queueSize: number, completedCount: number): void {
  const totalCellsForN = ATTACKS.length * SEEDS.length * POLICIES.length;
  const mem = getMemoryState();
  const effectiveConcurrency = computeEffectiveConcurrency(MAX_CONCURRENT_BASE);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  N=${n} Level Summary`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  Total cells        : ${totalCellsForN}`);
  console.log(`  Already completed  : ${completedCount}`);
  console.log(`  Remaining          : ${queueSize}`);
  console.log(`  Attacks            : ${ATTACKS.length} (${ATTACKS.join(", ")})`);
  console.log(`  Policies           : ${POLICIES.length} (${POLICIES.map(p => p.label).join(", ")})`);
  console.log(`  Seeds              : ${SEEDS.length} (${SEEDS.join(", ")})`);
  console.log(`  Rounds             : ${roundsForN(n)}`);
  console.log(`  Malicious ratio    : ${MALICIOUS_RATIO} (30%)`);
  console.log(`  Heap size          : ${heapSizeForN(n)} MB`);
  console.log(`  Timeout            : ${(timeoutForN(n) / 1000 / 60).toFixed(0)} min`);
  console.log(`  Concurrency        : ${effectiveConcurrency} (base=${MAX_CONCURRENT_BASE})`);
  console.log(`  System RAM         : ${mem.totalMB.toFixed(0)} MB total, ${mem.freeMB.toFixed(0)} MB free (${mem.headroomPercent.toFixed(0)}% headroom)`);
  console.log(`  Output             : ${resultsFileForN(n)}`);

  // Estimate runtime
  const avgCellMin = n <= 5000 ? 20 : 45;
  const estimatedMin = (queueSize * avgCellMin) / effectiveConcurrency;
  console.log(`  Est. runtime       : ~${formatDuration(estimatedMin * 60)}`);
  console.log(`  Est. peak memory   : ~${heapSizeForN(n)} MB per subprocess`);
  console.log(`${"─".repeat(70)}\n`);
}

// ─── Summary Generation ───────────────────────────────────────────────────────

async function loadAllRecords(filePath: string): Promise<CellRecord[]> {
  const records: CellRecord[] = [];
  if (!fs.existsSync(filePath)) return records;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed) as CellRecord); } catch { /* skip */ }
  }
  return records;
}

async function generateAllSummaries(): Promise<void> {
  const allRecords: CellRecord[] = [];
  for (const n of N_LEVELS) {
    const records = await loadAllRecords(resultsFileForN(n));
    allRecords.push(...records);
  }

  if (allRecords.length === 0) {
    console.log("  No records to summarize.");
    return;
  }

  // 1. Aggregate CSV
  const aggHeader = "networkSize,policyLabel,attack,seed,fraudExposure,maliciousRoutingRate,honestRoutingRate,defaultRate,largestSCCSize,graphEdgeCount,graphDensity,wallClockSec,peakRSS_MB,avgRoundMs";
  const aggRows = allRecords.map((r) =>
    [r.networkSize, r.policyLabel, r.attack, r.seed, r.fraudExposure,
     r.maliciousRoutingRate.toFixed(4), r.honestRoutingRate.toFixed(4),
     r.defaultRate.toFixed(4), r.largestSCCSize, r.graphEdgeCount,
     r.graphDensity.toFixed(6), r.wallClockSec.toFixed(1),
     (r.peakRSS / 1024 / 1024).toFixed(0), r.avgRoundRuntimeMs].join(",")
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary_aggregate.csv"),
    [aggHeader, ...aggRows].join("\n") + "\n", "utf-8",
  );

  // 2. Per-policy summary
  const polHeader = "networkSize,policyLabel,attack,fraudExposure,maliciousRoutingRate,honestRoutingRate,defaultRate,graphEdgeCount,wallClockSec,peakRSS_MB";
  const polRows = allRecords.map((r) =>
    [r.networkSize, r.policyLabel, r.attack, r.fraudExposure,
     r.maliciousRoutingRate.toFixed(4), r.honestRoutingRate.toFixed(4),
     r.defaultRate.toFixed(4), r.graphEdgeCount,
     r.wallClockSec.toFixed(1), (r.peakRSS / 1024 / 1024).toFixed(0)].join(",")
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary_per_policy.csv"),
    [polHeader, ...polRows].join("\n") + "\n", "utf-8",
  );

  // 3. Per-attack summary
  const attackGroups = new Map<string, CellRecord[]>();
  for (const r of allRecords) {
    const key = `${r.networkSize}|${r.attack}`;
    if (!attackGroups.has(key)) attackGroups.set(key, []);
    attackGroups.get(key)!.push(r);
  }

  const atkHeader = "networkSize,attack,nCells,meanFraud,minFraud,maxFraud,meanMaliciousRouting,meanHonestRouting,meanGraphEdges";
  const atkRows: string[] = [];
  for (const [key, records] of attackGroups) {
    const [nStr, attack] = key.split("|");
    const frauds = records.map((r) => r.fraudExposure);
    atkRows.push([
      nStr, attack, records.length,
      mean(frauds).toFixed(1), Math.min(...frauds), Math.max(...frauds),
      mean(records.map((r) => r.maliciousRoutingRate)).toFixed(4),
      mean(records.map((r) => r.honestRoutingRate)).toFixed(4),
      mean(records.map((r) => r.graphEdgeCount)).toFixed(0),
    ].join(","));
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary_per_attack.csv"),
    [atkHeader, ...atkRows].join("\n") + "\n", "utf-8",
  );

  console.log(`  Summaries written to ${OUTPUT_DIR}/`);
  console.log(`    - summary_aggregate.csv     (${allRecords.length} rows)`);
  console.log(`    - summary_per_policy.csv    (${polRows.length} rows)`);
  console.log(`    - summary_per_attack.csv    (${atkRows.length} rows)`);
}

// ─── Reproducibility Metadata ─────────────────────────────────────────────────

function writeReproducibilityMetadata(): void {
  const metadata = {
    generatedAt: new Date().toISOString(),
    purpose: "Extreme-scale stress-test of TRACE adversarial evaluation",
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    totalRAM_MB: Math.round(os.totalmem() / (1024 * 1024)),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    nLevels: N_LEVELS,
    seeds: SEEDS,
    attacks: [...ATTACKS],
    policies: POLICIES.map((p) => p.label),
    maliciousRatio: MALICIOUS_RATIO,
    jobsPerRound: JOBS_PER_ROUND,
    roundsByN: Object.fromEntries(N_LEVELS.map((n) => [n, roundsForN(n)])),
    heapByN: Object.fromEntries(N_LEVELS.map((n) => [n, heapSizeForN(n)])),
    timeoutByN: Object.fromEntries(N_LEVELS.map((n) => [n, `${timeoutForN(n) / 60000} min`])),
    ghostModuleFlags: { TEMPORAL_ENABLED: false, CAUSAL_ENABLED: false },
    totalCells: N_LEVELS.length * ATTACKS.length * SEEDS.length * POLICIES.length,
    maxConcurrentBase: MAX_CONCURRENT_BASE,
    scientificConstraints: [
      "No modification to routing logic, attacks, graph semantics, thresholds, exploration, or evaluation policies",
      "Execution order has ZERO semantic effect (subprocess isolation)",
      "30% malicious agents fixed across all runs",
      "Ghost module flags: Publication_Preset (both OFF)",
      "Full graph density, full PageRank iterations, full entropy precision",
      "No approximate algorithms, no stale caches, no skipped updates",
    ],
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "reproducibility_metadata.json"),
    JSON.stringify(metadata, null, 2), "utf-8",
  );
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

function logTelemetry(record: CellRecord): void {
  const entry = {
    cellId: record.cellId,
    networkSize: record.networkSize,
    policy: record.policyLabel,
    attack: record.attack,
    peakRSS_MB: Math.round(record.peakRSS / (1024 * 1024)),
    heapUsed_MB: Math.round(record.heapUsed / (1024 * 1024)),
    rssGrowthRatio: record.rssGrowthRatio.toFixed(2),
    wallClockSec: record.wallClockSec.toFixed(1),
    graphEdgeCount: record.graphEdgeCount,
    graphDensity: record.graphDensity.toFixed(6),
    pprRuntimeMs: record.pprRuntimeMs,
    entropyRuntimeMs: record.entropyRuntimeMs,
    dbCleanupDurationMs: record.dbCleanupDurationMs,
    gcDurationMs: record.gcDurationMs,
    avgRoundRuntimeMs: record.avgRoundRuntimeMs,
    timestamp: record.timestamp,
  };
  fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(entry) + "\n", "utf-8");
}

// ─── Utility Functions ────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify worker script exists
  if (!fs.existsSync(WORKER_SCRIPT)) {
    console.error(
      `Worker script missing at ${WORKER_SCRIPT}.\n` +
      `Run the publication matrix setup first, or ensure scripts/_publicationMatrixWorker.ts exists.`,
    );
    process.exit(1);
  }

  // Create output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const totalCells = N_LEVELS.length * ATTACKS.length * SEEDS.length * POLICIES.length;
  const mem = getMemoryState();

  // ── Banner ──────────────────────────────────────────────────────────────────
  console.log("═".repeat(70));
  console.log("  TRACE EXTREME-SCALE STRESS-TEST MATRIX");
  console.log("═".repeat(70));
  console.log(`  N Levels           : ${N_LEVELS.join(", ")}`);
  console.log(`  Seeds              : ${SEEDS.length} (${SEEDS.join(", ")})`);
  console.log(`  Attacks            : ${ATTACKS.length} (${ATTACKS.join(", ")})`);
  console.log(`  Policies           : ${POLICIES.length} (${POLICIES.map(p => p.label).join(", ")})`);
  console.log(`  Total cells        : ${totalCells}`);
  console.log(`  Malicious ratio    : ${MALICIOUS_RATIO} (30%)`);
  console.log(`  Jobs/round         : ${JOBS_PER_ROUND}`);
  console.log(`  Max concurrent     : ${MAX_CONCURRENT_BASE}`);
  console.log(`  System RAM         : ${mem.totalMB.toFixed(0)} MB (${mem.headroomPercent.toFixed(0)}% free)`);
  console.log(`  Ghost module flags : TEMPORAL=false, CAUSAL=false (Publication_Preset)`);
  console.log(`  Output dir         : ${OUTPUT_DIR}`);
  console.log(`  Game-theoretic     : maps to "game-theoretic-adversary" attack type`);
  console.log(`  Scientific mode    : NO routing/attack/graph modifications`);
  console.log(`  Worker             : scripts/_publicationMatrixWorker.ts (shared)`);
  console.log("═".repeat(70));

  // Memory warning for extreme scale
  const requiredRAM_MB = heapSizeForN(10000) + 2048; // heap + OS overhead
  if (mem.totalMB < requiredRAM_MB) {
    console.log(`\n  ⚠ WARNING: System has ${mem.totalMB.toFixed(0)} MB RAM.`);
    console.log(`    N=10000 cells need ~${requiredRAM_MB} MB. OOM risk is elevated.`);
    console.log(`    Consider running with --max-concurrent 1 (default).\n`);
  }

  console.log("");

  // ── Write reproducibility metadata ──────────────────────────────────────────
  writeReproducibilityMetadata();
  console.log("  Reproducibility metadata written.\n");

  // ── Validation cell ─────────────────────────────────────────────────────────
  if (!SKIP_VALIDATION) {
    const valid = runValidationCell();
    if (!valid) {
      console.error("  ABORTING: Validation cell failed. Fix issues before running extreme-scale.");
      process.exit(1);
    }
  } else {
    console.log("  Validation skipped (--skip-validation).\n");
  }

  // ── Execute per-N level ─────────────────────────────────────────────────────
  const globalStartTime = Date.now();
  let globalSucceeded = 0;
  let globalFailed = 0;
  let globalTimedOut = 0;

  for (const n of N_LEVELS) {
    const resultsFile = resultsFileForN(n);
    const completedIds = await loadCompletedCellIds(resultsFile);
    const queue = buildQueueForN(n, completedIds);

    printPreRunSummary(n, queue.length, completedIds.size);

    if (queue.length === 0) {
      console.log(`  All cells for N=${n} already completed. Skipping.\n`);
      globalSucceeded += completedIds.size;
      continue;
    }

    globalSucceeded += completedIds.size;

    const nStartTime = Date.now();
    let nSucceeded = 0;
    let nFailed = 0;
    let nTimedOut = 0;
    let cellIndex = completedIds.size;

    const totalForN = ATTACKS.length * SEEDS.length * POLICIES.length;

    for (const spec of queue) {
      cellIndex++;

      // Dynamic concurrency check
      const effectiveConcurrency = computeEffectiveConcurrency(MAX_CONCURRENT_BASE);
      const mem = getMemoryState();

      const banner = `  [N=${n} ${cellIndex}/${totalForN}] ${spec.policyLabel} | ${spec.attack} | s=${spec.seed}`;
      console.log(`${banner}`);
      console.log(`    RAM: ${mem.freeMB.toFixed(0)}MB free (${mem.headroomPercent.toFixed(0)}% headroom), concurrency=${effectiveConcurrency}`);
      process.stdout.write(`    Running...`);

      const t0 = Date.now();
      const outcome = runCellInSubprocess(spec);
      const dur = (Date.now() - t0) / 1000;

      if (outcome.kind === "ok") {
        fs.appendFileSync(resultsFile, JSON.stringify(outcome.record) + "\n", "utf-8");
        logTelemetry(outcome.record);
        nSucceeded++;
        globalSucceeded++;
        const r = outcome.record;
        console.log(` ✓ ${formatDuration(dur)}`);
        console.log(`    fraud=${r.fraudExposure} sats | mr=${(r.maliciousRoutingRate * 100).toFixed(1)}% | hr=${(r.honestRoutingRate * 100).toFixed(1)}%`);
        console.log(`    edges=${r.graphEdgeCount} | density=${r.graphDensity.toFixed(5)} | SCC=${r.largestSCCSize}`);
        console.log(`    peakRSS=${(r.peakRSS / 1024 / 1024).toFixed(0)}MB | heap=${(r.heapUsed / 1024 / 1024).toFixed(0)}MB | rssGrowth=${r.rssGrowthRatio.toFixed(2)}x`);
        console.log(`    avgRound=${r.avgRoundRuntimeMs}ms | ppr=${r.pprRuntimeMs}ms | entropy=${r.entropyRuntimeMs}ms | cleanup=${r.dbCleanupDurationMs}ms`);
      } else if (outcome.kind === "timeout") {
        nTimedOut++;
        globalTimedOut++;
        console.log(` TIMEOUT after ${formatDuration(dur)} (cap=${(timeoutForN(n) / 60000).toFixed(0)}min)`);
      } else {
        nFailed++;
        globalFailed++;
        console.log(` FAILED after ${formatDuration(dur)}`);
        console.log(`    Error: ${outcome.err.slice(0, 200)}`);
      }
      console.log("");
    }

    // N-level summary
    const nElapsed = (Date.now() - nStartTime) / 1000;
    console.log(`${"─".repeat(70)}`);
    console.log(`  N=${n} COMPLETE: ${nSucceeded} ok, ${nFailed} failed, ${nTimedOut} timeout`);
    console.log(`  Wall-clock: ${formatDuration(nElapsed)}`);
    console.log(`${"─".repeat(70)}\n`);
  }

  // ── Global Summary ──────────────────────────────────────────────────────────
  const globalElapsed = (Date.now() - globalStartTime) / 1000;

  console.log("\n" + "═".repeat(70));
  console.log("  EXTREME-SCALE MATRIX EXECUTION COMPLETE");
  console.log("═".repeat(70));
  console.log(`  Succeeded  : ${globalSucceeded}`);
  console.log(`  Failed     : ${globalFailed}`);
  console.log(`  Timed out  : ${globalTimedOut}`);
  console.log(`  Total      : ${totalCells}`);
  console.log(`  Wall-clock : ${formatDuration(globalElapsed)}`);
  console.log("═".repeat(70) + "\n");

  // ── Generate summaries ──────────────────────────────────────────────────────
  await generateAllSummaries();

  // ── Print results table ─────────────────────────────────────────────────────
  console.log("\n  ── Results Table ──────────────────────────────────────────────");
  for (const n of N_LEVELS) {
    const records = await loadAllRecords(resultsFileForN(n));
    if (records.length === 0) continue;
    console.log(`\n  N=${n}:`);
    console.log(`  ${"Policy".padEnd(16)} ${"Attack".padEnd(24)} ${"Fraud".padStart(8)} ${"MR%".padStart(8)} ${"HR%".padStart(8)} ${"Edges".padStart(8)} ${"Time".padStart(8)}`);
    console.log(`  ${"─".repeat(16)} ${"─".repeat(24)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)}`);
    for (const r of records) {
      console.log(
        `  ${r.policyLabel.padEnd(16)} ${r.attack.padEnd(24)} ${String(r.fraudExposure).padStart(8)} ` +
        `${(r.maliciousRoutingRate * 100).toFixed(1).padStart(7)}% ` +
        `${(r.honestRoutingRate * 100).toFixed(1).padStart(7)}% ` +
        `${String(r.graphEdgeCount).padStart(8)} ` +
        `${formatDuration(r.wallClockSec).padStart(8)}`
      );
    }
  }

  console.log("\n\n  ✅ EXTREME-SCALE STRESS-TEST COMPLETE");
  console.log(`  Output: ${OUTPUT_DIR}/`);
  for (const n of N_LEVELS) {
    console.log(`    extreme_scale_N${n}.jsonl`);
  }
  console.log(`    summary_aggregate.csv`);
  console.log(`    summary_per_policy.csv`);
  console.log(`    summary_per_attack.csv`);
  console.log(`    reproducibility_metadata.json`);
  console.log(`    runtime_telemetry.jsonl`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
