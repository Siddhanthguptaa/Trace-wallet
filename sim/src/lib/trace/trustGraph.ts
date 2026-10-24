/**
 * TRACE v2.9 Trust Graph Engine — Dense Subgraph Detection + Advanced Fraud Suppression
 *
 * v2.9 additions (CRITICAL COLLUSION FIX):
 *   - Dense subgraph detection: catches mesh topologies via local clustering coefficient
 *   - Behavioral anomaly detection: flags "too-good-to-be-true" patterns
 *   - Failure clustering detection: tracks temporal clustering of failures
 *   - Cross-agent failure correlation: detects coordinated fraud patterns
 *
 * v2.2 additions:
 *   - Maturity-aware repeated-pair decay: k_eff = k × maturityFactor
 *   - Confidence-gated diversity scoring
 *   - Causal-aware trust persistence
 *
 * v2.1 features (maintained):
 *   - Counterparty entropy: H = -Σ pᵢ·log₂(pᵢ) per provider
 *   - Repeated-pair suppression: trust gain *= exp(-count/k)
 *   - Economic volume weighting: tiny transactions give less trust
 *   - Diversity-adjusted trust: AdjustedTrust = networkTrust × diversityScore
 *   - Loop suspicion score integrated into sybilRisk
 *
 * v2 features (maintained):
 *   - Edge weight saturation caps
 *   - Trust saturation with logarithmic scaling
 *   - Circular trust detection with penalty amplification
 *   - Stronger sybil risk scoring
 */

import { prisma } from "../db";
import {
  TRUST_DECAY,
  TRUST_GRAPH_VALIDATION,
  REPEATED_PAIR,
  ECONOMIC_VOLUME_WEIGHTING,
  SPECTRAL_GAP_CONFIG,
  V2_FLAGS,
  TRUSTFLOW_CONFIG,
} from "./config";
import {
  computeEntropyConfidence,
  effectiveDecayConstant,
  computeRequiredEntropy,
  // Dynamic-formula registry consumed per Task 2.3 of the
  // trace-adversarial-coevolution audit (R-SCALE rewire). The legacy static
  // reads on `TRUST_GRAPH_VALIDATION.edgeWeightCap` and the literal `total < 10`
  // / `>= 3` / `maxDepth = 10` thresholds in this file are routed through
  // these helpers so the values scale with the live network size N.
  edgeWeightCap as edgeWeightCapForN,
  trustPropagationDepth,
  computeEntropyConfidenceFloor,
  // Task 6.2 (R-GRAPH 6, R-STABILITY 4): bounded PPR iteration cap routed
  // through the dynamic-formula registry. Replaces the static `MAX_ITER = 100`
  // (`computeAllNetworkTrustWithMeta`) and `MAX_ITER = 50`
  // (`computePersonalizedPageRank`) literals previously declared in this file.
  pprMaxIter,
} from "./adaptiveConfig";
import { computeCounterpartyEntropyFromWindow } from "./interactionWindow";

// ─── Edge Cache for Batch Entropy Computation ─────────────────────────────────

/**
 * In-memory cache of all trust edges, indexed by source and target.
 * Used to eliminate per-provider DB queries during scoring and trust persistence.
 * The computation is identical to the per-query version — only the I/O pattern changes.
 */
export interface EdgeCache {
  bySource: Map<string, Array<{ targetProviderId: string; successfulCoJobs: number; economicVolume: number; weight: number; escrowReliability: number }>>;
  byTarget: Map<string, Array<{ sourceProviderId: string; successfulCoJobs: number; economicVolume: number; weight: number; escrowReliability: number }>>;
}

/**
 * Load all trust edges into an in-memory cache.
 * Call once before batch operations (scoring, trust persistence) to avoid N individual queries.
 */
export async function buildEdgeCache(): Promise<EdgeCache> {
  const allEdges = await prisma.trustEdge.findMany({
    select: {
      sourceProviderId: true,
      targetProviderId: true,
      successfulCoJobs: true,
      economicVolume: true,
      weight: true,
      escrowReliability: true,
    },
  });

  const bySource = new Map<string, Array<{ targetProviderId: string; successfulCoJobs: number; economicVolume: number; weight: number; escrowReliability: number }>>();
  const byTarget = new Map<string, Array<{ sourceProviderId: string; successfulCoJobs: number; economicVolume: number; weight: number; escrowReliability: number }>>();

  for (const e of allEdges) {
    if (!bySource.has(e.sourceProviderId)) bySource.set(e.sourceProviderId, []);
    bySource.get(e.sourceProviderId)!.push({
      targetProviderId: e.targetProviderId,
      successfulCoJobs: e.successfulCoJobs,
      economicVolume: e.economicVolume,
      weight: e.weight,
      escrowReliability: e.escrowReliability,
    });

    if (!byTarget.has(e.targetProviderId)) byTarget.set(e.targetProviderId, []);
    byTarget.get(e.targetProviderId)!.push({
      sourceProviderId: e.sourceProviderId,
      successfulCoJobs: e.successfulCoJobs,
      economicVolume: e.economicVolume,
      weight: e.weight,
      escrowReliability: e.escrowReliability,
    });
  }

  return { bySource, byTarget };
}

// ─── EigenTrust Local Trust Matrix ────────────────────────────────────────────

/**
 * Build the local trust matrix for EigenTrust (Kamvar et al., 2003).
 *
 * For each edge from provider i to provider j:
 *   sat(i,j) = round(successfulCoJobs × escrowReliability)  — successful interactions
 *   unsat(i,j) = successfulCoJobs − sat(i,j)                — failed interactions
 *   c_ij = max(0, sat − unsat)                              — net positive trust
 *
 * Row-stochastic normalization:
 *   If Σ_j c_ij > 0: normalize c_ij / Σ_j c_ij
 *   If Σ_j c_ij = 0 (zero-row): uniform fallback 1/N for all providers
 *
 * Returns a sparse representation (adjacency list) for performance at N=5000.
 * Only non-zero entries are stored in the inner maps.
 *
 * @param edgeCache - Pre-built in-memory edge cache with escrowReliability
 * @param providerIds - List of all provider IDs to include in the matrix
 * @returns Sparse row-stochastic trust matrix and the provider ID list
 */
export function buildLocalTrustMatrix(
  edgeCache: EdgeCache,
  providerIds: string[]
): { matrix: Map<string, Map<string, number>>; providerIds: string[] } {
  const N = providerIds.length;
  const matrix = new Map<string, Map<string, number>>();

  if (N === 0) {
    return { matrix, providerIds };
  }

  // Build set for O(1) membership checks
  const providerSet = new Set(providerIds);

  // Phase 1: Compute raw c_ij = max(0, sat - unsat) for each edge
  for (const sourceId of providerIds) {
    const outEdges = edgeCache.bySource.get(sourceId);
    if (!outEdges || outEdges.length === 0) continue;

    const row = new Map<string, number>();
    let rowSum = 0;

    for (const edge of outEdges) {
      // Only include edges to providers in the providerIds set
      if (!providerSet.has(edge.targetProviderId)) continue;

      // Derive sat/unsat from the edge fields:
      // successfulCoJobs is total co-jobs (incremented on every interaction)
      // escrowReliability is the fraction that resolved successfully
      const totalJobs = edge.successfulCoJobs;
      const sat = Math.round(totalJobs * edge.escrowReliability);
      const unsat = totalJobs - sat;
      const c_ij = Math.max(0, sat - unsat);

      if (c_ij > 0) {
        row.set(edge.targetProviderId, c_ij);
        rowSum += c_ij;
      }
    }

    // Phase 2: Row-stochastic normalization
    if (rowSum > 0) {
      // Normalize: divide each entry by the row sum
      const normalizedRow = new Map<string, number>();
      for (const [targetId, value] of row) {
        normalizedRow.set(targetId, value / rowSum);
      }
      matrix.set(sourceId, normalizedRow);
    }
    // If rowSum === 0, this is a zero-row node — handled below with uniform fallback
  }

  // Phase 3: Zero-row fallback — nodes with no positive outgoing trust
  // get uniform 1/N for all providers (ensures the matrix is row-stochastic)
  // NOTE: We don't materialize uniform rows in the sparse representation.
  // Instead, consumers of this matrix should check if a row exists:
  //   - If row exists in matrix: use the sparse entries (they sum to 1.0)
  //   - If row is absent: treat as uniform 1/N over all providers

  return { matrix, providerIds };
}

// ─── TrustFlow Baseline (Seliuchenko 2026, arXiv:2603.19452) ─────────────────
//
// Reproduction of TrustFlow's contraction-mapping reputation propagation for
// direct empirical comparison against TRACE and EIGENTRUST. See
// TRUSTFLOW_CONFIG in config.ts for parameter provenance and the fidelity
// notes on why every edge here is treated as a "blind edge."

function fnv1aHash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeVec(v: Float64Array): Float64Array {
  let norm = 0;
  for (let d = 0; d < v.length; d++) norm += v[d] * v[d];
  norm = Math.sqrt(norm) || 1;
  const out = new Float64Array(v.length);
  for (let d = 0; d < v.length; d++) out[d] = v[d] / norm;
  return out;
}

/**
 * Deterministic synthetic "profile embedding" standing in for TrustFlow's
 * real content-derived profile vector — this simulation has no chat/job
 * content to derive one from. Pure function of providerId (stable across
 * every call within a run; drawn independently of honest/malicious labeling
 * so the topic-gating mechanism gets no privileged signal either attackers
 * or defenders wouldn't have in the real system).
 */
export function providerProfileEmbedding(providerId: string, dim: number = TRUSTFLOW_CONFIG.embeddingDim): Float64Array {
  const rand = mulberry32(fnv1aHash(providerId));
  const v = new Float64Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
  return normalizeVec(v);
}

/**
 * TrustFlow's "squared gating" transfer operator: f(R, e) = R ⊙ e².
 * One of the paper's five Lipschitz-1 operators; chosen because the paper
 * specifically describes it as preserving directional information on blind
 * edges, which is the only edge type this reproduction has.
 */
function squaredGatingOperator(R: Float64Array, e: Float64Array): Float64Array {
  const out = new Float64Array(R.length);
  for (let d = 0; d < R.length; d++) out[d] = R[d] * e[d] * e[d];
  return out;
}

/**
 * Compute TrustFlow reputation scores via contraction-mapping propagation:
 *
 *   R_new[j] = alpha * sum_i w(i->j) * f(R[i], e_ij) + (1-alpha) * T[j] + C[j]
 *
 * Faithful mapping of the paper's equation onto this codebase's data:
 *  - w(i->j): the same row-stochastic edge weight EIGENTRUST uses
 *    (buildLocalTrustMatrix), for an apples-to-apples graph signal — both
 *    baselines see identical graph evidence, differing only in propagation
 *    mechanism.
 *  - e_ij: every edge is a "blind edge" (no interaction-content signal
 *    exists in this simulation), using the paper's own documented fallback:
 *    e_ij = normalize(avg(p_i, p_j)), discounted at the paper's stated 0.3x
 *    blind-edge weight.
 *  - f = squared-gating operator (see above).
 *  - T[j] = provider j's own profile embedding (paper: "teleportation prior
 *    from the agent's own public content").
 *  - C[j] = 0 (no exogenous authority injection / pre-trusted peers — a
 *    clean, unaugmented baseline).
 *  - alpha = 0.85, convergence epsilon = 1e-4 (paper's stated defaults).
 *
 * Returns a per-provider scalar score: the converged reputation vector R[j]
 * dot-producted with q, the mean profile embedding of the candidate pool
 * (standing in for the paper's query embedding, since every candidate here
 * already shares the same capability/topic by construction), then min-max
 * normalized to [0,1] across the pool so it composes with cost the same way
 * EIGENTRUST's utility does.
 */
