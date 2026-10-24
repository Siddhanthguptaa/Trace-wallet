/**
 * scripts/runBitcoinOTCTest.ts
 *
 * Bitcoin OTC real-graph evaluation matrix (Path C).
 *
 * Mirrors `runAbstractTest.ts` exactly — same N, seeds, attacks, policies,
 * malicious ratio, rounds, and propagation delay — but seeds the initial
 * trust graph from the Bitcoin OTC subset produced by
 * `scripts/loadBitcoinOTC.ts`. Adversary placement remains uniform-random
 * over node ids (identical to synthetic), so the only variable changed is
 * the *initial* graph topology.
 *
 * Matrix:
 *   Network sizes : [1000]
 *   Seeds         : [42..51]   (10 seeds)
 *   Attacks       : strategic-default, collusion-ring, sybil-cluster,
 *                   game-theoretic-adversary
 *   Policies      : TRACE, REPUTATION, PRICE, EIGENTRUST
 *   Malicious     : 30%
 *   Total cells   : 1 × 10 × 4 × 4 = 160
 *
 * Output: bitcoin_otc_results_N1000_10seeds.jsonl
 *
 * Usage:
 *   1. Ensure the seed JSON exists for the chosen N:
 *        npx tsx scripts/loadBitcoinOTC.ts --n 1000
 *   2. Run the matrix:
 *        $env:NODE_OPTIONS='--max-old-space-size=14336'; npx tsx scripts/runBitcoinOTCTest.ts
 */

import { runExperiment, DEFAULT_CONFIG } from "../src/lib/trace/experiments";
import type { AttackType } from "../src/lib/trace/attacks";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const NETWORK_SIZES = [1000];
const SEEDS = [42, 43, 44, 45, 46, 47, 48, 49, 50, 51];

const ATTACKS: AttackType[] = [
  "strategic-default",
  "collusion-ring",
  "sybil-cluster",
  "game-theoretic-adversary",
];

const POLICIES = ["TRACE", "REPUTATION", "PRICE", "EIGENTRUST"] as const;

const RESULTS_FILE = path.join(process.cwd(), "bitcoin_otc_results_N1000_10seeds.jsonl");

function seedFileFor(n: number): string {
  return path.join(process.cwd(), "data", "real", `bitcoin-otc-seed-N${n}.json`);
}

function createPrisma(): PrismaClient {
  const dbPath = path.join(process.cwd(), "dev.db");
  return new PrismaClient({
    log: [],
    adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
  });
}

async function cleanup(): Promise<void> {
  const prisma = createPrisma();
  try {
    await prisma.routingDecision.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.trustEdge.deleteMany({});
    await prisma.economicEvent.deleteMany({});
    await prisma.scoreHistory.deleteMany({});
    await prisma.buyer.deleteMany({});
    await prisma.provider.deleteMany({});
  } finally {
    await prisma.$disconnect();
  }
}

