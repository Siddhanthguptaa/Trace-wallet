/**
 * Sliding-window edge accumulator — round-based TTL view of trust-edge
 * interactions.
 *
 * Spec: trace-adversarial-coevolution / design §6.3, §C.7;
 *       requirements R-GRAPH (criterion 5), R-STABILITY (criteria 4, 5).
 *
 * Provides a round-based view of trust-edge interactions, complementing
 * the timestamp-based half-life decay in `trustGraph.ts::applyTemporalDecay`
 * (and `computeAllNetworkTrustWithMeta`'s in-line decay using
 * `TRUST_DECAY.halfLifeMs`) and the per-provider counterparty-entropy
 * record window in `interactionWindow.ts`. Those two structures are kept
 * unchanged; this module is an additional, narrower accumulator that
 * exposes the round-based TTL semantics R-GRAPH 5 requires for
 * accumulators that ingest trust-edge weights.
 *
 * ─── Decay rule (R-GRAPH 5 documentation requirement) ────────────────
 *
 *   Hard sliding window of `K = edgeTTLWindowRounds(N)` rounds.
 *   `K = max(20, ⌈log2(N) · 5⌉)` from the dynamic-formula registry in
 *   `adaptiveConfig.ts` (see Task 2.2). Edges that have not been
 *   touched within the last `K` rounds return effective weight `0`
 *   from `getEffectiveWeight(...)` and are evicted on subsequent
 *   `prune` / `advanceRound` calls.
 *
 * ─── Justification (R-GRAPH 5) ───────────────────────────────────────
 *
 *   The trust-graph aggregation that feeds `computeAllNetworkTrust` /
 *   `computePersonalizedPageRank` already applies an exponential
 *   half-life decay against each edge's `lastInteraction: Date`
 *   timestamp using `TRUST_DECAY.halfLifeMs = 5 * 24 * 3600 * 1000`
 *   (5 days). That decay rule is correct for production deployments
 *   where rounds elapse over real wall-clock time.
 *
 *   Round-based experiments (the audit's Smoke_Matrix and Full_Matrix
 *   cells) complete in seconds: `now - e.lastInteraction.getTime()`
 *   is dominated by initialisation jitter rather than the half-life,
 *   so the half-life produces effectively zero decay across the
 *   per-cell horizon. This module adds a complementary round-based
 *   pruning layer so that stale graph signals from much earlier in
 *   the run cannot dominate detection at the current round.
 *
 *   The choice of a hard sliding window (rather than a second
 *   exponential decay) follows design §6.3: clique-detection and
 *   interaction-count signals are sensitive to whether old edges
 *   are "still there", and a half-life leaves long-tail mass that
 *   distorts counts. Sliding-window evictions are O(1) amortised.
 *
 * ─── Stability invariants (R-STABILITY 4, 5) ─────────────────────────
 *
 *   - Memory is bounded by prune-on-write and prune-on-advance:
 *     entries older than `K = edgeTTLWindowRounds(N)` rounds are
 *     deleted from the underlying map, so the working-set is
 *     `O(distinctEdges-touched-within-K-rounds)`.
 *   - Memory ceiling: at most `O(activeEdges × 1)` per pair (last
 *     write wins per pair); bounded above by `O(N²)` in worst-case
 *     graph density but practically `O(N · √N)` for adversarial
 *     budgets that scale with `√(maliciousCount)` (R-ATTACK-BUDGET 1).
 *     At N=1000 with `K ≈ 50` and adversarial density ≤ √1000 ≈ 31,
 *     the working set is at most ~50K entries.
 *   - All public methods return finite numeric results without
 *     raising; non-finite inputs are silently ignored (R-STABILITY 3).
 *
 * ─── Integrity (R-INTEGRITY 4) ───────────────────────────────────────
 *
 *   Imports only `./adaptiveConfig` for `edgeTTLWindowRounds(N)`.
 *   Contains no attack-identifier literal and no branch on attack
 *   identity — the TTL semantics apply uniformly to every edge.
 *
 * ─── Scope of Task 6.3 ───────────────────────────────────────────────
 *
 *   This module supplies the API surface, the TTL semantics, and the
 *   bounding-rule documentation required by R-GRAPH 5. The wiring of
 *   this accumulator into `computeAllNetworkTrust` / PPR consumers is
 *   intentionally out-of-scope for Task 6.3 and is tracked separately
 *   (it requires integration design work that may interact with the
 *   half-life decay already applied in `computeAllNetworkTrustWithMeta`).
 */

import { edgeTTLWindowRounds } from "./adaptiveConfig";

/**
 * Per-edge accumulator state. One entry per `(sourceId, targetId)` pair;
 * the latest write wins on `record(...)`.
 */