export function computeTrustFlowScores(
  edgeCache: EdgeCache,
  providerIds: string[]
): Map<string, number> {
  const N = providerIds.length;
  const result = new Map<string, number>();
  if (N === 0) return result;

  const { alpha, blindEdgeDiscount, convergenceThreshold, maxIterations } = TRUSTFLOW_CONFIG;
  const dim = TRUSTFLOW_CONFIG.embeddingDim;

  const profile = new Map<string, Float64Array>();
  for (const id of providerIds) profile.set(id, providerProfileEmbedding(id, dim));

  const { matrix } = buildLocalTrustMatrix(edgeCache, providerIds);

  let current = new Map<string, Float64Array>();
  for (const id of providerIds) current.set(id, profile.get(id)!.slice());

  const uniformShare = 1 / N;

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Map<string, Float64Array>();
    for (const id of providerIds) {
      const t = profile.get(id)!;
      const v = new Float64Array(dim);
      for (let d = 0; d < dim; d++) v[d] = t[d] * (1 - alpha); // (1-alpha)*T[j] + C[j], C=0
      next.set(id, v);
    }

    let zeroRowMass: Float64Array | null = null;

    for (const sourceId of providerIds) {
      const row = matrix.get(sourceId);
      const Ri = current.get(sourceId)!;
      if (row && row.size > 0) {
        const pi = profile.get(sourceId)!;
        for (const [targetId, w] of row) {
          const nextVec = next.get(targetId);
          if (!nextVec) continue;
          const pj = profile.get(targetId)!;
          const eij = normalizeVec(new Float64Array(dim).map((_, d) => (pi[d] + pj[d]) / 2));
          const f = squaredGatingOperator(Ri, eij);
          const wEff = w * blindEdgeDiscount;
          for (let d = 0; d < dim; d++) nextVec[d] += alpha * wEff * f[d];
        }
      } else {
        if (!zeroRowMass) zeroRowMass = new Float64Array(dim);
        for (let d = 0; d < dim; d++) zeroRowMass[d] += Ri[d];
      }
    }
    if (zeroRowMass) {
      const mass = zeroRowMass;
      for (const id of providerIds) {
        const nextVec = next.get(id)!;
        for (let d = 0; d < dim; d++) nextVec[d] += alpha * uniformShare * mass[d];
      }
    }

    let residualSq = 0;
    for (const id of providerIds) {
      const a = current.get(id)!, b = next.get(id)!;
      for (let d = 0; d < dim; d++) { const diff = b[d] - a[d]; residualSq += diff * diff; }
    }
    current = next;
    if (Math.sqrt(residualSq) < convergenceThreshold) break;
  }

  // Query embedding: mean profile of the candidate pool (all candidates
  // already share one capability, standing in for the paper's query-topic
  // vector).
  const q = new Float64Array(dim);
  for (const id of providerIds) {
    const p = profile.get(id)!;
    for (let d = 0; d < dim; d++) q[d] += p[d] / N;
  }

  const raw = new Map<string, number>();
  let min = Infinity, max = -Infinity;
  for (const id of providerIds) {
    const R = current.get(id)!;
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += R[d] * q[d];
    raw.set(id, dot);
    if (dot < min) min = dot;
    if (dot > max) max = dot;
  }

  const range = max - min;
  for (const id of providerIds) {
    const dot = raw.get(id)!;
    result.set(id, range > 1e-12 ? (dot - min) / range : 0.5);
  }

  return result;
}

// ─── Trust Edge Management ────────────────────────────────────────────────────

/**
 * Update or create a trust edge after two providers participate in the same
 * orchestration (co-job). v2: applies edge weight cap and diversity checks.
 *
 * The per-edge weight cap is computed via `edgeWeightCap(N)` from the
 * dynamic-formula registry in `adaptiveConfig.ts` (Task 2.3 rewire of R-SCALE):
 * `TRUST_GRAPH_VALIDATION.edgeWeightCap = 5.0` is now floor-only and live
 * consumers must route through the registry function. When the caller does not
 * provide `networkSize`, we use N=32 — `edgeWeightCap(32) = max(5, log2(32)) = 5`
 * exactly matches the legacy static, preserving backward-compatible behavior
 * for call sites in the runner / orchestrator / attack modules that don't yet
 * thread N through.
 */
export async function updateTrustEdge(
  sourceProviderId: string,
  targetProviderId: string,
  jobAmountSats: number,
  escrowSuccess: boolean,
  networkSize?: number
): Promise<void> {
  if (sourceProviderId === targetProviderId) return;

  // Dynamic-formula registry consumer (Task 2.3, R-SCALE).
  const dynamicEdgeWeightCap = edgeWeightCapForN(networkSize ?? 32);

  const existing = await prisma.trustEdge.findUnique({
    where: {
      sourceProviderId_targetProviderId: {
        sourceProviderId,
        targetProviderId,
      },
    },
  });

  if (existing) {
    const newCoJobs = existing.successfulCoJobs + 1;
    const newVolume = existing.economicVolume + jobAmountSats;
    const newReliability = escrowSuccess
      ? (existing.escrowReliability * existing.successfulCoJobs + 1.0) / newCoJobs
      : (existing.escrowReliability * existing.successfulCoJobs + 0.0) / newCoJobs;

    // v2: Compute edge weight with SATURATION CAP (Task 2.3: N-aware).
    let weight = computeEdgeWeight(newCoJobs, newVolume, newReliability);
    weight = Math.min(weight, dynamicEdgeWeightCap); // CAP

    await prisma.trustEdge.update({
      where: { id: existing.id },
      data: {
        successfulCoJobs: newCoJobs,
        economicVolume: newVolume,
        escrowReliability: round4(newReliability),
        weight: round4(weight),
        lastInteraction: new Date(),
      },
    });
  } else {
    let weight = computeEdgeWeight(1, jobAmountSats, escrowSuccess ? 1.0 : 0.0);
    weight = Math.min(weight, dynamicEdgeWeightCap);

    await prisma.trustEdge.create({
      data: {
        sourceProviderId,
        targetProviderId,
        successfulCoJobs: 1,
        economicVolume: jobAmountSats,
        escrowReliability: escrowSuccess ? 1.0 : 0.0,
        weight: round4(weight),
      },
    });
  }
}

/**
 * v2.2 Edge weight formula with MATURITY-AWARE DECAY:
 *   w = log2(1 + coJobs) × (1 + log10(1 + volume/100)) × reliability
 *       × exp(-coJobs / k_eff)            ← v2.2: maturity-scaled decay
 *       × volumeWeight                    ← VOLUME AUTHENTICITY
 *
 * v2.2: k_eff = decayConstant × maturityFactor
 * At small scales, maturityFactor > 1 (slower decay, more lenient)
 * At large scales, maturityFactor < 1 (faster decay, stricter)
 */
function computeEdgeWeight(
  coJobs: number,
  volume: number,
  reliability: number,
  networkSize?: number,
  diversityScore?: number
): number {
  const frequencyFactor = Math.log2(1 + coJobs);
  const volumeFactor = 1 + Math.log10(1 + volume / 100);

  // v2.2: Maturity-aware decay constant
  const k_eff = effectiveDecayConstant(networkSize ?? 50, diversityScore ?? 0.5);
  const repeatedPairDecay = Math.exp(-coJobs / k_eff);

  // v2.1: Volume authenticity — tiny fake transactions contribute less
  const minVol = ECONOMIC_VOLUME_WEIGHTING.minVolumeForFullWeight;
  const volumeWeight = Math.min(Math.log2(1 + volume / minVol), 1.0);

  return frequencyFactor * volumeFactor * reliability * repeatedPairDecay * volumeWeight;
}

// ─── v2.2: Tarjan SCC — Directed Cycle Detection ─────────────────────────────

/**
 * Iterative Tarjan's Strongly Connected Components algorithm.
 * Returns an array of SCCs; each SCC is a list of node IDs.
 * Time complexity: O(V + E). Iterative to avoid stack-overflow on large rings.
 */
function runTarjanSCC(adj: Map<string, Set<string>>): string[][] {
  const nodes = [...adj.keys()];
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  // Iterative Tarjan using explicit work-stack to avoid JS call-stack limits
  type Frame = { v: string; iterator: IterableIterator<string>; childDone: boolean };

  for (const root of nodes) {
    if (indexMap.has(root)) continue;

    const workStack: Frame[] = [];
    const pushNode = (v: string) => {
      indexMap.set(v, counter);
      lowlink.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
      workStack.push({ v, iterator: (adj.get(v) ?? new Set<string>())[Symbol.iterator](), childDone: false });
    };

    pushNode(root);

    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1];
      const { value: w, done } = frame.iterator.next();

      if (!done && w !== undefined) {
        if (!indexMap.has(w)) {
          pushNode(w);
        } else if (onStack.has(w)) {
          lowlink.set(frame.v, Math.min(lowlink.get(frame.v)!, indexMap.get(w)!));
        }
      } else {
        // All neighbours of frame.v processed — pop
        workStack.pop();
        if (workStack.length > 0) {
          const parent = workStack[workStack.length - 1];
          lowlink.set(parent.v, Math.min(lowlink.get(parent.v)!, lowlink.get(frame.v)!));
        }
        // Root of an SCC?
        if (lowlink.get(frame.v) === indexMap.get(frame.v)) {
          const scc: string[] = [];
          let w2: string;
          do {
            w2 = stack.pop()!;
            onStack.delete(w2);
            scc.push(w2);
          } while (w2 !== frame.v);
          sccs.push(scc);
        }
      }
    }
  }

  return sccs;
}

// ─── v4.2: Spectral Gap Anomaly Detection (RING COLLUSION FIX) ────────────────

/**
 * Compute the second-largest eigenvalue magnitude |λ₂| of the row-stochastic
 * submatrix restricted to a given SCC.
 *
 * Method: Deflated power iteration.
 *   1. Build the row-stochastic transition submatrix T for the SCC.
 *   2. The leading eigenvector of a row-stochastic matrix is the uniform
 *      vector (or the stationary distribution). We deflate it out:
 *      T' = T - (1/k)·1·1^T  (subtract the rank-1 component of λ₁=1)
 *   3. Run power iteration on T' to find the eigenvector with largest |λ|.
 *   4. Return |λ₂| = the Rayleigh quotient magnitude.
 *
 * Theoretical basis:
 *   - A pure directed cycle of length k has eigenvalues = k-th roots of unity,
 *     all with |λ| = 1. So |λ₂| = 1 for a perfect ring.
 *   - Honest-interleaving edges (30%) perturb this slightly but |λ₂| remains
 *     > 0.9 for rings of size ≥ 5.
 *   - Legitimate trust clusters have hierarchical structure → |λ₂| ≈ 0.3–0.6.
 *
 * Performance: O(k² × maxIterations). For k=100, maxIter=30: ~300K multiplications.
 * Sub-millisecond on modern hardware.
 *
 * @param scc - Array of provider IDs forming the SCC
 * @param edgeWeightMap - Map of "src→tgt" → weight for all edges
 * @returns |λ₂| in [0, 1]. Returns 0 if SCC is too small or degenerate.
 */
