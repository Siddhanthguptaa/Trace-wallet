/**
 * Attack Interface — Common contract for all adversarial evaluation attacks.
 *
 * Each attack class controls:
 *   - How malicious agents are configured
 *   - When they behave honestly vs maliciously
 *   - What side-effects they create (fake edges, identity resets, etc.)
 *
 * --------------------------------------------------------------------------
 * Integrity contract (R-INTEGRITY 1, R-ATTACK-ADAPT 4)
 * --------------------------------------------------------------------------
 * This module MUST NOT import from `traceScore`, `traceRouter`, `trustGraph`,
 * `causalGraph`, or `temporalTrust`. Importing the local `./_adversaryBase`
 * module is allowed because that module itself has zero TRACE-internal
 * imports (see `_adversaryBase.ts` header). The static-grep harness
 * `scripts/audit/grepAttackImports.sh` enforces this invariant at audit
 * time and its result is asserted by `assertAttackImportIntegrity`.
 */

import { jobsReceivedLedger } from "./_adversaryBase";

export interface AttackConfig {
  /** Total number of providers in the experiment */
  totalAgents: number;
  /** Fraction of agents that are malicious [0–1] */
  maliciousRatio: number;
  /**
   * Attack-specific parameters.
   *
   * The value type permits scalar primitives (`number`, `string`,
   * `boolean`) and `number[]` arrays. The array variant was added by
   * Task 11.1 (R-ATTACK-RING 1) so that the collusion-ring attack can
   * accept a `hopSchedule: number[]` describing the multi-hop indirect
   * topology used to evade direct-clique detection. Future attack
   * modules that require small numeric vectors (e.g. burst schedules,
   * jitter offsets) reuse the same slot rather than introducing
   * additional union members.
   */
  params: Record<string, number | string | boolean | number[]>;
}

/** Optional per-job context (e.g. price vs median for selective default). */
export interface AttackDecisionContext {
  jobPriceSats?: number;
  medianJobPriceSats?: number;
}

export interface AttackAgent {
  providerId: string;
  isMalicious: boolean;
  /** Attack-specific state */
  state: Record<string, unknown>;
}

export interface AttackDecision {
  /** Should this agent default/fail on this round? */
  shouldDefault: boolean;
  /** Why (for logging) */
  reason: string;
}

export interface AttackPostRoundResult {
  /** Side effects applied this round (for logging) */
  actions: string[];
}

export abstract class Attack {
  abstract readonly name: string;
  abstract readonly description: string;

  protected config: AttackConfig;
  protected agents: AttackAgent[] = [];

  constructor(config: AttackConfig) {
    this.config = config;
  }

  /** Assign malicious labels to agents after creation */
  assignAgents(providerIds: string[], maliciousIds?: Set<string>): AttackAgent[] {
    if (maliciousIds) {
      this.agents = providerIds.map((id) => ({
        providerId: id,
        isMalicious: maliciousIds.has(id),
        state: {},
      }));
    } else {
      const maliciousCount = Math.floor(providerIds.length * this.config.maliciousRatio);
      // Malicious agents are the last N providers
      this.agents = providerIds.map((id, i) => ({
        providerId: id,
        isMalicious: i >= providerIds.length - maliciousCount,
        state: {},
      }));
    }
    return this.agents;
  }

  /** Decide whether an agent should default on this round */
  abstract decide(
    agent: AttackAgent,
    round: number,
    totalRounds: number,
    context?: AttackDecisionContext
  ): AttackDecision;

  /**
   * Hook invoked by the runner whenever a provider is selected to receive a
   * job in the current round. This is the canonical mechanism by which
   * adversarial-adaptivity attacks observe their own routing frequency
   * without reading TRACE-internal state (R-ATTACK-ADAPT 1, 3).
   *
   * **DO NOT override this method.** It is intentionally non-virtual at
   * the design level: TypeScript has no `final` keyword, but the contract
   * is enforced by the rename pattern below. Subclasses that need their
   * own per-routing bookkeeping override
   * {@link observeRoutingHook} instead. This base method always runs
   * first and unconditionally records into the process-wide
   * `jobsReceivedLedger` whenever `selectedProviderId` is in
   * `maliciousIds`, then delegates to the hook. Centralising the ledger
   * write here removes the per-subclass `super.observeRouting(...)`
   * obligation that previously existed — every concrete attack now gets
   * automatic recording without opting in (R-ATTACK-ADAPT 1, criterion 3).
   *
   * **Honest agents.** Selections of honest providers are intentionally
   * not recorded; the ledger is consulted only inside malicious-agent
   * branches (see design §9.5).
   */
  observeRouting(selectedProviderId: string, round: number, maliciousIds: Set<string>): void {
    // Auto-record into the shared adversarial-adaptivity ledger. Restricted
    // to malicious-agent selections so the ledger captures only the signal
    // a real adversary can self-observe ("did the marketplace route a job
    // to ME?"). Honest-agent routing decisions are intentionally not
    // recorded — they are not part of any attack's self-observation
    // surface (design §9.5, R-ATTACK-ADAPT 3).
    if (maliciousIds.has(selectedProviderId)) {
      jobsReceivedLedger.record(selectedProviderId, round);
    }
    this.observeRoutingHook(selectedProviderId, round, maliciousIds);
  }

