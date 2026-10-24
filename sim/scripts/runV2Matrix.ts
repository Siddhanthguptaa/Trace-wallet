/**
 * scripts/runV2Matrix.ts
 *
 * WWW v2 Experiment Matrix — Controlled evaluation of DR/CR/XS/LG mechanisms.
 *
 * Runs the TRACE experiment across multiple V2 flag configurations to produce
 * paper-ready results comparing v1 (all flags off) vs v2 (DR+CR+XS, full v2).
 *
 * Matrix dimensions:
 *   - N = [50, 200, 1000]                                            (3 levels)
 *   - Seeds = [42, 43, 44, 45, 46, 47, 48, 49, 50, 51]              (10 seeds)
 *   - Attacks = [strategic-default, collusion-ring, sybil-cluster,
 *                game-theoretic-adversary]                             (4 attacks)
 *   - V2 configs = [v1-baseline, v2-DR, v2-DR-CR, v2-DR-CR-XS,
 *                   v2-full (DR-CR-XS-LG)]                           (5 configs)
 *   - Policy = TRACE only (baselines unaffected by V2)                (1 policy)
 *   - Total cells = 3 × 10 × 4 × 5 = 600
 *
 * Architecture:
 *   - Subprocess-isolated per cell (fresh heap, full OS reclamation)
 *   - Sequential execution (safe for single-machine runs)
 *   - JSONL output with resume support
 *   - Reproducibility metadata and telemetry
 *
 * Usage:
 *   npx tsx scripts/runV2Matrix.ts
 *   npx tsx scripts/runV2Matrix.ts --n-levels 50,200
 *   npx tsx scripts/runV2Matrix.ts --seeds 42,43,44
 *   npx tsx scripts/runV2Matrix.ts --quick       # N=50 only, 3 seeds, 2 attacks
 *   npx tsx scripts/runV2Matrix.ts --help
 *
 * Output:
 *   results_www/v2_matrix_N{n}.jsonl
 *   results_www/v2_summary_aggregate.csv
 *   results_www/v2_summary_by_config.csv
 *   results_www/v2_reproducibility_metadata.json
 *
 * MANUAL-LAUNCH ONLY — not part of the automated test suite.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import * as os from "node:os";

// ─── DB Health Monitor ────────────────────────────────────────────────────

function getDbFileSizes(): { dbMB: number; walMB: number } {
  const dbPath = path.join(process.cwd(), "dev.db");
  let dbMB = 0;
  let walMB = 0;
  try {
    if (fs.existsSync(dbPath)) dbMB = fs.statSync(dbPath).size / (1024 * 1024);
    if (fs.existsSync(dbPath + "-wal")) walMB = fs.statSync(dbPath + "-wal").size / (1024 * 1024);
  } catch { /* ignore */ }
  return { dbMB, walMB };
}

