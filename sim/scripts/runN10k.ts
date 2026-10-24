/**
 * TRACE v2.1 — N=10,000 Scale Experiment Orchestrator
 *
 * Runs the FULL TRACE v2.1 engine (real Prisma/SQLite, real scoring, real sybil
 * detection, real trust graph) at multiple agent counts up to N=10,000.
 *
 * Uses the same parallel-SQLite-worker pattern as runParallelSeeds.ts so each
 * seed gets its own isolated DB file. The provider creation bottleneck is fixed
 * with batch inserts (see runner.ts createSimulatedProviders).
 *
 * This produces publishable results identical to the validated N=30/50/100
 * experiments — just at larger scale.
 *
 * ---
 * Usage
 * ---
 *   # Quick smoke test — single seed, N=1000, collusion-ring 30%
 *   npx tsx scripts/runN10k.ts --n 1000 --attack collusion-ring --seed 42
 *
 *   # Full N=10,000 matrix (20 seeds × 4 policies × 3 attacks) — ~15–30 min
 *   npx tsx scripts/runN10k.ts --full-matrix --seeds 1-20
 *
 *   # Scaling curve: N = 30 → 50 → 100 → 1000 → 10000, 20 seeds, collusion-ring
 *   npx tsx scripts/runN10k.ts --scaling-curve --seeds 1-20
 *
 *   # Single N, specific attack, 20 seeds (good for targeted stats)
 *   npx tsx scripts/runN10k.ts --n 10000 --attack collusion-ring --malicious 0.3 --seeds 1-20
 *
 *   # Memory check: how long does N=10,000 setup take?
 *   npx tsx scripts/runN10k.ts --n 10000 --seed 1 --attack none --rounds 5
 *
 * ---
 * Time estimates (Windows, SSD, 8-core):
 *   N=1,000  — ~15 s/seed
 *   N=10,000 — ~60–90 s/seed  (dominated by score propagation + findMany)
 *   Full matrix (240 experiments, 8 cores) — ~45–90 min
 *   Scaling curve (100 experiments, 8 cores) — ~20–40 min
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { spawn } from "child_process";
import { DEFAULT_CONFIG, type ExperimentConfig, computeDetailedStats } from "../src/lib/trace/experiments";

// ─── Constants ────────────────────────────────────────────────────────────────

const SCRATCH_DIR = path.join(process.cwd(), "results", ".parallel_scratch");
const BASE_DB     = path.join(SCRATCH_DIR, "_schema_base.db");

// Agents mix for large-N: proportional 1/3 split across 3 model types
// Matches the mix used in runScalingExperiment.ts for consistency
function buildAgentMix(n: number) {
  const third     = Math.floor(n / 3);
  const remainder = n - third * 3;
  return [
    { model: "gpt-4o-mini",   displayName: "GPT-4o Mini",  count: third + (remainder > 0 ? 1 : 0), priceRange: { min: 8,  max: 18 } },
    { model: "sarvam",        displayName: "Sarvam AI",    count: third + (remainder > 1 ? 1 : 0), priceRange: { min: 5,  max: 12 } },
    { model: "llama-3.2-3b",  displayName: "Llama 3.2 3B", count: third,                           priceRange: { min: 3,  max: 8  } },
  ];
}

// ─── Prisma SQLite URL helper ─────────────────────────────────────────────────

function prismaSqliteUrl(absDbPath: string): string {
  const rel = path.relative(process.cwd(), absDbPath).split(path.sep).join("/");
  return `file:./${rel}`;
}

function ensureBaseDb(): void {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  if (fs.existsSync(BASE_DB)) return;
  console.log("  Building base schema DB (once)...");
  const url = prismaSqliteUrl(BASE_DB);
  execSync("npx prisma db push", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}

// ─── CLI Args ─────────────────────────────────────────────────────────────────

type Policy = "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
type Attack = "collusion-ring" | "sybil-cluster" | "strategic-default" | "whitewashing" | "none";

interface CliOpts {
  // Which N values to run
  n: number;
  scalingCurve: boolean;
  fullMatrix: boolean;

  // Experiment config
  attack: Attack;
  malicious: number;
  rounds: number;
  jobsPerRound: number;
  windowRounds: number;
  seeds: number[];
  policies: Policy[];
  attacks: Attack[];

  // Execution
  concurrency: number;
  outDir: string;
}

function parseSeedsArg(raw: string): number[] {
  const out = new Set<number>();
  for (const part of raw.split(/[, ]+/)) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("-")) {
      const [a, b] = p.split("-").map(Number);
      for (let s = Math.min(a, b); s <= Math.max(a, b); s++) out.add(s);
    } else {
      const n = parseInt(p, 10);
      if (!isNaN(n)) out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}

function parseArgs(): CliOpts {
  const argv = process.argv.slice(2);
  const get  = (flag: string, def: string): string => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  // Collect ALL occurrences of a repeated flag (e.g. --policy TRACE --policy REPUTATION)
  const getAll = (flag: string): string[] => {
    const results: string[] = [];
    const key = `--${flag}`;
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === key && argv[i + 1] && !argv[i + 1].startsWith("--")) {
        results.push(argv[i + 1]);
      }
    }
    return results;
  };
  const has  = (flag: string): boolean => argv.includes(`--${flag}`);

  const scalingCurve = has("scaling-curve");
  const fullMatrix   = has("full-matrix");
  const n            = parseInt(get("n", "10000"), 10);
  const attack       = get("attack", "collusion-ring") as Attack;
  const malicious    = parseFloat(get("malicious", "0.3"));
  const rounds       = parseInt(get("rounds", "60"), 10);
  const jobs         = parseInt(get("jobs-per-round", get("jobs", "5")), 10);
  const windowRounds = parseInt(get("window-rounds", "500"), 10);
  const seeds        = parseSeedsArg(get("seeds", "42"));
  const cpus         = Math.max(1, os.cpus().length - 1);
  const concurrency  = parseInt(get("concurrency", String(cpus)), 10);
  const outDir       = get("out", path.join(process.cwd(), "results", `n10k_${Date.now()}`));

  // Full matrix: all 4 policies × 3 attacks × 3 malicious ratios
  const explicitPolicies = getAll("policy") as Policy[];
  const policies: Policy[] = fullMatrix
    ? ["TRACE", "REPUTATION", "PRICE", "EIGENTRUST"]
    : explicitPolicies.length > 0 ? explicitPolicies : [get("policy", "TRACE") as Policy];

  const attacks: Attack[] = fullMatrix
    ? ["collusion-ring", "sybil-cluster", "strategic-default"]
    : [attack];

  return {
    n,
    scalingCurve,
    fullMatrix,
    attack,
    malicious,
    rounds,
    jobsPerRound: jobs,
    windowRounds,
    seeds,
    policies,
    attacks,
    concurrency,
    outDir,
  };
}

// ─── Experiment Task ──────────────────────────────────────────────────────────

interface Task {
  n: number;
  policy: Policy;
  attack: Attack;
  malicious: number;
  seed: number;
  rounds: number;
  jobsPerRound: number;
  windowRounds: number;
}

interface TaskResult {
  task: Task;
  ok: boolean;
  resultsDir: string;
  metrics?: MetricsSummary;
  elapsedMs: number;
}

interface MetricsSummary {
  overallSuccessRate: number;
  maliciousRoutingRate: number;
  totalFraudExposureSats: number;
  duringAttackSuccessRate: number;
  recoveryTimeRounds: number;
  finalMaliciousTraceScore: number;
  avgHonestTraceScore: number;
}

// ─── Worker Spawning ──────────────────────────────────────────────────────────

function runOneWorker(
  dbFile: string,
  task: Task,
  runId: string
): Promise<{ ok: boolean; resultsDir: string }> {
  return new Promise((resolve) => {
    const config: ExperimentConfig = {
      ...DEFAULT_CONFIG,
      policy:                        task.policy,
      attack:                        task.attack,
      agents:                        task.n,
      agentMix:                      buildAgentMix(task.n),
      maliciousRatio:                task.malicious,
      seed:                          task.seed,
      rounds:                        task.rounds,
      jobsPerRound:                  task.jobsPerRound,
      interactionHistoryWindowRounds: task.windowRounds,
      attackParams:                  { jobsPerRound: task.jobsPerRound },
    };

    const proc = spawn(
      "npx",
      ["tsx", "scripts/runParallelSeeds.worker.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TRACE_DB_PATH:         dbFile,
          TRACE_WORKER_SEED:     String(task.seed),
          TRACE_WORKER_CONFIG:   JSON.stringify(config),
          TRACE_PARALLEL_RUN_ID: runId,
        },
        stdio: "pipe",
        shell: true,
      }
    );

    // Suppress per-round output for large N (too verbose)
    // but surface errors
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("error", (err) => {
      console.error(`  Worker error (N=${task.n}, policy=${task.policy}, seed=${task.seed}): ${err.message}`);
      resolve({ ok: false, resultsDir: "" });
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`  Worker failed (N=${task.n} ${task.policy} ${task.attack} seed=${task.seed}, exit=${code})`);
        if (stderr) console.error(stderr.slice(-500));
        resolve({ ok: false, resultsDir: "" });
      } else {
        // Read marker file to get resultsDir
        const markerDir = path.join(process.cwd(), "results", ".parallel");
        const markerFile = path.join(markerDir, `${runId}_seed_${task.seed}.json`);
        try {
          const marker = JSON.parse(fs.readFileSync(markerFile, "utf-8"));
          resolve({ ok: true, resultsDir: marker.resultsDir ?? "" });
        } catch {
          resolve({ ok: true, resultsDir: "" });
        }
      }
    });
  });
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function mannWhitneyU(a: number[], b: number[]): { U: number; p: number; cliffDelta: number } {
  if (a.length === 0 || b.length === 0) return { U: 0, p: 1, cliffDelta: 0 };
  let U = 0;
  for (const x of a) for (const y of b) {
    if (x > y) U += 1;
    else if (x === y) U += 0.5;
  }
  const n1 = a.length, n2 = b.length;
  const maxU  = n1 * n2;
  const mu    = maxU / 2;
  const sigma = Math.sqrt(maxU * (n1 + n2 + 1) / 12);
  const z     = sigma > 0 ? Math.abs(U - mu) / sigma : 0;
  // Abramowitz–Stegun approximation for the normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const pTail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  const p = z > 0 ? 2 * pTail : 1;
  const cliffDelta = (2 * U / maxU) - 1;
  return { U, p, cliffDelta };
}

function mean(arr: number[]): number { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 === 0 ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : s[Math.floor(s.length / 2)];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║        TRACE v2.1 — N=10,000 Scale Experiments                     ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  ensureBaseDb();
  fs.mkdirSync(opts.outDir, { recursive: true });

  // ─── Build task list ───────────────────────────────────────────────
  const nValues = opts.scalingCurve || opts.fullMatrix
    ? [30, 50, 100, 1000, 10000]
    : [opts.n];

  const maliciousRatios = opts.fullMatrix
    ? [0.1, 0.2, 0.3]
    : [opts.malicious];

  const tasks: Task[] = [];
  for (const n of nValues) {
    for (const attack of opts.attacks) {
      for (const malicious of maliciousRatios) {
        for (const policy of opts.policies) {
          for (const seed of opts.seeds) {
            tasks.push({
              n, policy, attack, malicious, seed,
              rounds:       opts.rounds,
              jobsPerRound: opts.jobsPerRound,
              windowRounds: opts.windowRounds,
            });
          }
        }
      }
    }
  }

  const totalExperiments = tasks.length;
  const estSecondsPerSeed = (n: number): number => {
    if (n <= 100)   return 10;
    if (n <= 1000)  return 20;
    return 75; // N=10,000
  };
  const maxNForTime = Math.max(...nValues);
  const estTotal = Math.ceil(totalExperiments / opts.concurrency) * estSecondsPerSeed(maxNForTime);

  console.log(`  N values:   ${nValues.join(", ")}`);
  console.log(`  Attacks:    ${opts.attacks.join(", ")}`);
  console.log(`  Policies:   ${opts.policies.join(", ")}`);
  console.log(`  Mal ratios: ${maliciousRatios.join(", ")}`);
  console.log(`  Seeds:      ${opts.seeds.length} (${opts.seeds[0]}..${opts.seeds[opts.seeds.length - 1]})`);
  console.log(`  Rounds:     ${opts.rounds} × ${opts.jobsPerRound} jobs/round`);
  console.log(`  Window:     last ${opts.windowRounds} rounds for entropy`);
  console.log(`  Concurrency:${opts.concurrency} workers`);
  console.log(`  Total runs: ${totalExperiments}`);
  console.log(`  Est. time:  ~${Math.ceil(estTotal / 60)} min (${estSecondsPerSeed(maxNForTime)}s/seed at N=${maxNForTime})\n`);

  const runId    = `n10k_${Date.now()}`;
  const wallStart = Date.now();
  let completed  = 0;
  let failed     = 0;

  const taskResults: TaskResult[] = [];

  // ─── Worker pool ───────────────────────────────────────────────────
  let idx = 0;
  async function workerLoop(): Promise<void> {
    while (idx < tasks.length) {
      const myIdx = idx++;
      const task  = tasks[myIdx];
      const dbFile = path.join(SCRATCH_DIR, `${runId}_n${task.n}_${task.policy}_${task.attack}_m${task.malicious}_s${task.seed}.db`);
      fs.copyFileSync(BASE_DB, dbFile);

      const t0 = Date.now();
      const { ok, resultsDir } = await runOneWorker(dbFile, task, `${runId}_n${task.n}`);
      const elapsed = Date.now() - t0;

      // Clean up DB file to save disk space
      try { fs.unlinkSync(dbFile); } catch { /* ignore */ }

      let metrics: MetricsSummary | undefined;
      if (ok && resultsDir) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(resultsDir, "metrics.json"), "utf-8"));
          metrics = {
            overallSuccessRate:        raw.overallSuccessRate ?? 0,
            maliciousRoutingRate:      raw.maliciousRoutingRate ?? 0,
            totalFraudExposureSats:    raw.totalFraudExposureSats ?? 0,
            duringAttackSuccessRate:   raw.duringAttackSuccessRate ?? 0,
            recoveryTimeRounds:        raw.recoveryTimeRounds ?? 0,
            finalMaliciousTraceScore:  raw.finalMaliciousTraceScore ?? 0,
            avgHonestTraceScore:       raw.avgHonestTraceScore ?? 0,
          };
        } catch { /* metrics unavailable */ }
      }

      taskResults.push({ task, ok, resultsDir, metrics, elapsedMs: elapsed });
      if (ok) completed++; else failed++;

      const pct  = (((completed + failed) / totalExperiments) * 100).toFixed(0);
      const wall = ((Date.now() - wallStart) / 1000).toFixed(0);
      process.stdout.write(
        `\r  [${pct.padStart(3)}%] ${completed + failed}/${totalExperiments}` +
        ` | ok=${completed} fail=${failed}` +
        ` | ${wall}s elapsed` +
        ` | last: N=${task.n} ${task.policy} ${task.attack} seed=${task.seed} (${(elapsed/1000).toFixed(1)}s)`
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, tasks.length) }, () => workerLoop())
  );

  const totalWall = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.log(`\n\n  Done in ${totalWall}s — ${completed} succeeded, ${failed} failed\n`);

  // ─── Aggregate results ─────────────────────────────────────────────
  const successResults = taskResults.filter((r) => r.ok && r.metrics);

  // ─── Scaling curve table ────────────────────────────────────────────
  console.log("  ╔══ TRACE vs REPUTATION — Malicious Routing Rate by N ══════════════╗");
  console.log(`  ${"N".padEnd(8)} ${"Attack".padEnd(24)} ${"TRACE".padStart(9)} ${"REP".padStart(9)} ${"Δ(pp)".padStart(8)} ${"p-value".padStart(10)} ${"δ".padStart(8)}`);
  console.log(`  ${"─".repeat(82)}`);

  const scalingCurveData: Record<string, unknown>[] = [];

  for (const n of nValues) {
    for (const attack of opts.attacks) {
      const malicious = 0.3; // primary condition for the scaling curve
      const traceR = successResults.filter(
        (r) => r.task.n === n && r.task.attack === attack &&
               r.task.malicious === malicious && r.task.policy === "TRACE"
      );
      const repR   = successResults.filter(
        (r) => r.task.n === n && r.task.attack === attack &&
               r.task.malicious === malicious && r.task.policy === "REPUTATION"
      );
      if (traceR.length === 0) continue;

      const traceMal = traceR.map((r) => r.metrics!.maliciousRoutingRate);
      const repMal   = repR.map((r)   => r.metrics!.maliciousRoutingRate);
      const mw       = repMal.length > 0 ? mannWhitneyU(traceMal, repMal) : null;

      const traceMean = mean(traceMal);
      const repMean   = repMal.length > 0 ? mean(repMal) : NaN;
      const delta     = !isNaN(repMean) ? repMean - traceMean : NaN;

      console.log(
        `  ${String(n).padEnd(8)} ${attack.padEnd(24)} ` +
        `${(traceMean * 100).toFixed(1).padStart(8)}% ` +
        `${(!isNaN(repMean) ? (repMean * 100).toFixed(1) + "%" : "N/A").padStart(9)} ` +
        `${(!isNaN(delta) ? (delta > 0 ? "+" : "") + (delta * 100).toFixed(1) + "pp" : "N/A").padStart(7)} ` +
        `${(mw ? `p=${mw.p < 0.001 ? "<0.001" : mw.p.toFixed(4)}` : "N/A").padStart(10)} ` +
        `${(mw ? mw.cliffDelta.toFixed(3) : "N/A").padStart(8)}`
      );

      scalingCurveData.push({
        n, attack, malicious,
        TRACE_seeds:           traceR.length,
        TRACE_malRouting_mean: traceMean,
        TRACE_malRouting_med:  median(traceMal),
        TRACE_fraud_mean:      mean(traceR.map((r) => r.metrics!.totalFraudExposureSats)),
        TRACE_success_mean:    mean(traceR.map((r) => r.metrics!.overallSuccessRate)),
        REP_malRouting_mean:   repMean,
        REP_fraud_mean:        repMal.length > 0 ? mean(repR.map((r) => r.metrics!.totalFraudExposureSats)) : null,
        delta_pp:              !isNaN(delta) ? delta * 100 : null,
        mannWhitney_p:         mw?.p ?? null,
        cliffDelta:            mw?.cliffDelta ?? null,
        significant:           mw ? mw.p < 0.05 : null,
      });
    }
  }
  console.log(`  ${"─".repeat(82)}\n`);

  // ─── N=50 significance check ────────────────────────────────────────
  const n50trace = successResults.filter(
    (r) => r.task.n === 50 && r.task.attack === "collusion-ring" &&
           r.task.malicious === 0.3 && r.task.policy === "TRACE"
  );
  const n50rep = successResults.filter(
    (r) => r.task.n === 50 && r.task.attack === "collusion-ring" &&
           r.task.malicious === 0.3 && r.task.policy === "REPUTATION"
  );
  const n10ktrace = successResults.filter(
    (r) => r.task.n === 10000 && r.task.attack === "collusion-ring" &&
           r.task.malicious === 0.3 && r.task.policy === "TRACE"
  );
  const n10krep = successResults.filter(
    (r) => r.task.n === 10000 && r.task.attack === "collusion-ring" &&
           r.task.malicious === 0.3 && r.task.policy === "REPUTATION"
  );

  if (n50trace.length > 0 && n50rep.length > 0) {
    const mw50 = mannWhitneyU(
      n50trace.map((r) => r.metrics!.maliciousRoutingRate),
      n50rep.map((r)   => r.metrics!.maliciousRoutingRate)
    );
    console.log(`  N=50 TRACE vs REPUTATION (collusion-ring 30%): p=${mw50.p.toFixed(4)}, δ=${mw50.cliffDelta.toFixed(3)}`);
    if (mw50.p > 0.05) {
      console.log(`  → WAS non-significant at N=50 (p=${mw50.p.toFixed(3)})`);
    }
  }
  if (n10ktrace.length > 0 && n10krep.length > 0) {
    const mw10k = mannWhitneyU(
      n10ktrace.map((r) => r.metrics!.maliciousRoutingRate),
      n10krep.map((r)   => r.metrics!.maliciousRoutingRate)
    );
    console.log(`  N=10,000 TRACE vs REPUTATION (collusion-ring 30%): p=${mw10k.p < 0.001 ? "<0.001" : mw10k.p.toFixed(4)}, δ=${mw10k.cliffDelta.toFixed(3)}`);
    if (mw10k.p < 0.01) {
      console.log(`  ✓ RESOLVED at N=10,000 (p<0.01) — paper claim confirmed`);
    }
  }

  // ─── Per-seed stats for each (N, policy, attack, malicious) ────────
  const statsReport: Record<string, unknown> = {};
  for (const n of nValues) {
    for (const attack of opts.attacks) {
      for (const malicious of maliciousRatios) {
        const key = `N=${n}_${attack}_mal${malicious}`;
        const byPolicy: Record<string, unknown> = {};
        for (const policy of opts.policies) {
          const r = successResults.filter(
            (x) => x.task.n === n && x.task.attack === attack &&
                   x.task.malicious === malicious && x.task.policy === policy
          );
          if (r.length === 0) continue;
          const mal   = r.map((x) => x.metrics!.maliciousRoutingRate);
          const fraud = r.map((x) => x.metrics!.totalFraudExposureSats);
          const succ  = r.map((x) => x.metrics!.overallSuccessRate);
          byPolicy[policy] = computeDetailedStats
            ? computeDetailedStats(mal)
            : { mean: mean(mal), median: median(mal), min: Math.min(...mal), max: Math.max(...mal) };

          byPolicy[`${policy}_full`] = {
            nSeeds:             r.length,
            malRoutingMean:     mean(mal),
            malRoutingMedian:   median(mal),
            fraudMean:          mean(fraud),
            successRateMean:    mean(succ),
          };
        }

        // Mann-Whitney TRACE vs REPUTATION for this condition
        const traceR = successResults.filter((x) => x.task.n === n && x.task.attack === attack && x.task.malicious === malicious && x.task.policy === "TRACE");
        const repR   = successResults.filter((x) => x.task.n === n && x.task.attack === attack && x.task.malicious === malicious && x.task.policy === "REPUTATION");
        if (traceR.length > 0 && repR.length > 0) {
          const mw = mannWhitneyU(
            traceR.map((r) => r.metrics!.maliciousRoutingRate),
            repR.map((r)   => r.metrics!.maliciousRoutingRate)
          );
          byPolicy["mannWhitney_TRACE_vs_REP"] = {
            U: mw.U, p: mw.p, cliffDelta: mw.cliffDelta,
            significant: mw.p < 0.05,
            interpretation: mw.p < 0.001 ? "p<0.001 — highly significant"
              : mw.p < 0.01  ? "p<0.01  — significant"
              : mw.p < 0.05  ? "p<0.05  — significant"
              : `p=${mw.p.toFixed(4)} — not significant at N=${n}`,
          };
        }

        statsReport[key] = byPolicy;
      }
    }
  }

  // ─── Save results ──────────────────────────────────────────────────
  const rawOutput = successResults.map((r) => ({
    n:            r.task.n,
    policy:       r.task.policy,
    attack:       r.task.attack,
    malicious:    r.task.malicious,
    seed:         r.task.seed,
    elapsedSec:   (r.elapsedMs / 1000).toFixed(1),
    successRate:  r.metrics!.overallSuccessRate,
    malRouting:   r.metrics!.maliciousRoutingRate,
    fraud:        r.metrics!.totalFraudExposureSats,
    resultsDir:   r.resultsDir,
  }));

  fs.writeFileSync(path.join(opts.outDir, "full_matrix_results.json"), JSON.stringify(rawOutput, null, 2));
  fs.writeFileSync(path.join(opts.outDir, "scaling_curve.json"),       JSON.stringify(scalingCurveData, null, 2));
  fs.writeFileSync(path.join(opts.outDir, "stats_summary.json"),       JSON.stringify(statsReport, null, 2));

  const csv = [
    "n,policy,attack,malicious,seed,elapsed_s,success_rate,malicious_routing,fraud_sats",
    ...rawOutput.map((r) =>
      `${r.n},${r.policy},${r.attack},${r.malicious},${r.seed},${r.elapsedSec},` +
      `${r.successRate.toFixed(4)},${r.malRouting.toFixed(4)},${r.fraud}`
    ),
  ].join("\n");
  fs.writeFileSync(path.join(opts.outDir, "results.csv"), csv);

  if (failed > 0) {
    const failedTasks = taskResults.filter((r) => !r.ok).map((r) => r.task);
    fs.writeFileSync(path.join(opts.outDir, "failed_tasks.json"), JSON.stringify(failedTasks, null, 2));
  }

  console.log(`\n  Results saved to: ${opts.outDir}`);
  console.log(`    full_matrix_results.json — per-seed raw results`);
  console.log(`    scaling_curve.json       — paper figure data`);
  console.log(`    stats_summary.json       — Mann-Whitney + Cliff's δ per condition`);
  console.log(`    results.csv              — flat CSV for plotting`);
  if (failed > 0) {
    console.log(`    failed_tasks.json        — ${failed} failed seeds (re-run with --seeds to retry)`);
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
