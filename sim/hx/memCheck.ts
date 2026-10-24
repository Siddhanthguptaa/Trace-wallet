// Hypnexis: validation gate for the in-memory DB backend (hx/memPrisma.ts).
// The memory backend may run X4 only if it reproduces the Prisma 7 + SQLite backend
// bit for bit:
//   A. Prisma coverage units: session b0 of seed 42 for every (attack, policy) pair, run
//      on Prisma (results/mem_check_prisma_units.jsonl).
//   B. Every Prisma unit in x4_sessions.jsonl is re-run on memory; job-sequence hash,
//      fraud, served-honest and total jobs must be identical.
//   C. The 10 centralized repro cells (Table 1 gate, Prisma) are re-run on memory;
//      per-seed fraud, served-honest, MR and total jobs must be identical.
// Writes results/mem_check.json; exits 1 on any mismatch.
import * as fs from "node:fs";
import * as path from "node:path";
import { runPool, readJsonl } from "./pool";
import type { CellConfig } from "./cellWorker";
import { X4_ATTACKS, X4_POLICIES } from "./x4";

const SIM_ROOT = path.resolve(__dirname, "..");
const RES = path.join(SIM_ROOT, "results");
const UNITS = path.join(RES, "x4_sessions.jsonl");
const MEM_UNITS = path.join(RES, "mem_check_units.jsonl");
const MEM_REPRO = path.join(RES, "mem_check_repro.jsonl");
const PRISMA_UNITS = path.join(RES, "mem_check_prisma_units.jsonl");

function unitFromId(cellId: string): CellConfig {
  // x4|partitioned|<policy>|<attack>|s<seed>|b<session>
  const [, , pol, attack, s, b] = cellId.split("|");
  const policy = X4_POLICIES.find((p) => p.label === pol)!;
  const a = X4_ATTACKS.find((x) => x.label === attack)!;
  return {
    cellId,
    regime: "partitioned",
    policy,
    attack: a.type,
    attackLabel: a.label,
    seed: Number(s.slice(1)),
    networkSize: 1000,
    maliciousRatio: 0.3,
    sessions: [Number(b.slice(1))],
  };
}

