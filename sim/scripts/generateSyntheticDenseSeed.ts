/**
 * scripts/generateSyntheticDenseSeed.ts
 *
 * Generates a synthetic seed JSON in the same shape as the Bitcoin OTC
 * loader produces, but with random edges rather than real ratings. Used to
 * test whether OTC's TRACE × game-theoretic fraud=0 result is driven by
 * (a) density alone — which this script tests — versus (b) something
 * specific to real-world signed-trust topology.
 *
 * Construction:
 *   - N nodes, default 1000.
 *   - Edge count matches OTC subgraph (default 18,472) for direct comparability.
 *   - Source/target chosen uniformly at random from 0..N-1, no self-loops,
 *     no parallel edges.
 *   - Per-edge `escrowReliability` sampled from the same Bernoulli mixture
 *     as OTC: 89.5% positive (reliability uniform in [0.5, 0.95]) and
 *     10.5% negative (reliability uniform in [0.05, 0.5]).
 *   - `successfulCoJobs`, `economicVolume`, `weight` use the same translation
 *     rule as the OTC loader, derived from a synthetic `rating` resampled
 *     from |rating| in [1, 10].
 *
 * Deterministic via --seed flag so the dense-seed JSON is reproducible.
 *
 * Output: data/real/synthetic-dense-seed-N{N}.json
 *
 * Usage:
 *   npx tsx scripts/generateSyntheticDenseSeed.ts --n 1000
 *   npx tsx scripts/generateSyntheticDenseSeed.ts --n 1000 --edges 18472 --seed 7
 */

import * as fs from "node:fs";
import * as path from "node:path";

function parseArgs(): { n: number; edges: number; seed: number } {
  const args = process.argv.slice(2);
  let n = 1000;
  let edges = 18472; // Match OTC subgraph density at N=1000
  let seed = 7;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" && args[i + 1]) n = parseInt(args[++i], 10);
    else if (args[i] === "--edges" && args[i + 1]) edges = parseInt(args[++i], 10);
    else if (args[i] === "--seed" && args[i + 1]) seed = parseInt(args[++i], 10);
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: npx tsx scripts/generateSyntheticDenseSeed.ts [--n N] [--edges E] [--seed S]");
      console.log("Defaults: --n 1000 --edges 18472 --seed 7");
      process.exit(0);
    }
  }
  if (!Number.isFinite(n) || n < 10) { console.error(`Invalid --n: ${n}`); process.exit(1); }
  if (!Number.isFinite(edges) || edges < 1) { console.error(`Invalid --edges: ${edges}`); process.exit(1); }
  return { n, edges, seed };
}

// LCG for reproducibility — same family as the runner's SeededRandom.
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

const EDGE_WEIGHT_CAP = 5.0;
const MIN_VOLUME = 20;
const POSITIVE_FRAC = 0.895; // OTC subgraph: 89.5% reliability >= 0.5

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

interface TranslatedEdge {
  sourceIdx: number; targetIdx: number;
  successfulCoJobs: number; escrowReliability: number;
  economicVolume: number; weight: number;
}

function generate(n: number, edgeCount: number, masterSeed: number): TranslatedEdge[] {
  const rand = mkRng(masterSeed);
  const seen = new Set<string>();
  const edges: TranslatedEdge[] = [];

  // Cap to avoid infinite loops if edgeCount approaches the directed-pair max.
  const maxPairs = n * (n - 1);
  const target = Math.min(edgeCount, maxPairs);

  let attempts = 0;
  const attemptCap = target * 50; // generous safety margin

  while (edges.length < target && attempts < attemptCap) {
    attempts++;
    const src = Math.floor(rand() * n);
    let tgt = Math.floor(rand() * n);
    if (src === tgt) continue;
    const key = `${src}->${tgt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Sample reliability from the OTC-matched mixture.
    const isPositive = rand() < POSITIVE_FRAC;
    const reliability = isPositive
      ? 0.5 + rand() * 0.45   // [0.50, 0.95]
      : 0.05 + rand() * 0.45; // [0.05, 0.50)
    const reliabilityClamped = clamp(reliability, 0.05, 0.95);

    // Synthesize an effective |rating| in [1, 10] consistent with reliability sign.
    const ratingMag = 1 + Math.floor(rand() * 10);

    // Apply the same translation rule the OTC loader uses, so density and
    // weight scales line up.
    const coJobs = Math.max(1, ratingMag);
    const volume = Math.max(MIN_VOLUME, ratingMag * 5);
    const frequencyFactor = Math.log2(1 + coJobs);
    const volumeFactor = 1 + Math.log10(1 + volume / 100);
    const weight = Math.min(frequencyFactor * volumeFactor * reliabilityClamped, EDGE_WEIGHT_CAP);

    edges.push({
      sourceIdx: src,
      targetIdx: tgt,
      successfulCoJobs: coJobs,
      escrowReliability: Math.round(reliabilityClamped * 10000) / 10000,
      economicVolume: volume,
      weight: Math.round(weight * 10000) / 10000,
    });
  }

  if (edges.length < target) {
    console.warn(`  ⚠ Generated ${edges.length}/${target} edges after ${attempts} attempts`);
  }
  return edges;
}

function main(): void {
  const { n, edges: edgeCount, seed } = parseArgs();
  console.log("═".repeat(60));
  console.log("  Synthetic dense-edge seed generator");
  console.log("═".repeat(60));
  console.log(`  Nodes (N)         : ${n}`);
  console.log(`  Target edges      : ${edgeCount.toLocaleString()}`);
  console.log(`  RNG seed          : ${seed}`);
  console.log(`  Reliability mix   : ${(POSITIVE_FRAC * 100).toFixed(1)}% positive (matches OTC)`);
  console.log("");

  const startedAt = Date.now();
  const translated = generate(n, edgeCount, seed);
  const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`  ✓ Generated ${translated.length.toLocaleString()} edges in ${dur}s`);

  let pos = 0; let neg = 0;
  for (const e of translated) (e.escrowReliability >= 0.5) ? pos++ : neg++;
  const density = ((translated.length / (n * (n - 1))) * 100).toFixed(3);

  console.log("");
  console.log(`  Density           : ${density}%`);
  console.log(`  Positive edges    : ${pos.toLocaleString()} (${((pos/translated.length)*100).toFixed(1)}%)`);
  console.log(`  Negative edges    : ${neg.toLocaleString()} (${((neg/translated.length)*100).toFixed(1)}%)`);

  const outFile = path.join(process.cwd(), "data", "real", `synthetic-dense-seed-N${n}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  fs.writeFileSync(outFile, JSON.stringify({
    datasetName: "synthetic-dense",
    datasetUrl: "generated",
    generatedAt: new Date().toISOString(),
    rngSeed: seed,
    targetEdgeCount: edgeCount,
    subsetNodeCount: n,
    subsetEdgeCount: translated.length,
    translation: {
      escrowReliability: "Bernoulli(0.895) → Uniform[0.5,0.95] else Uniform[0.05,0.5)",
      successfulCoJobs:  "Uniform{1..10}",
      economicVolume:    "max(20, ratingMag * 5)",
      weight:            "min(5.0, log2(1+coJobs) * (1+log10(1+volume/100)) * reliability)",
    },
    edges: translated,
  }, null, 2));
  console.log("");
  console.log(`  ✅ Wrote ${outFile}`);
}

main();
