/**
 * scripts/loadBitcoinAlpha.ts
 *
 * Bitcoin Alpha trust-network loader. Mirror of `loadBitcoinOTC.ts` with a
 * different SNAP URL. Used to test whether the OTC TRACE × game-theoretic
 * fraud=0 result generalizes to a second real-world signed-trust graph.
 *
 * Source:
 *   Stanford SNAP — Bitcoin Alpha trust network
 *   https://snap.stanford.edu/data/soc-sign-bitcoin-alpha.html
 *   Format: source,target,rating,time   (rating ∈ [-10, +10], integer)
 *   ~3,800 nodes, ~24,000 directed signed edges.
 *
 * Translation rules: identical to loadBitcoinOTC.ts so the two datasets are
 * directly comparable.
 *
 * Output:
 *   data/real/bitcoin-alpha-seed-N{N}.json
 *
 * Usage:
 *   npx tsx scripts/loadBitcoinAlpha.ts --n 1000
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import * as zlib from "node:zlib";

const SNAP_URL = "https://snap.stanford.edu/data/soc-sign-bitcoinalpha.csv.gz";
const DATA_DIR = path.join(process.cwd(), "data", "real");
const RAW_FILE = path.join(DATA_DIR, "soc-sign-bitcoinalpha.csv.gz");
const CSV_FILE = path.join(DATA_DIR, "soc-sign-bitcoinalpha.csv");

function parseArgs(): { n: number; force: boolean } {
  const args = process.argv.slice(2);
  let n = 1000;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" && args[i + 1]) n = parseInt(args[++i], 10);
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx scripts/loadBitcoinAlpha.ts [--n N] [--force]");
      process.exit(0);
    }
  }
  if (!Number.isFinite(n) || n < 10) {
    console.error(`Invalid --n value: ${n}`);
    process.exit(1);
  }
  return { n, force };
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        if (!next) { reject(new Error(`Redirect without Location from ${url}`)); return; }
        file.close();
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        download(next, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} fetching ${url}`)); return; }
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
    console.log(`  ✓ Downloaded ${fs.statSync(RAW_FILE).size.toLocaleString()} bytes`);
  } else {
    console.log(`  ✓ Using cached ${RAW_FILE}`);
  }
  if (force || !fs.existsSync(CSV_FILE)) {
    console.log(`  ↺ Decompressing -> ${CSV_FILE}`);
    fs.writeFileSync(CSV_FILE, zlib.gunzipSync(fs.readFileSync(RAW_FILE)));
  }
}

interface RawEdge { source: number; target: number; rating: number; }

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
    if (s === t) continue;
    edges.push({ source: s, target: t, rating: r });
  }
  return edges;
}

function largestWCC(nodes: Set<number>, edges: RawEdge[]): Set<number> {
  const adj = new Map<number, Set<number>>();
  for (const v of nodes) adj.set(v, new Set());
  for (const e of edges) { adj.get(e.source)!.add(e.target); adj.get(e.target)!.add(e.source); }
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
      for (const w of adj.get(v) ?? []) if (!seen.has(w)) { seen.add(w); queue.push(w); }
    }
    if (component.size > best.size) best = component;
  }
  return best;
}

function highestDegreeSubset(nodes: Set<number>, edges: RawEdge[], n: number): Set<number> {
  const degree = new Map<number, number>();
  for (const v of nodes) degree.set(v, 0);
  for (const e of edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  if (nodes.size <= n) return new Set(nodes);
  const sorted = [...degree.entries()].sort((a, b) => b[1] !== a[1] ? b[1] - a[1] : a[0] - b[0]);
  const subset = new Set<number>();
  for (const [v] of sorted) { subset.add(v); if (subset.size >= n) break; }
  return subset;
}

const EDGE_WEIGHT_CAP = 5.0;
const MIN_VOLUME = 20;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

interface TranslatedEdge {
  sourceIdx: number; targetIdx: number;
  successfulCoJobs: number; escrowReliability: number;
  economicVolume: number; weight: number;
}

function translate(edges: RawEdge[], nodeSet: Set<number>, idxMap: Map<number, number>): TranslatedEdge[] {
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
    const weight = Math.min(frequencyFactor * volumeFactor * reliability, EDGE_WEIGHT_CAP);
    out.push({
      sourceIdx: sIdx, targetIdx: tIdx,
      successfulCoJobs: v.coJobs,
      escrowReliability: Math.round(reliability * 10000) / 10000,
      economicVolume: Math.round(v.volume),
      weight: Math.round(weight * 10000) / 10000,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const { n, force } = parseArgs();
  console.log("═".repeat(60));
  console.log("  Bitcoin Alpha trust-network loader");
  console.log("═".repeat(60));
  console.log(`  Subset size (N): ${n}`);
  console.log("");

  await ensureCsv(force);

  console.log(`  ↺ Parsing CSV`);
  const rawEdges = parseCsv();
  const allNodes = new Set<number>();
  for (const e of rawEdges) { allNodes.add(e.source); allNodes.add(e.target); }
  console.log(`  ✓ ${rawEdges.length.toLocaleString()} edges across ${allNodes.size.toLocaleString()} nodes`);

  console.log(`  ↺ Largest WCC`);
  const wcc = largestWCC(allNodes, rawEdges);
  console.log(`  ✓ WCC: ${wcc.size.toLocaleString()} nodes`);

  console.log(`  ↺ Top-${n} highest-degree induced subgraph`);
  const subset = highestDegreeSubset(wcc, rawEdges, n);
  console.log(`  ✓ Subset: ${subset.size.toLocaleString()} nodes`);

  const subsetSorted = [...subset].sort((a, b) => a - b);
  const idxMap = new Map<number, number>();
  subsetSorted.forEach((id, idx) => idxMap.set(id, idx));

  console.log(`  ↺ Translating ratings -> TrustEdge fields`);
  const translated = translate(rawEdges, subset, idxMap);
  console.log(`  ✓ ${translated.length.toLocaleString()} directed edges`);

  const density = ((translated.length / (subset.size * (subset.size - 1))) * 100).toFixed(3);
  let pos = 0; let neg = 0;
  for (const e of translated) (e.escrowReliability >= 0.5) ? pos++ : neg++;
  console.log("");
  console.log(`  Edge density   : ${density}%`);
  console.log(`  Positive edges : ${pos.toLocaleString()} (${((pos/translated.length)*100).toFixed(1)}%)`);
  console.log(`  Negative edges : ${neg.toLocaleString()} (${((neg/translated.length)*100).toFixed(1)}%)`);

  const outFile = path.join(DATA_DIR, `bitcoin-alpha-seed-N${subset.size}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    datasetName: "bitcoin-alpha",
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
  }, null, 2));
  console.log("");
  console.log(`  ✅ Wrote ${outFile}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
