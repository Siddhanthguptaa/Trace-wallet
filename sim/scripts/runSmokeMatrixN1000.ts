/**
 * scripts/runSmokeMatrixN1000.ts
 *
 * N=1000 Quick Smoke Matrix — EigenTrust + Hardened TRACE validation.
 *
 * Matrix dimensions:
 *   - N = 1000 agents
 *   - Seeds = [42] (1 seed for quick validation)
 *   - Attacks = 6 (strategic-default, collusion-ring, sybil-cluster,
 *                   economic-whitewashing, game-theoretic, none)
 *   - Policies = 4 (REPUTATION, PRICE, TRACE-full [hardened], EIGENTRUST)
 *   - Total cells = 6 × 1 × 4 = 24
 *
 * This is a quick validation run to verify:
 *   1. The new EigenTrust baseline (power iteration, Kamvar et al.) works at N=1000
 *   2. The hardened TRACE (risk-sensitive exploration, post-fraud cooldown,
 *      non-boosting graph cap, non-saturating penalties) reduces fraud exposure
 *   3. All 4 policies produce valid results without crashes
 *
 * Architecture:
 *   - Subprocess-isolated per cell (spawn `npx tsx scripts/_smokeMatrixWorker.ts`)
 *   - Sequential by default (--max-concurrent 1) for safety at N=1000
 *   - JSONL output with resume support
 *   - Per-cell timeout: 15 minutes
 *   - Ghost module flags: Publication_Preset (TEMPORAL=false, CAUSAL=false)
 *
 * Usage:
 *   npx tsx scripts/runSmokeMatrixN1000.ts
 *   npx tsx scripts/runSmokeMatrixN1000.ts --max-concurrent 2
 *   npx tsx scripts/runSmokeMatrixN1000.ts --help
 *
 * Output:
 *   smoke_matrix_N1000_seeds3.jsonl       (one cell per line)
 *   smoke_matrix_N1000_seeds3_summary.csv (after all cells complete)
 *
 * MANUAL-LAUNCH ONLY — not part of the automated test suite.
 * Expected wall-time: ~30-60 minutes (24 cells × ~2-5 minutes each at N=1000).
 *
 * Game-theoretic attack mapping:
 *   The "game-theoretic" attack maps to the existing `game-theoretic-adversary`
 *   attack type in src/lib/trace/attacks/gameTheoreticAdversary.ts.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as crypto from "node:crypto";

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printUsage(): void {
  const usage = [
    "scripts/runSmokeMatrixN1000.ts — N=1000 EigenTrust + Hardened TRACE Smoke (24 cells)",
    "",
    "Usage:",
    "  npx tsx scripts/runSmokeMatrixN1000.ts [options]",
    "",
    "Options:",
    "  --max-concurrent <N>  Max parallel subprocesses (default: 1 = sequential)",
    "  --help, -h            Show this help",
    "",
    "Output:",
    "  smoke_matrix_N1000_seeds3.jsonl       (one cell per line, resume-safe)",
    "  smoke_matrix_N1000_seeds3_summary.csv (generated after all cells)",
    "",
    "MANUAL-LAUNCH ONLY — not part of the automated test suite.",
    "Expected wall-time: ~30-60 min (24 subprocess-isolated cells at N=1000).",
  ].join("\n");
  console.log(usage);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}

// Parse --max-concurrent flag
function parseMaxConcurrent(): number {
  const idx = process.argv.indexOf("--max-concurrent");
  if (idx === -1) return 1;
  const val = parseInt(process.argv[idx + 1] ?? "", 10);
  return val > 0 ? val : 1;
}

const MAX_CONCURRENT = parseMaxConcurrent();

// ─── Configuration ────────────────────────────────────────────────────────────

const NETWORK_SIZE = 1000;
const SEEDS = [42];
const ROUNDS = 60;
const JOBS_PER_ROUND = 5;
const MALICIOUS_RATIO = 0.3;

/** Per-cell wall-clock cap: 15 minutes (N=1000 cells are slow). */
const PER_CELL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Attack types for the matrix.
 * "game-theoretic" maps to the existing `game-theoretic-adversary` attack type
 * in src/lib/trace/attacks/gameTheoreticAdversary.ts.
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

/**
 * Maps matrix attack labels to the actual AttackType used by the experiment runner.
 */
function resolveAttackType(attack: MatrixAttack): string {
  if (attack === "game-theoretic") {
    return "game-theoretic-adversary";
  }
  return attack;
}

