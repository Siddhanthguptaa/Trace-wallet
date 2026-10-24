// Hypnexis M6 repro gate (X4 step 0).
// Cell: TRACE-no-bandit, strategic-default, seeds 42-51, N=1000, 30% malicious,
// 60 rounds x 5 jobs, 5 buyers, propagation delay 2 (the _publicationMatrixWorker contract).
// Paper: Table 1 reports 4.7 +/- 4.3 sats (the +/- is the std over 10 seeds; section 4.1
// text: "std 4.3 sats on a mean of 4.7"). Pass iff |mean - 4.7| <= 4.3.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPool, readJsonl } from "./pool";
import type { CellConfig } from "./cellWorker";

const SIM_ROOT = path.resolve(__dirname, "..");
const RES = path.join(SIM_ROOT, "results");
const CELLS = path.join(RES, "repro_cells.jsonl");
const OUT = path.join(RES, "repro_table1.json");
const TIMING = path.join(RES, "x4_timing.json");
const SEEDS = [42, 43, 44, 45, 46, 47, 48, 49, 50, 51];
const PAPER_MEAN = 4.7;
const PAPER_BAND = 4.3;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;

async function main() {
  const cells: CellConfig[] = SEEDS.map((seed) => ({
    cellId: `repro|centralized|TRACE-no-bandit|strategic-default|s${seed}`,
    regime: "centralized",
    policy: { label: "TRACE-no-bandit", policy: "TRACE", ablation: { disableThompsonSampling: true }, eb: null },
    attack: "strategic-default",
    attackLabel: "strategic-default",
    seed,
    networkSize: 1000,
    maliciousRatio: 0.3,
  }));
  const concurrency = Number(process.env.SIM_CONCURRENCY ?? 5);
  const summary = await runPool(cells, {
    concurrency,
    outJsonl: CELLS,
    errLog: path.join(RES, "repro_errors.log"),
    label: "repro",
  });
  const rows = readJsonl(CELLS).filter((r) => SEEDS.includes(r.seed) && r.policyLabel === "TRACE-no-bandit");
  const bySeed = new Map<number, any>();
  for (const r of rows) bySeed.set(r.seed, r);
  if (bySeed.size !== SEEDS.length) {
    throw new Error(`repro incomplete: ${bySeed.size}/${SEEDS.length} seeds (failed: ${summary.failed.join(",")})`);
  }
  const ordered = SEEDS.map((s) => bySeed.get(s));
  const fraud = ordered.map((r) => r.fraud);
  const m = mean(fraud);
  const s = sd(fraud);
  const pass = Math.abs(m - PAPER_MEAN) <= PAPER_BAND;
  const out = {
    mean: r3(m),
    sd: r3(s),
    paperMean: PAPER_MEAN,
    band: PAPER_BAND,
    pass,
    n: fraud.length,
    cell: "TRACE-no-bandit | strategic-default | centralized (Table 1 contract) | N=1000, 30% malicious, 60x5 jobs, 5 buyers, delay 2",
    seeds: SEEDS,
    perSeedFraud: fraud,
    meanMaliciousRoutingRate: r3(mean(ordered.map((r) => r.maliciousRoutingRate))),
    paperMaliciousRoutingRate: 0.303,
    meanServedHonest: r3(mean(ordered.map((r) => r.servedHonest))),
    rule: "pass iff |mean - paperMean| <= band; band = the +/- reported in Table 1 (std over 10 seeds)",
    source: "TRACE_CIKM2026_preprint.pdf (zenodo 22706499) Table 1 row TRACE-no-bandit, column Strategic-default: 4.7 +/- 4.3",
    fork: "github.com/NikunjKaushik20/Trace_CIKM @94c4b9f + patches.json",
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

  let timing: any = {};
  try { timing = JSON.parse(fs.readFileSync(TIMING, "utf-8")); } catch { /* new file */ }
  const secs = ordered.map((r) => r.wallClockSec);
  const rss = ordered.map((r) => r.peakRssBytes);
  timing.machine = {
    totalRamGB: r3(os.totalmem() / 1e9),
    logicalCpus: os.cpus().length,
    cpu: os.cpus()[0]?.model ?? "unknown",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  timing.centralizedRepro = {
    cells: ordered.length,
    secondsPerCell: { mean: r3(mean(secs)), min: r3(Math.min(...secs)), max: r3(Math.max(...secs)) },
    peakRssGBPerCell: { mean: r3(mean(rss) / 1e9), max: r3(Math.max(...rss) / 1e9) },
    poolWallClockSec: summary.ran > 0 ? r3(summary.wallClockSec) : timing.centralizedRepro?.poolWallClockSec ?? null,
    concurrency,
  };
  fs.writeFileSync(TIMING, JSON.stringify(timing, null, 2) + "\n");
  console.log(JSON.stringify({ mean: out.mean, sd: out.sd, paperMean: PAPER_MEAN, band: PAPER_BAND, pass }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
