/**
 * Sliding-window interaction history for experiment-time entropy (Final_implementation.md).
 * When enabled, computeCounterpartyEntropy uses recent co-job pairs only instead of the full DB graph.
 */

import { minEntropyForFullTrust } from "./adaptiveConfig";

export interface InteractionRecord {
  round: number;
  providerId: string;
  counterpartyId: string;
  outcome: 0 | 1;
}

export interface WindowEntropyResult {
  entropy: number;
  diversityScore: number;
  uniqueCounterparties: number;
}

const HISTORY_WINDOW_DEFAULT = 200;

let windowEnabled = false;
let maxRounds = HISTORY_WINDOW_DEFAULT;
let records: InteractionRecord[] = [];

/**
 * N-independent component of the per-provider window entropy. The diversity
 * score is computed on demand (in `computeCounterpartyEntropyFromWindow`)
 * because it depends on the live network size N — caching it here would
 * tie cache validity to N, which is not the cache's invariant.
 */
interface WindowEntropyCacheEntry {
  entropy: number;
  uniqueCounterparties: number;
}

/** Rebuilt when `records.length` changes — avoids O(|records|) per provider during routing. */
let cacheRecordsLen = -1;
const entropyCacheByProvider = new Map<string, WindowEntropyCacheEntry>();

export function enableTraceInteractionWindow(rounds: number = HISTORY_WINDOW_DEFAULT): void {
  windowEnabled = true;
  maxRounds = rounds > 0 ? rounds : HISTORY_WINDOW_DEFAULT;
  records = [];
  cacheRecordsLen = -1;
  entropyCacheByProvider.clear();
}

export function disableTraceInteractionWindow(): void {
  windowEnabled = false;
  records = [];
  cacheRecordsLen = -1;
  entropyCacheByProvider.clear();
}

export function isTraceInteractionWindowEnabled(): boolean {
  return windowEnabled;
}

export function traceInteractionWindowPush(record: InteractionRecord): void {
  if (!windowEnabled) return;
  records.push(record);
}

/** Call once per simulation round after processing jobs. */
export function traceInteractionWindowPrune(currentRound: number): void {
  if (!windowEnabled) return;
  const cutoff = currentRound - maxRounds;
  let lo = 0;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid].round < cutoff) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) records = records.slice(lo);
  cacheRecordsLen = -1;
  entropyCacheByProvider.clear();
}

/**
 * Record a successful co-job between two providers (both directions) for entropy.
 */
export function traceInteractionWindowRecordCoJob(
  round: number,
  providerA: string,
  providerB: string
): void {
  traceInteractionWindowPush({
    round,
    providerId: providerA,
    counterpartyId: providerB,
    outcome: 1,
  });
  traceInteractionWindowPush({
    round,
    providerId: providerB,
    counterpartyId: providerA,
    outcome: 1,
  });
}

/**
 * Compute the N-independent entropy and counterparty count from an interaction map.
 * The diversity score is intentionally NOT computed here — it depends on the live
 * network size N and is computed on demand by `computeCounterpartyEntropyFromWindow`
 * via `minEntropyForFullTrust(N)` (rewired by Task 2.3 of the trace-adversarial-coevolution
 * audit; replaces the static `COUNTERPARTY_DIVERSITY.minEntropyForFullTrust` read).
 */
function entropyFromCounts(interactionMap: Map<string, number>): WindowEntropyCacheEntry {
  const uniqueCounterparties = interactionMap.size;
  if (uniqueCounterparties === 0) {
    return { entropy: 0, uniqueCounterparties: 0 };
  }

  const totalInteractions = [...interactionMap.values()].reduce((s, v) => s + v, 0);
  if (totalInteractions === 0) {
    return { entropy: 0, uniqueCounterparties };
  }

  let entropy = 0;
  for (const count of interactionMap.values()) {
    const p = count / totalInteractions;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  return {
    entropy: Math.round(entropy * 10000) / 10000,
    uniqueCounterparties,
  };
}

/** Single O(|records|) pass: all providers seen in the window. */
function rebuildWindowEntropyCache(): void {
  entropyCacheByProvider.clear();
  const perProvider = new Map<string, Map<string, number>>();
  for (const r of records) {
    let m = perProvider.get(r.providerId);
    if (!m) {
      m = new Map();
      perProvider.set(r.providerId, m);
    }
    const k = r.counterpartyId;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  for (const [pid, interactionMap] of perProvider) {
    entropyCacheByProvider.set(pid, entropyFromCounts(interactionMap));
  }
  cacheRecordsLen = records.length;
}

function ensureWindowEntropyCache(): void {
  if (!windowEnabled) return;
  if (cacheRecordsLen !== records.length) {
    rebuildWindowEntropyCache();
  }
}

/**
 * Compute the window entropy result for a provider using the live network size N.
 *
 * The diversity score is computed against `minEntropyForFullTrust(N)` from the
 * dynamic-formula registry in `adaptiveConfig.ts` (Task 2.3 rewire of R-SCALE):
 * the legacy static `COUNTERPARTY_DIVERSITY.minEntropyForFullTrust = 1.5` is now
 * floor-only and live consumers — including this one — must read the registry
 * function instead. `networkSize` is supplied by the caller (`trustGraph.ts::
 * computeCounterpartyEntropy`) and is the same N used by the rest of the
 * scoring pipeline.
 */
export function computeCounterpartyEntropyFromWindow(
  providerId: string,
  networkSize: number
): WindowEntropyResult | null {
  if (!windowEnabled) return null;

  ensureWindowEntropyCache();
  const cached = entropyCacheByProvider.get(providerId) ?? {
    entropy: 0,
    uniqueCounterparties: 0,
  };

  const requiredEntropy = minEntropyForFullTrust(networkSize);
  const diversityScore = requiredEntropy > 0
    ? Math.min(cached.entropy / requiredEntropy, 1.0)
    : 0;

  return {
    entropy: cached.entropy,
    diversityScore: Math.round(diversityScore * 10000) / 10000,
    uniqueCounterparties: cached.uniqueCounterparties,
  };
}