export function computeSpectralGap(
  scc: string[],
  edgeWeightMap: Map<string, number>,
): number {
  const k = scc.length;
  if (k < SPECTRAL_GAP_CONFIG.minSCCSize) return 0;

  // Build row-stochastic submatrix T[i][j] for the SCC
  const idxMap = new Map<string, number>();
  for (let i = 0; i < k; i++) idxMap.set(scc[i], i);

  // T stored as flat array for cache efficiency: T[i*k + j]
  const T = new Float64Array(k * k);

  for (let i = 0; i < k; i++) {
    const src = scc[i];
    let rowSum = 0;

    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const tgt = scc[j];
      const w = edgeWeightMap.get(`${src}→${tgt}`) ?? 0;
      if (w > 0) {
        T[i * k + j] = w;
        rowSum += w;
      }
    }

    // Row-stochastic normalization (or uniform fallback for zero-row)
    if (rowSum > 0) {
      for (let j = 0; j < k; j++) {
        T[i * k + j] /= rowSum;
      }
    } else {
      // Uniform fallback: 1/k for all entries
      for (let j = 0; j < k; j++) {
        T[i * k + j] = 1 / k;
      }
    }
  }

  // Deflated power iteration to find |λ₂|.
  // Instead of explicitly deflating T, we use the orthogonal iteration trick:
  // After each multiplication v = T·v, subtract the projection onto the
  // stationary distribution (uniform for row-stochastic: 1/k).
  // This converges to the eigenvector of λ₂.

  // Initialize with a random-looking vector orthogonal to uniform
  let v = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    // Deterministic pseudo-random initialization based on position
    v[i] = Math.sin(i * 2.39996323 + 1.0) * 0.5 + 0.5;
  }

  // Subtract mean to make orthogonal to uniform eigenvector
  let mean = 0;
  for (let i = 0; i < k; i++) mean += v[i];
  mean /= k;
  for (let i = 0; i < k; i++) v[i] -= mean;

  // Normalize
  let norm = 0;
  for (let i = 0; i < k; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return 0; // Degenerate
  for (let i = 0; i < k; i++) v[i] /= norm;

  let lambda2 = 0;

  for (let iter = 0; iter < SPECTRAL_GAP_CONFIG.maxIterations; iter++) {
    // w = T^T · v (left-multiply by transpose for row-stochastic matrix)
    // For row-stochastic T, the left eigenvectors of T^T correspond to
    // right eigenvectors of T. We compute T·v directly.
    const w = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      let sum = 0;
      for (let j = 0; j < k; j++) {
        sum += T[i * k + j] * v[j];
      }
      w[i] = sum;
    }

    // Deflate: subtract projection onto uniform vector (the λ₁=1 eigenvector)
    mean = 0;
    for (let i = 0; i < k; i++) mean += w[i];
    mean /= k;
    for (let i = 0; i < k; i++) w[i] -= mean;

    // Compute norm (this approximates |λ₂|)
    norm = 0;
    for (let i = 0; i < k; i++) norm += w[i] * w[i];
    norm = Math.sqrt(norm);

    if (norm < 1e-12) {
      // λ₂ ≈ 0 — highly connected/uniform structure
      lambda2 = 0;
      break;
    }

    const newLambda2 = norm;

    // Check convergence
    if (Math.abs(newLambda2 - lambda2) < SPECTRAL_GAP_CONFIG.convergenceThreshold) {
      lambda2 = newLambda2;
      break;
    }

    lambda2 = newLambda2;

    // Normalize for next iteration
    for (let i = 0; i < k; i++) v[i] = w[i] / norm;
  }

  // Clamp to [0, 1] — numerical noise can push slightly above 1
  return Math.min(1.0, Math.max(0, lambda2));
}

// ─── WWW v2: TRACE-CR Louvain Community Detection ─────────────────────────────

/**
 * Lightweight Louvain community detection for TRACE-CR.
 * Greedy modularity optimization: each node starts in its own community,
 * then iteratively moves to the neighbor community that maximizes modularity
 * gain, until no further improvement is possible.
 *
 * Returns a Map from nodeId → communityId (string).
 *
 * This is a simplified single-level Louvain (no hierarchical aggregation)
 * which is sufficient for N ≤ 10,000. For larger graphs, the full
 * multi-level Louvain or Leiden (Traag et al. 2019) would be needed.
 *
 * Citation: Blondel et al. (2008) "Fast unfolding of communities in large networks"
 *
 * @param adj - Adjacency map (directed; treated as undirected for modularity)
 * @returns Map from nodeId to communityId
 */
export function detectCommunities(
  adj: Map<string, Set<string>>,
): Map<string, string> {
  const nodes = Array.from(adj.keys());
  const N = nodes.length;
  if (N === 0) return new Map();

  // Treat directed graph as undirected for community detection:
  // edge (u,v) exists if u→v OR v→u
  // Compute total edge weight (m) and degree of each node
  const degree = new Map<string, number>();
  let totalEdges = 0;

  for (const v of nodes) {
    let deg = 0;
    const nbrs = adj.get(v) ?? new Set();
    for (const u of nbrs) {
      if (adj.has(u)) deg++; // only count edges to valid nodes
    }
    // Also count incoming edges (undirected view)
    for (const [u, uNbrs] of adj) {
      if (u !== v && uNbrs.has(v)) {
        // Check if we already counted this as outgoing
        if (!nbrs.has(u)) deg++;
      }
    }
    degree.set(v, deg);
    totalEdges += deg;
  }
  const m = totalEdges / 2; // each undirected edge counted twice
  if (m === 0) {
    // No edges — every node is its own community
    const result = new Map<string, string>();
    for (const v of nodes) result.set(v, v);
    return result;
  }

  // Initialize: each node in its own community
  const community = new Map<string, string>();
  for (const v of nodes) community.set(v, v);

  // Track community membership for efficient modularity computation
  // communityNodes[communityId] = set of nodes in that community
  const communityNodes = new Map<string, Set<string>>();
  for (const v of nodes) communityNodes.set(v, new Set([v]));

  // Iterative optimization (single level)
  const MAX_PASSES = 10;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;

    for (const v of nodes) {
      const currentComm = community.get(v)!;
      const vDeg = degree.get(v) ?? 0;

      // Compute edges from v to each neighboring community
      const commEdges = new Map<string, number>();
      const nbrs = adj.get(v) ?? new Set();
      for (const u of nbrs) {
        if (!adj.has(u)) continue;
        const uComm = community.get(u)!;
        commEdges.set(uComm, (commEdges.get(uComm) ?? 0) + 1);
      }
      // Also count incoming edges (undirected view)
      for (const [u, uNbrs] of adj) {
        if (u !== v && uNbrs.has(v) && !nbrs.has(u)) {
          const uComm = community.get(u)!;
          commEdges.set(uComm, (commEdges.get(uComm) ?? 0) + 1);
        }
      }

      // Compute sum of degrees for each neighboring community
      // (excluding v if v is currently in that community)
      let bestComm = currentComm;
      let bestGain = 0;

      for (const [targetComm, k_v_in] of commEdges) {
        if (targetComm === currentComm) continue;

        // Sum of degrees in target community
        let sumTot = 0;
        for (const u of communityNodes.get(targetComm) ?? []) {
          sumTot += degree.get(u) ?? 0;
        }

        // Sum of degrees in current community (excluding v)
        let sumCurrent = 0;
        for (const u of communityNodes.get(currentComm) ?? []) {
          if (u !== v) sumCurrent += degree.get(u) ?? 0;
        }

        // Edges from v to current community (excluding self)
        const k_v_current = commEdges.get(currentComm) ?? 0;

        // Modularity gain from moving v: currentComm → targetComm
        // ΔQ = [k_v_in / m - sumTot × k_v / (2m²)]
        //     - [k_v_current / m - sumCurrent × k_v / (2m²)]
        const gain = (k_v_in - k_v_current) / m
          - vDeg * (sumTot - sumCurrent) / (2 * m * m);

        if (gain > bestGain) {
          bestGain = gain;
          bestComm = targetComm;
        }
      }

      // Move v to bestComm if there's a positive gain
      if (bestComm !== currentComm) {
        communityNodes.get(currentComm)!.delete(v);
        if (communityNodes.get(currentComm)!.size === 0) {
          communityNodes.delete(currentComm);
        }
        community.set(v, bestComm);
        if (!communityNodes.has(bestComm)) communityNodes.set(bestComm, new Set());
        communityNodes.get(bestComm)!.add(v);
        moved = true;
      }
    }

    if (!moved) break; // Converged
  }

  return community;
}

// ─── v2.9: Dense Subgraph Detection (CRITICAL COLLUSION FIX) ──────────────────

/**
 * Detect dense subgraphs (collusion meshes) that don't form obvious SCCs.
 * Uses local clustering coefficient + edge density to catch mesh topologies.
 *
 * CRITICAL: This catches collusion-ring attacks that use mesh instead of ring topology.
 * Mesh patterns have high local clustering but may not form large SCCs.
 *
 * Task 2.3 (R-SCALE): the "high-degree neighbor" threshold is no longer a
 * hardcoded `>= 3`. It scales with the live graph size as
 * `max(3, ceil(log2(N) / 2))`, derived from the dynamic-formula registry's
 * spirit: a node's degree only counts as "high" relative to the network's
 * branching factor, which grows logarithmically. At N=8 the threshold is 3
 * (preserves prior behavior); at N=1024 it is 5.
 */
export function detectDenseSubgraphRisk(adj: Map<string, Set<string>>): Map<string, number> {
  const riskScores = new Map<string, number>();

  // Live network size proxy — `adj.size` is the active node count in the
  // graph passed by `updateSybilRiskScores`, which equals the active provider
  // count for the round.
  const N = Math.max(2, adj.size);

  // ─── Charikar's Greedy Peeling (½-approximation of densest subgraph) ────
  // Citation: Charikar (2000) "Greedy Approximation Algorithms for Finding
  // Dense Components in a Graph". Runs in O(V + E).
  //
  // Iteratively removes the minimum-degree node and tracks the densest
  // subgraph seen during the peeling process. Provably finds a subgraph
  // with density ≥ ½ of the maximum-density subgraph.
  //
  // This replaces the prior heuristic (clustering coefficient × degree
  // centrality) which had no approximation guarantee and could miss
  // bipartite or irregular dense subgraphs.

  const nodes = Array.from(adj.keys());
  const remaining = new Set(nodes);

  // Build mutable degree map (count only edges within remaining set)
  const degree = new Map<string, number>();
  let edgeCount = 0;
  for (const v of nodes) {
    let deg = 0;
    for (const u of adj.get(v) ?? []) {
      if (remaining.has(u)) deg++;
    }
    degree.set(v, deg);
    edgeCount += deg;
  }
  // Each undirected edge counted twice (once from each endpoint); but since
  // the adjacency is directed, edgeCount is the total directed edge count.
  // Density = directed edges / nodes.
  let bestDensity = remaining.size > 0 ? edgeCount / remaining.size : 0;
  let bestMembers = new Set(remaining);

  // Peeling loop: remove min-degree node, track best subgraph
  while (remaining.size > 1) {
    // Find minimum-degree node in remaining set
    let minV = "";
    let minDeg = Infinity;
    for (const v of remaining) {
      const d = degree.get(v) ?? 0;
      if (d < minDeg) { minDeg = d; minV = v; }
    }

    // Remove it and update degrees
    remaining.delete(minV);
    for (const nbr of adj.get(minV) ?? []) {
      if (remaining.has(nbr)) {
        degree.set(nbr, (degree.get(nbr) ?? 1) - 1);
        edgeCount--;
      }
    }
    // Also subtract edges FROM remaining nodes TO minV
    for (const v of remaining) {
      if (adj.get(v)?.has(minV)) {
        degree.set(v, (degree.get(v) ?? 1) - 1);
        edgeCount--;
      }
    }

    // Check density of remaining subgraph
    const density = remaining.size > 0 ? edgeCount / remaining.size : 0;
    if (density > bestDensity) {
      bestDensity = density;
      bestMembers = new Set(remaining);
    }
  }

  // ─── Risk scoring based on Charikar result ──────────────────────────────

  // Expected random density: if edges were distributed uniformly,
  // density ≈ totalEdges / N. Subgraphs significantly denser than this
  // are suspicious.
  let totalEdgeCount = 0;
  for (const [, nbrs] of adj) totalEdgeCount += nbrs.size;
  const expectedRandomDensity = N > 1 ? totalEdgeCount / N : 1;

  // Density ratio: how much denser is the Charikar subgraph vs random?
  const densityRatio = expectedRandomDensity > 0
    ? bestDensity / expectedRandomDensity
    : 0;

  // Only flag if the densest subgraph is significantly denser than random
  // and has enough members to be a meaningful cluster (not just a single edge)
  const isDense = densityRatio > 2.0 && bestMembers.size >= 3;

  for (const nodeId of nodes) {
    if (isDense && bestMembers.has(nodeId)) {
      // Risk proportional to how anomalously dense the subgraph is,
      // capped at 1.0. Members of the densest subgraph get risk based on
      // the density ratio: densityRatio=3 → risk≈0.33, ratio=5 → risk≈0.53
      const baseRisk = Math.min(1.0, Math.log2(densityRatio) / 3);

      // Secondary signal: local clustering coefficient within the dense
      // subgraph (retained from v1 as a refinement signal)
      const neighbors = adj.get(nodeId) ?? new Set();
      const denseNeighbors = Array.from(neighbors).filter(n => bestMembers.has(n));
      let clusterBonus = 0;
      if (denseNeighbors.length >= 2) {
        let triangles = 0;
        for (let i = 0; i < denseNeighbors.length; i++) {
          for (let j = i + 1; j < denseNeighbors.length; j++) {
            if (adj.get(denseNeighbors[i])?.has(denseNeighbors[j]) ||
                adj.get(denseNeighbors[j])?.has(denseNeighbors[i])) {
              triangles++;
            }
          }
        }
        const possibleTriangles = (denseNeighbors.length * (denseNeighbors.length - 1)) / 2;
        clusterBonus = possibleTriangles > 0 ? (triangles / possibleTriangles) * 0.2 : 0;
      }

      riskScores.set(nodeId, Math.min(1.0, baseRisk + clusterBonus));
    } else {
      riskScores.set(nodeId, 0);
    }
  }

  return riskScores;
}

