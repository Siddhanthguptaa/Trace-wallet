/**
 * Port equals fork on fixed inputs (BUILD.md M6 Done-when). The fork side is the unmodified
 * vendored code in sim/src/lib/trace, run by test/fork/oracle.ts in a child process (tsx, the
 * runtime sim/ itself uses). Skipped only if sim/ has no node_modules (then the port is untested
 * against the fork; the test says so).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import * as P from '../src/trace/port.ts';
import { fixture } from './fork/fixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SVC = resolve(HERE, '..');
const SIM = resolve(SVC, '..', '..', 'sim');
const simReady = existsSync(join(SIM, 'node_modules', '@prisma', 'client')) && existsSync(join(SIM, 'node_modules', 'better-sqlite3'));

type Oracle = Record<string, any>;
let fork: Oracle;

const near = (a: number, b: number) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(1e-12);
const nearMap = (port: Map<string, number>, forkObj: Record<string, number>) => {
  expect([...port.keys()].sort()).toEqual(Object.keys(forkObj).sort());
  for (const [k, v] of port) near(v, forkObj[k]!);
};
const asEdges = (xs: typeof fixture.graph.edges): P.Edge[] => xs.map((x) => ({ ...x, lastInteraction: 0 }));

describe.skipIf(!simReady)('TRACE port equals the vendored fork', () => {
  beforeAll(() => {
    const dir = join(tmpdir(), 'hx-attestor-oracle');
    mkdirSync(dir, { recursive: true });
    const fx = join(dir, `fixture_${process.pid}.json`);
    writeFileSync(fx, JSON.stringify(fixture));
    const tsxCli = join(SVC, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const r = spawnSync(process.execPath, [tsxCli, join(HERE, 'fork', 'oracle.ts'), fx, dir], {
      cwd: SVC,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      timeout: 120_000,
    });
    if (r.status !== 0) throw new Error(`oracle failed (${r.status}): ${r.stderr?.slice(-2000)}`);
    fork = JSON.parse(r.stdout) as Oracle;
  }, 150_000);

  it('Bayesian LCB, both CUSUMs, TRACE score, default probability, adaptive scaling', () => {
    fixture.lcbGrid.forEach(([s, f], i) => near(P.computeBayesianLCB(s, f), fork.lcb[i]));
    fixture.cusumSeqs.forEach((seq, i) => {
      let a = 0;
      let b = 0;
      seq.forEach((o, k) => {
        a = P.updateCUSUMScore(a, o).newScore;
        b = P.updateCUSUMSensitive(b, o).newScore;
        near(a, fork.cusum[i][k][0]);
        near(b, fork.cusum[i][k][1]);
      });
    });
    fixture.traceScoreInputs.forEach((inp, i) => near(P.computeTraceScore(inp).traceScore, fork.traceScore[i]));
    fixture.defaultProbInputs.forEach((inp, i) => near(P.computeDefaultProbability(inp), fork.defaultProb[i]));
    fixture.adaptiveN.forEach((n, i) => {
      const port = [
        P.computeScaleFactor(n),
        P.nonSaturatingPenaltyScale(n),
        P.computeRequiredEntropy(n),
        P.effectiveCliquePenalty(n),
        P.effectiveSybilPenalty(n),
        P.computeEntropyConfidence(n / 2, n),
        P.effectiveDecayConstant(n, 0.5),
        P.pprMaxIter(n),
        P.edgeWeightCapForN(n),
        P.computeEntropyConfidenceFloor(n),
      ];
      port.forEach((v, k) => near(v, fork.adaptive[i][k]));
    });
  });

  it('PPR, weighted and raw counterparty entropy, contamination, dense subgraph, spectral gap', () => {
    const g = fixture.graph;
    const cache = P.buildEdgeCache(asEdges(g.edges));
    nearMap(P.computePersonalizedPageRank(cache, new Set(g.seeds)), fork.ppr);
    for (const n of g.nodes) {
      near(P.computeWeightedEntropy(n, cache, new Map(Object.entries(g.trustMap))), fork.weightedEntropy[n]);
      expect(P.computeCounterpartyEntropy(n, cache)).toEqual(fork.entropy[n]);
    }
    nearMap(P.computeNeighborhoodContamination(cache, new Map(Object.entries(g.sybil))), fork.contamination);
    const adj = new Map<string, Set<string>>(g.nodes.map((n) => [n, new Set<string>()]));
    for (const x of g.edges) adj.get(x.source)!.add(x.target);
    nearMap(P.detectDenseSubgraphRisk(adj), fork.dense);
    fixture.spectral.forEach((s, i) => near(P.computeSpectralGap(s.scc, new Map(Object.entries(s.weights))), fork.spectral[i]));
  });

  it('updateTrustEdge sequences give the same edge rows', () => {
    fixture.edgeUpdates.forEach((seq, i) => {
      let edge: P.Edge | undefined;
      for (const u of seq) edge = P.updateTrustEdge(edge, 'a', 'b', u.amount, u.success, 0);
      const f = fork.edgeUpdates[i];
      expect(edge!.successfulCoJobs).toBe(f.successfulCoJobs);
      expect(edge!.economicVolume).toBe(f.economicVolume);
      near(edge!.escrowReliability, f.escrowReliability);
      near(edge!.weight, f.weight);
    });
  });

  it('Sybil risk (SCC, spectral, cycles, diversity, dense subgraph) and network trust match the DB pipelines', () => {
    fixture.sybilGraphs.forEach((sg, i) => {
      const edges = asEdges(sg.edges);
      nearMap(P.computeSybilRisk(sg.nodes, edges), fork.sybilGraphs[i].sybilRisk);
      // Fork edges were written "now"; the decay over a few ms is below round4.
      nearMap(P.computeAllNetworkTrust(sg.nodes, edges, 0), fork.sybilGraphs[i].networkTrust);
    });
    // The fixture must actually exercise the flag: the ring and the clique get flagged.
    expect(fork.sybilGraphs[0].sybilRisk.s1).toBeGreaterThan(0.5);
    expect(fork.sybilGraphs[1].sybilRisk.c1).toBeGreaterThan(0.15);
  });

  it("the runner's per-job event replay matches updateScoreAfterEvent (score, default risk, volatility, CUSUM)", () => {
    fixture.scoreCases.forEach((sc, i) => {
      const s = P.replayScore(
        sc.jobs.map((j) => ({ ...j, defaulted: false })),
        { networkTrust: sc.networkTrust, sybilRisk: sc.sybilRisk },
      );
      const f = fork.scoreCases[i];
      near(s.traceScore, f.traceScore);
      near(s.defaultProbability, f.defaultProbability);
      near(s.scoreVolatility, f.scoreVolatility);
      near(s.metrics.completionRate, f.completionRate);
      near(s.metrics.repaymentRate, f.repaymentRate);
      near(s.cusumScore, f.cusumScore);
      expect(s.metrics.totalJobs).toBe(f.totalJobs);
    });
  });
});