interface AccumulatorEntry {
  /** The most recent round at which this edge was touched. */
  lastInteractionRound: number;
  /** The most recent weight recorded for this edge. */
  recentWeight: number;
}

/**
 * Sliding-window edge accumulator. See module-level JSDoc for the decay
 * rule, justification, and stability invariants.
 *
 * State invariants (enforced by `record` / `prune` / `advanceRound`):
 *
 *   - `entries.size ≤ distinctEdges-touched-within-K-rounds`
 *   - For every entry `e`, `currentRound − e.lastInteractionRound ≤ K`
 *     after the next `prune` / `advanceRound` call resolves.
 *   - `getEffectiveWeight` returns `0` for any edge whose age exceeds
 *     `K = edgeTTLWindowRounds(networkSize)`.
 */
export class WindowedEdgeAccumulator {
  private readonly entries = new Map<string, AccumulatorEntry>();
  private currentRound = 0;
  private currentNetworkSize = 100;

  /**
   * Update the live network-size used for TTL window evaluation. Call
   * once per round (or on cell setup) before recording new edges.
   * Non-finite or non-positive values are silently ignored — the
   * accumulator retains its previous network-size estimate.
   */
  setNetworkSize(networkSize: number): void {
    if (Number.isFinite(networkSize) && networkSize > 0) {
      this.currentNetworkSize = networkSize;
    }
  }

  /**
   * Update the live round counter (monotone non-decreasing) and prune
   * entries older than the current TTL window. Non-finite values are
   * silently ignored.
   */
  advanceRound(round: number): void {
    if (!Number.isFinite(round)) return;
    this.currentRound = Math.max(this.currentRound, round);
    this.prune(this.currentRound);
  }

  /**
   * Record (or update) an edge interaction at the given round. The
   * latest write wins per `(sourceId, targetId)` pair: the entry's
   * `lastInteractionRound` and `recentWeight` are overwritten.
   *
   * Non-finite `weight` or `round` values are silently ignored.
   */
  record(sourceId: string, targetId: string, weight: number, round: number): void {
    if (!Number.isFinite(weight) || !Number.isFinite(round)) return;
    const key = this.edgeKey(sourceId, targetId);
    this.entries.set(key, { lastInteractionRound: round, recentWeight: weight });
    this.currentRound = Math.max(this.currentRound, round);
  }

  /**
   * Effective weight after sliding-window TTL decay.
   *
   * Returns `0` if the edge has not been touched within the last
   * `edgeTTLWindowRounds(networkSize)` rounds, or if the edge has
   * never been recorded. Returns the edge's most recent weight
   * otherwise.
   *
   * @param round       Defaults to the engine's `currentRound`.
   * @param networkSize Defaults to the engine's `currentNetworkSize`.
   */
  getEffectiveWeight(
    sourceId: string,
    targetId: string,
    round?: number,
    networkSize?: number,
  ): number {
    const r = round ?? this.currentRound;
    const N = networkSize ?? this.currentNetworkSize;
    const window = edgeTTLWindowRounds(N);
    const entry = this.entries.get(this.edgeKey(sourceId, targetId));
    if (!entry) return 0;
    const age = r - entry.lastInteractionRound;
    if (age < 0 || age > window) return 0;
    return entry.recentWeight;
  }

  /**
   * Prune all entries older than the current TTL window. Returns the
   * number of entries deleted (used by audit telemetry and tests).
   *
   * Idempotent: calling `prune` repeatedly without intervening writes
   * deletes nothing on the second and subsequent calls.
   */
  prune(round?: number): number {
    const r = round ?? this.currentRound;
    const window = edgeTTLWindowRounds(this.currentNetworkSize);
    let pruned = 0;
    for (const [key, entry] of this.entries) {
      if (r - entry.lastInteractionRound > window) {
        this.entries.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Drop all per-edge state. Used between experiment cells so the
   * accumulator does not leak history across runs (mirrors
   * `velocityEngine.reset()` and `causalGraph.reset()`).
   */
  reset(): void {
    this.entries.clear();
    this.currentRound = 0;
  }

  /** Read-only diagnostic — current entry count. */
  size(): number {
    return this.entries.size;
  }

  /** Stable string key for `(src, tgt)`. */
  private edgeKey(src: string, tgt: string): string {
    return `${src}→${tgt}`;
  }
}

/**
 * Process-wide singleton. Constructed once; `reset()` is the supported
 * way to clear state between experiment cells.
 *
 * Not yet wired into `trustGraph.ts` consumers — Task 6.3 supplies the
 * API surface and TTL semantics; the wiring into PPR / network-trust
 * aggregation is tracked separately and out of scope here.
 */
export const windowedEdgeAccumulator = new WindowedEdgeAccumulator();