// ─── v2: Edge Diversity Analysis ──────────────────────────────────────────────

/**
 * Compute edge diversity score for a provider using a pre-built adjacency map.
 * Fixed: accounts for whether out-edges leave the provider's SCC.
 * Returns [0, 1] where 1 = highly diverse with external connections.
 */
function computeEdgeDiversityFromGraph(
  providerId: string,
  adj: Map<string, Set<string>>,
  reverseAdj: Map<string, Set<string>>,
  sccMembership: Map<string, number>,   // nodeId → sccIndex
  edgeVolumes: Map<string, number>,     // "src→tgt" → economicVolume
): number {
  const outNeighbours = adj.get(providerId) ?? new Set<string>();
  const inNeighbours = reverseAdj.get(providerId) ?? new Set<string>();

  const counterparties = new Set<string>([...outNeighbours, ...inNeighbours]);
  const uniqueCount = counterparties.size;
  const totalEdges = outNeighbours.size + inNeighbours.size;

  if (totalEdges === 0) return 0;

  const rawDiversity = uniqueCount / totalEdges;

  // External connectivity: what fraction of out-edges leave this node's SCC?
  const mySCC = sccMembership.get(providerId) ?? -1;
  let externalOut = 0;
  for (const tgt of outNeighbours) {
    if ((sccMembership.get(tgt) ?? -2) !== mySCC) externalOut++;
  }
  // Nodes with ZERO external out-edges (closed ring / clique) get penalised
  const externalRatio = outNeighbours.size > 0 ? externalOut / outNeighbours.size : 1.0;

  // Volume-concentration penalty (Herfindahl index)
  const volumes = [...outNeighbours].map((tgt) => edgeVolumes.get(`${providerId}→${tgt}`) ?? 0);
  const totalVol = volumes.reduce((s, v) => s + v, 0);
  let concentrationPenalty = 0;
  if (totalVol > 0 && volumes.length > 1) {
    const hhi = volumes.reduce((s, v) => s + (v / totalVol) ** 2, 0);
    concentrationPenalty = Math.max(0, hhi - 1 / volumes.length);
  }

  return Math.max(0, Math.min(1, rawDiversity * externalRatio - concentrationPenalty));
}

// ─── v2: Circular Trust Detection ─────────────────────────────────────────────

/**
 * Depth-limited DFS to count how many cycles of length ≤ MAX_DEPTH pass
 * through `startId`, using a pre-built in-memory adjacency map.
 * Replaces the old 2-hop / 3-hop hardcoded DB queries.
 *
 * Task 2.3 (R-SCALE): the `maxDepth` parameter default is no longer the
 * hardcoded `10` literal — when undefined, we route through
 * `trustPropagationDepth(adj.size)` from the dynamic-formula registry in
 * `adaptiveConfig.ts`. The registry returns `max(4, ceil(log2(N)))`, which
 * yields exactly `10` at N=1024 (preserves the previous behavior at the upper
 * end of the audited range) and shrinks gracefully at small N. Existing call
 * sites that pass an explicit numeric depth (the round-level secondary-cycle
 * scan uses `5`) are preserved.
 */
function detectCircularPatternsFromGraph(
  startId: string,
  adj: Map<string, Set<string>>,
  maxDepth?: number,
  cycleCap?: number,
): number {
  // Default to N-aware depth from the dynamic-formula registry (R-SCALE).
  const effectiveMaxDepth = maxDepth ?? trustPropagationDepth(adj.size);
  // Early-exit cap. Downstream consumer (updateSybilRiskScores) saturates the
  // circular-penalty contribution at `maxCircularPenalty / circularPenaltyPerCycle`
  // = 0.6 / 0.15 = 4 cycles. Any DFS work beyond ~2× that count is wasted.
  // Default = 8 gives one round-trip of headroom for non-saturating callers
  // while bounding worst-case work on dense graphs (e.g. real-graph seeds
  // with mean out-degree 18, where the un-capped 5-hop DFS can explore
  // ~10^6 paths per node).
  const effectiveCycleCap = cycleCap ?? 8;
  let cycles = 0;

  // Task 6.1 (R-GRAPH 1, R-GRAPH 2, R-STABILITY 4): explicit-stack iteration.
  //
  // The prior implementation used a recursive `dfs` closure whose JS call-stack
  // depth grew with `effectiveMaxDepth`. At N=1000 with high-branching graph
  // shapes this could approach the engine's call-stack limit and either throw
  // a `RangeError: Maximum call stack size exceeded` or destabilise the
  // surrounding harness. The work-stack pattern below mirrors the iterative
  // `runTarjanSCC` wrapper above and bounds language-level recursion to zero.
  //
  // A single shared `visited` set tracks the nodes on the **current DFS path**:
  // we add a node when we descend (push a frame for it) and remove it when its
  // iterator is exhausted (pop the frame). This matches the recursive
  // `visited.add` / `visited.delete` pair exactly, so the cycle-counting
  // semantics are bit-identical to the prior version on graphs that don't
  // blow the stack (Property P7 in §14 of the design; verified by
  // `__tests__/trustGraph.edge-cases.spec.ts` under Task 6.4).
  //
  // Stability bounds (R-STABILITY 4):
  //   - workStack depth is bounded by `effectiveMaxDepth` (each frame
  //     represents one path step; we never push a child whose depth exceeds
  //     the cap).
  //   - Each frame's iterator advances monotonically and is dropped when
  //     exhausted, so total work is O(N + E) per outer call.
  //   - The `visited` set guarantees no node is re-entered on the current
  //     path, so the iterator-driven loop always makes forward progress.
  type Frame = { node: string; iterator: IterableIterator<string>; depth: number };

  const visited = new Set<string>([startId]);
  const workStack: Frame[] = [{
    node: startId,
    iterator: (adj.get(startId) ?? new Set<string>())[Symbol.iterator](),
    depth: 1,
  }];

  while (workStack.length > 0) {
    const frame = workStack[workStack.length - 1];
    const step = frame.iterator.next();

    if (step.done) {
      // All neighbours of `frame.node` have been processed — backtrack.
      workStack.pop();
      visited.delete(frame.node);
      continue;
    }

    const next = step.value;

    // Cycle closure back to the start node. Mirrors the recursive
    // `if (next === startId && depth >= 2)` branch — we count and do NOT
    // descend back into the start (its iterator is already on the stack).
    if (next === startId && frame.depth >= 2) {
      cycles++;
      if (cycles >= effectiveCycleCap) {
        // Saturated — every further cycle clamps to the same downstream
        // penalty, so further DFS work is provably wasted.
        return cycles;
      }
      continue;
    }

    // Forward edge: descend only if the node is not already on the current
    // path AND we have remaining depth budget. The depth guard mirrors the
    // recursive `if (depth > effectiveMaxDepth) return;` entry check —
    // child frames would bail immediately, so we elide them here.
    if (!visited.has(next) && frame.depth + 1 <= effectiveMaxDepth) {
      visited.add(next);
      workStack.push({
        node: next,
        iterator: (adj.get(next) ?? new Set<string>())[Symbol.iterator](),
        depth: frame.depth + 1,
      });
    }
  }

  return cycles;
}

// ─── Placeholder stubs so the old per-provider call sites still compile ───────
// (updateSybilRiskScores now calls the graph-level versions; these are unused)

async function _legacyDetectCircularPatterns(_providerId: string): Promise<number> {
  return 0;
}
async function _legacyComputeEdgeDiversity(_providerId: string): Promise<number> {
  return 1;
}

// Suppress unused-variable warnings
void _legacyDetectCircularPatterns;
void _legacyComputeEdgeDiversity;

// ─── PageRank-Style Network Trust ─────────────────────────────────────────────

/**
 * v2: Compute networkTrust with saturation caps and diversity weighting.
 *
 * Theoretical-foundations fix (Framework 7): the previous MAX_ITER=20 cap
 * with damping d=0.85 required ≈58 iterations to reach ε=1e-4, so the
 * iterate was returning to the Router un-converged (Requirement 7.1/7.2).
 * We now iterate until ‖x_k − x_{k−1}‖_∞ < ε or up to `pprMaxIter(N)` from
 * the dynamic-formula registry (Task 6.2 / R-GRAPH 6 — replaces the
 * legacy `MAX_ITER = 100` literal), and surface the convergence flag for
 * downstream callers. On cap-reached the partial iterate is returned with
 * `converged = false` (R-STABILITY 4).
 *
 * Banach fixed-point: the iteration is a contraction with modulus d in L1,
 * so convergence rate is O(d^k); the registry's lower bound 50 is safely
 * above the required 58 at every audited N.
 */
export interface NetworkTrustResult {
  trust: Map<string, number>;
  converged: boolean;
  iterations: number;
}

export async function computeAllNetworkTrust(): Promise<Map<string, number>> {
  const result = await computeAllNetworkTrustWithMeta();
  return result.trust;
}

