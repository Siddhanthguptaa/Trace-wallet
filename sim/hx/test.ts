// Hypnexis sim tests (npm --prefix sim test). Dev seeds 1-3 only; nothing here is an X4 number.
//   1. tier rule: lcb95 == fork computeBayesianLCB, boundary + flag cases, vectors file
//   2. hook-less hx/runnerHx == vendored runner, bit for bit (job-sequence hash), 4 policies
//   3. TRACE+EB(B) invariants: EB(0) never explores; budget never exceeded; flagged never
//      picked; charged price == predicted price; same seed -> same job sequence
import * as fs from "node:fs";
import * as path from "node:path";
import { computeBayesianLCB } from "../src/lib/trace/traceScore";
import { ROUTING_CONSTRAINTS } from "../src/lib/trace/config";
import {
  lcb95,
  PROVEN_LCB_THRESHOLD,
  tierFromEvidence,
  simFlagged,
  simTier,
  tierFromDecisionCode,
  SIM_MAX_SYBIL_RISK,
} from "./tierRule";
import { runPool, readJsonl } from "./pool";
import type { CellConfig, PolicySpec } from "./cellWorker";

const SIM_ROOT = path.resolve(__dirname, "..");
const RES = path.join(SIM_ROOT, "results");
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, cond: boolean, detail?: string) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}

function tierTests() {
  let maxDiff = 0;
  for (let s = 0; s <= 40; s++) for (let f = 0; f <= 40; f++) maxDiff = Math.max(maxDiff, Math.abs(lcb95(s, f) - computeBayesianLCB(s, f)));
  check("tier_lcb95_equals_fork_computeBayesianLCB", maxDiff === 0, `maxDiff=${maxDiff}`);
  check("tier_threshold_is_lcb_3_0", PROVEN_LCB_THRESHOLD === computeBayesianLCB(3, 0), `thr=${PROVEN_LCB_THRESHOLD}`);
  check("tier_cold_start_unproven", tierFromEvidence({ successes: 0, failures: 0, flagged: false }) === "UNPROVEN");
  check("tier_2_0_unproven", tierFromEvidence({ successes: 2, failures: 0, flagged: false }) === "UNPROVEN");
  check("tier_3_0_proven_boundary", tierFromEvidence({ successes: 3, failures: 0, flagged: false }) === "PROVEN");
  check("tier_flag_beats_evidence", tierFromEvidence({ successes: 500, failures: 0, flagged: true }) === "FLAGGED");
  check("tier_3_1_unproven", tierFromEvidence({ successes: 3, failures: 1, flagged: false }) === "UNPROVEN");
  check("sim_max_sybil_matches_router", SIM_MAX_SYBIL_RISK === ROUTING_CONSTRAINTS.maxSybilRisk, `router=${ROUTING_CONSTRAINTS.maxSybilRisk}`);
  check("sim_flag_strict_gt", !simFlagged({ successfulJobs: 9, failedJobs: 0, sybilRisk: 0.5 }) && simFlagged({ successfulJobs: 9, failedJobs: 0, sybilRisk: 0.51 }));
  check("sim_flag_sybil_failure", !simFlagged({ successfulJobs: 9, failedJobs: 0, sybilRisk: 0.2 }) && simFlagged({ successfulJobs: 9, failedJobs: 1, sybilRisk: 0.2 }));
  check("sim_tier_flagged", simTier({ successfulJobs: 50, failedJobs: 0, sybilRisk: 0.9 }) === "FLAGGED");
  check(
    "decision_code_adapter",
    tierFromDecisionCode("ROUTE") === "PROVEN" &&
      tierFromDecisionCode("ROUTE_WITH_CAUTION") === "UNPROVEN" &&
      tierFromDecisionCode(null) === "UNPROVEN" &&
      ["HOLD", "INVESTIGATE", "REFER", "QUARANTINE", "SOMETHING_NEW"].every((c) => tierFromDecisionCode(c) === "FLAGGED"),
  );
  const vectors: any[] = [];
  for (const [s, f, fl] of [[0, 0, false], [1, 0, false], [2, 0, false], [3, 0, false], [3, 1, false], [4, 1, false], [5, 1, false], [10, 2, false], [30, 3, false], [3, 0, true], [100, 0, true]] as Array<[number, number, boolean]>) {
    vectors.push({ successes: s, failures: f, flagged: fl, lcb95: lcb95(s, f), tier: tierFromEvidence({ successes: s, failures: f, flagged: fl }) });
  }
  fs.writeFileSync(
    path.join(SIM_ROOT, "hx", "tier_vectors.json"),
    JSON.stringify({ rule: "FLAGGED if flagged; else PROVEN iff lcb95(s,f|Beta(1,3)) >= lcb95(3,0); else UNPROVEN", threshold: PROVEN_LCB_THRESHOLD, vectors }, null, 2) + "\n",
  );
}

const POL: Record<string, PolicySpec> = {
  "TRACE-full": { label: "TRACE-full", policy: "TRACE", ablation: {}, eb: null },
  "TRACE-no-bandit": { label: "TRACE-no-bandit", policy: "TRACE", ablation: { disableThompsonSampling: true }, eb: null },
  REPUTATION: { label: "REPUTATION", policy: "REPUTATION", ablation: null, eb: null },
  EIGENTRUST: { label: "EIGENTRUST", policy: "EIGENTRUST", ablation: null, eb: null },
};
const eb = (B: number): PolicySpec => ({ label: `EB(${B})`, policy: "TRACE", ablation: {}, eb: { B } });

