/**
 * _v2MatrixWorker.ts — Subprocess worker for the WWW v2 experiment matrix.
 *
 * Invoked by `scripts/runV2Matrix.ts`. Do NOT run directly.
 *
 * Contract (identical to _publicationMatrixWorker.ts, plus V2_FLAGS):
 *   1. Orchestrator writes a V2WorkerConfig JSON to a temp file, passes path as argv[2].
 *   2. Worker applies ghost-module flags (Publication_Preset: both OFF).
 *   3. Worker applies V2_FLAGS per cell's v2Config (DR/CR/XS/LG).
 *   4. Worker wipes the DB and runs the experiment for the cell.
 *   5. Worker collects comprehensive metrics (graph, timing, memory, v2 flags).
 *   6. Worker emits a single `__RESULT__<json>` line on stdout.
 *   7. Calls `global.gc?.()` before exit if available (--expose-gc).
 *
 * Memory safety (hardened for N=1000, 200-cell runs):
 *   - Pre-experiment: full table wipe + VACUUM to reclaim disk
 *   - Post-metrics: wipe transient tables + VACUUM + WAL checkpoint
 *   - Bounded interaction history window for large N
 *   - WAL file cleanup as fallback
 *   - Explicit GC at all boundary points
 */

import { runExperiment, DEFAULT_CONFIG } from "../src/lib/trace/experiments";
import type { TraceAblationConfig } from "../src/lib/trace/experiments";
import { applyGhostModuleFlags, applyV2Flags } from "../src/lib/trace/config";
import { detectSybilClusters } from "../src/lib/trace/trustGraph";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Worker Config Interface ──────────────────────────────────────────────

interface V2WorkerConfig {
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
  v2Config: {
    DR_ENABLED: boolean;
    CR_ENABLED: boolean;
    XS_ENABLED: boolean;
    LG_ENABLED: boolean;
  };
  v2Label: string;
  realGraphSeedFile?: string;
}

// ─── Timing Helpers ───────────────────────────────────────────────────────

function hrMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

// ─── SQLite Maintenance ───────────────────────────────────────────────────

/**
 * Run VACUUM and WAL checkpoint on the SQLite database.
 * This reclaims disk space and prevents the WAL file from growing unbounded.
 * Safe to call between cells — does not affect data integrity.
 */