  /**
   * Subclass extension point for per-routing bookkeeping. Default
   * implementation is a no-op; subclasses override this method (NOT
   * {@link observeRouting}) when they need to maintain their own
   * per-agent state in response to routing decisions — e.g. a
   * Sybil-cluster attack tracking its own routing exposure for adaptive
   * edge-budget tuning.
   *
   * **Contract.**
   *   - The shared `jobsReceivedLedger` is already populated by
   *     {@link observeRouting} before this hook is invoked. Overrides
   *     MUST NOT call `jobsReceivedLedger.record(...)` themselves; doing
   *     so would double-count the routing event.
   *   - Overrides MAY consult the ledger via `countWithinWindow` /
   *     `consecutiveZeroRounds` for their own decision logic.
   *   - Overrides MUST NOT read TRACE-internal state (R-ATTACK-ADAPT 4 /
   *     Property P15). The arguments to this hook (`selectedProviderId`,
   *     `round`, `maliciousIds`) are exactly the externally observable
   *     signals available to a real adversary.
   *   - Overrides do NOT need to call `super.observeRoutingHook(...)` —
   *     the base implementation is intentionally a no-op so there is
   *     no shared state to forward.
   *
   * Parameters are prefixed with `_` to silence the "unused parameter"
   * lint in the no-op default; overrides drop the prefix.
   */
  protected observeRoutingHook(
    _selectedProviderId: string,
    _round: number,
    _maliciousIds: Set<string>,
  ): void {
    // No-op default — subclasses override.
  }

  /**
   * Reset the process-wide adversarial-adaptivity ledger. Intended to
   * be called by the experiment runner between cells so per-cell RNG
   * isolation is preserved (R-VERIFY-INTEGRITY 4, design §10.6).
   *
   * The ledger is shared across the entire attack suite via the
   * `jobsReceivedLedger` singleton in `_adversaryBase.ts`, so this
   * `reset` clears every tracked agent's history regardless of which
   * concrete attack subclass populated it. Mirrors the per-cell
   * `reset()` pattern used by `velocityEngine`, `causalGraph`, and
   * `temporalEngine`.
   *
   * Public so the runner can call `attack.resetLedger()` at cell
   * boundaries without importing `_adversaryBase` directly.
   */
  resetLedger(): void {
    jobsReceivedLedger.reset();
  }

  /**
   * Inferred-detection helper for adversarial-adaptivity (R-ATTACK-ADAPT 2).
   *
   * Checks whether a malicious agent has received zero jobs for K
   * consecutive rounds, indicating that the router has likely detected
   * and suppressed this identity. When detection is inferred, sets
   * `agent.state.strategySwitched = true` and returns `true`.
   *
   * Each attack subclass consumes this trigger in its own `decide`
   * branch to choose the appropriate response: honest mode, identity
   * reset, or reduced exploit rate (design §9.5). The chosen branch
   * is recorded per cell via the `AttackDecision.reason` field.
   *
   * **Contract:**
   *   - MUST only be called for agents where `agent.isMalicious === true`
   *     (design §9.5 restriction: ledger reads are restricted to
   *     malicious-agent branches).
   *   - Returns `false` for agents with no ledger history (never-tracked
   *     agents are not the same as recently-zero agents).
   *   - Does NOT read TRACE-internal state (R-ATTACK-ADAPT 3, 4).
   *
   * @param agent - The malicious attack agent to check.
   * @param round - The current simulation round.
   * @param K - Number of consecutive zero-routing rounds to trigger
   *            detection inference. Default 5 (design §9.5).
   * @returns `true` if detection is inferred (K consecutive zero rounds).
   */
  protected isInferredDetected(agent: AttackAgent, round: number, K: number = 5): boolean {
    if (!agent.isMalicious) return false;
    if (!jobsReceivedLedger.hasHistory(agent.providerId)) return false;
    const consecutive = jobsReceivedLedger.consecutiveZeroRounds(agent.providerId, round);
    if (consecutive >= K) {
      agent.state.strategySwitched = true;
      return true;
    }
    return false;
  }

  /** Post-round side effects (e.g., create fake edges, reset identity) */
  abstract postRound(round: number, totalRounds: number): Promise<AttackPostRoundResult>;

  /** Get malicious agent IDs */
  getMaliciousIds(): string[] {
    return this.agents.filter((a) => a.isMalicious).map((a) => a.providerId);
  }

  /** Get honest agent IDs */
  getHonestIds(): string[] {
    return this.agents.filter((a) => !a.isMalicious).map((a) => a.providerId);
  }

  /** Serialise for experiment config snapshot */
  toJSON() {
    return {
      name: this.name,
      description: this.description,
      config: this.config,
      maliciousAgents: this.getMaliciousIds(),
      honestAgents: this.getHonestIds(),
    };
  }
}