function logHealthCheck(cellIndex: number, totalCells: number): void {
  const mem = os.freemem() / (1024 * 1024);
  const totalMem = os.totalmem() / (1024 * 1024);
  const usedPct = ((1 - mem / totalMem) * 100).toFixed(0);
  const db = getDbFileSizes();
  console.log(`  ── Health: RAM ${usedPct}% used (${mem.toFixed(0)}MB free), DB ${db.dbMB.toFixed(1)}MB + WAL ${db.walMB.toFixed(1)}MB ── [${cellIndex}/${totalCells}]`);
  if (db.walMB > 100) {
    console.log(`  ⚠ WARNING: WAL file exceeds 100MB — worker cleanup may be failing`);
  }
  if (mem < 500) {
    console.log(`  ⚠ WARNING: Free RAM < 500MB — OOM risk`);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function printUsage(): void {
  const usage = [
    "scripts/runV2Matrix.ts — WWW v2 Experiment Matrix Runner",
    "",
    "Usage:",
    "  npx tsx scripts/runV2Matrix.ts [options]",
    "",
    "Options:",
    "  --n-levels <list>      Comma-separated N levels (default: 50,200,1000)",
    "  --seeds <list>         Comma-separated seeds (default: 42-51)",
    "  --quick                Quick mode: N=1000, 3 seeds, 4 attacks (60 cells)",
    "  --skip-validation      Skip the pre-launch validation cell",
    "  --help, -h             Show this help",
    "",
    "Output:",
    "  results_www/v2_matrix_N{n}.jsonl",
    "  results_www/v2_summary_aggregate.csv",
    "  results_www/v2_summary_by_config.csv",
    "  results_www/v2_reproducibility_metadata.json",
  ].join("\n");
  console.log(usage);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

// ─── CLI Parsing ──────────────────────────────────────────────────────────

function parseFlag(flag: string, defaultVal: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return defaultVal;
  return process.argv[idx + 1] ?? defaultVal;
}

const IS_QUICK = process.argv.includes("--quick");
const SKIP_VALIDATION = process.argv.includes("--skip-validation");

const N_LEVELS = IS_QUICK
  ? [1000]
  : parseFlag("--n-levels", "50,200,1000").split(",").map(s => parseInt(s.trim(), 10)).filter(n => n > 0);

const SEEDS = IS_QUICK
  ? [42, 43, 44]
  : parseFlag("--seeds", "42,43,44,45,46,47,48,49,50,51").split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

// ─── Configuration ────────────────────────────────────────────────────────

const MALICIOUS_RATIO = 0.30;
const JOBS_PER_ROUND = 5;

function roundsForN(n: number): number {
  if (n <= 50) return 40;
  if (n <= 200) return 50;
  if (n <= 1000) return 60;
  return 80;
}

function timeoutForN(n: number): number {
  if (n <= 50) return 3 * 60 * 1000;
  if (n <= 200) return 5 * 60 * 1000;
  if (n <= 1000) return 20 * 60 * 1000;
  return 60 * 60 * 1000;
}

function heapSizeForN(n: number): number {
  if (n <= 200) return 4096;
  if (n <= 1000) return 12288;
  return 16384;
}

// ─── Attack Types ─────────────────────────────────────────────────────────

const ATTACKS = [
  "strategic-default",
  "collusion-ring",
  "sybil-cluster",
  "game-theoretic-adversary",
] as const;

// ─── V2 Flag Configurations ──────────────────────────────────────────────

interface V2FlagConfig {
  label: string;
  flags: {
    DR_ENABLED: boolean;
    CR_ENABLED: boolean;
    XS_ENABLED: boolean;
    LG_ENABLED: boolean;
    GG_ENABLED: boolean;
    PT_ENABLED: boolean;
  };
}

/**
 * V2 configurations for controlled evaluation.
 * Each configuration adds one mechanism on top of the previous,
 * enabling incremental contribution analysis (ablation from the other direction).
 *
 * v2.1-full adds Gap-Gated Thompson + Pessimistic Thompson on top of all v2 mechanisms.
 */
const V2_CONFIGS: V2FlagConfig[] = [
  {
    label: "v1-baseline",
    flags: { DR_ENABLED: false, CR_ENABLED: false, XS_ENABLED: false, LG_ENABLED: false, GG_ENABLED: false, PT_ENABLED: false },
  },
  {
    label: "v2-DR-CR",
    flags: { DR_ENABLED: true, CR_ENABLED: true, XS_ENABLED: false, LG_ENABLED: false, GG_ENABLED: false, PT_ENABLED: false },
  },
  {
    label: "v2-DR-CR-XS",
    flags: { DR_ENABLED: true, CR_ENABLED: true, XS_ENABLED: true, LG_ENABLED: false, GG_ENABLED: false, PT_ENABLED: false },
  },
  {
    label: "v2.1-full",
    flags: { DR_ENABLED: true, CR_ENABLED: true, XS_ENABLED: true, LG_ENABLED: true, GG_ENABLED: true, PT_ENABLED: true },
  },
];

// ─── Output Paths ─────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(process.cwd(), "results_www");
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "_v2MatrixWorker.ts");

function resultsFileForN(n: number): string {
  return path.join(OUTPUT_DIR, `v2_matrix_N${n}.jsonl`);
}

// ─── Cell Types ───────────────────────────────────────────────────────────

interface CellSpec {
  cellId: string;
  attack: string;
  seed: number;
  networkSize: number;
  rounds: number;
  v2Config: V2FlagConfig;
  configHash: string;
}

function buildCellId(attack: string, seed: number, n: number, v2Label: string): string {
  return `N${n}|TRACE|${attack}|${v2Label}|s${seed}`;
}

function computeConfigHash(spec: CellSpec): string {
  const payload = JSON.stringify({
    policy: "TRACE",
    attack: spec.attack,
    seed: spec.seed,
    networkSize: spec.networkSize,
    rounds: spec.rounds,
    jobsPerRound: JOBS_PER_ROUND,
    maliciousRatio: MALICIOUS_RATIO,
    v2Config: spec.v2Config.flags,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ─── Resume Support ───────────────────────────────────────────────────────

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

// ─── Queue Builder ────────────────────────────────────────────────────────

function buildQueueForN(n: number, completedIds: Set<string>): CellSpec[] {
  const queue: CellSpec[] = [];
  const rounds = roundsForN(n);

  for (const seed of SEEDS) {
    for (const attack of ATTACKS) {
      for (const v2Config of V2_CONFIGS) {
        const cellId = buildCellId(attack, seed, n, v2Config.label);
        if (completedIds.has(cellId)) continue;
        const spec: CellSpec = {
          cellId,
          attack,
          seed,
          networkSize: n,
          rounds,
          v2Config,
          configHash: "",
        };
        spec.configHash = computeConfigHash(spec);
        queue.push(spec);
      }
    }
  }

  return queue;
}

// ─── Subprocess Execution ─────────────────────────────────────────────────

type CellOutcome =
  | { kind: "ok"; record: Record<string, unknown> }
  | { kind: "timeout" }
  | { kind: "error"; err: string };

function runCellInSubprocess(spec: CellSpec): CellOutcome {
  const workerConfig = {
    cellId: spec.cellId,
    policyLabel: "TRACE-" + spec.v2Config.label,
    policy: "TRACE",
    ablation: {},
    attack: spec.attack,
    seed: spec.seed,
    networkSize: spec.networkSize,
    rounds: spec.rounds,
    jobsPerRound: JOBS_PER_ROUND,
    maliciousRatio: MALICIOUS_RATIO,
    configHash: spec.configHash,
    v2Config: spec.v2Config.flags,
    v2Label: spec.v2Config.label,
  };

  // Write config to temp file
  const tmpConfigFile = path.join(
    OUTPUT_DIR,
    `_tmp_v2cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(tmpConfigFile, JSON.stringify(workerConfig), "utf-8");

  const heapSize = heapSizeForN(spec.networkSize);
  const timeout = timeoutForN(spec.networkSize);

  try {
    const output = execSync(
      `npx tsx scripts/_v2MatrixWorker.ts "${tmpConfigFile}"`,
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        maxBuffer: 100 * 1024 * 1024,
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
    const record = JSON.parse(resultLine.replace("__RESULT__", ""));
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

// ─── Validation Cell ──────────────────────────────────────────────────────

function runValidationCell(): boolean {
  const valN = N_LEVELS[0];
  const valRounds = roundsForN(valN);
  console.log("  ── Validation Cell ──────────────────────────────────────────");
  console.log(`  Running: TRACE | strategic-default | v1-baseline | seed=42 | N=${valN}`);

  const spec: CellSpec = {
    cellId: buildCellId("strategic-default", 42, valN, "v1-baseline"),
    attack: "strategic-default",
    seed: 42,
    networkSize: valN,
    rounds: valRounds,
    v2Config: V2_CONFIGS[0], // v1-baseline
    configHash: "",
  };
  spec.configHash = computeConfigHash(spec);

  const outcome = runCellInSubprocess(spec);

  if (outcome.kind !== "ok") {
    console.log(`  ⚠ Validation cell ${outcome.kind}: ${outcome.kind === "error" ? outcome.err : "timeout"}`);
    console.log("  ABORTING — validation must pass before full matrix.\n");
    return false;
  }

  const r = outcome.record as Record<string, number>;
  console.log(`  Result: fraud=${r.fraudExposure} sats, malRouting=${((r.maliciousRoutingRate ?? 0) * 100).toFixed(1)}%`);
  console.log(`          wallClock=${(r.wallClockSec ?? 0).toFixed(1)}s`);

  const checks: string[] = [];
  if (r.fraudExposure < 0) checks.push("fraudExposure < 0");
  if (r.totalJobs === 0) checks.push("totalJobs === 0");

  if (checks.length > 0) {
    console.log(`  ❌ VALIDATION FAILED: ${checks.join(", ")}`);
    return false;
  }

  console.log("  ✓ Validation passed\n");
  return true;
}

// ─── Summary Generation ───────────────────────────────────────────────────

interface CellRecord {
  cellId: string;
  attack: string;
  seed: number;
  networkSize: number;
  v2Label: string;
  v2Config: Record<string, boolean>;
  fraudExposure: number;
  maliciousRoutingRate: number;
  honestRoutingRate: number;
  wallClockSec: number;
  totalJobs: number;
}

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

async function generateSummaries(): Promise<void> {
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
  const aggHeader = "networkSize,v2Label,attack,seed,fraudExposure,maliciousRoutingRate,honestRoutingRate,wallClockSec";
  const aggRows = allRecords.map(r =>
    [r.networkSize, r.v2Label, r.attack, r.seed, r.fraudExposure,
     (r.maliciousRoutingRate ?? 0).toFixed(4),
     (r.honestRoutingRate ?? 0).toFixed(4),
     (r.wallClockSec ?? 0).toFixed(1)].join(",")
  );
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "v2_summary_aggregate.csv"),
    [aggHeader, ...aggRows].join("\n") + "\n",
    "utf-8",
  );

  // 2. Per v2-config summary (mean ± std across seeds)
  const groups = new Map<string, CellRecord[]>();
  for (const r of allRecords) {
    const key = `${r.networkSize}|${r.v2Label}|${r.attack}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const configHeader = "networkSize,v2Label,attack,nSeeds,meanFraud,stdFraud,meanMalRouting,stdMalRouting,meanHonestRouting,meanWallClock";
  const configRows: string[] = [];
  for (const [key, records] of groups) {
    const [nStr, v2Label, attack] = key.split("|");
    const frauds = records.map(r => r.fraudExposure);
    const mrs = records.map(r => r.maliciousRoutingRate ?? 0);
    const hrs = records.map(r => r.honestRoutingRate ?? 0);
    const wcs = records.map(r => r.wallClockSec ?? 0);
    configRows.push([
      nStr, v2Label, attack, records.length,
      mean(frauds).toFixed(1), std(frauds).toFixed(1),
      mean(mrs).toFixed(4), std(mrs).toFixed(4),
      mean(hrs).toFixed(4),
      mean(wcs).toFixed(1),
    ].join(","));
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "v2_summary_by_config.csv"),
    [configHeader, ...configRows].join("\n") + "\n",
    "utf-8",
  );

  console.log(`  Summaries written to ${OUTPUT_DIR}/`);
  console.log(`    - v2_summary_aggregate.csv     (${allRecords.length} rows)`);
  console.log(`    - v2_summary_by_config.csv     (${configRows.length} rows)`);
}

// ─── Reproducibility Metadata ─────────────────────────────────────────────

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
    v2Configs: V2_CONFIGS.map(c => ({ label: c.label, ...c.flags })),
    maliciousRatio: MALICIOUS_RATIO,
    jobsPerRound: JOBS_PER_ROUND,
    roundsByN: Object.fromEntries(N_LEVELS.map(n => [n, roundsForN(n)])),
    totalCells: N_LEVELS.length * ATTACKS.length * SEEDS.length * V2_CONFIGS.length,
    scientificConstraints: [
      "V2 flags are the ONLY variable between cells with the same seed/attack/N",
      "When all V2 flags are false, behavior is bit-identical to v1",
      "Ghost module flags: Publication_Preset (both OFF)",
      "30% malicious agents fixed across all runs",
      "Subprocess isolation: full OS-level heap reclamation between cells",
    ],
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "v2_reproducibility_metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );
}

// ─── Utility ──────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify worker script exists
  if (!fs.existsSync(WORKER_SCRIPT)) {
    console.error(`Worker script missing at ${WORKER_SCRIPT}.`);
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const totalCells = N_LEVELS.length * ATTACKS.length * SEEDS.length * V2_CONFIGS.length;

  // ── Banner ──────────────────────────────────────────────────────────────
  console.log("═".repeat(70));
  console.log("  TRACE WWW v2 EXPERIMENT MATRIX");
  console.log("═".repeat(70));
  console.log(`  N Levels           : ${N_LEVELS.join(", ")}`);
  console.log(`  Seeds              : ${SEEDS.length} (${SEEDS.join(", ")})`);
  console.log(`  Attacks            : ${ATTACKS.length} (${ATTACKS.join(", ")})`);
  console.log(`  V2 Configs         : ${V2_CONFIGS.length} (${V2_CONFIGS.map(c => c.label).join(", ")})`);
  console.log(`  Total cells        : ${totalCells}`);
  console.log(`  Malicious ratio    : ${MALICIOUS_RATIO} (30%)`);
  console.log(`  Jobs/round         : ${JOBS_PER_ROUND}`);
  console.log(`  Output dir         : ${OUTPUT_DIR}`);
  console.log(`  Mode               : ${IS_QUICK ? "QUICK (reduced matrix)" : "FULL"}`);
  console.log("═".repeat(70) + "\n");

  writeReproducibilityMetadata();
  console.log("  Reproducibility metadata written.\n");

  // ── Validation cell ─────────────────────────────────────────────────────
  if (!SKIP_VALIDATION) {
    const valid = runValidationCell();
    if (!valid) {
      console.error("  ABORTING: Validation cell failed.");
      process.exit(1);
    }
  } else {
    console.log("  Validation skipped (--skip-validation).\n");
  }

  // ── Execute per-N level ─────────────────────────────────────────────────
  const globalStartTime = Date.now();
  let globalSucceeded = 0;
  let globalFailed = 0;
  let globalTimedOut = 0;

  for (const n of N_LEVELS) {
    const resultsFile = resultsFileForN(n);
    const completedIds = await loadCompletedCellIds(resultsFile);
    const queue = buildQueueForN(n, completedIds);

    const totalCellsForN = ATTACKS.length * SEEDS.length * V2_CONFIGS.length;
    console.log(`\n${"─".repeat(70)}`);
    console.log(`  N=${n} — ${queue.length} remaining / ${totalCellsForN} total`);
    console.log(`  Rounds: ${roundsForN(n)}, Timeout: ${(timeoutForN(n) / 1000 / 60).toFixed(0)}min`);
    console.log(`${"─".repeat(70)}\n`);

    if (queue.length === 0) {
      console.log(`  All cells for N=${n} already completed. Skipping.\n`);
      globalSucceeded += completedIds.size;
      continue;
    }

    globalSucceeded += completedIds.size;

    let nSucceeded = 0;
    let nFailed = 0;
    let nTimedOut = 0;

    for (let i = 0; i < queue.length; i++) {
      const spec = queue[i];
      const progress = `[${i + 1}/${queue.length}]`;
      console.log(`  ${progress} ${spec.cellId}`);

      // Health check every 10 cells or on first cell
      if (i % 10 === 0) {
        logHealthCheck(i + 1, queue.length);
      }

      const cellStart = Date.now();
      const outcome = runCellInSubprocess(spec);
      const cellElapsed = ((Date.now() - cellStart) / 1000).toFixed(1);

      if (outcome.kind === "ok") {
        fs.appendFileSync(resultsFile, JSON.stringify(outcome.record) + "\n", "utf-8");
        const fraud = (outcome.record as { fraudExposure?: number }).fraudExposure ?? 0;
        const rss = (outcome.record as { peakRSS?: number }).peakRSS ?? 0;
        console.log(`    ✓ fraud=${fraud} sats, RSS=${(rss / 1024 / 1024).toFixed(0)}MB (${cellElapsed}s)`);
        nSucceeded++;
        globalSucceeded++;
      } else if (outcome.kind === "timeout") {
        console.log(`    ⏰ TIMEOUT (${cellElapsed}s)`);
        nTimedOut++;
        globalTimedOut++;
      } else {
        console.log(`    ❌ ERROR: ${outcome.err.slice(0, 200)}`);
        nFailed++;
        globalFailed++;
      }
    }

    console.log(`\n  N=${n} complete: ${nSucceeded} ok, ${nFailed} failed, ${nTimedOut} timed out\n`);
  }

  // ── Final Summary ───────────────────────────────────────────────────────
  const totalElapsed = (Date.now() - globalStartTime) / 1000;

  console.log("═".repeat(70));
  console.log("  MATRIX COMPLETE");
  console.log("═".repeat(70));
  console.log(`  Total: ${globalSucceeded} ok, ${globalFailed} failed, ${globalTimedOut} timed out`);
  console.log(`  Wall clock: ${formatDuration(totalElapsed)}`);
  console.log("═".repeat(70) + "\n");

  await generateSummaries();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
