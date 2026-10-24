/**
 * Score-velocity engine — generic anomaly signal for non-stationary
 * provider score sequences.
 *
 * Spec: trace-adversarial-coevolution / design §7, §C.8, §D.5;
 *       requirements R-VOLATILITY (Requirement 6).
 *
 * Owns a per-provider ring buffer of `(round, score)` records and exposes
 *
 *   - `push(providerId, round, score, networkSize)` — append a sample,
 *     evict oldest entries past `min(HISTORY_LENGTH, edgeTTLWindowRounds(N))`.
 *   - `compute(providerId)` — return `{ velocity, acceleration }` when at
 *     least `MIN_SAMPLES_FOR_SIGNAL = 3` samples are available, else `null`.
 *   - `reset()` — clear all per-provider state (used between experiment
 *     cells, mirroring `temporalEngine.reset()` and `causalGraph.reset()`).
 *
 * Memory bound (R-STABILITY 5): the engine retains at most
 *   O(activeProviders × min(HISTORY_LENGTH, edgeTTLWindowRounds(N)))
 * records. At N=1000 the TTL window is `edgeTTLWindowRounds(1000) ≈ 50`,
 * but `HISTORY_LENGTH = 10` is the dominant cap, so memory is bounded
 * by `O(activeProviders × 10) ≤ 10 K records` for the audited cells.
 *
 * Stability (R-STABILITY 3): `compute` returns `null` (not `NaN`) when
 * fewer than 3 samples are available; the consumer in `computeTraceUtility`
 * maps `null → anomalyTerm = 0` (design §7.4, Property P9). Velocity and
 * acceleration are integer score differences, so they are inherently
 * finite when the underlying score samples are finite.
 *
 * Generalisability claim (R-VOLATILITY 5, R-INTEGRITY 5):
 *
 *   The velocity / acceleration anomaly term is a generic signal: it
 *   reacts identically to (a) whitewash-driven score zeroing followed
 *   by recovery, (b) collusion-driven rapid score inflation, (c) sybil-
 *   burst defaults, and (d) any future adversary family that produces
 *   non-stationary score sequences — including adversaries not present
 *   in the simulation. The term measures only `|Δscore|` and `|Δ²score|`,
 *   neither of which depends on attack labels. Honest agents whose score
 *   trajectories are smooth produce a near-zero contribution; the term
 *   cannot rerank an honest agent below an adversary at the same evidence
 *   under the bound `α_velocity = 0.05` chosen in §7.2 (Property P8).
 *
 * Integrity (R-INTEGRITY 4): this module imports only `adaptiveConfig.ts`
 * for the dynamic TTL formula. It does not import from any module under
 * `attacks/` and contains no attack-identifier literal.
 *
 * Consumed by `traceRouter.ts::computeTraceUtility` in Task 7.2 (a
 * separate task); this file creates the engine module only.
 */

import { edgeTTLWindowRounds } from "./adaptiveConfig";

/** Fixed per-provider ring-buffer length (design §7.1). */
export const HISTORY_LENGTH = 10;

/**
 * Minimum number of score samples required before velocity / acceleration
 * are defined. Below this threshold `compute` returns `null` rather than
 * raising or returning NaN (R-VOLATILITY 6, Property P9).
 */
export const MIN_SAMPLES_FOR_SIGNAL = 3;

/** A single score observation for a provider at a given round (design D.5). */
export interface VelocityRecord {
  round: number;
  score: number;
}

/**
 * Per-provider velocity / acceleration engine. State invariants
 * (per design D.5, enforced inside `push`):
 *
 *   - `list.length ≤ HISTORY_LENGTH`
 *   - `∀ r ∈ list, currentRound − r.round ≤ edgeTTLWindowRounds(N)`
 */
export class VelocityEngine {
  private readonly history: Map<string, VelocityRecord[]> = new Map();

  /**
   * Append a score sample for `providerId` at `round`, evicting any
   * record older than the network-size–aware TTL window and any
   * overflow beyond `HISTORY_LENGTH`. Newest record is appended last.
   *
   * @param providerId  Stable provider identifier.
   * @param round       Current round (monotone non-decreasing per provider).
   * @param score       TRACE score sample at `round`.
   * @param networkSize Live network size N — used to evaluate
   *                    `edgeTTLWindowRounds(N)` for the TTL window.
   */
  push(providerId: string, round: number, score: number, networkSize: number): void {
    const ttl = edgeTTLWindowRounds(networkSize);
    const list = this.history.get(providerId) ?? [];
    list.push({ round, score });

    // Drop overflow beyond HISTORY_LENGTH and any TTL-expired oldest records.
    // Loop terminates because each iteration removes the head and the list
    // length is finite; the predicate is non-trivial only for the head.
    while (
      list.length > HISTORY_LENGTH ||
      (list.length > 0 && round - list[0].round > ttl)
    ) {
      list.shift();
    }

    this.history.set(providerId, list);
  }

  /**
   * Return the discrete first and second derivatives of the most-recent
   * score samples for `providerId`, or `null` when fewer than
   * `MIN_SAMPLES_FOR_SIGNAL` samples are available.
   *
   *   v_t   = score_t   − score_{t−1}
   *   v_t-1 = score_{t−1} − score_{t−2}
   *   acceleration = v_t − v_{t-1}
   *
   * The returned values are score-unit differences (raw `Δ` and `Δ²`); the
   * consumer in `computeTraceUtility` (Task 7.2) normalises them against
   * `TRACE_MAX_SCORE − TRACE_MIN_SCORE` to produce the bounded anomaly
   * term per §7.2.
   *
   * Read-only — does not mutate the engine's state.
   */
  compute(providerId: string): { velocity: number; acceleration: number } | null {
    const list = this.history.get(providerId);
    if (!list || list.length < MIN_SAMPLES_FOR_SIGNAL) return null;

    const n = list.length;
    const v_t = list[n - 1].score - list[n - 2].score;
    const v_tm1 = list[n - 2].score - list[n - 3].score;
    const acceleration = v_t - v_tm1;

    // Stability guard (R-STABILITY 3): if any score sample was non-finite
    // upstream, refuse to emit an anomaly signal rather than propagating it.
    if (!Number.isFinite(v_t) || !Number.isFinite(acceleration)) return null;

    return { velocity: v_t, acceleration };
  }

  /**
   * Drop all per-provider state. Used between experiment cells so the
   * engine does not leak history across runs (mirrors
   * `temporalEngine.reset()` and `causalGraph.reset()`).
   */
  reset(): void {
    this.history.clear();
  }

  /** Number of providers currently tracked — used by audit telemetry. */
  trackedProviders(): number {
    return this.history.size;
  }
}

/**
 * Process-wide singleton. Constructed once; `reset()` is the supported
 * way to clear state between experiment cells. Consumed by
 * `traceRouter.ts::computeTraceUtility` in Task 7.2.
 */
export const velocityEngine = new VelocityEngine();
