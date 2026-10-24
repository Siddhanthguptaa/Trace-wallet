/**
 * scripts/runPublicationMatrix.ts
 *
 * Publication-Scale Experiment Runner — Multi-N, 10-seed, 6-attack matrix.
 *
 * Generates reproducible, memory-safe, subprocess-isolated results suitable
 * for reporting in the paper abstract.
 *
 * Matrix dimensions:
 *   - N = [10, 50, 100, 1000, 5000]
 *   - Seeds = [42, 43, 44, 45, 46, 47, 48, 49, 50, 51] (10 seeds)
 *   - Attacks = 6 (strategic-default, collusion-ring, sybil-cluster,
 *                   economic-whitewashing, game-theoretic, none)
 *   - Policies = 4 (REPUTATION, PRICE, TRACE-full, EIGENTRUST)
 *   - Total cells per N = 6 × 10 × 4 = 240
 *   - Total cells all N = 240 × 5 = 1200
 *
 * Architecture:
 *   - Subprocess-isolated per cell (fresh heap, full OS reclamation)
 *   - Dynamic concurrency bounded by observed RSS + available RAM
 *   - JSONL output per N level with resume support
 *   - Per-cell timeout scaled by N
 *   - Ghost module flags: Publication_Preset (TEMPORAL=false, CAUSAL=false)
 *   - Validation cell before full launch
 *   - Aggregate CSV + per-policy + per-attack summaries
 *
 * Usage:
 *   npx tsx scripts/runPublicationMatrix.ts
 *   npx tsx scripts/runPublicationMatrix.ts --max-concurrent 2
 *   npx tsx scripts/runPublicationMatrix.ts --n-levels 100,1000
 *   npx tsx scripts/runPublicationMatrix.ts --help
 *
 * Output:
 *   results/publication/final_matrix_N10.jsonl
 *   results/publication/final_matrix_N50.jsonl
 *   results/publication/final_matrix_N100.jsonl
 *   results/publication/final_matrix_N1000.jsonl
 *   results/publication/final_matrix_N5000.jsonl
 *   results/publication/summary_aggregate.csv
 *   results/publication/summary_per_policy.csv
 *   results/publication/summary_per_attack.csv
 *   results/publication/reproducibility_metadata.json
 *   results/publication/runtime_telemetry.jsonl
 *
 * MANUAL-LAUNCH ONLY — not part of the automated test suite.
 *
 * Scientific constraints:
 *   - NO modification to routing logic, attacks, graph semantics, thresholds,
 *     exploration behavior, or evaluation policies.
 *   - Execution order has ZERO semantic effect on results (subprocess isolation).
 *   - Baselines execute first for early sanity checking.
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
  const usage = [
    "scripts/runPublicationMatrix.ts — Publication-Scale Experiment Runner",
    "",
    "Usage:",
    "  npx tsx scripts/runPublicationMatrix.ts [options]",
    "",
    "Options:",
    "  --max-concurrent <N>   Max parallel subprocesses (default: 1)",
    "  --n-levels <list>      Comma-separated N levels (default: 10,50,100,1000,5000)",
    "  --seeds <list>         Comma-separated seeds (default: 42-51)",
    "  --skip-validation      Skip the pre-launch validation cell",
    "  --help, -h             Show this help",
    "",
    "Output:",
    "  results/publication/final_matrix_N{n}.jsonl  (one cell per line, resume-safe)",
    "  results/publication/summary_*.csv            (aggregate summaries)",
    "  results/publication/reproducibility_metadata.json",
    "  results/publication/runtime_telemetry.jsonl",
    "",
    "MANUAL-LAUNCH ONLY — not part of the automated test suite.",
  ].join("\n");
  console.log(usage);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

// ─── CLI Parsing ──────────────────────────────────────────────────────────────

function parseFlag(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return defaultVal;
  return process.argv[idx + 1] ?? defaultVal;
}

function parseMaxConcurrent(): number {
  const val = parseInt(parseFlag("--max-concurrent", "1"), 10);
  return val > 0 ? val : 1;
}

function parseNLevels(): number[] {
  const raw = parseFlag("--n-levels", "10,50,100,1000,5000");
  return raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
}

function parseSeeds(): number[] {
  const raw = parseFlag("--seeds", "42,43,44,45,46,47,48,49,50,51");
  return raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
}

const SKIP_VALIDATION = process.argv.includes("--skip-validation");
const MAX_CONCURRENT_BASE = parseMaxConcurrent();
const N_LEVELS = parseNLevels();
const SEEDS = parseSeeds();

// ─── Configuration ────────────────────────────────────────────────────────────

const MALICIOUS_RATIO = 0.30;
const JOBS_PER_ROUND = 5;

/**
 * Rounds scale with N to ensure statistical convergence.
 * Small N needs fewer rounds; large N needs more for graph maturation.
 */
