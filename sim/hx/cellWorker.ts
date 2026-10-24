// Hypnexis patch (listed in patches.json): one simulation cell per process.
//
// Regimes (both mirror the author's workers; no routing/attack/graph logic changes):
//   centralized : scripts/_publicationMatrixWorker.ts contract (Table 1): one router,
//                 N agents, 60 rounds x 5 jobs, 5 buyers, propagation delay 2.
//   partitioned : the author's _partitionedViewWorker.ts contract (Table 9; that file is
//                 not in the public tree, ported from the author's SatsRouter copy):
//                 5 independent buyer sessions, sub-seed seed*100+s, 60 rounds x 1 job,
//                 1 buyer, no shared state between buyers; metrics summed over sessions.
//
// Usage: node --import tsx hx/cellWorker.ts <config.json>
// Env:   TRACE_DB_PATH (absolute; a fresh file is created per cell).
// Output: a single line "__RESULT__<json>" on stdout.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { initDb } from "./dbInit";

export type Regime = "centralized" | "partitioned";

export interface PolicySpec {
  label: string; // e.g. TRACE-full, TRACE-no-bandit, REPUTATION, EIGENTRUST, EB(5)
  policy: "TRACE" | "REPUTATION" | "PRICE" | "EIGENTRUST";
  ablation: Record<string, unknown> | null;
  eb?: { B: number } | null; // TRACE+EB(B), B as a fraction (0.05 = 5%)
}

export interface CellConfig {
  cellId: string;
  regime: Regime;
  policy: PolicySpec;
  attack: string; // resolved runner attack type (e.g. "game-theoretic-adversary")
  attackLabel: string; // X4 label (e.g. "game-theoretic")
  seed: number;
  networkSize: number;
  maliciousRatio: number;
  forceHxRunner?: boolean; // test only: run a non-EB policy through hx/runnerHx (no hook)
  sessions?: number[]; // partitioned only: which buyer sessions to run in this process (default 0-4)
}

interface RunMetrics {
  fraud: number;
  totalJobs: number;
  maliciousJobs: number;
  honestJobs: number;
  servedHonest: number;
  servedMalicious: number;
  failedJobs: number;
  jobsHash: string;
  eb?: Record<string, number> | null;
}

const SIM_ROOT = path.resolve(__dirname, "..");