async function collectMetrics(): Promise<{
  fraudExposure: number;
  honestRoutingRate: number;
  maliciousRoutingRate: number;
  successRate: number;
  totalJobs: number;
}> {
  const prisma = createPrisma();
  try {
    const malicious = await prisma.provider.findMany({
      where: { isActive: true, name: { contains: "[M]" } },
      select: { id: true },
    });
    const maliciousIds = new Set(malicious.map(p => p.id));

    const jobs = await prisma.job.findMany({
      where: { buyerId: { startsWith: "experiment-buyer" } },
      select: { providerId: true, status: true, priceSats: true },
    });

    const total = jobs.length;
    const malJobs = jobs.filter(j => maliciousIds.has(j.providerId));
    const honJobs = jobs.filter(j => !maliciousIds.has(j.providerId));
    const failedMal = malJobs.filter(j => j.status === "failed");
    const successful = jobs.filter(j => j.status === "completed");

    return {
      fraudExposure: failedMal.reduce((s, j) => s + j.priceSats, 0),
      maliciousRoutingRate: total > 0 ? (malJobs.length / total) * 100 : 0,
      honestRoutingRate: total > 0 ? (honJobs.length / total) * 100 : 0,
      successRate: total > 0 ? successful.length / total : 1,
      totalJobs: total,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  // Pre-flight: every N in NETWORK_SIZES must have a seed file
  for (const n of NETWORK_SIZES) {
    const f = seedFileFor(n);
    if (!fs.existsSync(f)) {
      console.error(`Seed file missing: ${f}`);
      console.error(`Run: npx tsx scripts/loadBitcoinOTC.ts --n ${n}`);
      process.exit(1);
    }
  }

  const total = NETWORK_SIZES.length * POLICIES.length * ATTACKS.length * SEEDS.length;
  console.log("═".repeat(70));
  console.log("  TRACE × Bitcoin OTC real-graph evaluation");
  console.log("═".repeat(70));
  console.log(`  Network sizes: ${NETWORK_SIZES.join(", ")}`);
  console.log(`  Policies:      ${POLICIES.join(", ")}`);
  console.log(`  Attacks:       ${ATTACKS.join(", ")}`);
  console.log(`  Seeds:         ${SEEDS.length} (${SEEDS[0]}-${SEEDS[SEEDS.length - 1]})`);
  console.log(`  Malicious:     30%`);
  console.log(`  Trust seed:    Bitcoin OTC (largest WCC, top-degree induced subgraph)`);
  console.log(`  Total:         ${total} experiments`);
  console.log(`  Output:        ${RESULTS_FILE}`);
  console.log("═".repeat(70) + "\n");

  // Resume support
  const completedKeys = new Set<string>();
  if (fs.existsSync(RESULTS_FILE)) {
    const lines = fs.readFileSync(RESULTS_FILE, "utf-8").split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        completedKeys.add(`${r.networkSize}|${r.policy}|${r.attack}|${r.seed}`);
      } catch { /* ignore malformed line */ }
    }
    console.log(`  Resuming: ${completedKeys.size}/${total} already done\n`);
  }

  let completed = completedKeys.size;
  const startTime = Date.now();

  for (const networkSize of NETWORK_SIZES) {
    const seedFile = seedFileFor(networkSize);

    for (const policy of POLICIES) {
      for (const attack of ATTACKS) {
        for (const seed of SEEDS) {
          const key = `${networkSize}|${policy}|${attack}|${seed}`;
          if (completedKeys.has(key)) continue;

          console.log(`  ▶ N=${networkSize} | ${policy} vs ${attack} (seed=${seed})`);
          const start = Date.now();

          await cleanup();

          try {
            await runExperiment({
              ...DEFAULT_CONFIG,
              policy,
              attack,
              agents: networkSize,
              maliciousRatio: 0.3,
              seed,
              rounds: 60,
              jobsPerRound: 5,
              numBuyers: 5,
              propagationDelayRounds: networkSize >= 100 ? 2 : 1,
              realGraphSeedFile: seedFile,
            });

            const metrics = await collectMetrics();
            const duration = (Date.now() - start) / 1000;

            const result = {
              networkSize,
              policy,
              attack,
              seed,
              dataset: "bitcoin-otc",
              ...metrics,
              duration,
              timestamp: new Date().toISOString(),
            };
            fs.appendFileSync(RESULTS_FILE, JSON.stringify(result) + "\n", "utf-8");

            completed++;
            const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
            const eta = completed > 0
              ? (((Date.now() - startTime) / completed) * (total - completed) / 1000 / 60).toFixed(0)
              : "?";
            console.log(
              `    ✓ ${duration.toFixed(0)}s | fraud=${metrics.fraudExposure} | ` +
              `MR=${metrics.maliciousRoutingRate.toFixed(1)}% | ` +
              `${completed}/${total} | elapsed=${elapsed}m ETA=${eta}m\n`,
            );
          } catch (err) {
            const duration = (Date.now() - start) / 1000;
            console.error(`    ✗ FAILED (${duration.toFixed(0)}s): ${err}\n`);
            const failResult = {
              networkSize,
              policy,
              attack,
              seed,
              dataset: "bitcoin-otc",
              fraudExposure: -1,
              maliciousRoutingRate: -1,
              honestRoutingRate: -1,
              successRate: -1,
              totalJobs: 0,
              duration,
              error: true,
              errorMessage: String(err).slice(0, 500),
              timestamp: new Date().toISOString(),
            };
            fs.appendFileSync(RESULTS_FILE, JSON.stringify(failResult) + "\n", "utf-8");
            completed++;
          }

          await cleanup();
          if (typeof global.gc === "function") global.gc();
        }
      }
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log("\n" + "═".repeat(70));
  console.log(`  ✅ Done — ${completed}/${total} experiments in ${totalElapsed} minutes`);
  console.log(`  Results: ${RESULTS_FILE}`);
  console.log("═".repeat(70) + "\n");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
