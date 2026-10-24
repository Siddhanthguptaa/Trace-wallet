/**
 * TRACE — Final Publication Matrix Runner
 *
 * Runs the COMPLETE experiment matrix for paper-grade results:
 *   - 4 attacks × 3 policies × 3 scales × 10 seeds = 360 experiments
 *   - Produces multi-seed aggregated statistics (mean ± std)
 *   - Mann-Whitney U significance tests (TRACE vs baselines)
 *   - Outlier detection and variance analysis
 *   - Publication-ready tables
 *
 * Usage:
 *   npx tsx scripts/runFinalMatrix.ts                     # Full matrix (slow!)
 *   npx tsx scripts/runFinalMatrix.ts --attack collusion-ring  # Single attack
 *   npx tsx scripts/runFinalMatrix.ts --scale 50               # Single scale
 *   npx tsx scripts/runFinalMatrix.ts --seeds 5                # Fewer seeds (faster)
 *   npx tsx scripts/runFinalMatrix.ts --quick                  # Quick run: 5 seeds, N=50 only
 *   npx tsx scripts/runFinalMatrix.ts --trace-config guard_mid # TRACE routing preset
 */

import {
  runExperiment,
  DEFAULT_CONFIG,
  MODEL_PRESETS,
  type ExperimentConfig,
  type AgentModelSpec,
} from "../src/lib/trace/experiments";
import { OPENAI_CHAT_MODEL } from "../src/lib/openaiModel";
import { TRACE_ROUTING_PRESETS, type RoutingPolicy, type TraceRoutingPreset } from "../src/lib/trace";
import type { AttackType } from "../src/lib/trace/attacks";
import {
  descriptiveStats,
  mannWhitneyU,
  detectOutliers,
  aggregateMultiSeed,
  formatPctStat,
  formatSatsStat,
  type ExperimentResult,
} from "../src/lib/trace/experiments/statistics";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
import dotenv from "dotenv";

dotenv.config();

// ─── Configuration ────────────────────────────────────────────────────────────

const ALL_ATTACKS: AttackType[] = [
  "adaptive-sybil-swarm", 
  "economic-whitewashing", 
  "adaptive-collusion-market",
  "strategic-default"
];
const ALL_POLICIES: RoutingPolicy[] = ["TRACE", "REPUTATION", "PRICE", "EIGENTRUST"];
const ALL_SCALES = [100, 500, 1000];
const MALICIOUS_RATIOS = [0.1, 0.2];
const DEFAULT_SEEDS = 10;
const ROUNDS = 100;
const JOBS_PER_ROUND = 10;
const MALICIOUS_RATIO = 0.2;

// ─── Agent Mix Builder ────────────────────────────────────────────────────────