async function main(): Promise<void> {
  const cfgPath = process.argv[2];
  if (!cfgPath) {
    console.error("usage: cellWorker <config.json>");
    process.exit(64);
  }
  const cfg: CellConfig = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));

  const dbPath = path.resolve(
    process.env.TRACE_DB_PATH ?? path.join(SIM_ROOT, ".work", `cell_${process.pid}.db`),
  );
  process.env.TRACE_DB_PATH = dbPath;
  // SIM_DB=memory: in-memory Prisma-subset store (hx/memPrisma.ts), installed through the
  // globalThis.prisma hook in src/lib/db.ts; default: Prisma 7 + better-sqlite3 file.
  const dbBackend = process.env.SIM_DB === "memory" ? "memory" : "prisma-sqlite";
  if (dbBackend === "memory") {
    const { installMemPrisma } = await import("./memPrisma");
    installMemPrisma();
  } else {
    initDb(dbPath);
  }

  // Imports happen after TRACE_DB_PATH is fixed (src/lib/db.ts reads it at load time).
  const { prisma } = await import("../src/lib/db");
  const { applyGhostModuleFlags } = await import("../src/lib/trace/config");
  const { runExperiment, DEFAULT_CONFIG } = await import("../src/lib/trace/experiments");

  // Publication_Preset ghost flags, exactly as both author workers do.
  applyGhostModuleFlags({ TEMPORAL_ENABLED: false, CAUSAL_ENABLED: false });

  // Durability-only SQLite settings for a throwaway per-cell file: they change how
  // writes reach the disk, never what any query returns (hx/test.ts and the
  // dev-cell check compare job-sequence hashes with and without them).
  if (process.env.SIM_FAST_SQLITE === "1") {
    await prisma.$queryRawUnsafe(`PRAGMA journal_mode = WAL`);
    await prisma.$executeRawUnsafe(`PRAGMA synchronous = OFF`);
    await prisma.$executeRawUnsafe(`PRAGMA temp_store = MEMORY`);
  }

  const quiet = process.env.SIM_VERBOSE !== "1";
  const realLog = console.log;
  if (quiet) console.log = () => {};

  let ebRun: ((c: any, hook: any) => Promise<string>) | null = null;
  let makeEbHook: ((B: number) => any) | null = null;
  if (cfg.policy.eb || cfg.forceHxRunner) {
    ({ runExperimentHx: ebRun } = await import("./runnerHx"));
    ({ makeEbHook } = await import("./ebPolicy"));
  }

  // The vendored REPUTATION and PRICE utilities add an unseeded Math.random() jitter
  // (traceRouter.ts computeReputationUtility / computePriceUtility). Seed it per run so
  // every reported cell is reproducible from its seed; the jitter law is unchanged.
  const mulberry32 = (a: number) => () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const runOnce = async (seed: number, rounds: number, jobsPerRound: number, numBuyers: number) => {
    Math.random = mulberry32((seed ^ 0x5eed5eed) >>> 0);
    const experimentConfig = {
      ...DEFAULT_CONFIG,
      policy: cfg.policy.policy as typeof DEFAULT_CONFIG.policy,
      attack: cfg.attack as typeof DEFAULT_CONFIG.attack,
      agents: cfg.networkSize,
      maliciousRatio: cfg.maliciousRatio,
      seed,
      rounds,
      jobsPerRound,
      numBuyers,
      propagationDelayRounds: cfg.networkSize >= 100 ? 2 : 1,
      traceAblation: (cfg.policy.ablation ?? undefined) as any,
    };
    if (cfg.policy.eb && ebRun && makeEbHook) {
      const hook = makeEbHook(cfg.policy.eb.B);
      await ebRun(experimentConfig, hook);
      return hook.stats() as Record<string, number>;
    }
    if (cfg.forceHxRunner && ebRun) {
      await ebRun(experimentConfig, undefined);
      return null;
    }
    await runExperiment(experimentConfig);
    return null;
  };

  const collect = async (ebStats: Record<string, number> | null): Promise<RunMetrics> => {
    // Same queries and definitions as scripts/_publicationMatrixWorker.ts.
    const maliciousProviders = await prisma.provider.findMany({
      where: { isActive: true, name: { contains: "[M]" } },
      select: { id: true },
    });
    const maliciousIds = new Set(maliciousProviders.map((p) => p.id));
    const allProviders = await prisma.provider.findMany({ where: { isActive: true }, select: { id: true } });
    const honestIds = new Set(allProviders.filter((p) => !maliciousIds.has(p.id)).map((p) => p.id));
    const jobs = await prisma.job.findMany({
      where: { buyerId: { startsWith: "experiment-buyer" } },
      select: { providerId: true, status: true, priceSats: true },
    });
    const malJobs = jobs.filter((j) => maliciousIds.has(j.providerId));
    const honJobs = jobs.filter((j) => honestIds.has(j.providerId));
    const fraud = malJobs.filter((j) => j.status === "failed").reduce((s, j) => s + j.priceSats, 0);
    // Insertion-ordered job sequence, for bit-for-bit equivalence tests.
    const seq: Array<{ providerId: string; status: string; priceSats: number }> = await prisma.$queryRawUnsafe(
      `SELECT providerId, status, priceSats FROM "Job" ORDER BY rowid`,
    );
    const jobsHash = createHash("sha256")
      .update(seq.map((j) => `${j.providerId}:${j.status}:${Number(j.priceSats)}`).join("|"))
      .digest("hex")
      .slice(0, 16);
    return {
      fraud,
      totalJobs: jobs.length,
      maliciousJobs: malJobs.length,
      honestJobs: honJobs.length,
      servedHonest: new Set(honJobs.map((j) => j.providerId)).size,
      servedMalicious: new Set(malJobs.map((j) => j.providerId)).size,
      failedJobs: jobs.filter((j) => j.status === "failed").length,
      jobsHash,
      eb: ebStats,
    };
  };

  const wipeAll = async () => {
    await prisma.routingDecision.deleteMany({});
    await prisma.job.deleteMany({});
    await prisma.trustEdge.deleteMany({});
    await prisma.economicEvent.deleteMany({});
    await prisma.scoreHistory.deleteMany({});
    await prisma.buyer.deleteMany({});
    await prisma.provider.deleteMany({});
  };

  const t0 = Date.now();
  const sessions: RunMetrics[] = [];
  if (cfg.regime === "centralized") {
    await wipeAll();
    const eb = await runOnce(cfg.seed, 60, 5, 5);
    sessions.push(await collect(eb));
  } else {
    const sessionList = cfg.sessions ?? [0, 1, 2, 3, 4];
    for (const s of sessionList) {
      if (s === sessionList[0]) {
        await wipeAll();
      } else {
        // As the author's worker: reset per-buyer job state. runExperiment then
        // re-creates providers and edges from the session sub-seed, so no state
        // is shared between buyers (paper section 7.3).
        await prisma.routingDecision.deleteMany({});
        await prisma.job.deleteMany({});
        await prisma.economicEvent.deleteMany({});
        await prisma.scoreHistory.deleteMany({});
        await prisma.provider.updateMany({
          data: { successfulJobs: 0, failedJobs: 0, totalJobs: 0, defaultProbability: 0.05, reputationScore: 5.0 },
        });
      }
      const eb = await runOnce(cfg.seed * 100 + s, 60, 1, 1);
      sessions.push(await collect(eb));
      if (typeof (globalThis as any).gc === "function") (globalThis as any).gc();
    }
  }
  const wallClockSec = (Date.now() - t0) / 1000;
  await prisma.$disconnect();
  if (quiet) console.log = realLog;

  const sum = (k: keyof RunMetrics) => sessions.reduce((a, r) => a + (r[k] as number), 0);
  const totalJobs = sum("totalJobs");
  const ebAgg: Record<string, number> | null = cfg.policy.eb
    ? sessions.reduce((acc, r) => {
        for (const [k, v] of Object.entries(r.eb ?? {})) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {} as Record<string, number>)
    : null;
  const ru = process.resourceUsage();
  const result = {
    cellId: cfg.cellId,
    regime: cfg.regime,
    policyLabel: cfg.policy.label,
    policy: cfg.policy.policy,
    ablation: cfg.policy.ablation,
    B: cfg.policy.eb ? cfg.policy.eb.B : null,
    attack: cfg.attackLabel,
    attackType: cfg.attack,
    seed: cfg.seed,
    networkSize: cfg.networkSize,
    maliciousRatio: cfg.maliciousRatio,
    fraud: sum("fraud"),
    maliciousRoutingRate: totalJobs > 0 ? sum("maliciousJobs") / totalJobs : 0,
    servedHonest: sum("servedHonest"),
    servedMalicious: sum("servedMalicious"),
    totalJobs,
    failedJobs: sum("failedJobs"),
    sessions: cfg.regime === "partitioned" ? cfg.sessions ?? [0, 1, 2, 3, 4] : null,
    perSession: sessions.map((r) => ({ fraud: r.fraud, totalJobs: r.totalJobs, servedHonest: r.servedHonest, servedMalicious: r.servedMalicious, maliciousJobs: r.maliciousJobs, failedJobs: r.failedJobs, jobsHash: r.jobsHash, eb: r.eb ?? null })),
    eb: ebAgg,
    wallClockSec,
    peakRssBytes: ru.maxRSS * 1024, // Node reports maxRSS in kilobytes on every platform
    nodeVersion: process.version,
    dbBackend,
  };
  process.stdout.write("__RESULT__" + JSON.stringify(result) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
