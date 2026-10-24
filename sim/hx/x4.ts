// Hypnexis M8: X4 pre-registered sweep, partitioned regime only (FASTPLAN cut 4).
// 4 attacks x 9 policies (EB(0,1,2,5,10)% + TRACE-full, TRACE-no-bandit, REPUTATION,
// EigenTrust) x seeds 42-51 = 360 cells. N=1000, 30% malicious.
//
// Each cell = 5 buyer sessions; each session runs in its own process (unit), because the
// author's single-process worker leaks module state (e.g. scoreVelocity history) from one
// buyer session into the next and grows past 1.5 GB of heap by session 4; one process per
// buyer is exactly the paper's "no shared state between buyers" (section 7.3).
//
// Resumable at two levels: units already in x4_sessions.jsonl are skipped by the pool, and
// cells already in x4_cells.jsonl are skipped entirely. A cell row is appended as soon as
// its 5 sessions exist. Dev seeds 1-3 never appear here.
//
// Env: SIM_CONCURRENCY (cap, default 6), SIM_UNIT_MB (default 950), SIM_RESERVE_FREE_MB
// (default 3000: never launch if free RAM would fall below this; other lanes need it).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPool, readJsonl } from "./pool";
import type { CellConfig, PolicySpec } from "./cellWorker";

const SIM_ROOT = path.resolve(__dirname, "..");
const RES = path.join(SIM_ROOT, "results");
const UNITS = path.join(RES, "x4_sessions.jsonl");
const CELLS = path.join(RES, "x4_cells.jsonl");
const TIMING = path.join(RES, "x4_timing.json");

export const X4_SEEDS = [42, 43, 44, 45, 46, 47, 48, 49, 50, 51];
export const X4_ATTACKS: Array<{ label: string; type: string }> = [
  { label: "strategic-default", type: "strategic-default" },
  { label: "collusion-ring", type: "collusion-ring" },
  { label: "sybil-cluster", type: "sybil-cluster" },
  { label: "game-theoretic", type: "game-theoretic-adversary" },
];
export const X4_B = [0, 1, 2, 5, 10];
export const X4_POLICIES: PolicySpec[] = [
  ...X4_B.map((B) => ({ label: `EB(${B})`, policy: "TRACE" as const, ablation: {}, eb: { B } })),
  { label: "TRACE-full", policy: "TRACE", ablation: {}, eb: null },
  { label: "TRACE-no-bandit", policy: "TRACE", ablation: { disableThompsonSampling: true }, eb: null },
  { label: "REPUTATION", policy: "REPUTATION", ablation: null, eb: null },
  { label: "EIGENTRUST", policy: "EIGENTRUST", ablation: null, eb: null },
];
const SESSIONS = [0, 1, 2, 3, 4];

const cellIdOf = (pol: string, attack: string, seed: number) => `x4|partitioned|${pol}|${attack}|s${seed}`;

function aggregate(cellId: string, units: any[]): any {
  const u = [...units].sort((a, b) => a.sessions[0] - b.sessions[0]);
  const first = u[0];
  const sum = (k: string) => u.reduce((a, r) => a + r[k], 0);
  const totalJobs = sum("totalJobs");
  const malJobs = u.reduce((a, r) => a + r.perSession[0].maliciousJobs, 0);
  let eb: Record<string, number> | null = null;
  if (first.eb) {
    eb = {};
    for (const r of u) for (const [k, v] of Object.entries(r.eb as Record<string, number>)) eb[k] = (eb[k] ?? 0) + v;
  }
  return {
    cellId,
    regime: "partitioned",
    policyLabel: first.policyLabel,
    policy: first.policy,
    ablation: first.ablation,
    B: first.B,
    attack: first.attack,
    attackType: first.attackType,
    seed: Number(cellId.split("|s").pop()),
    networkSize: first.networkSize,
    maliciousRatio: first.maliciousRatio,
    fraud: sum("fraud"),
    maliciousRoutingRate: totalJobs > 0 ? malJobs / totalJobs : 0,
    servedHonest: sum("servedHonest"),
    servedMalicious: sum("servedMalicious"),
    totalJobs,
    failedJobs: sum("failedJobs"),
    perSession: u.map((r) => ({ session: r.sessions[0], ...r.perSession[0] })),
    eb,
    wallClockSec: Math.round(sum("wallClockSec") * 1000) / 1000,
    peakRssBytes: Math.max(...u.map((r) => r.peakRssBytes)),
    nodeVersion: first.nodeVersion,
  };
}

