/**
 * GameTheoreticBehavioralAttack — Behavioral game-theoretic adversary.
 *
 * Decision rule (simplified Option 3 — expected-utility-based exploit):
 *
 *   Adversary observes only its own job-receipt history via the shared
 *   `jobsReceivedLedger` (the same signal the base `Attack` class records
 *   for every malicious selection). It does NOT read traceScore,
 *   sybilRisk, or any other policy-internal field.
 *
 *   For each malicious agent at each round:
 *     1. Compute the agent's recent routing share over a sliding window:
 *          share = jobs_received_in_window / max(1, expected_jobs_in_window)
 *        where expected_jobs_in_window = window × jobsPerRound × (1 / N)
 *        is the share an agent would receive under uniform random routing.
 *
 *     2. Stay in build phase (always cooperate) for `buildPhaseRounds`.
 *        After build phase, gate on `share >= shareThreshold`. The intuition:
 *        the marketplace is selecting the agent at a stable rate, indicating
 *        accumulated trust independent of any specific score formulation.
 *
 *     3. When share gate fires AND the current job's value exceeds
 *        `valueThresholdMultiplier * medianJobPriceSats`, defect on this
 *        job — high-value jobs maximise expected loot per detection event.
 *
 *     4. Burst control: stop defecting after `maxExploitBurst` consecutive
 *        defections to avoid triggering count-based hard filters.
 *
 *     5. Detection retreat: if `consecutiveZeroRounds >= retreatZeroRounds`
 *        (the marketplace stopped sending us jobs), enter a forced retreat
 *        for `retreatCooldownRounds` rounds.
 *
 *   This adversary is dense-graph robust: routing share is bounded above by
 *   1.0 and is observable from the agent's own job stream regardless of
 *   the routing policy, the score distribution, or the topology.
 *
 *   No oracle knowledge; no policy-specific signal; no traceScore.
 *
 * --------------------------------------------------------------------------
 * Integrity contract (R-ATTACK-ADAPT 4)
 * --------------------------------------------------------------------------
 * This module imports ONLY from `./base` and `./_adversaryBase`. It does
 * NOT import from `traceScore`, `traceRouter`, `trustGraph`, or any other
 * TRACE-internal module. The static-grep harness
 * `scripts/audit/grepAttackImports.sh` enforces this invariant.
 */

import {
  Attack,
  type AttackAgent,
  type AttackDecision,
  type AttackPostRoundResult,
  type AttackConfig,
  type AttackDecisionContext,
} from "./base";
import { jobsReceivedLedger } from "./_adversaryBase";

export class GameTheoreticBehavioralAttack extends Attack {
  readonly name = "game-theoretic-behavioral";
  readonly description =
    "Behavioral game-theoretic adversary — defects on high-value jobs once routing share signals accumulated trust. Reads only its own job stream (no policy-internal state).";

  private readonly buildPhaseRounds: number;
  private readonly windowRounds: number;
  private readonly shareThreshold: number;
  private readonly valueThresholdMultiplier: number;
  private readonly maxExploitBurst: number;
  private readonly retreatZeroRounds: number;
  private readonly retreatCooldownRounds: number;
  private readonly jobsPerRound: number;

  constructor(config: AttackConfig) {
    super(config);
    // Build phase: rounds during which the agent always cooperates so it
    // accumulates a routing baseline.
    this.buildPhaseRounds = (config.params.buildPhaseRounds as number) ?? 15;
    // Sliding window over which routing share is computed.
    this.windowRounds = (config.params.windowRounds as number) ?? 10;
    // Routing share above which the agent considers defection profitable.
    // share = jobs_received_in_window / expected_under_uniform.
    // Default 1.5 means "I'm getting at least 1.5x my fair share" — a
    // weak gate that fires when accumulated trust visibly biases routing.
    this.shareThreshold = (config.params.shareThreshold as number) ?? 1.5;
    // Job value must exceed this multiple of median price to be worth
    // defecting on. Below this multiple, expected loot < expected
    // detection cost.
    this.valueThresholdMultiplier =
      (config.params.valueThresholdMultiplier as number) ?? 1.2;
    // Maximum consecutive defaults before forced retreat.
    this.maxExploitBurst = (config.params.maxExploitBurst as number) ?? 3;
    // Consecutive zero-routing rounds that trigger detection-retreat.
    this.retreatZeroRounds = (config.params.retreatZeroRounds as number) ?? 4;
    // Forced cooldown after retreat trigger.
    this.retreatCooldownRounds =
      (config.params.retreatCooldownRounds as number) ?? 8;
    // Expected jobs/round for share calibration; passed in by the runner.
    this.jobsPerRound = (config.params.jobsPerRound as number) ?? 5;
  }