export async function computeAllNetworkTrustWithMeta(): Promise<NetworkTrustResult> {
  const DAMPING = 0.85;
  const EPSILON = 0.0001;

  const providers = await prisma.provider.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  const edges = await prisma.trustEdge.findMany();

  const N = providers.length;
  if (N === 0) return { trust: new Map(), converged: true, iterations: 0 };

  // Task 6.2 (R-GRAPH 6, R-STABILITY 4): N-aware iteration cap via
  // `pprMaxIter(N) = max(50, ceil(log2(N) * 5))` from the dynamic-formula
  // registry in `adaptiveConfig.ts`. Replaces the legacy static
  // `MAX_ITER = 100`. K(d=0.85, ε=1e-4) ≈ log(1e-4) / log(0.85) ≈ 58, so the
  // formula's lower bound 50 plus the log2(N)·5 term keeps the budget above
  // the convergence horizon at every audited N (e.g. N=1024 → 50). When the
  // cap is reached, the iterate is returned as-is with `converged = false`
  // and the partial PPR vector is well-defined.
  const MAX_ITER = pprMaxIter(N);

  const providerIds = providers.map((p) => p.id);
  const idToIndex = new Map(providerIds.map((id, i) => [id, i]));

  // Apply temporal decay to edge weights
  const now = Date.now();
  // Task 2.3 (R-SCALE) — edge-weight cap routed through the dynamic-formula
  // registry; `TRUST_GRAPH_VALIDATION.edgeWeightCap` is floor-only.
  const dynamicEdgeWeightCap = edgeWeightCapForN(N);
  const decayedEdges = edges.map((e) => {
    const age = now - e.lastInteraction.getTime();
    const decayFactor = Math.pow(0.5, age / TRUST_DECAY.halfLifeMs);
    // v2: Apply edge weight cap AFTER decay
    const weight = Math.min(e.weight * decayFactor, dynamicEdgeWeightCap);
    return {
      source: idToIndex.get(e.sourceProviderId),
      target: idToIndex.get(e.targetProviderId),
      weight,
    };
  }).filter((e) => e.source !== undefined && e.target !== undefined) as Array<{
    source: number;
    target: number;
    weight: number;
  }>;

  // Build adjacency
  const outEdges: Map<number, Array<{ target: number; weight: number }>> = new Map();
  const outWeightSum: number[] = new Array(N).fill(0);

  for (const e of decayedEdges) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    outEdges.get(e.source)!.push({ target: e.target, weight: e.weight });
    outWeightSum[e.source] += e.weight;
  }

  // Initialize trust
  let trust = new Array(N).fill(1 / N);

  // Iterate until convergence or cap
  // Uses Gauss-Seidel (in-place) iteration for ~2× faster convergence vs
  // Jacobi (double-buffered). Later nodes see already-updated values from
  // the current iteration, accelerating convergence via successive
  // over-relaxation. Same mathematical fixed point is guaranteed.
  // Citation: Arasu et al. (2002); Kamvar et al. (2003) §3.
  let converged = false;
  let iter = 0;
  for (; iter < MAX_ITER; iter++) {
    // Snapshot for convergence check
    const prevTrust = [...trust];

    // Reset trust with teleportation baseline
    trust.fill((1 - DAMPING) / N);

    // Gauss-Seidel: accumulate into trust in-place so nodes processed later
    // in this iteration immediately benefit from updated values of earlier nodes
    for (let i = 0; i < N; i++) {
      const edges_i = outEdges.get(i);
      if (!edges_i || outWeightSum[i] === 0) continue;

      for (const e of edges_i) {
        trust[e.target] += DAMPING * (e.weight / outWeightSum[i]) * trust[i];
      }
    }

    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(trust[i] - prevTrust[i]));
    }

    if (maxDelta < EPSILON) { converged = true; iter++; break; }
  }

  if (!converged) {
    // eslint-disable-next-line no-console
    console.warn(`[TRACE] PageRank did not converge in ${MAX_ITER} iterations (N=${N})`);
  }

  // Normalize to [0, 1] with v2 SATURATION CAP
  const maxTrust = Math.max(...trust, 0.0001);
  const result = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const normalizedTrust = trust[i] / maxTrust;
    // v2: Apply trust saturation cap (logarithmic dampening)
    const cappedTrust = Math.min(
      normalizedTrust,
      TRUST_GRAPH_VALIDATION.maxNetworkTrust
    );
    result.set(providerIds[i], round4(cappedTrust));
  }

  return { trust: result, converged, iterations: iter };
}

/**
 * Compute and persist networkTrust for a single provider.
 */
export async function computeNetworkTrust(providerId: string): Promise<number> {
  const allTrust = await computeAllNetworkTrust();
  const trust = allTrust.get(providerId) ?? 0;

  await prisma.provider.update({
    where: { id: providerId },
    data: { networkTrust: trust },
  });

  return trust;
}

// ─── Personalized PageRank from Honest Seed (Framework 3) ────────────────────

/**
 * Personalized PageRank from a documented Honest Seed set, computed
 * directly on the in-memory edge cache.
 *
 * Definition:
 *   ppr_α(v) = α · e_S + (1 − α) · A^T D^{-1} ppr_α(v)
 * where S is the seed set and α is the teleportation probability.
 *
 * This is the spectral-distance proxy used by Framework 3 — full Laplacian
 * decomposition is O(N^3) and infeasible at N=1000 per round; PPR is
 * O(|E| × iterations) and within the Per_Round_Budget.
 *
 * Citation: Page et al. (1999); Andersen, Chung, Lang (2006) for PPR
 * concentration around the seed set.
 *
 * Edge cases:
 *   - Empty seed set or empty graph → empty map (caller handles defaults).
 *   - Zero-degree node → contributes only via teleportation; never NaN.
 *   - All weights zero → outflow skipped; teleportation still applies.
 */
export function computePersonalizedPageRank(
  edgeCache: EdgeCache,
  seedIds: Set<string>,
  alpha: number = 0.15
): Map<string, number> {
  if (seedIds.size === 0) return new Map();

  const allProviders = new Set<string>();
  for (const id of edgeCache.bySource.keys()) allProviders.add(id);
  for (const id of edgeCache.byTarget.keys()) allProviders.add(id);
  for (const id of seedIds) allProviders.add(id);

  if (allProviders.size === 0) return new Map();

  const seedSize = seedIds.size;
  const teleportShare = alpha / seedSize;

  // Initial distribution: uniform over seed set.
  const scores = new Map<string, number>();
  for (const id of allProviders) {
    scores.set(id, seedIds.has(id) ? 1 / seedSize : 0);
  }

  const EPSILON = 0.001;
  // Task 6.2 (R-GRAPH 6, R-STABILITY 4): N-aware iteration cap via
  // `pprMaxIter(N)` from the dynamic-formula registry in `adaptiveConfig.ts`.
  // Replaces the legacy static `MAX_ITER = 50`. The live network size for
  // this PPR is the constructed `allProviders` set (graph-level node count
  // including out/in vertices and the seed set). On cap-reached the loop
  // exits cleanly and the partial `scores` map is normalised and returned —
  // the caller never observes a non-finite or undefined entry.
  const MAX_ITER = pprMaxIter(allProviders.size);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const next = new Map<string, number>();
    for (const id of allProviders) {
      next.set(id, seedIds.has(id) ? teleportShare : 0);
    }

    for (const [srcId, outEdges] of edgeCache.bySource) {
      let totalWeight = 0;
      for (const e of outEdges) totalWeight += e.weight;
      if (totalWeight <= 0) continue;
      const srcScore = scores.get(srcId) ?? 0;
      if (srcScore <= 0) continue;
      for (const edge of outEdges) {
        const contribution = (1 - alpha) * srcScore * (edge.weight / totalWeight);
        next.set(
          edge.targetProviderId,
          (next.get(edge.targetProviderId) ?? 0) + contribution
        );
      }
    }

    let maxDelta = 0;
    for (const id of allProviders) {
      const prev = scores.get(id) ?? 0;
      const cur = next.get(id) ?? 0;
      const d = Math.abs(cur - prev);
      if (d > maxDelta) maxDelta = d;
      scores.set(id, cur);
    }
    if (maxDelta < EPSILON) break;
  }

  // Normalize to [0, 1] using the maximum mass.
  let maxScore = 0;
  for (const v of scores.values()) if (v > maxScore) maxScore = v;
  const denom = maxScore > 1e-10 ? maxScore : 1e-10;
  const normalized = new Map<string, number>();
  for (const [id, v] of scores) {
    const ratio = v / denom;
    normalized.set(id, round4(Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0));
  }
  return normalized;
}

// ─── Trust-Weighted Entropy (Framework 5) ────────────────────────────────────

/**
 * Trust-weighted Shannon entropy over a provider's counterparty
 * distribution. Each counterparty's contribution is scaled by its
 * Beta(1,3) posterior mean of completion rate.
 *
 *   H_w(P) = − Σ_i w_i · p_i · log_2 p_i
 *
 * High value = diverse interactions with established honest counterparties.
 * Low value = concentrated interactions or interactions with low-trust peers.
 *
 * Citation: Belis & Guiasu (1968) — weighted entropy generalisation.
 */
export function computeWeightedEntropy(
  providerId: string,
  edgeCache: EdgeCache,
  providerTrustMap: Map<string, number>
): number {
  const outEdges = edgeCache.bySource.get(providerId) ?? [];
  const inEdges = edgeCache.byTarget.get(providerId) ?? [];

  const interactionMap = new Map<string, number>();
  for (const e of outEdges) {
    interactionMap.set(
      e.targetProviderId,
      (interactionMap.get(e.targetProviderId) ?? 0) + e.successfulCoJobs
    );
  }
  for (const e of inEdges) {
    interactionMap.set(
      e.sourceProviderId,
      (interactionMap.get(e.sourceProviderId) ?? 0) + e.successfulCoJobs
    );
  }

  let total = 0;
  for (const v of interactionMap.values()) total += v;
  // Task 2.3 (R-SCALE): confidence floor is N-aware — read from the dynamic-formula
  // registry in `adaptiveConfig.ts`. The legacy literal `10` corresponded to
  // `computeEntropyConfidenceFloor(N)` at N=2..32; for larger N the floor grows as
  // `max(10, ceil(log2(N)*2))`, which is monotone in N (Property P1). The live N
  // is approximated by `edgeCache.bySource.size` — the same proxy already used
  // by `computeCounterpartyEntropy` below.
  const networkSize = edgeCache.bySource.size;
  const confidenceFloor = computeEntropyConfidenceFloor(networkSize);
  if (total < confidenceFloor) return 0; // low-confidence threshold — Requirement 5.6

  let H = 0;
  for (const [cpId, count] of interactionMap) {
    const p = count / total;
    if (p <= 0) continue;
    // Default to prior mean (α/(α+β) = 1/4 = 0.25) for unknown counterparties.
    const w = providerTrustMap.get(cpId) ?? 0.25;
    H -= w * p * Math.log2(p);
  }
  return Number.isFinite(H) ? round4(H) : 0;
}

/**
 * v2.1: Compute counterparty entropy for a provider.
 *
 * H(A) = -Σ pᵢ·log₂(pᵢ)
 *
 * where pᵢ = fraction of interactions with counterparty i.
 *
 * High entropy = diverse economic interactions (honest behavior)
 * Low entropy = concentrated clique behavior (suspicious)
 *
 * Returns { entropy, diversityScore } where diversityScore ∈ [0, 1].
 */
