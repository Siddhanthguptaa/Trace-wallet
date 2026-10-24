/**
 * Fork oracle: runs the UNMODIFIED vendored Trace_CIKM code in sim/src/lib/trace on a fixture and
 * prints its outputs as JSON. Used by test/port.test.ts to check the attestor's port.
 *
 *   tsx test/fork/oracle.ts <fixture.json> <scratch-dir>
 *
 * Pure functions are called directly. DB-bound pipelines (updateTrustEdge, updateSybilRiskScores,
 * computeAllNetworkTrustWithMeta, updateScoreAfterEvent) run against a fresh SQLite file built
 * from sim/prisma/init.sql, exactly as sim/hx/dbInit.ts does. Read-only use of sim/.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM = resolve(HERE, '..', '..', '..', '..', 'sim');
const TRACE = join(SIM, 'src', 'lib', 'trace');
const imp = (rel: string) => import(new URL(`file:///${join(TRACE, rel).replace(/\\/g, '/')}`).href);

interface EdgeIn {
  source: string;
  target: string;
  successfulCoJobs: number;
  economicVolume: number;
  weight: number;
  escrowReliability: number;
}
interface Fixture {
  lcbGrid: Array<[number, number]>;
  cusumSeqs: Array<Array<0 | 1>>;
  traceScoreInputs: Array<Record<string, number>>;
  defaultProbInputs: Array<Record<string, number>>;
  adaptiveN: number[];
  graph: { nodes: string[]; edges: EdgeIn[]; seeds: string[]; trustMap: Record<string, number>; sybil: Record<string, number> };
  spectral: Array<{ scc: string[]; weights: Record<string, number> }>;
  sybilGraphs: Array<{ nodes: string[]; edges: EdgeIn[] }>;
  edgeUpdates: Array<Array<{ amount: number; success: boolean }>>;
  scoreCases: Array<{ jobs: Array<{ success: boolean; price: number; round: number }>; networkTrust: number; sybilRisk: number }>;
}

const [fixturePath, scratch] = process.argv.slice(2);
if (!fixturePath || !scratch) throw new Error('usage: oracle.ts <fixture.json> <scratch-dir>');
const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

mkdirSync(scratch, { recursive: true });
const dbPath = join(scratch, `oracle_${process.pid}.db`);
for (const s of ['', '-journal', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
const simRequire = createRequire(join(SIM, 'package.json'));
const Database = simRequire('better-sqlite3');
{
  const db = new Database(dbPath);
  db.exec(readFileSync(join(SIM, 'prisma', 'init.sql'), 'utf8'));
  db.close();
}
process.env.TRACE_DB_PATH = dbPath;

const ts = await imp('traceScore.ts');
const tg = await imp('trustGraph.ts');
const ac = await imp('adaptiveConfig.ts');
const { prisma } = await import(new URL(`file:///${join(SIM, 'src', 'lib', 'db.ts').replace(/\\/g, '/')}`).href);

const toObj = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort());
function edgeCache(edges: EdgeIn[]) {
  const bySource = new Map<string, unknown[]>();
  const byTarget = new Map<string, unknown[]>();
  for (const e of edges) {
    const f = { successfulCoJobs: e.successfulCoJobs, economicVolume: e.economicVolume, weight: e.weight, escrowReliability: e.escrowReliability };
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source)!.push({ targetProviderId: e.target, ...f });
    if (!byTarget.has(e.target)) byTarget.set(e.target, []);
    byTarget.get(e.target)!.push({ sourceProviderId: e.source, ...f });
  }
  return { bySource, byTarget };
}
function adjOf(nodes: string[], edges: EdgeIn[]) {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n, new Set());
  for (const e of edges) adj.get(e.source)?.add(e.target);
  return adj;
}

async function resetDb() {
  await prisma.economicEvent.deleteMany();
  await prisma.scoreHistory.deleteMany();
  await prisma.job.deleteMany();
  await prisma.trustEdge.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.buyer.deleteMany();
}
async function makeProviders(ids: string[]) {
  for (const id of ids) {
    await prisma.provider.create({ data: { id, name: id, description: '', capability: 'x', priceSats: 10, endpointUrl: '' } });
  }
}

const out: Record<string, unknown> = {};
out.lcb = fx.lcbGrid.map(([s, f]) => ts.computeBayesianLCB(s, f));
out.cusum = fx.cusumSeqs.map((seq) => {
  let a = 0;
  let b = 0;
  const trace: Array<[number, number]> = [];
  for (const o of seq) {
    a = ts.updateCUSUMScore(a, o).newScore;
    b = ts.updateCUSUMSensitive(b, o).newScore;
    trace.push([a, b]);
  }
  return trace;
});
out.traceScore = fx.traceScoreInputs.map((i) => ts.computeTraceScore(i).traceScore);
out.defaultProb = fx.defaultProbInputs.map((i) => ts.computeDefaultProbability(i));
out.adaptive = fx.adaptiveN.map((n) => [
  ac.computeScaleFactor(n),
  ac.nonSaturatingPenaltyScale(n),
  ac.computeRequiredEntropy(n),
  ac.effectiveCliquePenalty(n),
  ac.effectiveSybilPenalty(n),
  ac.computeEntropyConfidence(n / 2, n),
  ac.effectiveDecayConstant(n, 0.5),
  ac.pprMaxIter(n),
  ac.edgeWeightCap(n),
  ac.computeEntropyConfidenceFloor(n),
]);

const g = fx.graph;
const cache = edgeCache(g.edges);
out.ppr = toObj(tg.computePersonalizedPageRank(cache, new Set(g.seeds)));
out.weightedEntropy = Object.fromEntries(g.nodes.map((n) => [n, tg.computeWeightedEntropy(n, cache, new Map(Object.entries(g.trustMap)))]));
out.entropy = Object.fromEntries(await Promise.all(g.nodes.map(async (n) => [n, await tg.computeCounterpartyEntropy(n, cache)])));
out.contamination = toObj(tg.computeNeighborhoodContamination(cache, new Map(Object.entries(g.sybil))));
out.dense = toObj(tg.detectDenseSubgraphRisk(adjOf(g.nodes, g.edges)));
out.spectral = fx.spectral.map((s) => tg.computeSpectralGap(s.scc, new Map(Object.entries(s.weights))));

// DB-bound: updateTrustEdge sequences (pair a->b).
out.edgeUpdates = [];
for (const seq of fx.edgeUpdates) {
  await resetDb();
  await makeProviders(['a', 'b']);
  for (const u of seq) await tg.updateTrustEdge('a', 'b', u.amount, u.success);
  const e = await prisma.trustEdge.findFirst({ where: { sourceProviderId: 'a', targetProviderId: 'b' } });
  (out.edgeUpdates as unknown[]).push({ successfulCoJobs: e.successfulCoJobs, economicVolume: e.economicVolume, escrowReliability: e.escrowReliability, weight: e.weight });
}

// DB-bound: updateSybilRiskScores + computeAllNetworkTrustWithMeta.
out.sybilGraphs = [];
for (const sg of fx.sybilGraphs) {
  await resetDb();
  await makeProviders(sg.nodes);
  const now = new Date();
  for (const e of sg.edges) {
    await prisma.trustEdge.create({
      data: {
        sourceProviderId: e.source,
        targetProviderId: e.target,
        successfulCoJobs: e.successfulCoJobs,
        economicVolume: e.economicVolume,
        escrowReliability: e.escrowReliability,
        weight: e.weight,
        lastInteraction: now,
      },
    });
  }
  await tg.updateSybilRiskScores();
  const rows = await prisma.provider.findMany({ select: { id: true, sybilRisk: true } });
  const nt = await tg.computeAllNetworkTrustWithMeta();
  (out.sybilGraphs as unknown[]).push({
    sybilRisk: Object.fromEntries(rows.map((r: { id: string; sybilRisk: number }) => [r.id, r.sybilRisk]).sort()),
    networkTrust: toObj(nt.trust),
  });
}

// DB-bound: the runner's per-job event sequence through updateScoreAfterEvent.
out.scoreCases = [];
for (const sc of fx.scoreCases) {
  await resetDb();
  await makeProviders(['p']);
  await prisma.buyer.create({ data: { id: 'buyer', name: 'buyer' } });
  await prisma.provider.update({ where: { id: 'p' }, data: { networkTrust: sc.networkTrust, sybilRisk: sc.sybilRisk } });
  let k = 0;
  for (const j of sc.jobs) {
    const job = await prisma.job.create({
      data: {
        buyerId: 'buyer',
        providerId: 'p',
        capability: 'x',
        inputHash: `h${k++}`,
        input: JSON.stringify({ simulated: true, round: j.round, job: k }),
        status: j.success ? 'completed' : 'failed',
        priceSats: j.price,
        escrowStatus: j.success ? 'released' : 'refunded',
      },
    });
    if (j.success) {
      await ts.updateScoreAfterEvent('p', 'JOB_SUCCESS', job.id, j.price);
      await ts.updateScoreAfterEvent('p', 'PAYMENT_SETTLED', job.id, j.price);
    } else {
      await ts.updateScoreAfterEvent('p', 'JOB_FAILURE', job.id, j.price);
      await ts.updateScoreAfterEvent('p', 'DEFAULT', job.id, j.price);
    }
    // ScoreHistory orders by createdAt; keep rows 2 ms apart so "last 10" is well defined.
    await new Promise((r) => setTimeout(r, 2));
  }
  const p = await prisma.provider.findUnique({ where: { id: 'p' } });
  (out.scoreCases as unknown[]).push({
    traceScore: p.traceScore,
    defaultProbability: p.defaultProbability,
    scoreVolatility: p.scoreVolatility,
    completionRate: p.completionRate,
    repaymentRate: p.repaymentRate,
    cusumScore: p.cusumScore,
    totalJobs: p.totalJobs,
  });
}

await prisma.$disconnect();
for (const s of ['', '-journal', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.stdout.write(JSON.stringify(out));