// ─── Policy Definitions ───────────────────────────────────────────────────────

interface TraceAblationConfig {
  disablePPR?: boolean;
  disableBayesianLCB?: boolean;
  disableWeightedEntropy?: boolean;
  disableCUSUM?: boolean;
  disableThompsonSampling?: boolean;
  disableAllGraph?: boolean;
  useCleanVariant?: boolean;
}

interface PolicySpec {
  label: string;
  policy: "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
  ablation: TraceAblationConfig | null;
}

/**
 * Policies: 4 core policies for EigenTrust + Hardened TRACE validation.
 * - REPUTATION: simple reputation baseline (unchanged)
 * - PRICE: price-only baseline (unchanged)
 * - TRACE-full: hardened TRACE with all mechanisms (risk-sensitive exploration,
 *   post-fraud cooldown, non-boosting graph cap, non-saturating penalties)
 * - EIGENTRUST: new EigenTrust baseline (Kamvar et al. 2003 power iteration)
 */
const POLICIES: PolicySpec[] = [
  // 1. REPUTATION baseline
  { label: "REPUTATION", policy: "REPUTATION", ablation: null },
  // 2. PRICE baseline
  { label: "PRICE", policy: "PRICE", ablation: null },
  // 3. TRACE-full (all hardening mechanisms enabled)
  { label: "TRACE-full", policy: "TRACE", ablation: {} },
  // 4. EIGENTRUST baseline (proper EigenTrust power iteration)
  { label: "EIGENTRUST", policy: "EIGENTRUST", ablation: null },
];

// Total cells = 6 attacks × 1 seed × 4 policies = 24
const TOTAL_CELLS = ATTACKS.length * SEEDS.length * POLICIES.length;

// ─── Output Files ─────────────────────────────────────────────────────────────

const RESULTS_FILE = path.join(process.cwd(), "smoke_matrix_N1000_seeds3.jsonl");
const SUMMARY_FILE = path.join(process.cwd(), "smoke_matrix_N1000_seeds3_summary.csv");
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "_smokeMatrixWorker.ts");
const PRIOR_RESULTS_FILE = path.join(
  process.cwd(),
  "comprehensive_comparison_results_N1000_seeds3.json",
);

// ─── Cell-Id Encoding ─────────────────────────────────────────────────────────

/**
 * cellId = "{policyLabel}|{attack}|s{seed}"
 * e.g. "TRACE-full|strategic-default|s42"
 */
function buildCellId(policyLabel: string, attack: string, seed: number): string {
  return `${policyLabel}|${attack}|s${seed}`;
}

// ─── Config Hash ──────────────────────────────────────────────────────────────

/**
 * SHA-256 of the canonical config for reproducibility verification.
 */