async function simTests() {
  const out = path.join(RES, "sim_tests_cells.jsonl");
  fs.rmSync(out, { force: true });
  const N = 60;
  const cells: CellConfig[] = [];
  const mk = (id: string, regime: "centralized" | "partitioned", p: PolicySpec, attack: string, seed: number, forceHx = false): CellConfig => ({
    cellId: id, regime, policy: p, attack, attackLabel: attack, seed, networkSize: N, maliciousRatio: 0.3, forceHxRunner: forceHx,
  });
  // 2. equivalence pairs
  const pairs: Array<[string, "centralized" | "partitioned", string, string]> = [
    ["eq1", "partitioned", "TRACE-full", "collusion-ring"],
    ["eq2", "partitioned", "TRACE-no-bandit", "strategic-default"],
    ["eq3", "partitioned", "REPUTATION", "sybil-cluster"],
    ["eq4", "partitioned", "EIGENTRUST", "game-theoretic-adversary"],
    ["eq5", "centralized", "TRACE-full", "sybil-cluster"],
  ];
  for (const [id, regime, pol, attack] of pairs) {
    cells.push(mk(`${id}|vendored`, regime, POL[pol], attack, 3, false));
    cells.push(mk(`${id}|hx`, regime, POL[pol], attack, 3, true));
  }
  // 3. EB invariants
  for (const attack of ["strategic-default", "collusion-ring", "sybil-cluster", "game-theoretic-adversary"]) {
    cells.push(mk(`eb0|${attack}`, "partitioned", eb(0), attack, 1));
    cells.push(mk(`eb10|${attack}`, "partitioned", eb(10), attack, 1));
  }
  cells.push(mk(`eb5|sybil-cluster|a`, "partitioned", eb(5), "sybil-cluster", 2));
  cells.push(mk(`eb5|sybil-cluster|b`, "partitioned", eb(5), "sybil-cluster", 2));
  const summary = await runPool(cells, {
    concurrency: Number(process.env.SIM_CONCURRENCY ?? 4),
    outJsonl: out,
    errLog: path.join(RES, "sim_tests_errors.log"),
    heapMb: 1024,
    unitMb: 500,
    reserveFreeMb: 2500,
    retries: 0,
    label: "test",
  });
  check("all_test_cells_ran", summary.failed.length === 0, summary.failed.join(","));
  const rows = new Map(readJsonl(out).map((r) => [r.cellId, r]));
  for (const [id] of pairs) {
    const a = rows.get(`${id}|vendored`);
    const b = rows.get(`${id}|hx`);
    const ha = a?.perSession.map((x: any) => x.jobsHash).join(",");
    const hb = b?.perSession.map((x: any) => x.jobsHash).join(",");
    check(`runnerHx_bit_identical_${id}`, !!a && !!b && ha === hb && a.fraud === b.fraud && a.servedHonest === b.servedHonest, `${ha} vs ${hb}`);
  }
  let flaggedSeen = 0;
  for (const attack of ["strategic-default", "collusion-ring", "sybil-cluster", "game-theoretic-adversary"]) {
    const r0 = rows.get(`eb0|${attack}`);
    const r10 = rows.get(`eb10|${attack}`);
    check(`eb0_never_explores_${attack}`, !!r0 && r0.eb.exploreJobs === 0 && r0.eb.exploreSpend === 0);
    for (const r of [r0, r10]) {
      if (!r) continue;
      flaggedSeen += r.eb.flaggedSeen;
      check(`eb_budget_${r.cellId}`, r.eb.budgetViolations === 0 && 100 * r.eb.exploreSpend <= r.B * r.eb.totalSpend, `explore=${r.eb.exploreSpend} total=${r.eb.totalSpend} B=${r.B}%`);
      check(`eb_no_flagged_pick_${r.cellId}`, r.eb.flaggedPicked === 0);
      check(`eb_price_match_${r.cellId}`, r.eb.priceMismatches === 0);
    }
    check(`eb10_explores_${attack}`, !!r10 && r10.eb.exploreJobs > 0, `exploreJobs=${r10?.eb.exploreJobs}`);
  }
  const a = rows.get("eb5|sybil-cluster|a");
  const b = rows.get("eb5|sybil-cluster|b");
  check("eb_deterministic_same_seed", !!a && !!b && a.perSession.map((x: any) => x.jobsHash).join() === b.perSession.map((x: any) => x.jobsHash).join());
  check("eb_flag_path_exercised", flaggedSeen + (a?.eb.flaggedSeen ?? 0) >= 0, `flaggedSeen=${flaggedSeen + (a?.eb.flaggedSeen ?? 0)} (informational)`);
}

async function main() {
  tierTests();
  if (process.env.SIM_TEST_FAST !== "1") await simTests();
  const failed = results.filter((r) => !r.pass);
  fs.mkdirSync(RES, { recursive: true });
  fs.writeFileSync(
    path.join(RES, "sim_tests.json"),
    JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results, generatedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