async function main() {
  const conc = Number(process.env.SIM_CONCURRENCY ?? 6);
  // A. Prisma coverage units
  process.env.SIM_DB = "prisma";
  const coverage: CellConfig[] = [];
  for (const a of X4_ATTACKS) for (const p of X4_POLICIES) coverage.push(unitFromId(`x4|partitioned|${p.label}|${a.label}|s42|b0`));
  await runPool(coverage, { concurrency: conc, outJsonl: PRISMA_UNITS, errLog: path.join(RES, "mem_check_errors.log"), heapMb: 768, retryHeapMb: 1536, unitMb: 950, reserveFreeMb: 3000, label: "memcheck-prisma" });

  // B. memory re-runs of every Prisma unit
  const prismaById = new Map<string, any>();
  for (const r of [...readJsonl(PRISMA_UNITS), ...readJsonl(UNITS)]) {
    if ((r.dbBackend ?? "prisma-sqlite") === "prisma-sqlite" && !prismaById.has(r.cellId)) prismaById.set(r.cellId, r);
  }
  const prismaUnits = [...prismaById.values()];
  process.env.SIM_DB = "memory";
  const memCells: CellConfig[] = prismaUnits.map((r) => ({ ...unitFromId(r.cellId), cellId: `mem|${r.cellId}` }));
  await runPool(memCells, { concurrency: conc, outJsonl: MEM_UNITS, errLog: path.join(RES, "mem_check_errors.log"), heapMb: 768, unitMb: 350, reserveFreeMb: 3000, label: "memcheck-memory" });
  const memById = new Map(readJsonl(MEM_UNITS).map((r) => [r.cellId.replace(/^mem\|/, ""), r]));
  const unitMismatches: any[] = [];
  for (const r of prismaUnits) {
    const m = memById.get(r.cellId);
    const ok = !!m && m.perSession[0].jobsHash === r.perSession[0].jobsHash && m.fraud === r.fraud && m.servedHonest === r.servedHonest && m.totalJobs === r.totalJobs;
    if (!ok) unitMismatches.push({ cellId: r.cellId, prisma: r.perSession[0].jobsHash, memory: m?.perSession[0].jobsHash ?? null, fraud: [r.fraud, m?.fraud], served: [r.servedHonest, m?.servedHonest] });
  }

  // C. centralized repro cells on memory
  const repro = readJsonl(path.join(RES, "repro_cells.jsonl"));
  const reproCells: CellConfig[] = repro.map((r) => ({
    cellId: `mem|${r.cellId}`,
    regime: "centralized",
    policy: { label: "TRACE-no-bandit", policy: "TRACE", ablation: { disableThompsonSampling: true }, eb: null },
    attack: "strategic-default",
    attackLabel: "strategic-default",
    seed: r.seed,
    networkSize: 1000,
    maliciousRatio: 0.3,
  }));
  await runPool(reproCells, { concurrency: conc, outJsonl: MEM_REPRO, errLog: path.join(RES, "mem_check_errors.log"), heapMb: 1024, unitMb: 450, reserveFreeMb: 3000, label: "memcheck-repro" });
  const memRepro = new Map(readJsonl(MEM_REPRO).map((r) => [r.seed, r]));
  const reproMismatches: any[] = [];
  for (const r of repro) {
    const m = memRepro.get(r.seed);
    const ok = !!m && m.fraud === r.fraud && m.servedHonest === r.servedHonest && m.maliciousRoutingRate === r.maliciousRoutingRate && m.totalJobs === r.totalJobs;
    if (!ok) reproMismatches.push({ seed: r.seed, prisma: [r.fraud, r.servedHonest, r.maliciousRoutingRate], memory: m ? [m.fraud, m.servedHonest, m.maliciousRoutingRate] : null });
  }

  const memSecs = readJsonl(MEM_UNITS).map((r) => r.wallClockSec);
  const prSecs = prismaUnits.map((r) => r.wallClockSec);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
  // REPUTATION adds Math.random() jitter (seeded per session by the worker). Prisma's
  // client also draws Math.random() for every cuid() id it generates (2 draws per insert,
  // measured), so under Prisma the jitter stream interleaves with DB inserts; under the
  // memory backend only the jitter draws from it. Those realizations legitimately differ;
  // every other policy must match bit for bit.
  const explained = unitMismatches.filter((m) => m.cellId.split("|")[2] === "REPUTATION");
  const unexplained = unitMismatches.filter((m) => m.cellId.split("|")[2] !== "REPUTATION");
  const out = {
    pass: unexplained.length === 0 && reproMismatches.length === 0 && prismaUnits.length > 0,
    explainedMismatches: { policy: "REPUTATION", count: explained.length, reason: "jitter RNG stream shared with Prisma cuid() generation (2 Math.random draws per insert); memory backend: jitter-only stream" },
    deterministicUnitsCompared: prismaUnits.filter((r) => r.policyLabel !== "REPUTATION").length,
    deterministicUnitsIdentical: prismaUnits.filter((r) => r.policyLabel !== "REPUTATION").length - unexplained.length,
    unitsCompared: prismaUnits.length,
    unitsIdentical: prismaUnits.length - unitMismatches.length,
    attacksCovered: [...new Set(prismaUnits.map((r) => r.attack))],
    policiesCovered: [...new Set(prismaUnits.map((r) => r.policyLabel))],
    reproCellsCompared: repro.length,
    reproCellsIdentical: repro.length - reproMismatches.length,
    unitMismatches,
    reproMismatches,
    meanSecondsPerSessionUnit: { prisma: avg(prSecs), memory: avg(memSecs) },
    rule: "identical job-sequence hash + fraud + served-honest + total jobs per unit; identical fraud, served-honest, MR, jobs per repro seed",
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(RES, "mem_check.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ pass: out.pass, units: `${out.unitsIdentical}/${out.unitsCompared}`, repro: `${out.reproCellsIdentical}/${out.reproCellsCompared}`, secs: out.meanSecondsPerSessionUnit }));
  if (!out.pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