function computeConfigHash(
  policy: string,
  ablation: TraceAblationConfig | null,
  attack: string,
  seed: number,
): string {
  const payload = JSON.stringify({
    policy,
    ablation,
    attack,
    seed,
    networkSize: NETWORK_SIZE,
    rounds: ROUNDS,
    jobsPerRound: JOBS_PER_ROUND,
    maliciousRatio: MALICIOUS_RATIO,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ─── Resume Support ───────────────────────────────────────────────────────────

interface CellRecord {
  cellId: string;
  policyLabel: string;
  policy: string;
  ablation: TraceAblationConfig | null;
  attack: string;
  seed: number;
  networkSize: number;
  rounds: number;
  fraudExposure: number;
  maliciousRoutingRate: number;
  defaultCount: number;
  defaultRate: number;
  largestSCCSize: number;
  peakRSS: number;
  heapUsed: number;
  rssRound1: number;
  rssRound60: number;
  rssGrowthRatio: number;
  uncaughtExceptionCount: number;
  wallClockSec: number;
  totalJobs: number;
  configHash: string;
  timestamp: string;
}

async function loadCompletedCellIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!fs.existsSync(RESULTS_FILE)) return ids;
  const rl = readline.createInterface({
    input: fs.createReadStream(RESULTS_FILE, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const r = JSON.parse(trimmed) as { cellId?: string };
      if (typeof r.cellId === "string") ids.add(r.cellId);
    } catch {
      // skip malformed lines
    }
  }
  return ids;
}

// ─── Cell Spec ────────────────────────────────────────────────────────────────

interface CellSpec {
  cellId: string;
  policyLabel: string;
  policy: "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
  ablation: TraceAblationConfig | null;
  attack: MatrixAttack;
  resolvedAttack: string;
  seed: number;
  configHash: string;
}

/**
 * Builds the full 216-cell queue.
 * Execution order: for each seed, for each attack, iterate policies in order.
 * This means baselines finish first per attack×seed combination.
 */
function buildQueue(completedIds: Set<string>): CellSpec[] {
  const queue: CellSpec[] = [];

  for (const seed of SEEDS) {
    for (const attack of ATTACKS) {
      for (const policySpec of POLICIES) {
        const cellId = buildCellId(policySpec.label, attack, seed);
        if (completedIds.has(cellId)) continue;
        const configHash = computeConfigHash(
          policySpec.policy,
          policySpec.ablation,
          resolveAttackType(attack),
          seed,
        );
        queue.push({
          cellId,
          policyLabel: policySpec.label,
          policy: policySpec.policy,
          ablation: policySpec.ablation,
          attack,
          resolvedAttack: resolveAttackType(attack),
          seed,
          configHash,
        });
      }
    }
  }

  return queue;
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
    networkSize: NETWORK_SIZE,
    rounds: ROUNDS,
    jobsPerRound: JOBS_PER_ROUND,
    maliciousRatio: MALICIOUS_RATIO,
    configHash: spec.configHash,
  };

  // Write config to a temp file to avoid Windows shell escaping issues
  // with JSON containing pipes, quotes, and hyphens.
  const tmpConfigFile = path.join(
    process.cwd(),
    `_tmp_cell_config_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(tmpConfigFile, JSON.stringify(workerConfig), "utf-8");

  try {
    const output = execSync(
      `npx tsx scripts/_smokeMatrixWorker.ts "${tmpConfigFile}"`,
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: PER_CELL_TIMEOUT_MS,
        env: {
          ...process.env,
          NODE_OPTIONS: "--max-old-space-size=12288 --expose-gc",
        },
      },
    );

    const lines = output.split("\n");
    const resultLine = lines.findLast((l) => l.startsWith("__RESULT__"));
    if (!resultLine) {
      return { kind: "error", err: "no __RESULT__ line in worker output" };
    }
    const record = JSON.parse(resultLine.replace("__RESULT__", "")) as CellRecord;
    return { kind: "ok", record };
  } catch (err: unknown) {
    const e = err as { signal?: string; code?: string; message?: string };
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
      return { kind: "timeout" };
    }
    const msg = err instanceof Error
      ? err.message.slice(0, 300)
      : String(err).slice(0, 300);
    return { kind: "error", err: msg };
  } finally {
    // Clean up temp config file
    try { fs.unlinkSync(tmpConfigFile); } catch { /* ignore */ }
  }
}

// ─── Validation Cell ──────────────────────────────────────────────────────────

/**
 * Before the full matrix, run ONE validation cell: TRACE-full | strategic-default | seed=42.
 * Compare against the existing comprehensive_comparison_results_N1000_seeds3.json if available.
 * Log whether fraud exposure is within 20% of the prior run. Informational only (does not abort).
 */
function runValidationCell(): void {
  console.log("  ── Validation Cell ──────────────────────────────────────────");
  console.log("  Running: TRACE-full | strategic-default | seed=42");

  const validationSpec: CellSpec = {
    cellId: buildCellId("TRACE-full", "strategic-default", 42),
    policyLabel: "TRACE-full",
    policy: "TRACE",
    ablation: {},
    attack: "strategic-default",
    resolvedAttack: "strategic-default",
    seed: 42,
    configHash: computeConfigHash("TRACE", {}, "strategic-default", 42),
  };

  const outcome = runCellInSubprocess(validationSpec);

  if (outcome.kind !== "ok") {
    console.log(`  ⚠ Validation cell ${outcome.kind}: ${outcome.kind === "error" ? outcome.err : "timeout"}`);
    console.log("  Continuing with full matrix (validation is informational only).\n");
    return;
  }

  const record = outcome.record;
  console.log(`  Validation result: fraudExposure=${record.fraudExposure}, wallClock=${record.wallClockSec.toFixed(1)}s`);

  // Append to JSONL (it's a real cell)
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + "\n", "utf-8");

  // Compare against prior results if available
  if (fs.existsSync(PRIOR_RESULTS_FILE)) {
    try {
      const priorData = JSON.parse(fs.readFileSync(PRIOR_RESULTS_FILE, "utf-8"));
      // Prior file may be an array of results or a structured object
      const priorResults = Array.isArray(priorData) ? priorData : (priorData.results ?? []);
      const priorCell = priorResults.find(
        (r: { attack?: string; policy?: string; seed?: number }) =>
          r.attack === "strategic-default" && r.policy === "TRACE" && r.seed === 42,
      );
      if (priorCell && typeof priorCell.fraudExposure === "number") {
        const priorFraud = priorCell.fraudExposure;
        const currentFraud = record.fraudExposure;
        const ratio = priorFraud > 0
          ? Math.abs(currentFraud - priorFraud) / priorFraud
          : (currentFraud === 0 ? 0 : 1);
        const within20 = ratio <= 0.2;
        console.log(
          `  Prior fraudExposure: ${priorFraud}, Current: ${currentFraud}, ` +
          `Δ=${(ratio * 100).toFixed(1)}% — ${within20 ? "✓ WITHIN 20%" : "⚠ EXCEEDS 20% threshold"}`,
        );
      } else {
        console.log("  Prior TRACE|strategic-default|seed=42 cell not found in prior results.");
      }
    } catch {
      console.log("  Could not parse prior results file for comparison.");
    }
  } else {
    console.log("  No prior results file found for comparison (informational only).");
  }

  console.log("  ─────────────────────────────────────────────────────────────\n");
}

// ─── Summary CSV Generation ───────────────────────────────────────────────────

/**
 * After all cells complete, generate a summary CSV with columns:
 * policyLabel, attack, seed, fraudExposure, maliciousRoutingRate, defaultRate,
 * largestSCCSize, peakRSS, wallClockSec
 */
async function generateSummaryCSV(): Promise<void> {
  if (!fs.existsSync(RESULTS_FILE)) return;

  const records: CellRecord[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(RESULTS_FILE, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as CellRecord);
    } catch {
      // skip malformed
    }
  }

  if (records.length === 0) return;

  const header = "policyLabel,attack,seed,fraudExposure,maliciousRoutingRate,defaultRate,largestSCCSize,peakRSS,wallClockSec";
  const rows = records.map((r) =>
    [
      r.policyLabel,
      r.attack,
      r.seed,
      r.fraudExposure,
      r.maliciousRoutingRate.toFixed(4),
      r.defaultRate.toFixed(4),
      r.largestSCCSize,
      r.peakRSS,
      r.wallClockSec.toFixed(1),
    ].join(","),
  );

  const csv = [header, ...rows].join("\n") + "\n";
  fs.writeFileSync(SUMMARY_FILE, csv, "utf-8");
  console.log(`  Summary CSV written: ${SUMMARY_FILE} (${records.length} rows)`);
}

// ─── Telemetry Helpers ────────────────────────────────────────────────────────

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
  if (!fs.existsSync(WORKER_SCRIPT)) {
    console.error(
      `Worker script missing at ${WORKER_SCRIPT}. ` +
      `It should be co-located with this runner (scripts/_smokeMatrixWorker.ts).`,
    );
    process.exit(1);
  }

  console.log("═".repeat(70));
  console.log("  TRACE SMOKE MATRIX — N=1000, EigenTrust + Hardened TRACE (24 Cells)");
  console.log("═".repeat(70));
  console.log(`  Network Size       : ${NETWORK_SIZE}`);
  console.log(`  Seeds              : ${SEEDS.length} (${SEEDS.join(", ")})`);
  console.log(`  Attacks            : ${ATTACKS.length} (${ATTACKS.join(", ")})`);
  console.log(`  Policies           : ${POLICIES.length}`);
  console.log(`  Total cells        : ${TOTAL_CELLS}`);
  console.log(`  Rounds             : ${ROUNDS}`);
  console.log(`  Jobs/round         : ${JOBS_PER_ROUND}`);
  console.log(`  Malicious ratio    : ${MALICIOUS_RATIO}`);
  console.log(`  Max concurrent     : ${MAX_CONCURRENT}`);
  console.log(`  Per-cell timeout   : ${PER_CELL_TIMEOUT_MS / 1000}s (15 min)`);
  console.log(`  Ghost module flags : TEMPORAL=false, CAUSAL=false (Publication_Preset)`);
  console.log(`  NODE_OPTIONS       : --max-old-space-size=12288 --expose-gc`);
  console.log(`  Output (JSONL)     : ${RESULTS_FILE}`);
  console.log(`  Output (CSV)       : ${SUMMARY_FILE}`);
  console.log(`  Game-theoretic     : maps to "game-theoretic-adversary" attack type`);
  console.log(`  Manual-launch only : NOT part of the automated test suite.`);
  console.log("═".repeat(70) + "\n");

  // ── Resume support ──────────────────────────────────────────────────────────
  const completedIds = await loadCompletedCellIds();
  console.log(`  Resuming: ${completedIds.size} / ${TOTAL_CELLS} already done\n`);

  // ── Validation cell ─────────────────────────────────────────────────────────
  const validationCellId = buildCellId("TRACE-full", "strategic-default", 42);
  if (!completedIds.has(validationCellId)) {
    runValidationCell();
    completedIds.add(validationCellId);
  } else {
    console.log("  Validation cell already completed (skipping).\n");
  }

  // ── Build queue (excluding validation cell if already done) ─────────────────
  const queue = buildQueue(completedIds);
  console.log(`  Remaining: ${queue.length} cells\n`);

  if (queue.length === 0) {
    console.log("  All cells already completed. Generating summary...\n");
    await generateSummaryCSV();
    console.log("\n  ✅ SMOKE MATRIX COMPLETE (all cells from prior run)");
    return;
  }

  // ── Execute matrix ──────────────────────────────────────────────────────────
  const matrixStartTime = Date.now();
  let runIndex = completedIds.size;
  let failed = 0;
  let timedOut = 0;
  let succeeded = completedIds.size;

  for (const spec of queue) {
    runIndex++;
    const banner = `  [${runIndex}/${TOTAL_CELLS}] ${spec.policyLabel} | ${spec.attack} | s=${spec.seed}`;
    console.log(`${banner} — running...`);

    const t0 = Date.now();
    const outcome = runCellInSubprocess(spec);
    const dur = (Date.now() - t0) / 1000;

    if (outcome.kind === "ok") {
      fs.appendFileSync(RESULTS_FILE, JSON.stringify(outcome.record) + "\n", "utf-8");
      succeeded++;
      const r = outcome.record;
      console.log(
        `${banner} — ✓ fraud=${r.fraudExposure} mr=${r.maliciousRoutingRate.toFixed(3)} ` +
        `dur=${r.wallClockSec.toFixed(1)}s rss=${(r.peakRSS / 1024 / 1024).toFixed(0)}MB\n`,
      );
    } else if (outcome.kind === "timeout") {
      timedOut++;
      console.log(
        `${banner} — TIMEOUT after ${dur.toFixed(1)}s (cap=${PER_CELL_TIMEOUT_MS / 1000}s); continuing\n`,
      );
    } else {
      failed++;
      console.log(`${banner} — FAILED: ${outcome.err}\n`);
    }

    // Progress telemetry every 10 cells
    if (runIndex % 10 === 0) {
      const elapsed = (Date.now() - matrixStartTime) / 1000;
      const remaining = queue.length - (runIndex - completedIds.size);
      const avgPerCell = elapsed / (runIndex - completedIds.size + succeeded - completedIds.size || 1);
      const eta = remaining * avgPerCell;
      console.log(
        `  ── Progress: ${succeeded}/${TOTAL_CELLS} done, ${failed} failed, ${timedOut} timeout ` +
        `| elapsed=${formatDuration(elapsed)} ETA=${formatDuration(eta)} ──\n`,
      );
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const totalElapsed = (Date.now() - matrixStartTime) / 1000;

  console.log("\n" + "═".repeat(70));
  console.log("  SMOKE MATRIX EXECUTION COMPLETE");
  console.log("═".repeat(70));
  console.log(`  Succeeded  : ${succeeded}`);
  console.log(`  Failed     : ${failed}`);
  console.log(`  Timed out  : ${timedOut}`);
  console.log(`  Total      : ${TOTAL_CELLS}`);
  console.log(`  Wall-clock : ${formatDuration(totalElapsed)}`);
  console.log(`  Results    : ${RESULTS_FILE}`);
  console.log("═".repeat(70) + "\n");

  // Generate summary CSV
  await generateSummaryCSV();

  console.log("\n  ✅ SMOKE MATRIX N=1000 COMPLETE");
  console.log(`  JSONL: ${RESULTS_FILE}`);
  console.log(`  CSV:   ${SUMMARY_FILE}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