  decide(
    agent: AttackAgent,
    round: number,
    _totalRounds: number,
    context?: AttackDecisionContext,
  ): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    // State init.
    if (agent.state.phase === undefined) {
      agent.state.phase = "build";
      agent.state.burstCount = 0;
      agent.state.totalExploits = 0;
      agent.state.retreatUntil = 0;
    }

    // Forced retreat window (we just defected too many times or detected
    // a routing-share collapse).
    if (round < (agent.state.retreatUntil as number)) {
      agent.state.burstCount = 0;
      return { shouldDefault: false, reason: "gtb_forced_retreat" };
    }

    // Build phase — always cooperate to accumulate baseline trust.
    if (round < this.buildPhaseRounds) {
      agent.state.phase = "build";
      return { shouldDefault: false, reason: "gtb_build_phase" };
    }

    // Detection inference: K consecutive zero-routing rounds → router has
    // probably suppressed this identity. Retreat and lower aggression.
    const consecutiveZero = jobsReceivedLedger.consecutiveZeroRounds(
      agent.providerId,
      round,
    );
    if (consecutiveZero >= this.retreatZeroRounds) {
      agent.state.phase = "retreat";
      agent.state.burstCount = 0;
      agent.state.retreatUntil = round + this.retreatCooldownRounds;
      return {
        shouldDefault: false,
        reason: `gtb_retreat_detected: zero_for=${consecutiveZero}`,
      };
    }

    // Burst control — never run more than maxExploitBurst defections in a row.
    if ((agent.state.burstCount as number) >= this.maxExploitBurst) {
      agent.state.phase = "retreat";
      agent.state.burstCount = 0;
      agent.state.retreatUntil = round + this.retreatCooldownRounds;
      return { shouldDefault: false, reason: "gtb_burst_limit" };
    }

    // Compute routing share over the sliding window.
    // expected_under_uniform = window × jobsPerRound / N
    // We approximate N using totalAgents from config; the share metric is
    // the ratio of observed-receipts to this expectation.
    const N = Math.max(2, this.config.totalAgents);
    const expectedJobs =
      (this.windowRounds * this.jobsPerRound) / N;
    const observedJobs = jobsReceivedLedger.countWithinWindow(
      agent.providerId,
      round,
    );
    const share = expectedJobs > 0 ? observedJobs / expectedJobs : 0;

    // Need a minimum window of observation before trusting the share signal.
    const ledgerWindowReady = round - this.buildPhaseRounds >= this.windowRounds;
    if (!ledgerWindowReady) {
      agent.state.phase = "build";
      return {
        shouldDefault: false,
        reason: `gtb_window_warmup: round_since_build=${round - this.buildPhaseRounds}`,
      };
    }

    // Trust gate: are we visibly being routed to above fair share?
    if (share < this.shareThreshold) {
      agent.state.phase = "build";
      agent.state.burstCount = 0;
      return {
        shouldDefault: false,
        reason: `gtb_below_share: share=${share.toFixed(2)}`,
      };
    }

    // Value gate: is this job worth defecting on?
    const jobValue = context?.jobPriceSats ?? 0;
    const median = context?.medianJobPriceSats ?? jobValue;
    const isHighValue = median > 0 && jobValue >= median * this.valueThresholdMultiplier;
    if (!isHighValue) {
      // Stable rate but not a high-value job — keep cooperating.
      return {
        shouldDefault: false,
        reason: `gtb_below_value_threshold: jobValue=${jobValue}, median=${median}`,
      };
    }

    // Both gates pass — defect.
    agent.state.phase = "exploit";
    agent.state.burstCount = (agent.state.burstCount as number) + 1;
    agent.state.totalExploits = (agent.state.totalExploits as number) + 1;
    return {
      shouldDefault: true,
      reason: `gtb_exploit: share=${share.toFixed(2)}, burst=${agent.state.burstCount}/${this.maxExploitBurst}`,
    };
  }

  async postRound(_round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    // Behavioral adversary has no graph-manipulation side effects. The
    // ledger is updated automatically by the base class's `observeRouting`.
    return { actions: [] };
  }
}
