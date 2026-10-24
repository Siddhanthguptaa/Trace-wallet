/**
 * src/lib/trace/attacks/_adversaryBase.ts
 *
 * Per-agent jobs-received ledger used by adversarial-adaptivity attacks to
 * observe their own routing frequency without reading TRACE-internal state.
 *
 * Spec: trace-adversarial-coevolution
 *   - Task 13.1 (tasks.md, parent §13)
 *   - Public interface: design §C.9
 *   - Implementation specification: design §9.5
 *   - Validates: R-ATTACK-ADAPT criterion 1 (per-agent ledger of jobs received
 *     per configurable observation window).
 *
 * --------------------------------------------------------------------------
 * Integrity contract (R-INTEGRITY 4 / R-ATTACK-ADAPT 3, 4)
 * --------------------------------------------------------------------------
 * This module MUST NOT import from `traceScore`, `traceRouter`, `trustGraph`,
 * `causalGraph`, or `temporalTrust`. Those are the TRACE-internal scoring
 * modules; reading them from an attack module would mean an adversary is
 * branching on router-internal state that a real attacker cannot observe.
 *
 * The static-grep harness `scripts/audit/grepAttackImports.sh` (Task 1)
 * enforces this invariant at audit time. Any future edit that introduces
 * such an import is a direct violation of R-ATTACK-ADAPT 4 and will be
 * flagged by `assertAttackImportIntegrity`.
 *
 * --------------------------------------------------------------------------
 * Stability invariants (R-STABILITY 5)
 * --------------------------------------------------------------------------
 * The ledger is a per-agent ring buffer of round-keyed counts, bounded above
 * by a configurable observation window (default 30 rounds). Memory is
 * therefore O(numTrackedAgents × windowRounds). At N=1000 with sustained
 * adversarial activity this is approximately 30K Map entries — well within
 * the `Bounded_Memory_Growth` < 2× ceiling asserted by the smoke harness.
 *
 * All methods return finite numeric results and never throw on adversarial
 * input. Non-finite round numbers are silently ignored (matching the
 * NaN/Infinity-guard convention used by `traceScore.computeBayesianLCB`).
 *
 * --------------------------------------------------------------------------
 * Generalisability claim (R-ATTACK-ADAPT 5)
 * --------------------------------------------------------------------------
 * The ledger consumes only the abstract signal "did this agent receive a
 * job at round t?". This signal is observable by ANY provider on ANY router
 * (TRACE, REPUTATION, PRICE, EIGENTRUST, or routers not in this
 * simulation). The adaptivity strategy built on top of this ledger therefore
 * generalises across routers — it reproduces the simplest signal a real
 * adversary can observe: "the marketplace stopped sending me work."
 */

/** Configuration for a {@link JobsReceivedLedger} instance. */
export interface AdversaryLedgerConfig {
  /**
   * Sliding-window length in rounds. The ledger retains per-round counts
   * for at most this many rounds ending at the most-recent recorded round.
   * Bounded below by 1.
   */
  windowRounds: number;
}

/**
 * Default ledger configuration. The 30-round window is chosen to be wide
 * enough to span the typical attack-detection-and-retreat cycle (W=5
 * stealth + multiple exploit cycles) while keeping the per-agent memory
 * footprint small.
 */
export const DEFAULT_LEDGER_CONFIG: AdversaryLedgerConfig = {
  windowRounds: 30,
};

interface AgentEntry {
  /** Per-round received-count, keyed by round number. */
  countsByRound: Map<number, number>;
  /** The most recent round at which any record was made for this agent. */
  lastRecordRound: number;
}

/**
 * Per-agent ledger of jobs received per round, used by adversarial-adaptivity
 * attacks to observe their own routing frequency. Implements design §C.9.
 *
 * Usage pattern (Tasks 13.2 / 13.3): `Attack.observeRouting` calls
 * `record(providerId, round)` whenever a job is routed to a malicious agent;
 * `decide(agent, round, ...)` consults `consecutiveZeroRounds(agent, round)`
 * to detect "I am being detected and under-routed; switch strategy"
 * (R-ATTACK-ADAPT 2). Ledger reads are restricted to malicious-agent
 * branches — see design §9.5.
 */