export async function computeCounterpartyEntropy(
  providerId: string,
  edgeCache?: EdgeCache
): Promise<{ entropy: number; diversityScore: number; uniqueCounterparties: number }> {
  // Task 2.3 (R-SCALE): pass live N to the window-entropy helper so its
  // diversityScore is computed against `minEntropyForFullTrust(N)` rather
  // than the legacy floor-only static `COUNTERPARTY_DIVERSITY.minEntropyForFullTrust`.
  const networkSizeForWindow = edgeCache ? edgeCache.bySource.size : 100;
  const fromWindow = computeCounterpartyEntropyFromWindow(providerId, networkSizeForWindow);
  if (fromWindow) return fromWindow;

  // Use pre-loaded edge cache if available, otherwise fall back to DB queries
  let outEdges: Array<{ targetProviderId: string; successfulCoJobs: number }>;
  let inEdges: Array<{ sourceProviderId: string; successfulCoJobs: number }>;

  if (edgeCache) {
    outEdges = edgeCache.bySource.get(providerId) ?? [];
    inEdges = edgeCache.byTarget.get(providerId) ?? [];
  } else {
    outEdges = await prisma.trustEdge.findMany({
      where: { sourceProviderId: providerId },
      select: { targetProviderId: true, successfulCoJobs: true, economicVolume: true },
    });
    inEdges = await prisma.trustEdge.findMany({
      where: { targetProviderId: providerId },
      select: { sourceProviderId: true, successfulCoJobs: true, economicVolume: true },
    });
  }

  // Build interaction frequency map: counterpartyId → total interactions
  const interactionMap = new Map<string, number>();
  for (const e of outEdges) {
    interactionMap.set(
      e.targetProviderId,
      (interactionMap.get(e.targetProviderId) ?? 0) + e.successfulCoJobs
    );
  }
  for (const e of inEdges) {
    interactionMap.set(
      (e as { sourceProviderId: string }).sourceProviderId,
      (interactionMap.get((e as { sourceProviderId: string }).sourceProviderId) ?? 0) + e.successfulCoJobs
    );
  }

  const uniqueCounterparties = interactionMap.size;
  if (uniqueCounterparties === 0) {
    return { entropy: 0, diversityScore: 0, uniqueCounterparties: 0 };
  }

  // Total interactions
  const totalInteractions = [...interactionMap.values()].reduce((s, v) => s + v, 0);
  if (totalInteractions === 0) {
    return { entropy: 0, diversityScore: 0, uniqueCounterparties };
  }

  // Shannon entropy: H = -Σ pᵢ·log₂(pᵢ)
  let entropy = 0;
  for (const count of interactionMap.values()) {
    const p = count / totalInteractions;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  const networkSize = edgeCache ? edgeCache.bySource.size : 100; // fallback
  const requiredEntropy = computeRequiredEntropy(networkSize);
  const diversityScore = Math.min(entropy / requiredEntropy, 1.0);

  return {
    entropy: round4(entropy),
    diversityScore: round4(diversityScore),
    uniqueCounterparties,
  };
}

/**
 * v2.2: Persist all network trust with confidence-gated diversity weighting.
 *
 * AdjustedTrust = baseTrust × diversityScore × pairSaturationMultiplier
 *
 * v2.2 improvement: Uses entropy confidence to avoid over-penalizing
 * agents with insufficient interaction history.
 */
export async function persistAllNetworkTrust(): Promise<void> {
  const allTrust = await computeAllNetworkTrust();

  // Fix 1+4: Build edge cache once and load all providers once (eliminates ~5000 queries/round)
  const edgeCache = await buildEdgeCache();
  const allProviders = await prisma.provider.findMany({
    where: { isActive: true },
    select: { id: true, totalJobs: true },
  });
  const providerJobsMap = new Map(allProviders.map(p => [p.id, p.totalJobs]));

  const updates: Array<{ id: string; networkTrust: number }> = [];

  for (const [providerId, baseTrust] of allTrust) {
    // v2.1: Counterparty entropy — THE primary collusion defense (uses cache)
    const { diversityScore, uniqueCounterparties } = await computeCounterpartyEntropy(providerId, edgeCache);

    // v2.2: Get total interactions for confidence gating (uses pre-loaded map)
    const totalInteractions = providerJobsMap.get(providerId) ?? 0;
    const confidence = computeEntropyConfidence(totalInteractions, allProviders.length);

    // ANTI-OVER-HARDENING: New agents have few edges by definition.
    // v2.2: Confidence-gated floor — smoother than hard edge-count threshold
    const totalEdgeCount = uniqueCounterparties;
    const confidenceFloor = 0.5 + (0.5 * (1 - confidence)); // Ranges from 1.0 (new) to 0.5 (mature)
    const effectiveDiversityScore = totalEdgeCount < TRUST_GRAPH_VALIDATION.minDiverseEdges
      ? Math.max(diversityScore, confidenceFloor)
      : diversityScore;

    // Providers with low diversity get dampened trust
    let adjustedTrust = baseTrust * effectiveDiversityScore;

    // Also check minimum diverse edges (v2 feature, preserved)
    const minDiverseEdges = TRUST_GRAPH_VALIDATION.minDiverseEdges;
    if (uniqueCounterparties > 0 && uniqueCounterparties < minDiverseEdges) {
      adjustedTrust *= uniqueCounterparties / minDiverseEdges;
    }

    // v2.1: Apply max single-pair contribution cap (uses cached edges)
    const outEdges = edgeCache.bySource.get(providerId) ?? [];
    if (outEdges.length > 0) {
      const totalWeight = outEdges.reduce((s, e) => s + e.weight, 0);
      const maxPairWeight = Math.max(...outEdges.map((e) => e.weight));
      const maxPairFraction = totalWeight > 0 ? maxPairWeight / totalWeight : 0;

      if (maxPairFraction > REPEATED_PAIR.maxSinglePairContribution) {
        const excess = maxPairFraction - REPEATED_PAIR.maxSinglePairContribution;
        adjustedTrust *= Math.max(0.2, 1 - excess * 2);
      }
    }

    const finalTrust = round4(Math.min(adjustedTrust, TRUST_GRAPH_VALIDATION.maxNetworkTrust));
    updates.push({ id: providerId, networkTrust: finalTrust });
  }

  // Fix 4: Batch all updates into a single transaction (1 disk flush instead of N)
  await prisma.$transaction(
    updates.map(u => prisma.provider.update({
      where: { id: u.id },
      data: { networkTrust: u.networkTrust },
    }))
  );
}

// ─── v2.9: Trust Neighborhood Contamination (SYBIL PROPAGATION FIX) ───────────

/**
 * Compute neighborhood contamination risk for all providers.
 * 
 * KEY INSIGHT: In sybil-cluster attacks, only 36.5% of sybils participate in the graph.
 * The remaining 63.5% are invisible to direct detection — they look like honest newcomers.
 * 
 * SOLUTION: Propagate suspicion from detected sybils to their graph neighbors.
 * If an agent's neighbors have elevated sybilRisk, the agent inherits partial suspicion.
 * 
 * This catches the "guilt by association" pattern without requiring direct evidence.
 * 
 * @param edgeCache - Pre-built edge cache for efficient neighbor lookup
 * @param providerSybilRisks - Current sybilRisk scores for all providers
 * @returns Map of providerId → neighborhood contamination risk [0, 1]
 */
export function computeNeighborhoodContamination(
  edgeCache: EdgeCache,
  providerSybilRisks: Map<string, number>
): Map<string, number> {
  const contaminationScores = new Map<string, number>();
  
  // For each provider, compute average sybilRisk of their graph neighbors
  for (const [providerId, outEdges] of edgeCache.bySource) {
    const inEdges = edgeCache.byTarget.get(providerId) ?? [];
    
    // Collect all neighbors (both directions)
    const neighbors = new Set<string>();
    for (const edge of outEdges) {
      neighbors.add(edge.targetProviderId);
    }
    for (const edge of inEdges) {
      neighbors.add(edge.sourceProviderId);
    }
    
    if (neighbors.size === 0) {
      contaminationScores.set(providerId, 0);
      continue;
    }
    
    // Calculate weighted average sybilRisk of neighbors
    let totalRisk = 0;
    let totalWeight = 0;
    
    for (const neighborId of neighbors) {
      const neighborRisk = providerSybilRisks.get(neighborId) ?? 0;
      
      // Weight by edge strength (bidirectional edges count more)
      let edgeWeight = 0;
      const outEdge = outEdges.find(e => e.targetProviderId === neighborId);
      const inEdge = inEdges.find(e => e.sourceProviderId === neighborId);
      
      if (outEdge) edgeWeight += outEdge.weight;
      if (inEdge) edgeWeight += inEdge.weight;
      
      totalRisk += neighborRisk * edgeWeight;
      totalWeight += edgeWeight;
    }
    
    const avgNeighborRisk = totalWeight > 0 ? totalRisk / totalWeight : 0;
    
    // v2.9 Fix: Contamination factor increased from 0.30 to 0.50
    // Stronger propagation needed to detect non-participating sybils (63.5% without graph activity)
    const contaminationFactor = 0.50;
    
    // v2.9 Fix: Lowered threshold from 0.25 to 0.15
    // More sensitive to suspicious neighborhoods, catches earlier-stage attacks
    const threshold = 0.15;
    const contaminationRisk = avgNeighborRisk > threshold 
      ? avgNeighborRisk * contaminationFactor 
      : 0;
    
    // v2.9 Fix: Increased cap from 0.3 to 0.5
    // Allows stronger penalties for high-risk neighborhoods
    const cappedRisk = Math.min(contaminationRisk, 0.5);
    
    contaminationScores.set(providerId, round4(cappedRisk));
  }
  
  // Handle providers with no edges (they get 0 contamination)
  for (const [providerId] of providerSybilRisks) {
    if (!contaminationScores.has(providerId)) {
      contaminationScores.set(providerId, 0);
    }
  }
  
  return contaminationScores;
}

// ─── v2: Enhanced Sybil Detection ─────────────────────────────────────────────

export interface SybilCluster {
  providerIds: string[];
  clusterDensity: number;
  suspicionScore: number;
  reasons: string[];
}

/**
 * v2: Detect Sybil clusters with enhanced heuristics:
 *   - Dense cluster detection (same as v1)
 *   - Circular pattern penalty (NEW)
 *   - Edge diversity penalty (NEW)
 *   - Uniform weight detection (enhanced)
 */
export async function detectSybilClusters(): Promise<SybilCluster[]> {
  const edges = await prisma.trustEdge.findMany();
  const providers = await prisma.provider.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  if (providers.length < 2 || edges.length < 2) return [];

  // Build directed adjacency map (only for providers that have edges)
  const adj = new Map<string, Set<string>>();
  const edgeWeightMap = new Map<string, number>();

  for (const p of providers) {
    adj.set(p.id, new Set());
  }
  for (const e of edges) {
    adj.get(e.sourceProviderId)?.add(e.targetProviderId);
    edgeWeightMap.set(`${e.sourceProviderId}→${e.targetProviderId}`, e.weight);
  }

  // v2.2: Run Tarjan's SCC — finds ALL directed cycles of any length in O(V+E)
  const rawSCCs = runTarjanSCC(adj);

  // Only non-trivial SCCs (size ≥ 2) indicate directed cycles → potentially sybil
  const nonTrivialSCCs = rawSCCs.filter((scc) => scc.length >= 2);
  if (nonTrivialSCCs.length === 0) return [];

  // Build SCC membership map for external-connectivity checks
  const sccMembership = new Map<string, number>();
  rawSCCs.forEach((scc, idx) => {
    for (const id of scc) sccMembership.set(id, idx);
  });

  const clusters: SybilCluster[] = [];

  for (const scc of nonTrivialSCCs) {
    const sccSet = new Set(scc);
    const reasons: string[] = [];
    let suspicionBase = 0;

    // Signal 1: SCC size — larger rings are more organised and suspicious
    if (scc.length >= 3) {
      suspicionBase += 0.40;
      reasons.push(`Directed cycle detected: SCC size=${scc.length}`);
    } else {
      suspicionBase += 0.20;
      reasons.push(`Mutual trust pair: SCC size=2`);
    }
    if (scc.length >= 10) {
      suspicionBase += 0.15;
      reasons.push(`Large organised ring (size ≥ 10)`);
    }

    // Signal 2: External isolation — members that have ZERO out-edges leaving the SCC
    let isolatedCount = 0;
    for (const id of scc) {
      const outNeighbours = adj.get(id) ?? new Set<string>();
      const externalOut = [...outNeighbours].filter((n) => !sccSet.has(n)).length;
      if (externalOut === 0 && outNeighbours.size > 0) isolatedCount++;
    }
    const isolationRatio = isolatedCount / scc.length;
    if (isolationRatio >= 0.6) {
      suspicionBase += 0.30;
      reasons.push(`${isolatedCount}/${scc.length} members have zero external out-edges`);
    } else if (isolationRatio >= 0.3) {
      suspicionBase += 0.15;
      reasons.push(`${isolatedCount}/${scc.length} members have zero external out-edges`);
    }

    // Signal 3: Uniform internal edge weights (low CV → fabricated edges)
    const internalWeights: number[] = [];
    for (const src of scc) {
      for (const tgt of scc) {
        const w = edgeWeightMap.get(`${src}→${tgt}`);
        if (w !== undefined) internalWeights.push(w);
      }
    }
    if (internalWeights.length >= 3) {
      const mean = internalWeights.reduce((s, w) => s + w, 0) / internalWeights.length;
      const variance = internalWeights.reduce((s, w) => s + (w - mean) ** 2, 0) / internalWeights.length;
      const cv = Math.sqrt(variance) / (mean || 1);
      if (cv < 0.15) {
        suspicionBase += 0.20;
        reasons.push(`Uniform internal edge weights (CV=${cv.toFixed(3)})`);
      }
    }

    // Signal 4: Bidirectional pairs within the SCC (still counts extra)
    let circularPairs = 0;
    for (const src of scc) {
      for (const tgt of scc) {
        if (src !== tgt && adj.get(src)?.has(tgt) && adj.get(tgt)?.has(src)) {
          circularPairs++;
        }
      }
    }
    const circularPairsUnique = circularPairs / 2;
    if (circularPairsUnique > 0) {
      suspicionBase += Math.min(
        circularPairsUnique * TRUST_GRAPH_VALIDATION.circularPenaltyPerCycle,
        TRUST_GRAPH_VALIDATION.maxCircularPenalty
      );
      reasons.push(`${circularPairsUnique} bidirectional trust pairs within cluster`);
    }

    const suspicionScore = Math.min(suspicionBase, 1.0);

    // Internal density is computed as fraction of possible directed edges present
    const possibleInternalEdges = scc.length * (scc.length - 1);
    const actualInternalEdges = internalWeights.length;
    const clusterDensity = possibleInternalEdges > 0
      ? actualInternalEdges / possibleInternalEdges
      : 0;

    clusters.push({
      providerIds: scc,
      clusterDensity: round4(clusterDensity),
      suspicionScore: round4(suspicionScore),
      reasons,
    });
  }

  return clusters;
}

/**
 * v2.2: Update sybilRisk for all providers.
 *
 * Fully rewritten to use Tarjan SCC-based detection so that directed ring
 * attacks (collusionRing.ts) are correctly detected regardless of ring size.
 *
 * Performance: O(V + E) graph algorithms run in-memory after two DB reads.
 * All writes are done in a single batch at the end (no per-provider queries).
 */
export async function updateSybilRiskScores(): Promise<void> {
  // ── 1. Load graph from DB ─────────────────────────────────────────────────
  const [edges, providers] = await Promise.all([
    prisma.trustEdge.findMany(),
    prisma.provider.findMany({ where: { isActive: true }, select: { id: true } }),
  ]);

  // ── 2. Build in-memory adjacency maps ────────────────────────────────────
  const adj = new Map<string, Set<string>>();
  const reverseAdj = new Map<string, Set<string>>();
  const edgeWeightMap = new Map<string, number>();
  const edgeVolumeMap = new Map<string, number>();

  for (const p of providers) {
    adj.set(p.id, new Set());
    reverseAdj.set(p.id, new Set());
  }
  for (const e of edges) {
    adj.get(e.sourceProviderId)?.add(e.targetProviderId);
    reverseAdj.get(e.targetProviderId)?.add(e.sourceProviderId);
    edgeWeightMap.set(`${e.sourceProviderId}→${e.targetProviderId}`, e.weight);
    edgeVolumeMap.set(`${e.sourceProviderId}→${e.targetProviderId}`, e.economicVolume);
  }

  // ── 3. Run Tarjan SCC — detects all directed cycles in O(V+E) ──────────
  const allSCCs = runTarjanSCC(adj);
  const sccMembership = new Map<string, number>();
  allSCCs.forEach((scc, idx) => {
    for (const id of scc) sccMembership.set(id, idx);
  });

  // ── 4. Compute sybil risk per provider ───────────────────────────────────
  // Inline SCC scoring — avoids a second DB load + second Tarjan run that
  // detectSybilClusters() would trigger if called separately here.
  await prisma.provider.updateMany({ where: { isActive: true }, data: { sybilRisk: 0 } });

  const riskAccum = new Map<string, number>();
  for (const p of providers) riskAccum.set(p.id, 0);

  // 4a. Score each non-trivial SCC directly from the already-computed allSCCs
  for (const scc of allSCCs) {
    if (scc.length < 2) continue;
    const sccSet = new Set(scc);
    let suspicion = scc.length >= 10 ? 0.55 : scc.length >= 3 ? 0.40 : 0.20;

    // External isolation bonus
    let isolated = 0;
    for (const id of scc) {
      const out = adj.get(id) ?? new Set<string>();
      if (out.size > 0 && [...out].every((n) => sccSet.has(n))) isolated++;
    }
    const isolationRatio = isolated / scc.length;
    if (isolationRatio >= 0.6) suspicion += 0.30;
    else if (isolationRatio >= 0.3) suspicion += 0.15;

    // Uniform weights bonus
    const weights: number[] = [];
    for (const src of scc) {
      for (const tgt of scc) {
        const w = edgeWeightMap.get(`${src}→${tgt}`);
        if (w !== undefined) weights.push(w);
      }
    }
    if (weights.length >= 3) {
      const mean = weights.reduce((s, w) => s + w, 0) / weights.length;
      const cv = Math.sqrt(weights.reduce((s, w) => s + (w - mean) ** 2, 0) / weights.length) / (mean || 1);
      if (cv < 0.15) suspicion += 0.20;
    }

    const score = Math.min(suspicion, 1.0);
    for (const pid of scc) {
      riskAccum.set(pid, Math.max(riskAccum.get(pid) ?? 0, score));
    }
  }

  // ── TRACE-DR: Distribution-Robust spectral gap thresholding (WWW v2) ──────
  //
  // When DR is enabled, we first collect all |λ₂| values across SCCs, then
  // compute an adaptive threshold: max(config.threshold, mean(λ₂) + 2σ).
  // On dense graphs where ALL SCCs have elevated λ₂, this lifts the threshold
  // so only statistical outliers are flagged — fixing the dense-graph gate
  // failure mode documented in futureworks.md.
  //
  // When DR is disabled, the original absolute threshold (0.85) is used.
  // Citation: Tartakovsky, Nikiforov, Basseville (2014) — adaptive thresholds.

  // Phase 1: Collect all lambda2 values
  const sccLambdas: Array<{ scc: string[]; lambda2: number }> = [];
  for (const scc of allSCCs) {
    if (scc.length < SPECTRAL_GAP_CONFIG.minSCCSize) continue;
    const lambda2 = computeSpectralGap(scc, edgeWeightMap);
    sccLambdas.push({ scc, lambda2 });
  }

  // Phase 2: Compute adaptive threshold when DR is enabled
  let spectralThreshold: number = SPECTRAL_GAP_CONFIG.threshold;
  let adaptiveParticipation: number = SPECTRAL_GAP_CONFIG.participationThreshold;

  if (V2_FLAGS.DR_ENABLED && sccLambdas.length >= 2) {
    // Compute mean and stddev of lambda2 across all qualifying SCCs
    const lambdaValues = sccLambdas.map(s => s.lambda2);
    const lambdaMean = lambdaValues.reduce((s, v) => s + v, 0) / lambdaValues.length;
    const lambdaVariance = lambdaValues.reduce((s, v) => s + (v - lambdaMean) ** 2, 0)
      / lambdaValues.length;
    const lambdaStddev = Math.sqrt(lambdaVariance);

    // Adaptive threshold: only flag SCCs whose λ₂ is > mean + 2σ
    // Falls back to config.threshold when the distribution is tight (all low λ₂)
    spectralThreshold = Math.max(
      SPECTRAL_GAP_CONFIG.threshold,
      lambdaMean + 2 * lambdaStddev
    );

    // Adaptive participation: 2× random baseline edge density
    // On dense graphs, random baseline is higher → threshold rises
    let totalEdgeCount = 0;
    for (const [, nbrs] of adj) totalEdgeCount += nbrs.size;
    const N = Math.max(2, adj.size);
    const randomBaselineDensity = totalEdgeCount / (N * N);
    adaptiveParticipation = Math.max(
      SPECTRAL_GAP_CONFIG.participationThreshold,
      2 * randomBaselineDensity
    );
  }

  // Phase 3: Apply spectral gap detection with (possibly adaptive) threshold
  for (const { scc, lambda2 } of sccLambdas) {
    if (lambda2 > spectralThreshold) {
      // Attenuation: (1 - |λ₂|)^γ → near-zero for ring-like structures
      const attenuation = Math.pow(1 - lambda2, SPECTRAL_GAP_CONFIG.gamma);
      const spectralRisk = 1 - attenuation; // ≈ 1.0 for rings

      const sccSet = new Set(scc);

      for (const pid of scc) {
        // Per-node ring participation: what fraction of this node's edges
        // (both in and out) are internal to the SCC?
        // True ring members: most/all edges are internal (participation ≈ 1.0)
        // Honest agents pulled in: most edges are external (participation ≈ 0.1–0.3)
        const outEdges = adj.get(pid) ?? new Set<string>();
        const inEdges = reverseAdj.get(pid) ?? new Set<string>();
        const totalEdges = outEdges.size + inEdges.size;

        if (totalEdges === 0) continue;

        let internalEdges = 0;
        for (const tgt of outEdges) {
          if (sccSet.has(tgt)) internalEdges++;
        }
        for (const src of inEdges) {
          if (sccSet.has(src)) internalEdges++;
        }

        const participation = internalEdges / totalEdges;

        // Apply spectral penalty with (possibly adaptive) participation threshold
        if (participation > adaptiveParticipation) {
          // Scale the risk by participation — nodes deeply embedded in the ring
          // get full penalty, nodes at the periphery get proportionally less.
          const scaledRisk = spectralRisk * participation;
          riskAccum.set(pid, Math.min(1.0, Math.max(riskAccum.get(pid) ?? 0, scaledRisk)));
        }
      }
    }
  }

  // 4b. Individual secondary signals (computed from in-memory graph — no extra DB calls)
  // v4.1 Perf: Compute dense subgraph risk ONCE outside the loop (was O(N²×E), now O(N×E))
  const denseSubgraphRisks = detectDenseSubgraphRisk(adj);

  // ── TRACE-CR: Community-Refined sybil detection (WWW v2) ────────────────
  //
  // When CR is enabled, run Louvain community detection and compute
  // per-community baseline density. Dense subgraph risk is then normalized
  // against the community baseline: nodes in naturally dense honest
  // communities have their risk attenuated, while nodes in anomalously
  // dense clusters (relative to their community) retain full risk.
  //
  // This fixes the OTC sybil regression where honest Bitcoin OTC community
  // structure (naturally high clustering) was misidentified as sybil mesh.
  //
  // Citation: Blondel et al. (2008); Newman (2006) on modularity.
  let communityDensityBaseline: Map<string, number> | null = null;

  if (V2_FLAGS.CR_ENABLED) {
    const communities = detectCommunities(adj);

    // Group nodes by community and compute internal density per community
    const communityMembers = new Map<string, string[]>();
    for (const [nodeId, commId] of communities) {
      if (!communityMembers.has(commId)) communityMembers.set(commId, []);
      communityMembers.get(commId)!.push(nodeId);
    }

    communityDensityBaseline = new Map<string, number>();
    for (const [commId, members] of communityMembers) {
      if (members.length < 2) {
        for (const m of members) communityDensityBaseline.set(m, 0);
        continue;
      }
      // Compute internal edge density for this community
      const memberSet = new Set(members);
      let internalEdges = 0;
      for (const m of members) {
        for (const nbr of adj.get(m) ?? []) {
          if (memberSet.has(nbr)) internalEdges++;
        }
      }
      const possibleEdges = members.length * (members.length - 1);
      const communityDensity = possibleEdges > 0 ? internalEdges / possibleEdges : 0;
      for (const m of members) {
        communityDensityBaseline.set(m, communityDensity);
      }
    }
  }

  for (const p of providers) {
    let additional = 0;

    // Depth-limited DFS — catches short cycles (≤ 5 hops) as a secondary signal
    // (Tarjan above already handles long rings; DFS here adds a cheap extra nudge)
    const cycles = detectCircularPatternsFromGraph(p.id, adj, 5);
    if (cycles > 0) {
      additional += Math.min(
        cycles * TRUST_GRAPH_VALIDATION.circularPenaltyPerCycle,
        TRUST_GRAPH_VALIDATION.maxCircularPenalty
      );
    }

    // External connectivity diversity
    const diversity = computeEdgeDiversityFromGraph(
      p.id, adj, reverseAdj, sccMembership, edgeVolumeMap
    );
    if (diversity < 0.3) {
      additional += 0.1;
    }

    // v2.9: DENSE SUBGRAPH DETECTION (Fix 1) — catches collusion meshes
    // Mesh topologies don't form large SCCs but have high local clustering
    let collusionRisk = denseSubgraphRisks.get(p.id) ?? 0;

    // CR normalization: attenuate risk for nodes in naturally dense communities
    if (V2_FLAGS.CR_ENABLED && communityDensityBaseline && collusionRisk > 0) {
      const baseline = communityDensityBaseline.get(p.id) ?? 0;
      // If the node's community is naturally dense (baseline > 0.1),
      // the Charikar density is less anomalous → attenuate the risk.
      // anomalyRatio = 1.0 when baseline is near 0 (sparse community → anomaly is real)
      // anomalyRatio → 0.3 when baseline is high (dense community → likely honest)
      if (baseline > 0.05) {
        const anomalyRatio = Math.max(0.3, 1.0 - baseline * 2);
        collusionRisk *= anomalyRatio;
      }
    }

    if (collusionRisk > 0) {
      additional += collusionRisk;
    }

    if (additional > 0) {
      riskAccum.set(p.id, Math.min((riskAccum.get(p.id) ?? 0) + additional, 1.0));
    }
  }

  // ── 5. Co-failure correlation propagation (v4.3) ───────────────────────────
  //
  // Problem: At N=1000, only ~10% of ring agents participate in graph
  // manipulation (sqrt-scaled participation). The remaining 90% have zero
  // graph edges and sybilRisk=0, making them invisible to all graph-based
  // detectors. Yet they still default at the same rate and in the same
  // temporal pattern as the detected ring members.
  //
  // Solution: Propagate sybil risk from detected agents (sybilRisk > 0) to
  // agents who exhibit statistically correlated failure patterns. This is
  // NOT guilt-by-association (which would penalize honest neighbors) — it
  // specifically targets agents whose FAILURE TIMING correlates with known
  // bad actors.
  //
  // Theoretical basis: Coordinated attacks produce temporal failure
  // correlation that is statistically improbable under independence.
  // If agent A (detected, sybilRisk > 0.3) and agent B (undetected,
  // sybilRisk = 0) both default in the same rounds at a rate exceeding
  // the independence baseline, B is likely part of the same coordinated
  // group.
  //
  // Method: Jaccard similarity on failure-round sets.
  //   J(A, B) = |F_A ∩ F_B| / |F_A ∪ F_B|
  //
  // Under independence with failure rate p, the expected Jaccard similarity
  // between two agents over T rounds is:
  //   E[J] = p² / (2p - p²) = p / (2 - p)
  //
  // At p=0.15: E[J] = 0.15 / 1.85 ≈ 0.081
  // At p=0.05: E[J] = 0.05 / 1.95 ≈ 0.026
  //
  // We flag correlation when J > 3× the expected baseline under the
  // observed failure rate. For p=0.15: threshold = 3 × 0.081 = 0.243.
  // We use a conservative fixed threshold of 0.20 which is ~2.5× the
  // baseline at p=0.15 and ~8× the baseline at p=0.05.
  //
  // Citation:
  //   - Jaccard (1912) — similarity coefficient for set comparison
  //   - Chandola et al. (2009) "Anomaly Detection: A Survey" — temporal
  //     correlation as a collective anomaly signal
  //   - Akoglu et al. (2015) "Graph-based Anomaly Detection" — propagation
  //     of suspicion scores through behavioral similarity networks
  //
  // False positive analysis:
  //   - Two honest agents with independent 5% failure rates over 60 rounds
  //     each fail ~3 times. Expected overlap: 3×3/60 ≈ 0.15 rounds.
  //     Jaccard = 0.15 / (3+3-0.15) ≈ 0.026. Well below threshold 0.20.
  //   - Two honest agents with independent 12% failure rates over 60 rounds
  //     each fail ~7 times. Expected overlap: 7×7/60 ≈ 0.82 rounds.
  //     Jaccard = 0.82 / (7+7-0.82) ≈ 0.062. Well below threshold 0.20.
  //   - Two coordinated agents with 15% failure in the SAME rounds:
  //     Each fails ~9 times, overlap = 9. Jaccard = 9/9 = 1.0. Far above.
  //   - Even partial coordination (50% overlap): Jaccard ≈ 0.5. Above.
  //
  // The propagated risk is scaled by the Jaccard similarity and capped at
  // 50% of the source agent's risk, preventing runaway amplification.

  // Only run propagation if we have detected agents to propagate from
  const detectedAgents = [...riskAccum.entries()]
    .filter(([_, risk]) => risk >= 0.30)
    .map(([id]) => id);

  if (detectedAgents.length > 0) {
    // Load failure rounds for all providers (batch query)
    const allFailedJobs = await prisma.job.findMany({
      where: {
        providerId: { in: providers.map(p => p.id) },
        status: "failed",
      },
      select: { providerId: true, input: true },
    });

    // Build failure-round sets per provider
    const failureRounds = new Map<string, Set<number>>();
    for (const job of allFailedJobs) {
      let round: number | null = null;
      try {
        const parsed = JSON.parse(job.input) as { round?: unknown };
        if (typeof parsed.round === "number") round = parsed.round;
      } catch { /* ignore parse errors */ }
      if (round === null) continue;

      if (!failureRounds.has(job.providerId)) {
        failureRounds.set(job.providerId, new Set());
      }
      failureRounds.get(job.providerId)!.add(round);
    }

    // For each undetected provider, compute Jaccard similarity with detected agents.
    //
    // Adaptive strategy:
    //   N ≤ 5000 → Exact pairwise Jaccard (fast at this scale)
    //   N > 5000 → MinHash signatures with 128 hash functions for
    //               (1±ε)-approximate Jaccard. Reduces O(D×U×F) to
    //               O((D+U)×128) for signature construction + O(D×U×128)
    //               for cache-friendly integer comparison.
    // Citation: Broder (1997); Indyk & Motwani (1998).
    const CORRELATION_THRESHOLD = 0.20;
    const MIN_FAILURES_FOR_CORRELATION = 3; // Need at least 3 failures to be meaningful
    const MAX_PROPAGATED_RISK = 0.50; // Cap propagated risk at 50% of source

    const useMinHash = providers.length > 5000;

    // ── MinHash infrastructure (only initialized when needed) ────────────
    const NUM_HASHES = 128;
    const PRIME = 2147483647; // 2^31 - 1 (Mersenne prime)
    let hashA: Uint32Array | null = null;
    let hashB: Uint32Array | null = null;
    let minHashSigs: Map<string, Uint32Array> | null = null;

    if (useMinHash) {
      // Pre-generate universal hash coefficients: h_k(x) = (a_k * x + b_k) mod p
      hashA = new Uint32Array(NUM_HASHES);
      hashB = new Uint32Array(NUM_HASHES);
      // Use deterministic seed-like initialization for reproducibility
      for (let h = 0; h < NUM_HASHES; h++) {
        hashA[h] = ((h * 6364136223846793005 + 1442695040888963407) >>> 0) % (PRIME - 1) + 1;
        hashB[h] = ((h * 1103515245 + 12345) >>> 0) % PRIME;
      }

      // Build MinHash signatures for all providers with failures
      minHashSigs = new Map();
      for (const [providerId, rounds] of failureRounds) {
        if (rounds.size < MIN_FAILURES_FOR_CORRELATION) continue;
        const sig = new Uint32Array(NUM_HASHES).fill(0xFFFFFFFF);
        for (const round of rounds) {
          for (let h = 0; h < NUM_HASHES; h++) {
            const hash = ((hashA![h] * round + hashB![h]) % PRIME) >>> 0;
            if (hash < sig[h]) sig[h] = hash;
          }
        }
        minHashSigs.set(providerId, sig);
      }
    }

    /** Estimate Jaccard similarity — exact or MinHash depending on N */
    function estimateJaccard(
      setA: Set<number> | undefined,
      setB: Set<number> | undefined,
      idA: string,
      idB: string
    ): number {
      if (!setA || !setB) return 0;
      if (setA.size < MIN_FAILURES_FOR_CORRELATION ||
          setB.size < MIN_FAILURES_FOR_CORRELATION) return 0;

      if (useMinHash && minHashSigs) {
        // MinHash: compare signatures
        const sigA = minHashSigs.get(idA);
        const sigB = minHashSigs.get(idB);
        if (!sigA || !sigB) return 0;
        let matches = 0;
        for (let i = 0; i < NUM_HASHES; i++) {
          if (sigA[i] === sigB[i]) matches++;
        }
        return matches / NUM_HASHES;
      } else {
        // Exact Jaccard on failure-round sets
        let intersectionSize = 0;
        for (const round of setA) {
          if (setB.has(round)) intersectionSize++;
        }
        const unionSize = setA.size + setB.size - intersectionSize;
        return unionSize > 0 ? intersectionSize / unionSize : 0;
      }
    }

    for (const p of providers) {
      // Skip already-detected agents
      if ((riskAccum.get(p.id) ?? 0) >= 0.20) continue;

      const pFailures = failureRounds.get(p.id);
      if (!pFailures || pFailures.size < MIN_FAILURES_FOR_CORRELATION) continue;

      let maxCorrelation = 0;
      let maxSourceRisk = 0;

      for (const detectedId of detectedAgents) {
        const dFailures = failureRounds.get(detectedId);
        const jaccard = estimateJaccard(pFailures, dFailures, p.id, detectedId);

        if (jaccard > maxCorrelation) {
          maxCorrelation = jaccard;
          maxSourceRisk = riskAccum.get(detectedId) ?? 0;
        }
      }

      // Propagate risk if correlation exceeds threshold
      if (maxCorrelation > CORRELATION_THRESHOLD && maxSourceRisk > 0) {
        // Propagated risk = sourceRisk × correlation × cap
        // This ensures:
        //   - Higher correlation → more risk propagated
        //   - Higher source risk → more risk propagated
        //   - Never exceeds MAX_PROPAGATED_RISK × sourceRisk
        const propagatedRisk = Math.min(
          maxSourceRisk * maxCorrelation * MAX_PROPAGATED_RISK,
          maxSourceRisk * MAX_PROPAGATED_RISK
        );

        const currentRisk = riskAccum.get(p.id) ?? 0;
        riskAccum.set(p.id, Math.min(1.0, Math.max(currentRisk, propagatedRisk)));
      }
    }
  }

  // ── 6. Batch-write all sybilRisk updates ─────────────────────────────────
  // Group providers by risk value to minimise update calls
  const byRisk = new Map<number, string[]>();
  for (const [id, risk] of riskAccum) {
    if (risk <= 0) continue; // already reset to 0
    const key = round4(risk);
    if (!byRisk.has(key)) byRisk.set(key, []);
    byRisk.get(key)!.push(id);
  }

  for (const [risk, ids] of byRisk) {
    await prisma.provider.updateMany({
      where: { id: { in: ids } },
      data: { sybilRisk: risk },
    });
  }
}

// ─── v2.9: Dense Subgraph Detection (Collusion Mesh Detection) ───────────────

// ─── Temporal Trust Decay ─────────────────────────────────────────────────────

/**
 * v2: Apply temporal decay with inactivity penalties.
 */
export async function applyTemporalDecay(): Promise<number> {
  const edges = await prisma.trustEdge.findMany();
  const now = Date.now();
  let updatedCount = 0;

  for (const edge of edges) {
    const age = now - edge.lastInteraction.getTime();
    const decayFactor = Math.pow(0.5, age / TRUST_DECAY.halfLifeMs);

    if (decayFactor < 0.95) {
      const newWeight = round4(edge.weight * decayFactor);

      if (newWeight < 0.01) {
        await prisma.trustEdge.delete({ where: { id: edge.id } });
      } else {
        await prisma.trustEdge.update({
          where: { id: edge.id },
          data: { weight: newWeight },
        });
      }
      updatedCount++;
    }
  }

  return updatedCount;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