async function main() {
  fs.mkdirSync(RES, { recursive: true });
  const doneCells = new Set(readJsonl(CELLS).map((r) => r.cellId));
  const unitsByCell = new Map<string, any[]>();
  const addUnit = (r: any) => {
    const cellId = r.cellId.replace(/\|b\d$/, "");
    const list = unitsByCell.get(cellId) ?? [];
    if (!list.some((x) => x.sessions[0] === r.sessions[0])) list.push(r);
    unitsByCell.set(cellId, list);
    if (list.length === SESSIONS.length && !doneCells.has(cellId)) {
      fs.appendFileSync(CELLS, JSON.stringify(aggregate(cellId, list)) + "\n");
      doneCells.add(cellId);
    }
  };
  for (const r of readJsonl(UNITS)) addUnit(r);

  const units: CellConfig[] = [];
  for (const seed of X4_SEEDS)
    for (const a of X4_ATTACKS)
      for (const p of X4_POLICIES) {
        const cellId = cellIdOf(p.label, a.label, seed);
        if (doneCells.has(cellId)) continue;
        for (const s of SESSIONS) {
          units.push({
            cellId: `${cellId}|b${s}`,
            regime: "partitioned",
            policy: p,
            attack: a.type,
            attackLabel: a.label,
            seed,
            networkSize: 1000,
            maliciousRatio: 0.3,
            sessions: [s],
          });
        }
      }
  const totalCells = X4_SEEDS.length * X4_ATTACKS.length * X4_POLICIES.length;
  console.log(`[x4] ${doneCells.size}/${totalCells} cells done; ${units.length} session units queued`);

  // DB backend: the in-memory store only if hx/memCheck.ts proved it bit-identical to
  // Prisma + SQLite (results/mem_check.json pass); otherwise Prisma. SIM_DB overrides.
  if (!process.env.SIM_DB) {
    let memOk = false;
    try { memOk = JSON.parse(fs.readFileSync(path.join(RES, "mem_check.json"), "utf-8")).pass === true; } catch { /* none */ }
    process.env.SIM_DB = memOk ? "memory" : "prisma";
  }
  const memory = process.env.SIM_DB === "memory";
  console.log(`[x4] db backend: ${memory ? "memory (validated)" : "prisma-sqlite"}`);
  const concurrency = Number(process.env.SIM_CONCURRENCY ?? 6);
  const summary = await runPool(units, {
    concurrency,
    outJsonl: UNITS,
    errLog: path.join(RES, "x4_errors.log"),
    heapMb: 768,
    retryHeapMb: 1536,
    unitMb: Number(process.env.SIM_UNIT_MB ?? (memory ? 350 : 950)),
    rampMs: memory ? 2500 : 8000,
    reserveFreeMb: Number(process.env.SIM_RESERVE_FREE_MB ?? 3000),
    retries: 2,
    label: "x4",
    onResult: addUnit,
  });

  const cells = readJsonl(CELLS);
  const allUnits = readJsonl(UNITS);
  let timing: any = {};
  try { timing = JSON.parse(fs.readFileSync(TIMING, "utf-8")); } catch { /* new */ }
  const secs = allUnits.map((r) => r.wallClockSec);
  const rss = allUnits.map((r) => r.peakRssBytes);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  timing.partitionedSweep = {
    cells: cells.length,
    sessionUnits: allUnits.length,
    unitDesign: "one process per buyer session (5 per cell), heap 768 MB",
    unitsByBackend: allUnits.reduce((acc: Record<string, number>, r) => { const k = r.dbBackend ?? "prisma-sqlite"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    byBackend: Object.fromEntries(
      [...new Set(allUnits.map((r) => r.dbBackend ?? "prisma-sqlite"))].map((k) => {
        const u = allUnits.filter((r) => (r.dbBackend ?? "prisma-sqlite") === k);
        const ss = u.map((r) => r.wallClockSec);
        const rr = u.map((r) => r.peakRssBytes);
        return [k, { units: u.length, meanSec: r3(ss.reduce((a, b) => a + b, 0) / ss.length), meanRssGB: r3(rr.reduce((a, b) => a + b, 0) / rr.length / 1e9), maxRssGB: r3(Math.max(...rr) / 1e9) }];
      }),
    ),
    secondsPerSessionUnit: secs.length ? { mean: r3(secs.reduce((a, b) => a + b, 0) / secs.length), max: r3(Math.max(...secs)) } : null,
    peakRssGBPerSessionUnit: rss.length ? { mean: r3(rss.reduce((a, b) => a + b, 0) / rss.length / 1e9), max: r3(Math.max(...rss) / 1e9) } : null,
    lastRun: summary.ran === 0 && timing.partitionedSweep?.lastRun ? timing.partitionedSweep.lastRun : {
      ran: summary.ran,
      skipped: summary.skipped,
      failed: summary.failed,
      wallClockSec: r3(summary.wallClockSec),
      concurrencyCap: concurrency,
      maxObservedConcurrent: summary.maxObservedConcurrent,
      minFreeMbObserved: summary.minFreeMbObserved,
      reserveFreeMb: Number(process.env.SIM_RESERVE_FREE_MB ?? 3000),
      totalRamGB: r3(os.totalmem() / 1e9),
      finishedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(TIMING, JSON.stringify(timing, null, 2) + "\n");
  console.log(`[x4] cells=${cells.length}/${totalCells} failedUnits=${summary.failed.length}`);
  if (cells.length !== totalCells) process.exit(2);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