export class JobsReceivedLedger {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly windowRounds: number;

  constructor(config: AdversaryLedgerConfig = DEFAULT_LEDGER_CONFIG) {
    this.windowRounds = Math.max(1, Math.floor(config.windowRounds));
  }

  /**
   * Record that `agentId` received a job at `round`. Multiple calls with the
   * same `(agentId, round)` pair increment that round's count.
   *
   * Non-finite `round` values are silently ignored (R-STABILITY 3).
   * Negative rounds are recorded as-is; the consecutive-zero scan stops
   * at round 0 so negative rounds cannot be mis-attributed.
   */
  record(agentId: string, round: number): void {
    if (!Number.isFinite(round)) return;
    let entry = this.entries.get(agentId);
    if (!entry) {
      entry = { countsByRound: new Map(), lastRecordRound: round };
      this.entries.set(agentId, entry);
    }
    const prev = entry.countsByRound.get(round) ?? 0;
    entry.countsByRound.set(round, prev + 1);
    if (round > entry.lastRecordRound) entry.lastRecordRound = round;
    this.prune(entry, round);
  }

  /**
   * Returns the number of consecutive rounds ending at `currentRound`
   * (inclusive) in which `agentId` received zero jobs. Bounded above by
   * the configured `windowRounds`; bounded below at 0.
   *
   * Used by adversarial-adaptivity attacks to detect detection: K
   * consecutive zero-routing rounds → infer that the router has flagged
   * this identity (R-ATTACK-ADAPT 2).
   *
   * Returns 0 if the agent has no record in the ledger. A never-tracked
   * agent is not the same as a recently-zero agent; callers that need to
   * distinguish should use {@link hasHistory}.
   *
   * Non-finite `currentRound` values yield 0 (R-STABILITY 3).
   */
  consecutiveZeroRounds(agentId: string, currentRound: number): number {
    if (!Number.isFinite(currentRound)) return 0;
    const entry = this.entries.get(agentId);
    if (!entry) return 0;
    let count = 0;
    const lowerBound = Math.max(0, currentRound - this.windowRounds + 1);
    for (let r = currentRound; r >= lowerBound; r--) {
      const c = entry.countsByRound.get(r) ?? 0;
      if (c > 0) break;
      count++;
    }
    return count;
  }

  /**
   * Returns the total number of jobs received by `agentId` across the
   * sliding window of `windowRounds` ending at `currentRound`.
   */
  countWithinWindow(agentId: string, currentRound: number): number {
    if (!Number.isFinite(currentRound)) return 0;
    const entry = this.entries.get(agentId);
    if (!entry) return 0;
    let total = 0;
    const lowerBound = Math.max(0, currentRound - this.windowRounds + 1);
    for (let r = currentRound; r >= lowerBound; r--) {
      total += entry.countsByRound.get(r) ?? 0;
    }
    return total;
  }

  /**
   * Returns true if the ledger has any record for `agentId`, regardless of
   * how recent or how many jobs were received.
   */
  hasHistory(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  /**
   * Drop all entries. Called between experiment cells so the ledger does
   * not leak history across runs (mirrors the per-cell `reset()` pattern
   * used by `velocityEngine`, `causalGraph`, and `temporalEngine`).
   */
  reset(): void {
    this.entries.clear();
  }

  /** Diagnostic: number of agents currently tracked by the ledger. */
  trackedAgents(): number {
    return this.entries.size;
  }

  /**
   * Drop per-round counts for one agent that fall outside the sliding
   * window ending at `currentRound`. Called automatically by `record`;
   * the entries map's per-agent count map size is therefore bounded above
   * by `windowRounds` (R-STABILITY 5).
   */
  private prune(entry: AgentEntry, currentRound: number): void {
    const cutoff = currentRound - this.windowRounds + 1;
    for (const r of entry.countsByRound.keys()) {
      if (r < cutoff) entry.countsByRound.delete(r);
    }
  }
}

/**
 * Process-wide singleton for use by adversarial-adaptivity attack modules.
 * Constructed once with the default configuration; `reset()` is the
 * supported way to clear state between experiment cells.
 */
export const jobsReceivedLedger = new JobsReceivedLedger();
