/**
 * scripts/loadBitcoinOTC.ts
 *
 * Bitcoin OTC trust-network loader (Path C / Real-graph evaluation).
 *
 * Downloads the public Bitcoin OTC signed trust graph from SNAP, computes its
 * largest weakly-connected component (WCC), takes the N highest-degree nodes
 * as an induced subgraph, translates signed ratings into TRACE TrustEdge
 * fields, and writes a deterministic seed JSON consumed by the experiment
 * runner.
 *
 * Source:
 *   Stanford SNAP — Bitcoin OTC trust network
 *   https://snap.stanford.edu/data/soc-sign-bitcoin-otc.html
 *   Format: source,target,rating,time   (rating ∈ [-10, +10], integer)
 *
 * Translation (defaults agreed with paper plan):
 *   escrowReliability = clamp((rating + 10) / 20, 0.05, 0.95)
 *   successfulCoJobs  = ceil(|rating|)
 *   economicVolume    = max(20, |rating| × 5)         // ≥ minVolumeForFullWeight
 *   weight            = log2(1 + coJobs) × (1 + log10(1 + volume/100)) × reliability,
 *                       capped at 5.0 (matches TRUST_GRAPH_VALIDATION.edgeWeightCap)
 *
 * Output:
 *   data/real/bitcoin-otc-seed-N{N}.json
 *
 * Usage:
 *   npx tsx scripts/loadBitcoinOTC.ts                    # default N=1000
 *   npx tsx scripts/loadBitcoinOTC.ts --n 1000
 *   npx tsx scripts/loadBitcoinOTC.ts --n 500 --force    # force re-download
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import * as zlib from "node:zlib";

// ─── Configuration ────────────────────────────────────────────────────────────

const SNAP_URL = "https://snap.stanford.edu/data/soc-sign-bitcoinotc.csv.gz";
const DATA_DIR = path.join(process.cwd(), "data", "real");
const RAW_FILE = path.join(DATA_DIR, "soc-sign-bitcoinotc.csv.gz");
const CSV_FILE = path.join(DATA_DIR, "soc-sign-bitcoinotc.csv");

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(): { n: number; force: boolean } {
  const args = process.argv.slice(2);
  let n = 1000;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" && args[i + 1]) {
      n = parseInt(args[++i], 10);
    } else if (args[i] === "--force") {
      force = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "Usage: npx tsx scripts/loadBitcoinOTC.ts [--n N] [--force]\n" +
        "  --n N    Subset size (highest-degree induced subgraph). Default: 1000\n" +
        "  --force  Re-download even if cached file exists.\n"
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(n) || n < 10) {
    console.error(`Invalid --n value: ${n}`);
    process.exit(1);
  }
  return { n, force };
}

// ─── Step 1: Download ─────────────────────────────────────────────────────────

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        if (!next) {
          reject(new Error(`Redirect without Location header from ${url}`));
          return;
        }
        file.close();
        fs.unlinkSync(dest);
        download(next, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    req.on("error", (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      reject(err);
    });
  });
}

async function ensureCsv(force: boolean): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (force || !fs.existsSync(RAW_FILE)) {
    console.log(`  ↓ Downloading ${SNAP_URL}`);
    await download(SNAP_URL, RAW_FILE);
    const sz = fs.statSync(RAW_FILE).size;
    console.log(`  ✓ Downloaded ${sz.toLocaleString()} bytes -> ${RAW_FILE}`);
  } else {
    console.log(`  ✓ Using cached ${RAW_FILE}`);
  }

  if (force || !fs.existsSync(CSV_FILE)) {
    console.log(`  ↺ Decompressing -> ${CSV_FILE}`);
    const gz = fs.readFileSync(RAW_FILE);
    const csv = zlib.gunzipSync(gz);
    fs.writeFileSync(CSV_FILE, csv);
    console.log(`  ✓ Decompressed ${csv.length.toLocaleString()} bytes`);
  }
}

// ─── Step 2: Parse ────────────────────────────────────────────────────────────

interface RawEdge {
  source: number;
  target: number;
  rating: number;
}

function parseCsv(): RawEdge[] {
  const text = fs.readFileSync(CSV_FILE, "utf-8");
  const edges: RawEdge[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    if (parts.length < 3) continue;
    const s = parseInt(parts[0], 10);
    const t = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    if (!Number.isFinite(s) || !Number.isFinite(t) || !Number.isFinite(r)) continue;
    if (s === t) continue; // skip self-loops
    edges.push({ source: s, target: t, rating: r });
  }
  return edges;
}

// ─── Step 3: Largest WCC ──────────────────────────────────────────────────────

function largestWCC(nodes: Set<number>, edges: RawEdge[]): Set<number> {
  // Build undirected adjacency
  const adj = new Map<number, Set<number>>();
  for (const v of nodes) adj.set(v, new Set());
  for (const e of edges) {
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }

  let best = new Set<number>();
  const seen = new Set<number>();

  for (const start of nodes) {
    if (seen.has(start)) continue;
    const component = new Set<number>();
    const queue: number[] = [start];
    seen.add(start);
    while (queue.length > 0) {
      const v = queue.shift()!;
      component.add(v);
      for (const w of adj.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          queue.push(w);
        }
      }
    }
    if (component.size > best.size) best = component;
  }

  return best;
}

// ─── Step 4: Highest-degree induced subgraph ──────────────────────────────────

function highestDegreeSubset(nodes: Set<number>, edges: RawEdge[], n: number): Set<number> {
  const degree = new Map<number, number>();
  for (const v of nodes) degree.set(v, 0);
  for (const e of edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  if (nodes.size <= n) return new Set(nodes);

  // Sort descending by degree, tie-break by node id (deterministic)
  const sorted = [...degree.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] - b[0];
  });

  const subset = new Set<number>();
  for (const [v] of sorted) {
    subset.add(v);
    if (subset.size >= n) break;
  }
  return subset;
}

// ─── Step 5: Translation ──────────────────────────────────────────────────────

const EDGE_WEIGHT_CAP = 5.0;
const MIN_VOLUME = 20;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

interface TranslatedEdge {
  sourceIdx: number;
  targetIdx: number;
  successfulCoJobs: number;
  escrowReliability: number;
  economicVolume: number;
  weight: number;
}

function translate(
  edges: RawEdge[],
  nodeSet: Set<number>,
  idxMap: Map<number, number>,
): TranslatedEdge[] {
  // Aggregate parallel edges (rare in OTC but safe): sum |rating|, average reliability.
  const agg = new Map<string, { coJobs: number; reliabilitySum: number; reliabilityN: number; volume: number }>();

  for (const e of edges) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;

    const reliability = clamp((e.rating + 10) / 20, 0.05, 0.95);
    const coJobs = Math.max(1, Math.ceil(Math.abs(e.rating)));
    const volume = Math.max(MIN_VOLUME, Math.abs(e.rating) * 5);

    const key = `${e.source}->${e.target}`;
    const cur = agg.get(key);
    if (cur) {
      cur.coJobs += coJobs;
      cur.reliabilitySum += reliability;
      cur.reliabilityN += 1;
      cur.volume += volume;
    } else {
      agg.set(key, { coJobs, reliabilitySum: reliability, reliabilityN: 1, volume });
    }
  }

  const out: TranslatedEdge[] = [];
  for (const [key, v] of agg) {
    const [sStr, tStr] = key.split("->");
    const sIdx = idxMap.get(parseInt(sStr, 10))!;
    const tIdx = idxMap.get(parseInt(tStr, 10))!;
    const reliability = v.reliabilitySum / v.reliabilityN;
    const frequencyFactor = Math.log2(1 + v.coJobs);
    const volumeFactor = 1 + Math.log10(1 + v.volume / 100);
    const rawWeight = frequencyFactor * volumeFactor * reliability;
    const weight = Math.min(rawWeight, EDGE_WEIGHT_CAP);

    out.push({
      sourceIdx: sIdx,
      targetIdx: tIdx,
      successfulCoJobs: v.coJobs,
      escrowReliability: Math.round(reliability * 10000) / 10000,
      economicVolume: Math.round(v.volume),
      weight: Math.round(weight * 10000) / 10000,
    });
  }
  return out;
}

// ─── Step 6: Stats ────────────────────────────────────────────────────────────

function summarize(edges: TranslatedEdge[], nodeCount: number): void {
  const degree = new Array<number>(nodeCount).fill(0);
  let posReliability = 0;
  let negReliability = 0;
  for (const e of edges) {
    degree[e.sourceIdx]++;
    degree[e.targetIdx]++;
    if (e.escrowReliability >= 0.5) posReliability++; else negReliability++;
  }
  const sorted = [...degree].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  const min = sorted[0];
  const meanDeg = degree.reduce((a, b) => a + b, 0) / nodeCount;

  console.log("");
  console.log("  ── Subgraph statistics ─────────────────────────────────");
  console.log(`  Nodes              : ${nodeCount.toLocaleString()}`);
  console.log(`  Directed edges     : ${edges.length.toLocaleString()}`);
  console.log(`  Edge density       : ${((edges.length / (nodeCount * (nodeCount - 1))) * 100).toFixed(3)}%`);
  console.log(`  Degree (in+out)    : min=${min} median=${median} mean=${meanDeg.toFixed(1)} max=${max}`);
  console.log(`  Reliability ≥ 0.5  : ${posReliability.toLocaleString()} (${((posReliability / edges.length) * 100).toFixed(1)}%)`);
  console.log(`  Reliability < 0.5  : ${negReliability.toLocaleString()} (${((negReliability / edges.length) * 100).toFixed(1)}%)`);
  console.log("  ────────────────────────────────────────────────────────");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { n, force } = parseArgs();
  console.log("═".repeat(60));
  console.log("  Bitcoin OTC trust-network loader");
  console.log("═".repeat(60));
  console.log(`  Subset size (N)    : ${n}`);
  console.log(`  Force re-download  : ${force}`);
  console.log("");

  await ensureCsv(force);

  console.log(`  ↺ Parsing CSV`);
  const rawEdges = parseCsv();
  const allNodes = new Set<number>();
  for (const e of rawEdges) {
    allNodes.add(e.source);
    allNodes.add(e.target);
  }
  console.log(`  ✓ Parsed ${rawEdges.length.toLocaleString()} edges across ${allNodes.size.toLocaleString()} nodes`);

  console.log(`  ↺ Computing largest weakly-connected component`);
  const wcc = largestWCC(allNodes, rawEdges);
  console.log(`  ✓ WCC: ${wcc.size.toLocaleString()} nodes`);

  console.log(`  ↺ Selecting top-${n} highest-degree induced subgraph`);
  const subset = highestDegreeSubset(wcc, rawEdges, n);
  console.log(`  ✓ Subset: ${subset.size.toLocaleString()} nodes`);

  // Map original IDs -> contiguous indices [0..N-1], deterministic order
  const subsetSorted = [...subset].sort((a, b) => a - b);
  const idxMap = new Map<number, number>();
  subsetSorted.forEach((id, idx) => idxMap.set(id, idx));

  console.log(`  ↺ Translating ratings -> TrustEdge fields`);
  const translated = translate(rawEdges, subset, idxMap);
  console.log(`  ✓ Translated ${translated.length.toLocaleString()} directed edges`);

  summarize(translated, subset.size);

  const outFile = path.join(DATA_DIR, `bitcoin-otc-seed-N${subset.size}.json`);
  const payload = {
    datasetName: "bitcoin-otc",
    datasetUrl: SNAP_URL,
    generatedAt: new Date().toISOString(),
    originalNodeCount: allNodes.size,
    originalEdgeCount: rawEdges.length,
    wccNodeCount: wcc.size,
    subsetNodeCount: subset.size,
    subsetEdgeCount: translated.length,
    translation: {
      escrowReliability: "clamp((rating + 10) / 20, 0.05, 0.95)",
      successfulCoJobs:  "max(1, ceil(|rating|))",
      economicVolume:    "max(20, |rating| * 5)",
      weight:            "min(5.0, log2(1+coJobs) * (1+log10(1+volume/100)) * reliability)",
    },
    edges: translated,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log("");
  console.log(`  ✅ Wrote ${outFile}`);
  console.log(`     Pass to runner via realGraphSeedFile in ExperimentConfig.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