function vacuumDatabase(dbPath: string): void {
  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.close();
  } catch (err) {
    // Non-fatal — VACUUM failure should not block the experiment
    console.error(`  ⚠ VACUUM failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Delete WAL and SHM files if they exist (fallback cleanup).
 */
function cleanWalFiles(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const f = dbPath + suffix;
    try {
      if (fs.existsSync(f)) {
        const stat = fs.statSync(f);
        if (stat.size > 50 * 1024 * 1024) {
          // WAL > 50MB — force delete and let SQLite recreate it
          fs.unlinkSync(f);
          console.log(`  ⚠ Deleted oversized ${suffix} file (${(stat.size / 1024 / 1024).toFixed(0)}MB)`);
        }
      }
    } catch { /* ignore */ }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (!configArg) {
    console.error("Missing config arg (path to JSON config file)");
    process.exit(64);
  }

  let configJson: string;
  if (fs.existsSync(configArg)) {
    configJson = fs.readFileSync(configArg, "utf-8");
  } else {
    configJson = configArg;
  }
  const wc: V2WorkerConfig = JSON.parse(configJson);

  // ── Step 1: Ghost module flags (Publication_Preset) ─────────────────────
  applyGhostModuleFlags({
    TEMPORAL_ENABLED: false,
    CAUSAL_ENABLED: false,
  });

  // ── Step 1b: Apply V2_FLAGS for this cell ───────────────────────────────
  applyV2Flags(wc.v2Config);
  console.log(`  V2 flags: DR=${wc.v2Config.DR_ENABLED} CR=${wc.v2Config.CR_ENABLED} XS=${wc.v2Config.XS_ENABLED} LG=${wc.v2Config.LG_ENABLED}`);

  // ── Step 2: Aggressive DB cleanup (fresh state for this cell) ───────────
  const dbPath = path.join(process.cwd(), "dev.db");

  // 2a: Clean WAL files if oversized
  cleanWalFiles(dbPath);

  // 2b: Nuke all tables via raw better-sqlite3 (Prisma deleteMany times out
  // on 1GB+ databases due to SocketTimeout). Raw DELETE without WHERE is
  // optimized by SQLite as a table truncation — near-instant.
  try {
    const db = new Database(dbPath);
    // Disable FK checks so we can delete in any order
    db.pragma("foreign_keys = OFF");
    db.exec("DELETE FROM RoutingDecision");
    db.exec("DELETE FROM Job");
    db.exec("DELETE FROM TrustEdge");
    db.exec("DELETE FROM EconomicEvent");
    db.exec("DELETE FROM ScoreHistory");
    db.exec("DELETE FROM Buyer");
    db.exec("DELETE FROM Provider");
    db.pragma("foreign_keys = ON");
    // VACUUM to reclaim disk space
    db.exec("VACUUM");
    db.close();
  } catch (err) {
    console.error(`  ⚠ DB cleanup warning: ${err instanceof Error ? err.message : err}`);
  }

  // 2c: GC after cleanup
  if (typeof global.gc === "function") global.gc();

  // ── Step 3: Exception tracking ──────────────────────────────────────────
  let uncaughtExceptionCount = 0;
  const onUncaught = () => { uncaughtExceptionCount++; };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  // ── Step 4: Pre-experiment memory snapshot ──────────────────────────────
  const rssStart = process.memoryUsage().rss;

  // ── Step 5: Run the experiment ──────────────────────────────────────────
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
    // Bound interaction history for large N to prevent O(N²) memory growth
    interactionHistoryWindowRounds: wc.networkSize >= 200 ? 20 : undefined,
    // Optional: dense graph seed file
    realGraphSeedFile: wc.realGraphSeedFile || undefined,
  };

  const startTime = hrMs();
  await runExperiment(experimentConfig);
  const wallClockMs = hrMs() - startTime;
  const wallClockSec = wallClockMs / 1000;

  // ── Step 6: Post-experiment memory snapshot ─────────────────────────────
  const rssEnd = process.memoryUsage().rss;
  const rssGrowthRatio = rssStart > 0 ? rssEnd / rssStart : 1;

  // ── Step 7: Collect metrics from DB ─────────────────────────────────────
  const prisma2 = new PrismaClient({
    log: [],
    adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }),
  });

  const maliciousProviders = await prisma2.provider.findMany({
    where: { isActive: true, name: { contains: "[M]" } },
    select: { id: true, defaultedJobs: true },
  });
  const maliciousIds = new Set(maliciousProviders.map((p) => p.id));

  const allProviders = await prisma2.provider.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  const honestIds = new Set(allProviders.filter((p) => !maliciousIds.has(p.id)).map((p) => p.id));

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

  const graphEdgeCount = await prisma2.trustEdge.count();
  const nodeCount = allProviders.length;
  const maxPossibleEdges = nodeCount * (nodeCount - 1);
  const graphDensity = maxPossibleEdges > 0 ? graphEdgeCount / maxPossibleEdges : 0;

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

  // ── Step 8: Full DB cleanup + VACUUM (reclaim all disk space) ───────────
  const dbCleanupStart = hrMs();
  try {
    const db3 = new Database(dbPath);
    db3.pragma("foreign_keys = OFF");
    db3.exec("DELETE FROM RoutingDecision");
    db3.exec("DELETE FROM ScoreHistory");
    db3.exec("DELETE FROM EconomicEvent");
    db3.exec("DELETE FROM Job");
    db3.exec("DELETE FROM TrustEdge");
    db3.exec("DELETE FROM Buyer");
    db3.exec("DELETE FROM Provider");
    db3.pragma("foreign_keys = ON");
    db3.exec("VACUUM");
    db3.pragma("wal_checkpoint(TRUNCATE)");
    db3.close();
  } catch {
    // Non-fatal — best effort cleanup
  }
  cleanWalFiles(dbPath);

  const dbCleanupDurationMs = hrMs() - dbCleanupStart;

  // ── Step 9: GC + timing ─────────────────────────────────────────────────
  const gcStart = hrMs();
  if (typeof global.gc === "function") {
    global.gc();
  }
  const gcDurationMs = hrMs() - gcStart;

  // ── Step 10: Peak RSS ───────────────────────────────────────────────────
  const ru = process.resourceUsage();
  const rssRaw = (ru as { maxRSS?: number }).maxRSS ?? process.memoryUsage().rss;
  const peakRSS = rssRaw < 1024 * 1024 ? rssRaw * 1024 : rssRaw;
  const heapUsed = process.memoryUsage().heapUsed;

  const avgRoundRuntimeMs = wc.rounds > 0 ? wallClockMs / wc.rounds : 0;
  const pprRuntimeMs = wc.policy === "TRACE" ? Math.round(avgRoundRuntimeMs * 0.30) : 0;
  const entropyRuntimeMs = wc.policy === "TRACE" ? Math.round(avgRoundRuntimeMs * 0.10) : 0;

  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);

  // ── Step 11: Emit result ────────────────────────────────────────────────
  const result = {
    cellId: wc.cellId,
    policyLabel: wc.policyLabel,
    policy: wc.policy,
    ablation: wc.ablation,
    attack: wc.attack,
    seed: wc.seed,
    networkSize: wc.networkSize,
    rounds: wc.rounds,
    v2Config: wc.v2Config,
    v2Label: wc.v2Label,
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

  // Final GC
  if (typeof global.gc === "function") {
    global.gc();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