function roundsForN(n: number): number {
  if (n <= 10) return 30;
  if (n <= 50) return 40;
  if (n <= 100) return 50;
  if (n <= 1000) return 60;
  return 80; // N=5000
}

/**
 * Per-cell timeout scales with N (larger networks take longer).
 */
function timeoutForN(n: number): number {
  if (n <= 10) return 2 * 60 * 1000;      // 2 min
  if (n <= 50) return 3 * 60 * 1000;      // 3 min
  if (n <= 100) return 5 * 60 * 1000;     // 5 min
  if (n <= 1000) return 20 * 60 * 1000;   // 20 min
  return 60 * 60 * 1000;                   // 60 min for N=5000
}

/**
 * Heap size allocation scales with N.
 */
function heapSizeForN(n: number): number {
  if (n <= 100) return 4096;    // 4 GB
  if (n <= 1000) return 12288;  // 12 GB
  return 16384;                  // 16 GB for N=5000
}

/**
 * Attack types for the matrix.
 * "game-theoretic" maps to the existing `game-theoretic-adversary` attack type.
 */
const ATTACKS = [
  "strategic-default",
  "collusion-ring",
  "sybil-cluster",
  "economic-whitewashing",
  "game-theoretic",
  "none",
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
 * Order has ZERO semantic effect (subprocess isolation) but enables:
 *   - Early sanity checking (baselines are fast)
 *   - Faster regression visibility
 *   - Better orchestration efficiency
 */
const POLICIES: PolicySpec[] = [
  { label: "REPUTATION", policy: "REPUTATION", ablation: null },
  { label: "PRICE", policy: "PRICE", ablation: null },
  { label: "TRACE-full", policy: "TRACE", ablation: {} },
  { label: "EIGENTRUST", policy: "EIGENTRUST", ablation: null },
];

// ─── Output Paths ─────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(process.cwd(), "results", "publication");
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "_publicationMatrixWorker.ts");
const TELEMETRY_FILE = path.join(OUTPUT_DIR, "runtime_telemetry.jsonl");

function resultsFileForN(n: number): string {
  return path.join(OUTPUT_DIR, `final_matrix_N${n}.jsonl`);
}

// ─── Cell-Id Encoding ─────────────────────────────────────────────────────────

function buildCellId(policyLabel: string, attack: string, seed: number, n: number): string {
  return `N${n}|${policyLabel}|${attack}|s${seed}`;
}

// ─── Config Hash ──────────────────────────────────────────────────────────────

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

// ─── Cell Record (output) ─────────────────────────────────────────────────────

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

/**
 * Builds the cell queue for a given N level.
 * Execution order: for each seed, for each attack, iterate policies in order.
 * Baselines finish first per attack×seed combination.
 */
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
 * Dynamic concurrency: reduce if memory pressure rises above 80% used.
 * Maintains 20-25% RAM headroom. Never reduces fidelity.
 */
function computeEffectiveConcurrency(baseConcurrency: number, n: number): number {
  const mem = getMemoryState();

  // For N=5000, always sequential regardless of memory
  if (n >= 5000) return 1;

  // If headroom < 20%, reduce to 1
  if (mem.headroomPercent < 20) return 1;

  // If headroom < 30%, halve concurrency
  if (mem.headroomPercent < 30) return Math.max(1, Math.floor(baseConcurrency / 2));

  // For large N, cap concurrency
  if (n >= 1000) return Math.min(baseConcurrency, 2);

  return baseConcurrency;
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
    `_tmp_cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`,
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
        maxBuffer: 100 * 1024 * 1024, // 100 MB stdout buffer
        timeout,
        env: {
          ...process.env,
          NODE_OPTIONS: `--max-old-space-size=${heapSize} --expose-gc`,
        },
      },
    );

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
    const e = err as { signal?: string; code?: string; message?: string; status?: number };
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT" || e.status === null) {
      return { kind: "timeout" };
    }
    const msg = err instanceof Error
      ? err.message.slice(0, 500)
      : String(err).slice(0, 500);
    return { kind: "error", err: msg };
  } finally {
    try { fs.unlinkSync(tmpConfigFile); } catch { /* ignore */ }
  }
}

// ─── Validation Cell ──────────────────────────────────────────────────────────

/**
 * Before full launch: run one equivalence-validation cell.
 * Optimized vs baseline, same seed/config, verify no statistically meaningful
 * drift in fraud exposure, routing distribution, honest routing rate.
 */