function buildMix(n: number): AgentModelSpec[] {
  const gpt = MODEL_PRESETS[OPENAI_CHAT_MODEL];
  const sarvam = MODEL_PRESETS["sarvam"];
  const llama = MODEL_PRESETS["llama-3.2-3b"];
  const third = Math.floor(n / 3);
  const rem = n - third * 3;
  return [
    { ...gpt, count: third + (rem > 0 ? 1 : 0) },
    { ...sarvam, count: third + (rem > 1 ? 1 : 0) },
    { ...llama, count: third },
  ];
}

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const idx = args.indexOf(`--${flag}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };

  const quick = args.includes("--quick");
  const attackFilter = get("attack", "");
  const scaleFilter = get("scale", "");
  const traceRoutingPreset = get("trace-config", "baseline") as TraceRoutingPreset;
  if (!(traceRoutingPreset in TRACE_ROUTING_PRESETS)) {
    console.error(`Unknown TRACE config: ${traceRoutingPreset}. Available: ${Object.keys(TRACE_ROUTING_PRESETS).join(", ")}`);
    process.exit(1);
  }

  return {
    attacks: attackFilter ? [attackFilter as AttackType] : ALL_ATTACKS,
    scales: scaleFilter ? scaleFilter.split(",").map((s) => parseInt(s.trim())) : quick ? [50] : ALL_SCALES,
    seeds: parseInt(get("seeds", quick ? "5" : String(DEFAULT_SEEDS))),
    quick,
    traceRoutingPreset,
  };
}

// ─── Result Types ─────────────────────────────────────────────────────────────

interface CellResult {
  attack: AttackType;
  policy: RoutingPolicy;
  scale: number;
  maliciousRatio: number;
  seedResults: Array<{ seed: number; metrics: ExperimentResult; dir: string }>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  
  // Clean up any orphaned isolated databases from previously crashed runs
  try {
    const files = fs.readdirSync(process.cwd());
    for (const file of files) {
      if (file.startsWith("dev_iso_") && file.includes(".db")) {
        console.log(`🧹 Deleting orphaned DB: ${file}`);
        fs.unlinkSync(path.join(process.cwd(), file));
      }
    }
  } catch (e) {
    console.error("Failed to clean up orphaned databases:", e);
  }

  const totalExperiments = opts.attacks.length * ALL_POLICIES.length * opts.scales.length * MALICIOUS_RATIOS.length * opts.seeds;

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║          TRACE — FINAL PUBLICATION MATRIX                           ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");
  console.log(`  Attacks: ${opts.attacks.join(", ")}`);
  console.log(`  Policies: ${ALL_POLICIES.join(", ")}`);
  console.log(`  Scales: ${opts.scales.join(", ")}`);
  console.log(`  Seeds: 1–${opts.seeds}`);
  console.log(`  TRACE config: ${opts.traceRoutingPreset}`);
  console.log(`  Total experiments: ${totalExperiments}`);
  console.log(`  Estimated time: ~${Math.ceil(totalExperiments * 20 / 60)} minutes\n`);

  const allCells: CellResult[] = [];
  let completed = 0;

  for (const attack of opts.attacks) {
    for (const scale of opts.scales) {
      for (const ratio of MALICIOUS_RATIOS) {
        const mix = buildMix(scale); // Uses standard mix calculation

        for (const policy of ALL_POLICIES) {
          const cell: CellResult = { attack, policy, scale, maliciousRatio: ratio, seedResults: [] };

          // Run seeds in parallel chunks to prevent V8 state pollution while maximizing CPU
          const chunkSize = 8; 
          for (let i = 1; i <= opts.seeds; i += chunkSize) {
            const chunk = Array.from({ length: Math.min(chunkSize, opts.seeds - i + 1) }, (_, idx) => i + idx);
            
            const results = await Promise.all(chunk.map(async (seed) => {
              const config: ExperimentConfig = {
                ...DEFAULT_CONFIG,
                policy,
                attack,
                agents: scale,
                agentMix: mix,
                maliciousRatio: ratio,
                rounds: ROUNDS,
                jobsPerRound: JOBS_PER_ROUND,
                seed,
                traceRoutingPreset: opts.traceRoutingPreset,
              };

              // ─── RESUME LOGIC: Check if this exact experiment already exists ───
              const resultsDirPath = path.join(process.cwd(), "results");
              if (!fs.existsSync(resultsDirPath)) fs.mkdirSync(resultsDirPath, { recursive: true });
              const existingDirs = fs.readdirSync(resultsDirPath);
              const prefix = `exp_${policy}_${attack}_${scale}a_${Math.round(ratio*100)}t_${seed}s_`;
              const alreadyDone = existingDirs.find(d => d.startsWith(prefix));
              if (alreadyDone) {
                const metricsPath = path.join(process.cwd(), "results", alreadyDone, "metrics.json");
                if (fs.existsSync(metricsPath)) {
                  try {
                    const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf-8")) as ExperimentResult;
                    return { seed, metrics, dir: path.join(process.cwd(), "results", alreadyDone) };
                  } catch (e) {}
                }
              }

              // Spawn isolated process to guarantee zero memory pollution. Use base64 to avoid Windows CLI quote escaping issues.
              const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");
              const cmd = `npx tsx scripts/runSingle.ts ${configBase64}`;
              const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
              
              const match = stdout.match(/__DIR__(.*)__DIR__/);
              if (!match) throw new Error("Failed to parse experiment directory from isolated process: " + stdout);
              const dir = match[1];

              const metricsPath = path.join(dir, "metrics.json");
              const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf-8")) as ExperimentResult;
              return { seed, metrics, dir };
            }));

            for (const res of results) {
              completed++;
              console.log(`[${completed}/${totalExperiments}] ${attack} | ${policy} | N=${scale} | Threat=${ratio * 100}% | seed=${res.seed}`);
              cell.seedResults.push(res);
            }
          }
          allCells.push(cell);
        }
      }
    }
  }

  // ─── Generate Analysis ──────────────────────────────────────────────
  const reportDir = path.join(process.cwd(), "results", `final_matrix_${Date.now()}`);
  fs.mkdirSync(reportDir, { recursive: true });

  // Save raw cell data
  fs.writeFileSync(path.join(reportDir, "raw_cells.json"), JSON.stringify(allCells, null, 2));

  // ─── Per-attack comparison tables ───────────────────────────────────
  const tables: string[] = [];
  const significanceResults: Array<{
    attack: string;
    scale: number;
    metric: string;
    traceVsRep: { pValue: number; effectSize: number; significant: boolean };
    traceVsPrice: { pValue: number; effectSize: number; significant: boolean };
  }> = [];

  for (const attack of opts.attacks) {
    for (const scale of opts.scales) {
      const traceCell = allCells.find((c) => c.attack === attack && c.policy === "TRACE" && c.scale === scale);
      const repCell = allCells.find((c) => c.attack === attack && c.policy === "REPUTATION" && c.scale === scale);
      const priceCell = allCells.find((c) => c.attack === attack && c.policy === "PRICE" && c.scale === scale);

      if (!traceCell || !repCell || !priceCell) continue;

      const traceMetrics = traceCell.seedResults.map((r) => r.metrics);
      const repMetrics = repCell.seedResults.map((r) => r.metrics);
      const priceMetrics = priceCell.seedResults.map((r) => r.metrics);

      // Significance tests
      const metricKeys = [
        { key: "fraud", extract: (r: ExperimentResult) => r.totalFraudExposureSats },
        { key: "routing", extract: (r: ExperimentResult) => r.maliciousRoutingRate },
        { key: "success", extract: (r: ExperimentResult) => r.overallSuccessRate },
      ];

      for (const mk of metricKeys) {
        const traceVals = traceMetrics.map(mk.extract);
        const repVals = repMetrics.map(mk.extract);
        const priceVals = priceMetrics.map(mk.extract);

        const traceVsRep = mannWhitneyU(traceVals, repVals);
        const traceVsPrice = mannWhitneyU(traceVals, priceVals);

        significanceResults.push({
          attack,
          scale,
          metric: mk.key,
          traceVsRep: { pValue: traceVsRep.pValue, effectSize: traceVsRep.effectSize, significant: traceVsRep.significant },
          traceVsPrice: { pValue: traceVsPrice.pValue, effectSize: traceVsPrice.effectSize, significant: traceVsPrice.significant },
        });
      }

      // Outlier analysis
      const fraudOutliers = detectOutliers(traceMetrics.map((r) => r.totalFraudExposureSats));

      // Build table
      const header = `\n${"═".repeat(80)}\n  ${attack} | N=${scale} | ${opts.seeds} seeds\n${"═".repeat(80)}`;
      const tableRows = [
        header,
        `\n  ${"Metric".padEnd(22)} ${"TRACE".padStart(22)} ${"REPUTATION".padStart(22)} ${"PRICE".padStart(22)}`,
        `  ${"─".repeat(88)}`,
        `  ${"Success Rate".padEnd(22)} ${formatPctStat(traceMetrics.map((r) => r.overallSuccessRate)).padStart(22)} ${formatPctStat(repMetrics.map((r) => r.overallSuccessRate)).padStart(22)} ${formatPctStat(priceMetrics.map((r) => r.overallSuccessRate)).padStart(22)}`,
        `  ${"Fraud (sats)".padEnd(22)} ${formatSatsStat(traceMetrics.map((r) => r.totalFraudExposureSats)).padStart(22)} ${formatSatsStat(repMetrics.map((r) => r.totalFraudExposureSats)).padStart(22)} ${formatSatsStat(priceMetrics.map((r) => r.totalFraudExposureSats)).padStart(22)}`,
        `  ${"Mal. Routing".padEnd(22)} ${formatPctStat(traceMetrics.map((r) => r.maliciousRoutingRate)).padStart(22)} ${formatPctStat(repMetrics.map((r) => r.maliciousRoutingRate)).padStart(22)} ${formatPctStat(priceMetrics.map((r) => r.maliciousRoutingRate)).padStart(22)}`,
        `  ${"Recovery (rds)".padEnd(22)} ${descriptiveStats(traceMetrics.map((r) => r.recoveryTimeRounds)).formatted.padStart(22)} ${descriptiveStats(repMetrics.map((r) => r.recoveryTimeRounds)).formatted.padStart(22)} ${descriptiveStats(priceMetrics.map((r) => r.recoveryTimeRounds)).formatted.padStart(22)}`,
        `  ${"─".repeat(88)}`,
        `\n  Significance (Mann-Whitney U):`,
      ];

      // Add significance rows
      for (const mk of metricKeys) {
        const sig = significanceResults.find((s) => s.attack === attack && s.scale === scale && s.metric === mk.key);
        if (sig) {
          tableRows.push(
            `    ${mk.key.padEnd(12)} TRACE vs REP: p=${sig.traceVsRep.pValue.toFixed(4)} r=${sig.traceVsRep.effectSize.toFixed(2)} ${sig.traceVsRep.significant ? "*" : "ns"}`
          );
          tableRows.push(
            `    ${"".padEnd(12)} TRACE vs PRICE: p=${sig.traceVsPrice.pValue.toFixed(4)} r=${sig.traceVsPrice.effectSize.toFixed(2)} ${sig.traceVsPrice.significant ? "*" : "ns"}`
          );
        }
      }

      // Outlier report
      if (fraudOutliers.outliers.length > 0) {
        tableRows.push(`\n  Fraud Outliers (TRACE): ${fraudOutliers.outliers.map((o) => `seed=${traceCell.seedResults[o.index]?.seed}:${o.value}sats`).join(", ")}`);
        tableRows.push(`  IQR: [${fraudOutliers.lowerFence}, ${fraudOutliers.upperFence}]`);
      }

      const tableText = tableRows.join("\n");
      tables.push(tableText);
      console.log(tableText);
    }
  }

  // ─── Save everything ────────────────────────────────────────────────
  fs.writeFileSync(path.join(reportDir, "tables.txt"), tables.join("\n\n"));
  fs.writeFileSync(path.join(reportDir, "significance.json"), JSON.stringify(significanceResults, null, 2));

  // ─── Master CSV for paper ───────────────────────────────────────────
  const csvRows = ["attack,scale,policy,metric,mean,std,median,min,max,n"];
  for (const cell of allCells) {
    const metrics = cell.seedResults.map((r) => r.metrics);
    const agg = aggregateMultiSeed(metrics);

    const addRow = (metric: string, stats: ReturnType<typeof descriptiveStats>) => {
      csvRows.push(`${cell.attack},${cell.scale},${cell.policy},${metric},${stats.mean},${stats.std},${stats.median},${stats.min},${stats.max},${stats.n}`);
    };

    addRow("success_rate", agg.successRate);
    addRow("fraud_exposure", agg.fraudExposure);
    addRow("malicious_routing", agg.maliciousRouting);
    addRow("recovery_time", agg.recoveryTime);
    addRow("during_attack_success", agg.duringAttackSuccess);
    addRow("routing_concentration", agg.routingConcentration);
  }

  fs.writeFileSync(path.join(reportDir, "master_results.csv"), csvRows.join("\n"));

  // ─── Claim validation ───────────────────────────────────────────────
  const claims = validateClaims(allCells);
  fs.writeFileSync(path.join(reportDir, "claims.md"), claims);
  console.log(`\n${claims}`);

  console.log(`\n  All results saved to: ${reportDir}`);
  console.log(`${"═".repeat(80)}\n`);
}

// ─── Claim Validation ─────────────────────────────────────────────────────────

function validateClaims(cells: CellResult[]): string {
  const lines: string[] = [
    "# TRACE — Claim Registry",
    "",
    "| # | Claim | Evidence | Supported? | Notes |",
    "|---|-------|----------|------------|-------|",
  ];

  // Claim 1: TRACE reduces collusion fraud
  const collusionTrace = cells.find((c) => c.attack === "adaptive-collusion-market" && c.policy === "TRACE" && c.scale === 500);
  const collusionPrice = cells.find((c) => c.attack === "adaptive-collusion-market" && c.policy === "PRICE" && c.scale === 500);
  if (collusionTrace && collusionPrice) {
    const traceFraud = descriptiveStats(collusionTrace.seedResults.map((r) => r.metrics.totalFraudExposureSats));
    const priceFraud = descriptiveStats(collusionPrice.seedResults.map((r) => r.metrics.totalFraudExposureSats));
    const sig = mannWhitneyU(
      collusionTrace.seedResults.map((r) => r.metrics.totalFraudExposureSats),
      collusionPrice.seedResults.map((r) => r.metrics.totalFraudExposureSats)
    );
    lines.push(`| 1 | TRACE significantly reduces adaptive collusion fraud | ${traceFraud.formatted} vs ${priceFraud.formatted} sats | ${sig.significant ? "✅ YES" : "⚠️ WEAK"} | p=${sig.pValue}, r=${sig.effectSize.toFixed(2)} |`);
  }

  // Claim 2: TRACE exhibits positive network effects (Scaling defense)
  const swarmLow = cells.find((c) => c.attack === "adaptive-sybil-swarm" && c.policy === "TRACE" && c.scale === 100);
  const swarmHigh = cells.find((c) => c.attack === "adaptive-sybil-swarm" && c.policy === "TRACE" && c.scale === 1000);
  if (swarmLow && swarmHigh) {
    const fraudLow = descriptiveStats(swarmLow.seedResults.map((r) => r.metrics.totalFraudExposureSats));
    const fraudHigh = descriptiveStats(swarmHigh.seedResults.map((r) => r.metrics.totalFraudExposureSats));
    const sig = mannWhitneyU(
      swarmLow.seedResults.map((r) => r.metrics.totalFraudExposureSats),
      swarmHigh.seedResults.map((r) => r.metrics.totalFraudExposureSats)
    );
    const reduction = fraudLow.mean > 0 ? ((fraudLow.mean - fraudHigh.mean) / fraudLow.mean * 100).toFixed(0) : "N/A";
    lines.push(`| 2 | TRACE security improves with network scale | N=100: ${fraudLow.formatted} → N=1000: ${fraudHigh.formatted} sats (${reduction}% reduction) | ${sig.significant ? "✅ YES" : "⚠️ WEAK"} | p=${sig.pValue} |`);
  }

  // Claim 3: TRACE suppresses adaptive whitewashing
  const wwTrace = cells.find((c) => c.attack === "economic-whitewashing" && c.policy === "TRACE" && c.scale === 500);
  const wwPrice = cells.find((c) => c.attack === "economic-whitewashing" && c.policy === "PRICE" && c.scale === 500);
  if (wwTrace && wwPrice) {
    const traceRouting = descriptiveStats(wwTrace.seedResults.map((r) => r.metrics.maliciousRoutingRate * 100));
    const priceRouting = descriptiveStats(wwPrice.seedResults.map((r) => r.metrics.maliciousRoutingRate * 100));
    const sig = mannWhitneyU(
      wwTrace.seedResults.map((r) => r.metrics.maliciousRoutingRate),
      wwPrice.seedResults.map((r) => r.metrics.maliciousRoutingRate)
    );
    lines.push(`| 3 | TRACE suppresses economic whitewashing | ${traceRouting.formatted}% vs ${priceRouting.formatted}% | ${sig.significant ? "✅ YES" : "⚠️ WEAK"} | p=${sig.pValue}, r=${sig.effectSize.toFixed(2)} |`);
  }

  // Claim 4: TRACE maintains high success rate
  const traceSuccessAll = cells
    .filter((c) => c.policy === "TRACE")
    .flatMap((c) => c.seedResults.map((r) => r.metrics.overallSuccessRate));
  if (traceSuccessAll.length > 0) {
    const successStats = descriptiveStats(traceSuccessAll.map((v) => v * 100));
    const above90 = traceSuccessAll.filter((v) => v >= 0.90).length / traceSuccessAll.length * 100;
    lines.push(`| 4 | TRACE maintains high success rate (>90%) | ${successStats.formatted}%, ${above90.toFixed(0)}% of runs ≥ 90% | ${above90 >= 90 ? "✅ YES" : "⚠️ PARTIAL"} | min=${successStats.min}% |`);
  }

  // Claim 5: TRACE's defenses are scale-dependent (limitation)
  if (swarmLow && collusionTrace) {
    const fraudLow = descriptiveStats(swarmLow.seedResults.map((r) => r.metrics.totalFraudExposureSats));
    const fraudMid = descriptiveStats(collusionTrace.seedResults.map((r) => r.metrics.totalFraudExposureSats));
    const worseLow = fraudLow.mean > fraudMid.mean;
    lines.push(`| 5 | TRACE is weaker at small scale (limitation) | N=100: ${fraudLow.formatted} vs N=500: ${fraudMid.formatted} sats | ${worseLow ? "✅ CONFIRMED" : "❌ NOT CONFIRMED"} | Honest limitation |`);
  }

  lines.push("");
  lines.push("## Calibrated Language Guide");
  lines.push("");
  lines.push("| Instead of | Use |");
  lines.push("|------------|-----|");
  lines.push("| eliminates | significantly reduces |");
  lines.push("| dominates | outperforms |");
  lines.push("| solves | mitigates |");
  lines.push("| guarantees | demonstrates |");
  lines.push("| always | consistently / in most configurations |");

  return lines.join("\n");
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
