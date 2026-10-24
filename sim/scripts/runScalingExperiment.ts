/**
 * TRACE v2.1 — Scaling Experiment
 *
 * Runs collusion-ring attack at N=30, N=50, N=100 agent scales
 * with realistic LLM agent mixes:
 *   - GPT-4o-mini  (high-cost, high-capability)
 *   - Sarvam AI    (mid-cost, regional)
 *   - Llama 3.2 3B (low-cost, edge-deployed)
 *
 * Usage:
 *   npx tsx scripts/runScalingExperiment.ts
 *   npx tsx scripts/runScalingExperiment.ts --attack collusion-ring
 *   npx tsx scripts/runScalingExperiment.ts --attack sybil-cluster
 *   npx tsx scripts/runScalingExperiment.ts --seed 42
 */

import {
  runExperiment,
  DEFAULT_CONFIG,
  MODEL_PRESETS,
  type ExperimentConfig,
  type AgentModelSpec,
} from "../src/lib/trace/experiments";
import { OPENAI_CHAT_MODEL } from "../src/lib/openaiModel";
import type { AttackType } from "../src/lib/trace/attacks";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

dotenv.config();

// ─── Agent Mix Definitions ────────────────────────────────────────────────────

function buildAgentMix(scale: number): AgentModelSpec[] {
  // Proportional distribution across 3 model types
  // Rule: roughly 1/3 each, rounded to nearest integer
  const gpt = MODEL_PRESETS[OPENAI_CHAT_MODEL];
  const sarvam = MODEL_PRESETS["sarvam"];
  const llama = MODEL_PRESETS["llama-3.2-3b"];

  switch (scale) {
    case 30:
      return [
        { ...gpt, count: 10 },
        { ...sarvam, count: 10 },
        { ...llama, count: 10 },
      ];
    case 50:
      return [
        { ...gpt, count: 17 },
        { ...sarvam, count: 17 },
        { ...llama, count: 16 },
      ];
    case 100:
      return [
        { ...gpt, count: 34 },
        { ...sarvam, count: 33 },
        { ...llama, count: 33 },
      ];
    default:
      // For arbitrary N: proportional split
      const third = Math.floor(scale / 3);
      const remainder = scale - third * 3;
      return [
        { ...gpt, count: third + (remainder > 0 ? 1 : 0) },
        { ...sarvam, count: third + (remainder > 1 ? 1 : 0) },
        { ...llama, count: third },
      ];
  }
}

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const idx = args.indexOf(`--${flag}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
  };

  return {
    attack: get("attack", "collusion-ring") as AttackType,
    seed: parseInt(get("seed", "42")),
    malicious: parseFloat(get("malicious", "0.3")),
    rounds: parseInt(get("rounds", "60")),
    jobs: parseInt(get("jobs", "5")),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface ScaleResult {
  scale: number;
  policy: string;
  successRate: number;
  fraudExposure: number;
  maliciousRouting: number;
  recoveryTime: number;
  duringAttackSuccess: number;
  routingConcentration: number;
  resultsDir: string;
}

async function main() {
  const opts = parseArgs();
  const scales = [30, 50, 100];
  const policies = ["TRACE", "REPUTATION", "PRICE", "EIGENTRUST"] as const;
  const allResults: ScaleResult[] = [];

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║            TRACE v2.1 — SCALING EXPERIMENT                          ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");
  console.log(`  Attack: ${opts.attack}`);
  console.log(`  Malicious Ratio: ${(opts.malicious * 100).toFixed(0)}%`);
  console.log(`  Rounds: ${opts.rounds} × ${opts.jobs} jobs/round`);
  console.log(`  Seed: ${opts.seed}`);
  console.log(`  Scales: ${scales.join(", ")} agents\n`);

  for (const scale of scales) {
    const mix = buildAgentMix(scale);
    const modelSummary = mix.map((s) => `${s.count}×${s.model}`).join(", ");

    console.log(`\n${"━".repeat(70)}`);
    console.log(`  SCALE: ${scale} agents (${modelSummary})`);
    console.log(`${"━".repeat(70)}`);

    for (const policy of policies) {
      const config: ExperimentConfig = {
        ...DEFAULT_CONFIG,
        policy,
        attack: opts.attack,
        agents: scale,
        agentMix: mix,
        maliciousRatio: opts.malicious,
        rounds: opts.rounds,
        jobsPerRound: opts.jobs,
        seed: opts.seed,
      };

      const dir = await runExperiment(config);

      // Read metrics from saved results
      const metricsPath = path.join(dir, "metrics.json");
      const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf-8"));

      allResults.push({
        scale,
        policy,
        successRate: metrics.overallSuccessRate,
        fraudExposure: metrics.totalFraudExposureSats,
        maliciousRouting: metrics.maliciousRoutingRate,
        recoveryTime: metrics.recoveryTimeRounds,
        duringAttackSuccess: metrics.duringAttackSuccessRate,
        routingConcentration: metrics.avgRoutingConcentration,
        resultsDir: dir,
      });
    }
  }

  // ─── Generate Combined Report ─────────────────────────────────────
  const reportDir = path.join(process.cwd(), "results", `scaling_${opts.attack}_${opts.seed}_${Date.now()}`);
  fs.mkdirSync(reportDir, { recursive: true });

  // Console output
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  SCALING RESULTS: ${opts.attack}`);
  console.log(`${"═".repeat(70)}\n`);

  console.log(`  ${"Scale".padEnd(8)} ${"Policy".padEnd(12)} ${"Success".padStart(10)} ${"Fraud".padStart(12)} ${"Mal.Route".padStart(12)} ${"Recovery".padStart(10)} ${"Concentration".padStart(14)}`);
  console.log(`  ${"─".repeat(78)}`);

  for (const r of allResults) {
    console.log(
      `  ${String(r.scale).padEnd(8)} ${r.policy.padEnd(12)} ` +
      `${(r.successRate * 100).toFixed(1).padStart(9)}% ` +
      `${(r.fraudExposure + " sats").padStart(12)} ` +
      `${(r.maliciousRouting * 100).toFixed(1).padStart(11)}% ` +
      `${(r.recoveryTime + " rds").padStart(10)} ` +
      `${r.routingConcentration.toFixed(4).padStart(14)}`
    );
  }

  console.log(`  ${"─".repeat(78)}`);

  // TRACE-only summary for paper
  console.log(`\n  TRACE-only scaling summary:`);
  console.log(`  ${"Scale".padEnd(8)} ${"Success".padStart(10)} ${"Fraud".padStart(12)} ${"Mal.Route".padStart(12)}`);
  console.log(`  ${"─".repeat(42)}`);
  for (const r of allResults.filter((r) => r.policy === "TRACE")) {
    console.log(
      `  ${String(r.scale).padEnd(8)} ` +
      `${(r.successRate * 100).toFixed(1).padStart(9)}% ` +
      `${(r.fraudExposure + " sats").padStart(12)} ` +
      `${(r.maliciousRouting * 100).toFixed(1).padStart(11)}%`
    );
  }
  console.log(`  ${"─".repeat(42)}\n`);

  // Save CSV
  const csv = [
    "scale,policy,success_rate,fraud_exposure_sats,malicious_routing_rate,recovery_time,during_attack_success,routing_concentration",
    ...allResults.map((r) =>
      `${r.scale},${r.policy},${r.successRate.toFixed(4)},${r.fraudExposure},${r.maliciousRouting.toFixed(4)},${r.recoveryTime},${r.duringAttackSuccess.toFixed(4)},${r.routingConcentration.toFixed(4)}`
    ),
  ].join("\n");

  fs.writeFileSync(path.join(reportDir, "scaling_results.csv"), csv);
  fs.writeFileSync(path.join(reportDir, "scaling_results.json"), JSON.stringify(allResults, null, 2));

  // Save agent mix info
  const mixInfo = scales.map((s) => ({
    scale: s,
    mix: buildAgentMix(s).map((m) => ({ model: m.model, displayName: m.displayName, count: m.count })),
  }));
  fs.writeFileSync(path.join(reportDir, "agent_mixes.json"), JSON.stringify(mixInfo, null, 2));

  console.log(`  Results saved to: ${reportDir}`);
  console.log(`${"═".repeat(70)}\n`);
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