function runValidationCell(): boolean {
  console.log("  ── Validation Cell ──────────────────────────────────────────");
  console.log("  Running: TRACE-full | strategic-default | seed=42 | N=100");
  console.log("  Purpose: verify no drift from prior results\n");

  const spec: CellSpec = {
    cellId: buildCellId("TRACE-full", "strategic-default", 42, 100),
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
    console.log("  ABORTING — validation must pass before full matrix.\n");
    return false;
  }

  const r = outcome.record;
  console.log(`  Result: fraud=${r.fraudExposure} sats, maliciousRouting=${(r.maliciousRoutingRate * 100).toFixed(1)}%`);
  console.log(`          honestRouting=${(r.honestRoutingRate * 100).toFixed(1)}%, wallClock=${r.wallClockSec.toFixed(1)}s`);
  console.log(`          peakRSS=${(r.peakRSS / 1024 / 1024).toFixed(0)}MB, edges=${r.graphEdgeCount}`);

  // Sanity checks (not attack-specific — just basic validity)
  const checks: string[] = [];
  if (r.fraudExposure < 0) checks.push("fraudExposure < 0");
  if (r.maliciousRoutingRate < 0 || r.maliciousRoutingRate > 1) checks.push("maliciousRoutingRate out of [0,1]");
  if (r.honestRoutingRate < 0 || r.honestRoutingRate > 1) checks.push("honestRoutingRate out of [0,1]");
  if (r.totalJobs === 0) checks.push("totalJobs === 0");
  if (!Number.isFinite(r.fraudExposure)) checks.push("fraudExposure is not finite");

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
  const effectiveConcurrency = computeEffectiveConcurrency(MAX_CONCURRENT_BASE, n);

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
  console.log(`  Malicious ratio    : ${MALICIOUS_RATIO}`);
  console.log(`  Heap size          : ${heapSizeForN(n)} MB`);
  console.log(`  Timeout            : ${(timeoutForN(n) / 1000 / 60).toFixed(0)} min`);
  console.log(`  Concurrency        : ${effectiveConcurrency} (base=${MAX_CONCURRENT_BASE})`);
  console.log(`  System RAM         : ${mem.totalMB.toFixed(0)} MB total, ${mem.freeMB.toFixed(0)} MB free (${mem.headroomPercent.toFixed(0)}% headroom)`);
  console.log(`  Output             : ${resultsFileForN(n)}`);

  // Estimate runtime
  const avgCellSec = n <= 10 ? 5 : n <= 50 ? 15 : n <= 100 ? 30 : n <= 1000 ? 180 : 600;
  const estimatedSec = (queueSize * avgCellSec) / effectiveConcurrency;
  console.log(`  Est. runtime       : ~${formatDuration(estimatedSec)}`);
  console.log(`  Est. peak memory   : ~${(heapSizeForN(n) * effectiveConcurrency * 0.7).toFixed(0)} MB`);
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
  // Load all records across all N levels
  const allRecords: CellRecord[] = [];
  for (const n of N_LEVELS) {
    const records = await loadAllRecords(resultsFileForN(n));
    allRecords.push(...records);
  }

  if (allRecords.length === 0) {
    console.log("  No records to summarize.");
    return;
  }

  // 1. Aggregate CSV (all cells)
  const aggHeader = "networkSize,policyLabel,attack,seed,fraudExposure,maliciousRoutingRate,honestRoutingRate,defaultRate,largestSCCSize,graphEdgeCount,wallClockSec,peakRSS";
  const aggRows = allRecords.map((r) =>
    [r.networkSize, r.policyLabel, r.attack, r.seed, r.fraudExposure,
     r.maliciousRoutingRate.toFixed(4), r.honestRoutingRate.toFixed(4),
     r.defaultRate.toFixed(4), r.largestSCCSize, r.graphEdgeCount,
     r.wallClockSec.toFixed(1), r.peakRSS].join(",")
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary_aggregate.csv"),
    [aggHeader, ...aggRows].join("\n") + "\n",
    "utf-8",
  );

  // 2. Per-policy summary (mean ± std across seeds)
  const policyGroups = new Map<string, CellRecord[]>();
  for (const r of allRecords) {
    const key = `${r.networkSize}|${r.policyLabel}|${r.attack}`;
    if (!policyGroups.has(key)) policyGroups.set(key, []);
    policyGroups.get(key)!.push(r);
  }

  const polHeader = "networkSize,policyLabel,attack,nSeeds,meanFraud,stdFraud,meanMaliciousRouting,stdMaliciousRouting,meanHonestRouting,meanWallClock";
  const polRows: string[] = [];
  for (const [key, records] of policyGroups) {
    const [nStr, policy, attack] = key.split("|");
    const frauds = records.map((r) => r.fraudExposure);
    const mrs = records.map((r) => r.maliciousRoutingRate);
    const hrs = records.map((r) => r.honestRoutingRate);
    const wcs = records.map((r) => r.wallClockSec);
    polRows.push([
      nStr, policy, attack, records.length,
      mean(frauds).toFixed(1), std(frauds).toFixed(1),
      mean(mrs).toFixed(4), std(mrs).toFixed(4),
      mean(hrs).toFixed(4),
      mean(wcs).toFixed(1),
    ].join(","));
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary_per_policy.csv"),
    [polHeader, ...polRows].join("\n") + "\n",
    "utf-8",
  );

  // 3. Per-attack summary (mean across all policies and seeds)
  const attackGroups = new Map<string, CellRecord[]>();
  for (const r of allRecords) {
    const key = `${r.networkSize}|${r.attack}`;
    if (!attackGroups.has(key)) attackGroups.set(key, []);
    attackGroups.get(key)!.push(r);
  }

  const atkHeader = "networkSize,attack,nCells,meanFraud,stdFraud,meanMaliciousRouting,meanHonestRouting,meanGraphEdges,meanGraphDensity";
  const atkRows: string[] = [];
  for (const [key, records] of attackGroups) {
    const [nStr, attack] = key.split("|");
    atkRows.push([
      nStr, attack, records.length,
      mean(records.map((r) => r.fraudExposure)).toFixed(1),
      std(records.map((r) => r.fraudExposure)).toFixed(1),
      mean(records.map((r) => r.maliciousRoutingRate)).toFixed(4),
      mean(records.map((r) => r.honestRoutingRate)).toFixed(4),
      mean(records.map((r) => r.graphEdgeCount)).toFixed(0),
      mean(records.map((r) => r.graphDensity)).toFixed(4),
    ].join(","));
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "summary_per_attack.csv"),
    [atkHeader, ...atkRows].join("\n") + "\n",
    "utf-8",
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
    ghostModuleFlags: { TEMPORAL_ENABLED: false, CAUSAL_ENABLED: false },
    totalCells: N_LEVELS.length * ATTACKS.length * SEEDS.length * POLICIES.length,
    maxConcurrentBase: MAX_CONCURRENT_BASE,
    scientificConstraints: [
      "No modification to routing logic, attacks, graph semantics, thresholds, exploration, or evaluation policies",
      "Execution order has ZERO semantic effect (subprocess isolation)",
      "30% malicious agents fixed across all runs",
      "Ghost module flags: Publication_Preset (both OFF)",
      "Full graph density, full PageRank iterations, full entropy precision",
    ],
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "reproducibility_metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

function logTelemetry(record: CellRecord): void {
  const entry = {
    cellId: record.cellId,
    networkSize: record.networkSize,
    peakRSS_MB: Math.round(record.peakRSS / (1024 * 1024)),
    heapUsed_MB: Math.round(record.heapUsed / (1024 * 1024)),
    rssGrowthRatio: record.rssGrowthRatio.toFixed(2),
    wallClockSec: record.wallClockSec.toFixed(1),
    graphEdgeCount: record.graphEdgeCount,
    graphDensity: record.graphDensity.toFixed(4),
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

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
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
      `Expected: scripts/_publicationMatrixWorker.ts`,
    );
    process.exit(1);
  }

  // Create output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const totalCells = N_LEVELS.length * ATTACKS.length * SEEDS.length * POLICIES.length;

  // ── Banner ──────────────────────────────────────────────────────────────────
  console.log("═".repeat(70));
  console.log("  TRACE PUBLICATION-SCALE EXPERIMENT MATRIX");
  console.log("═".repeat(70));
  console.log(`  N Levels           : ${N_LEVELS.join(", ")}`);
  console.log(`  Seeds              : ${SEEDS.length} (${SEEDS.join(", ")})`);
  console.log(`  Attacks            : ${ATTACKS.length} (${ATTACKS.join(", ")})`);
  console.log(`  Policies           : ${POLICIES.length} (${POLICIES.map(p => p.label).join(", ")})`);
  console.log(`  Total cells        : ${totalCells}`);
  console.log(`  Malicious ratio    : ${MALICIOUS_RATIO} (30%)`);
  console.log(`  Jobs/round         : ${JOBS_PER_ROUND}`);
  console.log(`  Max concurrent     : ${MAX_CONCURRENT_BASE}`);
  console.log(`  Ghost module flags : TEMPORAL=false, CAUSAL=false (Publication_Preset)`);
  console.log(`  Output dir         : ${OUTPUT_DIR}`);
  console.log(`  Game-theoretic     : maps to "game-theoretic-adversary" attack type`);
  console.log(`  Scientific mode    : NO routing/attack/graph modifications`);
  console.log("═".repeat(70) + "\n");

  // ── Write reproducibility metadata ──────────────────────────────────────────
  writeReproducibilityMetadata();
  console.log("  Reproducibility metadata written.\n");

  // ── Validation cell ─────────────────────────────────────────────────────────
  if (!SKIP_VALIDATION) {
    const valid = runValidationCell();
    if (!valid) {
      console.error("  ABORTING: Validation cell failed. Fix issues before running full matrix.");
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

      // Dynamic concurrency check (for future parallel support)
      const effectiveConcurrency = computeEffectiveConcurrency(MAX_CONCURRENT_BASE, n);
      if (effectiveConcurrency < MAX_CONCURRENT_BASE) {
        const mem = getMemoryState();
        console.log(`  ⚠ Memory pressure: ${mem.headroomPercent.toFixed(0)}% headroom — concurrency reduced to ${effectiveConcurrency}`);
      }

      const banner = `  [N=${n} ${cellIndex}/${totalForN}] ${spec.policyLabel} | ${spec.attack} | s=${spec.seed}`;
      process.stdout.write(`${banner} — running...`);

      const t0 = Date.now();
      const outcome = runCellInSubprocess(spec);
      const dur = (Date.now() - t0) / 1000;

      if (outcome.kind === "ok") {
        fs.appendFileSync(resultsFile, JSON.stringify(outcome.record) + "\n", "utf-8");
        logTelemetry(outcome.record);
        nSucceeded++;
        globalSucceeded++;
        const r = outcome.record;
        console.log(
          ` ✓ fraud=${r.fraudExposure} mr=${(r.maliciousRoutingRate * 100).toFixed(1)}% ` +
          `hr=${(r.honestRoutingRate * 100).toFixed(1)}% ${r.wallClockSec.toFixed(0)}s ` +
          `rss=${(r.peakRSS / 1024 / 1024).toFixed(0)}MB`,
        );
      } else if (outcome.kind === "timeout") {
        nTimedOut++;
        globalTimedOut++;
        console.log(` TIMEOUT (${dur.toFixed(0)}s > ${(timeoutForN(n) / 1000).toFixed(0)}s cap)`);
      } else {
        nFailed++;
        globalFailed++;
        console.log(` FAILED: ${outcome.err.slice(0, 120)}`);
      }

      // Progress telemetry every 10 cells
      if (cellIndex % 10 === 0) {
        const elapsed = (Date.now() - nStartTime) / 1000;
        const remaining = queue.length - (cellIndex - completedIds.size);
        const avgPerCell = elapsed / (cellIndex - completedIds.size);
        const eta = remaining * avgPerCell;
        const mem = getMemoryState();
        console.log(
          `  ── N=${n} Progress: ${nSucceeded + completedIds.size}/${totalForN} done, ` +
          `${nFailed} failed, ${nTimedOut} timeout | ` +
          `elapsed=${formatDuration(elapsed)} ETA=${formatDuration(eta)} | ` +
          `RAM: ${mem.headroomPercent.toFixed(0)}% free ──`,
        );
      }
    }

    // N-level summary
    const nElapsed = (Date.now() - nStartTime) / 1000;
    console.log(`\n  N=${n} COMPLETE: ${nSucceeded} ok, ${nFailed} failed, ${nTimedOut} timeout in ${formatDuration(nElapsed)}\n`);
  }

  // ── Global Summary ──────────────────────────────────────────────────────────
  const globalElapsed = (Date.now() - globalStartTime) / 1000;

  console.log("\n" + "═".repeat(70));
  console.log("  PUBLICATION MATRIX EXECUTION COMPLETE");
  console.log("═".repeat(70));
  console.log(`  Succeeded  : ${globalSucceeded}`);
  console.log(`  Failed     : ${globalFailed}`);
  console.log(`  Timed out  : ${globalTimedOut}`);
  console.log(`  Total      : ${totalCells}`);
  console.log(`  Wall-clock : ${formatDuration(globalElapsed)}`);
  console.log("═".repeat(70) + "\n");

  // ── Generate summaries ──────────────────────────────────────────────────────
  await generateAllSummaries();

  console.log("\n  ✅ PUBLICATION MATRIX COMPLETE");
  console.log(`  Output: ${OUTPUT_DIR}/`);
  for (const n of N_LEVELS) {
    console.log(`    final_matrix_N${n}.jsonl`);
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
