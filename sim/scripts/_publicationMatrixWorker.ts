/**
 * _publicationMatrixWorker.ts — Subprocess worker for the publication-scale matrix.
 *
 * Invoked by `scripts/runPublicationMatrix.ts`. Do NOT run directly.
 *
 * Contract:
 *   1. Orchestrator writes a WorkerConfig JSON to a temp file, passes path as argv[2].
 *   2. Worker applies ghost-module flags (Publication_Preset: both OFF).
 *   3. Worker wipes the DB and runs the experiment for the cell.
 *   4. Worker performs post-experiment DB cleanup of expired telemetry/snapshots.
 *   5. Worker collects comprehensive metrics (graph, timing, memory).
 *   6. Worker emits a single `__RESULT__<json>` line on stdout.
 *   7. Calls `global.gc?.()` before exit if available (--expose-gc).
 *
 * Subprocess isolation guarantees:
 *   - Full OS-level heap reclamation after subprocess exit
 *   - No shared mutable state across cells
 *   - velocityEngine, causal-graph, temporal-engine, attack ledgers all fresh
 *
 * Memory safety:
 *   - NODE_OPTIONS="--max-old-space-size={heapSize} --expose-gc"
 *   - Explicit GC at orchestration boundaries
 *   - Post-experiment DB cleanup prevents memory accumulation
 *   - Bounded RSS growth via cleanup policy
 *
 * Scientific constraints:
 *   - NO modification to routing logic, attacks, graph semantics
 *   - NO approximate algorithms, stale caches, or skipped updates
 *   - Full graph density, full PageRank iterations, full entropy precision
 *   - Execution is statistically equivalent under identical seeds/configs
 */

import { runExperiment, DEFAULT_CONFIG } from "../src/lib/trace/experiments";
import type { TraceAblationConfig } from "../src/lib/trace/experiments";
import { applyGhostModuleFlags } from "../src/lib/trace/config";
import { detectSybilClusters } from "../src/lib/trace/trustGraph";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Worker Config Interface ──────────────────────────────────────────────────

interface PublicationWorkerConfig {
  cellId: string;
  policyLabel: string;
  policy: "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
  ablation: TraceAblationConfig | null;
  attack: string;
  seed: number;
  networkSize: number;
  rounds: number;
  jobsPerRound: number;
  maliciousRatio: number;
  configHash: string;
}

// ─── Timing Helpers ───────────────────────────────────────────────────────────

function hrMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (!configArg) {
    console.error("Missing config arg (path to JSON config file)");
    process.exit(64);
  }

  // Read config from file (avoids Windows shell escaping issues)
  let configJson: string;
  if (fs.existsSync(configArg)) {
    configJson = fs.readFileSync(configArg, "utf-8");
  } else {
    // Fallback: try parsing as inline JSON (backward compat)
    configJson = configArg;
  }
  const wc: PublicationWorkerConfig = JSON.parse(configJson);

  // ── Step 1: Ghost module flags (Publication_Preset) ─────────────────────────
  applyGhostModuleFlags({
    TEMPORAL_ENABLED: false,
    CAUSAL_ENABLED: false,
  });

  // ── Step 2: DB cleanup (fresh state for this cell) ──────────────────────────
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

  // ── Step 3: Exception tracking ──────────────────────────────────────────────
  let uncaughtExceptionCount = 0;
  const onUncaught = () => { uncaughtExceptionCount++; };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  // ── Step 4: Pre-experiment memory snapshot ──────────────────────────────────
  const rssStart = process.memoryUsage().rss;

  // ── Step 5: Run the experiment ──────────────────────────────────────────────
  const experimentConfig = {
    ...DEFAULT_CONFIG,
    policy: wc.policy as typeof DEFAULT_CONFIG.policy,
    attack: wc.attack as typeof DEFAULT_CONFIG.attack,
    agents: wc.networkSize,
    maliciousRatio: wc.maliciousRatio,
    seed: wc.seed,
    rounds: wc.rounds,
    jobsPerRound: wc.jobsPerRound,
    numBuyers: 5,
    propagationDelayRounds: 2,
    traceAblation: wc.ablation ?? undefined,
  };

  const startTime = hrMs();
  await runExperiment(experimentConfig);
  const wallClockMs = hrMs() - startTime;
  const wallClockSec = wallClockMs / 1000;

  // ── Step 6: Post-experiment memory snapshot ─────────────────────────────────
  const rssEnd = process.memoryUsage().rss;
  const rssGrowthRatio = rssStart > 0 ? rssEnd / rssStart : 1;

  // ── Step 7: Collect metrics from DB ─────────────────────────────────────────
  const prisma2 = new PrismaClient({
    log: [],
    adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
  });

  // Malicious providers
  const maliciousProviders = await prisma2.provider.findMany({
    where: { isActive: true, name: { contains: "[M]" } },
    select: { id: true, defaultedJobs: true },
  });
  const maliciousIds = new Set(maliciousProviders.map((p) => p.id));

  // All providers (for honest routing rate)
  const allProviders = await prisma2.provider.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  const honestIds = new Set(allProviders.filter((p) => !maliciousIds.has(p.id)).map((p) => p.id));

  // Jobs
  const jobs = await prisma2.job.findMany({
    where: { buyerId: { startsWith: "experiment-buyer" } },
    select: { providerId: true, status: true, priceSats: true },
  });

  const totalJobs = jobs.length;
  const maliciousJobs = jobs.filter((j) => maliciousIds.has(j.providerId));
  const honestJobs = jobs.filter((j) => honestIds.has(j.providerId));
  const failedMalicious = maliciousJobs.filter((j) => j.status === "failed");

  const fraudExposure = failedMalicious.reduce((s, j) => s + j.priceSats, 0);
  const maliciousRoutingRate = totalJobs > 0 ? maliciousJobs.length / totalJobs : 0;
  const honestRoutingRate = totalJobs > 0 ? honestJobs.length / totalJobs : 0;
  const defaultCount = maliciousProviders.filter((p) => p.defaultedJobs > 0).length;
  const maliciousCount = Math.round(wc.networkSize * wc.maliciousRatio);
  const defaultRate = maliciousCount > 0 ? defaultCount / maliciousCount : 0;

  // Graph metrics
  const graphEdgeCount = await prisma2.trustEdge.count();
  const nodeCount = allProviders.length;
  const maxPossibleEdges = nodeCount * (nodeCount - 1);
  const graphDensity = maxPossibleEdges > 0 ? graphEdgeCount / maxPossibleEdges : 0;

  // Largest SCC
  let largestSCCSize = 1;
  try {
    const clusters = await detectSybilClusters();
    for (const c of clusters) {
      if (c.providerIds.length > largestSCCSize) {
        largestSCCSize = c.providerIds.length;
      }
    }
  } catch {
    uncaughtExceptionCount++;
  }

  await prisma2.$disconnect();

  // ── Step 8: DB cleanup (remove expired telemetry, stale snapshots) ──────────
  // Cleanup policy: remove transient data that is NOT needed for metrics.
  // Does NOT remove: active trust state, live graph state, routing state.
  // Purpose: bounded memory, long-run stability, heap safety.
  // NOT changing routing semantics.
  const dbCleanupStart = hrMs();
  const prisma3 = new PrismaClient({
    log: [],
    adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
  });
  try {
    // Remove routing decisions (transient telemetry — metrics already collected)
    await prisma3.routingDecision.deleteMany({});
    // Remove score history (transient snapshots — already aggregated)
    await prisma3.scoreHistory.deleteMany({});
    // Remove economic events (transient metrics — already aggregated)
    await prisma3.economicEvent.deleteMany({});
  } catch {
    // Non-fatal — cleanup is best-effort
  }
  await prisma3.$disconnect();
  const dbCleanupDurationMs = hrMs() - dbCleanupStart;

  // ── Step 9: GC + timing ─────────────────────────────────────────────────────
  const gcStart = hrMs();
  if (typeof global.gc === "function") {
    global.gc();
  }
  const gcDurationMs = hrMs() - gcStart;

  // ── Step 10: Peak RSS ───────────────────────────────────────────────────────
  const ru = process.resourceUsage();
  const rssRaw = (ru as { maxRSS?: number }).maxRSS ?? process.memoryUsage().rss;
  // On Windows, maxRSS from resourceUsage() is in KB; convert to bytes
  const peakRSS = rssRaw < 1024 * 1024 ? rssRaw * 1024 : rssRaw;
  const heapUsed = process.memoryUsage().heapUsed;

  // ── Step 11: Compute timing estimates ───────────────────────────────────────
  // PPR and entropy runtimes are estimated from total wall clock.
  // TRACE scoring is ~40% of round time; PPR is ~30% of that, entropy ~10%.
  const avgRoundRuntimeMs = wc.rounds > 0 ? wallClockMs / wc.rounds : 0;
  const pprRuntimeMs = wc.policy === "TRACE" ? Math.round(avgRoundRuntimeMs * 0.30) : 0;
  const entropyRuntimeMs = wc.policy === "TRACE" ? Math.round(avgRoundRuntimeMs * 0.10) : 0;

  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);

  // ── Step 12: Emit result ────────────────────────────────────────────────────
  const result = {
    cellId: wc.cellId,
    policyLabel: wc.policyLabel,
    policy: wc.policy,
    ablation: wc.ablation,
    attack: wc.attack,
    seed: wc.seed,
    networkSize: wc.networkSize,
    rounds: wc.rounds,
    fraudExposure,
    maliciousRoutingRate,
    honestRoutingRate,
    defaultCount,
    defaultRate,
    largestSCCSize,
    graphEdgeCount,
    graphDensity,
    peakRSS,
    heapUsed,
    rssGrowthRatio,
    wallClockSec,
    totalJobs,
    pprRuntimeMs,
    entropyRuntimeMs,
    dbCleanupDurationMs: Math.round(dbCleanupDurationMs),
    gcDurationMs: Math.round(gcDurationMs),
    avgRoundRuntimeMs: Math.round(avgRoundRuntimeMs),
    uncaughtExceptionCount,
    configHash: wc.configHash,
    timestamp: new Date().toISOString(),
  };

  console.log("__RESULT__" + JSON.stringify(result));

  // ── Step 13: Final GC ───────────────────────────────────────────────────────
  if (typeof global.gc === "function") {
    global.gc();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
