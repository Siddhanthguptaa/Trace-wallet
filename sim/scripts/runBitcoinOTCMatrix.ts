/**
 * scripts/runBitcoinOTCMatrix.ts
 *
 * Subprocess-isolated Bitcoin OTC matrix runner.
 *
 * Spawns one fresh `npx tsx scripts/_bitcoinOTCWorker.ts` subprocess per cell.
 * Each subprocess starts with a clean heap, runs exactly one cell, emits a
 * `__RESULT__` line, and exits. The parent appends the result to the JSONL.
 *
 * Why this exists: the in-process runner (`runBitcoinOTCTest.ts`) accumulates
 * heap state across 160 cells (Prisma client warmups, JIT codegen, V8 hidden
 * classes, native handles inside the SQLite adapter). At the OTC seeded-graph
 * cost profile, this can OOM mid-run. Per-cell subprocesses make per-cell
 * memory bounded by design: every cell starts at the same baseline.
 *
 * Output is a drop-in replacement for `bitcoin_otc_results_N1000_10seeds.jsonl`
 * — same record shape, resume-safe based on `(networkSize|policy|attack|seed)`.
 *
 * Usage:
 *   1. Make sure the seed file exists:
 *        npx tsx scripts/loadBitcoinOTC.ts --n 1000
 *   2. Run the matrix:
 *        npx tsx scripts/runBitcoinOTCMatrix.ts
 *   3. The parent does NOT need a high --max-old-space-size (cells run
 *      in their own subprocesses). The worker uses 8 GB by default, which
 *      is plenty for N=1000 with the OTC seed.
 *
 * Configurable per-cell wall-clock cap: 20 minutes. If a cell exceeds it,
 * the parent kills it, records a timeout, and continues.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ─── Configuration ────────────────────────────────────────────────────────────

const NETWORK_SIZES = [1000];
const SEEDS = [42, 43, 44, 45, 46, 47, 48, 49, 50, 51];
const ATTACKS = [
  "strategic-default",
  "collusion-ring",
  "sybil-cluster",
  "game-theoretic-adversary",
] as const;
const POLICIES = ["TRACE", "REPUTATION", "PRICE", "EIGENTRUST"] as const;

const MALICIOUS_RATIO = 0.3;
const ROUNDS = 60;
const JOBS_PER_ROUND = 5;
const NUM_BUYERS = 5;

const PER_CELL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const WORKER_HEAP_MB = 8192;                // 8 GB per subprocess; ample for N=1000 OTC

const RESULTS_FILE = path.join(process.cwd(), "bitcoin_otc_results_N1000_10seeds.jsonl");
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "_bitcoinOTCWorker.ts");

function seedFileFor(n: number): string {
  return path.join(process.cwd(), "data", "real", `bitcoin-otc-seed-N${n}.json`);
}

// ─── Cell shape ───────────────────────────────────────────────────────────────

interface CellSpec {
  networkSize: number;
  policy: (typeof POLICIES)[number];
  attack: (typeof ATTACKS)[number];
  seed: number;
  realGraphSeedFile: string;
}

function cellKey(c: { networkSize: number; policy: string; attack: string; seed: number }): string {
  return `${c.networkSize}|${c.policy}|${c.attack}|${c.seed}`;
}

// ─── Resume support ───────────────────────────────────────────────────────────

async function loadCompletedKeys(): Promise<Set<string>> {
  const set = new Set<string>();
  if (!fs.existsSync(RESULTS_FILE)) return set;
  const rl = readline.createInterface({
    input: fs.createReadStream(RESULTS_FILE, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as { networkSize?: number; policy?: string; attack?: string; seed?: number; error?: boolean };
      // Only treat successful records as completed; failed records are retriable.
      if (
        !r.error
        && typeof r.networkSize === "number"
        && typeof r.policy === "string"
        && typeof r.attack === "string"
        && typeof r.seed === "number"
      ) {
        set.add(cellKey(r as { networkSize: number; policy: string; attack: string; seed: number }));
      }
    } catch {
      // skip malformed
    }
  }
  return set;
}

// ─── Build queue ──────────────────────────────────────────────────────────────

function buildQueue(completed: Set<string>): CellSpec[] {
  const queue: CellSpec[] = [];
  for (const networkSize of NETWORK_SIZES) {
    const seedFile = seedFileFor(networkSize);
    for (const policy of POLICIES) {
      for (const attack of ATTACKS) {
        for (const seed of SEEDS) {
          const spec: CellSpec = { networkSize, policy, attack, seed, realGraphSeedFile: seedFile };
          if (completed.has(cellKey(spec))) continue;
          queue.push(spec);
        }
      }
    }
  }
  return queue;
}

// ─── Subprocess invocation ────────────────────────────────────────────────────

type Outcome =
  | { kind: "ok"; record: Record<string, unknown> }
  | { kind: "timeout" }
  | { kind: "error"; err: string };

function runCell(spec: CellSpec): Outcome {
  const workerConfig = {
    policy: spec.policy,
    attack: spec.attack,
    seed: spec.seed,
    networkSize: spec.networkSize,
    maliciousRatio: MALICIOUS_RATIO,
    rounds: ROUNDS,
    jobsPerRound: JOBS_PER_ROUND,
    numBuyers: NUM_BUYERS,
    realGraphSeedFile: spec.realGraphSeedFile,
  };

  const tmpFile = path.join(
    process.cwd(),
    `_tmp_otc_cell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(tmpFile, JSON.stringify(workerConfig), "utf-8");

  try {
    const output = execSync(
      `npx tsx scripts/_bitcoinOTCWorker.ts "${tmpFile}"`,
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: PER_CELL_TIMEOUT_MS,
        env: {
          ...process.env,
          NODE_OPTIONS: `--max-old-space-size=${WORKER_HEAP_MB} --expose-gc`,
        },
      },
    );

    const lines = output.split("\n");
    const resultLine = lines.findLast((l) => l.startsWith("__RESULT__"));
    if (!resultLine) {
      return { kind: "error", err: "no __RESULT__ line in worker output" };
    }
    const record = JSON.parse(resultLine.replace("__RESULT__", "")) as Record<string, unknown>;
    return { kind: "ok", record };
  } catch (err: unknown) {
    const e = err as { signal?: string; code?: string; message?: string };
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
      return { kind: "timeout" };
    }
    const msg = err instanceof Error
      ? err.message.slice(0, 600)
      : String(err).slice(0, 600);
    return { kind: "error", err: msg };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

function fmtDur(seconds: number): string {
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
    console.error(`Worker script missing at ${WORKER_SCRIPT}`);
    process.exit(1);
  }

  for (const n of NETWORK_SIZES) {
    const f = seedFileFor(n);
    if (!fs.existsSync(f)) {
      console.error(`Seed file missing: ${f}`);
      console.error(`Run: npx tsx scripts/loadBitcoinOTC.ts --n ${n}`);
      process.exit(1);
    }
  }

  const total = NETWORK_SIZES.length * POLICIES.length * ATTACKS.length * SEEDS.length;

  console.log("═".repeat(72));
  console.log("  TRACE × Bitcoin OTC matrix — subprocess-isolated runner");
  console.log("═".repeat(72));
  console.log(`  Network sizes      : ${NETWORK_SIZES.join(", ")}`);
  console.log(`  Policies           : ${POLICIES.join(", ")}`);
  console.log(`  Attacks            : ${ATTACKS.join(", ")}`);
  console.log(`  Seeds              : ${SEEDS.length} (${SEEDS[0]}..${SEEDS[SEEDS.length - 1]})`);
  console.log(`  Malicious          : ${MALICIOUS_RATIO * 100}%`);
  console.log(`  Rounds × jobs/rd   : ${ROUNDS} × ${JOBS_PER_ROUND}`);
  console.log(`  Total cells        : ${total}`);
  console.log(`  Per-cell timeout   : ${PER_CELL_TIMEOUT_MS / 1000}s (${PER_CELL_TIMEOUT_MS / 60000} min)`);
  console.log(`  Worker heap        : ${WORKER_HEAP_MB} MB (--expose-gc)`);
  console.log(`  Output (JSONL)     : ${RESULTS_FILE}`);
  console.log("═".repeat(72) + "\n");

  const completed = await loadCompletedKeys();
  console.log(`  Resume: ${completed.size}/${total} already done (successful records only)\n`);

  const queue = buildQueue(completed);
  if (queue.length === 0) {
    console.log("  All cells already complete. Nothing to do.\n");
    return;
  }
  console.log(`  Remaining: ${queue.length} cells\n`);

  const matrixStart = Date.now();
  let succeeded = completed.size;
  let failed = 0;
  let timedOut = 0;
  let runIndex = completed.size;

  for (const spec of queue) {
    runIndex++;
    const banner = `  [${runIndex}/${total}] ${spec.policy} | ${spec.attack} | s=${spec.seed}`;
    console.log(`${banner} — running...`);

    const t0 = Date.now();
    const outcome = runCell(spec);
    const dur = (Date.now() - t0) / 1000;

    if (outcome.kind === "ok") {
      fs.appendFileSync(RESULTS_FILE, JSON.stringify(outcome.record) + "\n", "utf-8");
      succeeded++;
      const r = outcome.record as { fraudExposure?: number; maliciousRoutingRate?: number; peakRSS?: number };
      const fraud = typeof r.fraudExposure === "number" ? r.fraudExposure : "?";
      const mr = typeof r.maliciousRoutingRate === "number" ? r.maliciousRoutingRate.toFixed(1) : "?";
      const rssMB = typeof r.peakRSS === "number" ? Math.round(r.peakRSS / 1024 / 1024) : "?";
      console.log(`${banner} — ✓ ${dur.toFixed(0)}s | fraud=${fraud} | MR=${mr}% | rss=${rssMB}MB\n`);
    } else if (outcome.kind === "timeout") {
      timedOut++;
      const failRec = {
        networkSize: spec.networkSize,
        policy: spec.policy,
        attack: spec.attack,
        seed: spec.seed,
        dataset: "bitcoin-otc",
        fraudExposure: -1,
        maliciousRoutingRate: -1,
        honestRoutingRate: -1,
        successRate: -1,
        totalJobs: 0,
        duration: dur,
        error: true,
        errorMessage: `timeout after ${PER_CELL_TIMEOUT_MS / 1000}s`,
        timestamp: new Date().toISOString(),
      };
      fs.appendFileSync(RESULTS_FILE, JSON.stringify(failRec) + "\n", "utf-8");
      console.log(`${banner} — TIMEOUT after ${dur.toFixed(0)}s; continuing\n`);
    } else {
      failed++;
      const failRec = {
        networkSize: spec.networkSize,
        policy: spec.policy,
        attack: spec.attack,
        seed: spec.seed,
        dataset: "bitcoin-otc",
        fraudExposure: -1,
        maliciousRoutingRate: -1,
        honestRoutingRate: -1,
        successRate: -1,
        totalJobs: 0,
        duration: dur,
        error: true,
        errorMessage: outcome.err,
        timestamp: new Date().toISOString(),
      };
      fs.appendFileSync(RESULTS_FILE, JSON.stringify(failRec) + "\n", "utf-8");
      console.log(`${banner} — FAILED: ${outcome.err}\n`);
    }

    // Progress telemetry every 8 cells.
    if ((runIndex - completed.size) % 8 === 0) {
      const elapsed = (Date.now() - matrixStart) / 1000;
      const sessionDone = runIndex - completed.size;
      const remaining = total - runIndex;
      const avg = sessionDone > 0 ? elapsed / sessionDone : 0;
      const eta = remaining * avg;
      console.log(
        `  ── ${succeeded}/${total} ok, ${failed} failed, ${timedOut} timeout ` +
        `| elapsed=${fmtDur(elapsed)} ETA=${fmtDur(eta)} (avg ${avg.toFixed(0)}s/cell) ──\n`,
      );
    }
  }

  const totalElapsed = (Date.now() - matrixStart) / 1000;
  console.log("\n" + "═".repeat(72));
  console.log("  MATRIX COMPLETE");
  console.log("═".repeat(72));
  console.log(`  Succeeded : ${succeeded}/${total}`);
  console.log(`  Failed    : ${failed}`);
  console.log(`  Timed out : ${timedOut}`);
  console.log(`  Wall-clock: ${fmtDur(totalElapsed)}`);
  console.log(`  Results   : ${RESULTS_FILE}`);
  console.log("═".repeat(72) + "\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
