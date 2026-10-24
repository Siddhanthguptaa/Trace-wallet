/**
 * A3 — Strategic Default Attack
 *
 * THE MOST IMPORTANT ATTACK. Start here.
 *
 * Lifecycle:
 *   1. Honest behavior → trust accumulation → higher TRACE score
 *   2. Increased routing preference (TRACE trusts them)
 *   3. Sudden default/failure at a calculated moment
 *
 * This directly tests whether TRACE can:
 *   - Detect trust-then-betray patterns
 *   - Recover routing quality after a default
 *   - Limit fraud exposure from trusted-but-malicious agents
 *
 * Configurable params:
 *   - honestPhaseRatio: fraction of total rounds where agent behaves honestly [default: 0.6]
 *   - defaultBurst: number of consecutive defaults after switching [default: 3]
 *   - repeatCycles: whether the agent cycles honest→default→honest [default: false]
 *   - valueThresholdMultiplier: high-value job multiplier above median price [default: 1.5]
 *     (R-ATTACK-STRATEGIC C3 — Task 9.2 closure)
 *   - routingRateTriggerThreshold: rate below which the retreat branch fires [default: 0.05]
 *     (R-ATTACK-STRATEGIC C4 — Task 9.2 closure)
 *   - routingRateTriggerWindow: window length in rounds AND K for the K-consecutive
 *     low-routing-round trigger [default: 10] (R-ATTACK-STRATEGIC C4 — Task 9.2 closure)
 *   - retreatRounds: duration of the honest-mode retreat in rounds [default: 15]
 *     (R-ATTACK-STRATEGIC C4 — Task 9.2 closure)
 *
 * --------------------------------------------------------------------------
 * R-ATTACK-STRATEGIC closure (Task 9.2)
 * --------------------------------------------------------------------------
 * Task 9.1 confirmed C1 (per-agent jitter), C3 (high-value branch existence),
 * C4 (retreat branch existence), and C5 (own-ledger only). Task 9.2 closes
 * the externalisation gaps for C3 and C4 plus the C4 semantic gap:
 *
 *   - C3 externalisation: the `1.5` price multiplier is now read from
 *     `params.valueThresholdMultiplier`.
 *   - C4 externalisation: the `0.05` rate threshold, the `10`-round
 *     post-burst grace window, and the `15`-round retreat duration are now
 *     `params.routingRateTriggerThreshold`, `params.routingRateTriggerWindow`,
 *     `params.retreatRounds`.
 *   - C4 semantic fix: the cumulative integer counter `routingExposure` is
 *     replaced by a windowed-rate computation backed by the per-agent
 *     `JobsReceivedLedger` (Task 13.1, `attacks/_adversaryBase.ts`). The
 *     trigger now requires K consecutive low-routing rounds — using
 *     `consecutiveZeroRounds` as the K-consecutive-counter substrate — so
 *     a single noisy zero round cannot flip strategy. The threshold check
 *     uses the windowed rate, satisfying R-ATTACK-STRATEGIC criterion 4
 *     verbatim ("rate decline below a configurable threshold for K
 *     consecutive rounds").
 *
 * The defaults are bit-equivalent to the prior hardcoded literals so this
 * change is observationally identical on the default config except for the
 * count→rate + K-consecutive semantic improvement (which is a deliberate
 * behavioural fix required by R-ATTACK-STRATEGIC criterion 4).
 *
 * R-INTEGRITY note: the only imports are `./base` and `./_adversaryBase`.
 * `_adversaryBase.ts` itself imports nothing from the TRACE-internal
 * scoring modules, so Property P15 (no TRACE-internal imports under
 * `attacks/`) continues to hold.
 */

import { Attack, type AttackAgent, type AttackDecision, type AttackPostRoundResult, type AttackConfig, type AttackDecisionContext } from "./base";
import { jobsReceivedLedger } from "./_adversaryBase";

export class StrategicDefaultAttack extends Attack {
  readonly name = "strategic-default";
  readonly description = "Agents behave honestly to build trust, then suddenly default to exploit accumulated trust.";

  private honestPhaseRatio: number;
  private defaultBurst: number;
  private repeatCycles: boolean;

  // R-ATTACK-STRATEGIC C3, C4 — Task 9.2 externalisation.
  // Defaults preserve the previously-hardcoded literals so existing
  // experiment configs are bit-equivalent on the default-config path.
  private valueThresholdMultiplier: number;
  private routingRateTriggerThreshold: number;
  private routingRateTriggerWindow: number;
  private retreatRounds: number;

  constructor(config: AttackConfig) {
    super(config);
    this.honestPhaseRatio = (config.params.honestPhaseRatio as number) ?? 0.6;
    this.defaultBurst = (config.params.defaultBurst as number) ?? 3;
    this.repeatCycles = (config.params.repeatCycles as boolean) ?? false;

    // Tunable params introduced by Task 9.2 (R-ATTACK-STRATEGIC C3, C4).
    // The four defaults match the literals previously hardcoded at
    // strategicDefault.ts:60–71 (rate threshold, grace window, retreat
    // duration) and :99–108 (high-value price multiplier) so the audit
    // baseline is preserved on the default-config path.
    this.valueThresholdMultiplier = (config.params.valueThresholdMultiplier as number) ?? 1.5;
    this.routingRateTriggerThreshold = (config.params.routingRateTriggerThreshold as number) ?? 0.05;
    this.routingRateTriggerWindow = (config.params.routingRateTriggerWindow as number) ?? 10;
    this.retreatRounds = (config.params.retreatRounds as number) ?? 15;
  }

  decide(agent: AttackAgent, round: number, totalRounds: number, _context?: AttackDecisionContext): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    // Track state
    if (!agent.state.defaultsRemaining) {
      agent.state.defaultsRemaining = 0;
      agent.state.phase = "honest";
      agent.state.cycleCount = 0;
    }

