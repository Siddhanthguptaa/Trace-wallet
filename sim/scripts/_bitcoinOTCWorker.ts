/**
 * scripts/_bitcoinOTCWorker.ts
 *
 * Subprocess worker for the Bitcoin OTC matrix.
 *
 * Invoked by `scripts/runBitcoinOTCMatrix.ts`. Do NOT run directly.
 *
 * Contract:
 *   1. Parent serialises a WorkerConfig and passes the JSON file path as argv[2].
 *   2. Worker calls `applyGhostModuleFlags({ TEMPORAL_ENABLED: false,
 *      CAUSAL_ENABLED: false })` BEFORE any TRACE scoring runs (Publication_Preset).
 *   3. Worker wipes the DB, runs ONE cell with the OTC seed loaded, and emits a
 *      single `__RESULT__<json>` line on stdout.
 *   4. Worker exits, freeing all in-process state (PRNG ledgers, edge caches,
 *      temporal/causal engines). The parent's next cell starts fresh.
 *
 * Subprocess isolation makes per-cell memory bounded by design: every cell
 * begins with the same heap baseline, so growth across cells is impossible.
 */

import {
  runExperiment,
  DEFAULT_CONFIG,
} from "../src/lib/trace/experiments";
import { applyGhostModuleFlags } from "../src/lib/trace/config";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";

// ─── Worker Config Interface ──────────────────────────────────────────────────

export interface BitcoinOTCWorkerConfig {
  policy: "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
  attack: string;
  seed: number;
  networkSize: number;
  maliciousRatio: number;
  rounds: number;
  jobsPerRound: number;
  numBuyers: number;
  realGraphSeedFile: string;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (!configArg) {
    console.error("Missing config arg (path to JSON config file)");
    process.exit(64);
  }

  const wc: BitcoinOTCWorkerConfig = JSON.parse(
    fs.existsSync(configArg) ? fs.readFileSync(configArg, "utf-8") : configArg,
  );

  // Step 1 — Publication_Preset ghost-module flags (R-GHOST 4) BEFORE scoring runs.
  applyGhostModuleFlags({
    TEMPORAL_ENABLED: false,
    CAUSAL_ENABLED: false,
  });

  // Step 2 — DB cleanup.
  const dbPath = path.join(process.cwd(), "dev.db");
  const prisma = new PrismaClient({
    log: [],
    adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
  });
  try {
    await prisma.routingDecision.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.trustEdge.deleteMany({});
    await prisma.economicEvent.deleteMany({});
    await prisma.scoreHistory.deleteMany({});
    await prisma.buyer.deleteMany({});
    await prisma.provider.deleteMany({});
  } catch {
    // Tables may not exist on a fresh sqlite — proceed.
  }
  await prisma.$disconnect();

  // Step 3 — Run the cell.
  const startTime = Date.now();
  await runExperiment({
    ...DEFAULT_CONFIG,
    policy: wc.policy,
    attack: wc.attack as typeof DEFAULT_CONFIG.attack,
    agents: wc.networkSize,
    maliciousRatio: wc.maliciousRatio,
    seed: wc.seed,
    rounds: wc.rounds,
    jobsPerRound: wc.jobsPerRound,
    numBuyers: wc.numBuyers,
    propagationDelayRounds: wc.networkSize >= 100 ? 2 : 1,
    realGraphSeedFile: wc.realGraphSeedFile,
  });
  const wallClockSec = (Date.now() - startTime) / 1000;

  // Step 4 — Collect metrics from the DB (matches runBitcoinOTCTest.ts collectMetrics).
  const prisma2 = new PrismaClient({
    log: [],
    adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
  });

  const malicious = await prisma2.provider.findMany({
    where: { isActive: true, name: { contains: "[M]" } },
    select: { id: true },
  });
  const maliciousIds = new Set(malicious.map((p) => p.id));

  const jobs = await prisma2.job.findMany({
    where: { buyerId: { startsWith: "experiment-buyer" } },
    select: { providerId: true, status: true, priceSats: true },
  });

  const totalJobs = jobs.length;
  const malJobs = jobs.filter((j) => maliciousIds.has(j.providerId));
  const honJobs = jobs.filter((j) => !maliciousIds.has(j.providerId));
  const failedMal = malJobs.filter((j) => j.status === "failed");
  const successful = jobs.filter((j) => j.status === "completed");

  const fraudExposure = failedMal.reduce((s, j) => s + j.priceSats, 0);
  const maliciousRoutingRate = totalJobs > 0 ? (malJobs.length / totalJobs) * 100 : 0;
  const honestRoutingRate = totalJobs > 0 ? (honJobs.length / totalJobs) * 100 : 0;
  const successRate = totalJobs > 0 ? successful.length / totalJobs : 1;

  await prisma2.$disconnect();

  // Step 5 — Peak-RSS sample for telemetry.
  const ru = process.resourceUsage();
  const rssRaw = (ru as { maxRSS?: number }).maxRSS ?? process.memoryUsage().rss;
  const peakRSS = rssRaw < 1024 * 1024 ? rssRaw * 1024 : rssRaw;

  // Step 6 — Emit result. Same shape as runBitcoinOTCTest.ts so the JSONL is
  // append-compatible with whatever was already produced before the switch.
  const result = {
    networkSize: wc.networkSize,
    policy: wc.policy,
    attack: wc.attack,
    seed: wc.seed,
    dataset: "bitcoin-otc",
    fraudExposure,
    maliciousRoutingRate,
    honestRoutingRate,
    successRate,
    totalJobs,
    duration: wallClockSec,
    peakRSS,
    timestamp: new Date().toISOString(),
  };

  console.log("__RESULT__" + JSON.stringify(result));

  if (typeof global.gc === "function") global.gc();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