    // Phase 2 Enhancement: Per-agent warm-up randomization
    // Add ±20% variation to honestPhaseRatio based on agent ID hash
    const agentHash = deterministicHash(agent.providerId);
    const warmupVariation = (agentHash - 0.5) * 0.2; // [-0.1, +0.1]
    const agentWarmup = Math.max(0.3, Math.min(0.8, this.honestPhaseRatio + warmupVariation));
    const switchRound = Math.floor(totalRounds * agentWarmup);

    // Phase 2 Enhancement: Retreat behavior after detection (R-ATTACK-STRATEGIC C4)
    // If routing rate drops below the configurable threshold for K consecutive
    // rounds after the post-default phase, go honest to recover.
    if (agent.state.phase === "retreat" && round < (agent.state.retreatUntil as number)) {
      return { shouldDefault: false, reason: "retreat_after_detection" };
    }

    // R-ATTACK-STRATEGIC C4 semantic fix (Task 9.2):
    // Replace the prior cumulative integer counter `routingExposure` with a
    // windowed-rate computation backed by `JobsReceivedLedger` (Task 13.1).
    //
    //   - `countWithinWindow / window` is the per-agent routing rate over
    //     the most-recent `routingRateTriggerWindow` rounds.
    //   - `consecutiveZeroRounds` is the K-consecutive low-routing-round
    //     counter substrate (R-ATTACK-STRATEGIC criterion 4: "for K
    //     consecutive rounds"). Using the ledger's existing primitive
    //     avoids duplicating the K-consecutive logic in this module.
    //
    // Trigger requires BOTH the rate to be below threshold AND the
    // K-consecutive-zero-rounds counter to have reached the window length,
    // so a single noisy round cannot flip strategy.
    const routingRate =
      jobsReceivedLedger.countWithinWindow(agent.providerId, round) /
      Math.max(1, this.routingRateTriggerWindow);
    const consecutiveZeroRounds = jobsReceivedLedger.consecutiveZeroRounds(
      agent.providerId,
      round,
    );
    if (
      routingRate < this.routingRateTriggerThreshold &&
      consecutiveZeroRounds >= this.routingRateTriggerWindow &&
      round > switchRound + this.routingRateTriggerWindow &&
      agent.state.phase === "post_default"
    ) {
      // Detected — go honest for `retreatRounds` rounds to recover.
      agent.state.phase = "retreat";
      agent.state.retreatUntil = round + this.retreatRounds;
      return { shouldDefault: false, reason: "retreat_after_detection" };
    }

    // Cycling mode: honest → default → honest → default...
    if (this.repeatCycles) {
      const cycleLength = Math.floor(totalRounds / 4); // 4 phases per experiment
      const cyclePos = round % cycleLength;
      const inDefaultPhase = cyclePos >= Math.floor(cycleLength * agentWarmup);

      if (inDefaultPhase && cyclePos < Math.floor(cycleLength * agentWarmup) + this.defaultBurst) {
        agent.state.phase = "defaulting";
        return {
          shouldDefault: true,
          reason: `cycle_${Math.floor(round / cycleLength)}_default_burst`,
        };
      }
      agent.state.phase = "honest";
      return { shouldDefault: false, reason: `cycle_${Math.floor(round / cycleLength)}_honest` };
    }

    // Single-shot mode: honest until switchRound, then burst of defaults
    if (round < switchRound) {
      agent.state.phase = "honest";
      return { shouldDefault: false, reason: "trust_accumulation_phase" };
    }

    if (round >= switchRound && round < switchRound + this.defaultBurst) {
      agent.state.phase = "defaulting";

      // Phase 2 Enhancement: High-value job targeting (R-ATTACK-STRATEGIC C3)
      // Preferentially default on jobs above `valueThresholdMultiplier × median`.
      // The multiplier is now externalised via `params.valueThresholdMultiplier`
      // (default 1.5 — preserves the prior hardcoded literal).
      const isHighValue = _context?.jobPriceSats && _context?.medianJobPriceSats
        && _context.jobPriceSats > _context.medianJobPriceSats * this.valueThresholdMultiplier;

      if (isHighValue) {
        return {
          shouldDefault: true,
          reason: `strategic_high_value_default_${round - switchRound + 1}/${this.defaultBurst}`,
        };
      }

      // Default on 80% of normal-value jobs during burst
      if (deterministicHash(agent.providerId + round) < 0.8) {
        return {
          shouldDefault: true,
          reason: `strategic_default_burst_${round - switchRound + 1}/${this.defaultBurst}`,
        };
      }
    }

    // After the burst, go quiet (to measure recovery)
    agent.state.phase = "post_default";
    return { shouldDefault: false, reason: "post_default_quiet" };
  }

  // Note: this class no longer needs to override `observeRouting` *or*
  // `observeRoutingHook`. Task 13.2 wired automatic ledger recording
  // into the base `Attack.observeRouting` (now a non-virtual delegating
  // method that records into `jobsReceivedLedger` first and then calls
  // the protected `observeRoutingHook`). `decide(...)` consults the
  // ledger directly via `jobsReceivedLedger.countWithinWindow` and
  // `consecutiveZeroRounds`. Adding an `observeRoutingHook` override
  // that also recorded would be a contract violation — the hook's
  // contract (see base.ts) forbids `jobsReceivedLedger.record(...)`
  // because the auto-recording in `observeRouting` already populated
  // the per-`(agentId, round)` slot.

  async postRound(_round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    // Strategic default has no side effects beyond the defaults themselves
    return { actions: [] };
  }
}

// Deterministic hash function for agent-specific randomization
function deterministicHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}
