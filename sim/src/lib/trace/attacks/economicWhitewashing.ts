/**
 * TRACE v2.5 — Economic Whitewashing
 *
 * An economically rational attacker that resets its identity only when
 * doing so is *affordable* under a per-agent profit budget. The attack
 * lifecycle is:
 *
 *   1. EXPLORATION   — start with a fresh identity, behave honestly
 *                       through the post-reset stealth phase.
 *   2. EXPLOITATION  — default on high-value jobs while the score is
 *                       healthy; each successful high-value default
 *                       credits `jobPriceSats` to a per-agent
 *                       `cumulativeProfit` counter.
 *   3. EVALUATION    — once the score has decayed below
 *                       `exploitThreshold`, the agent attempts a reset.
 *   4. MUTATION      — the reset fires only if the agent has already
 *                       earned at least `resetCost` from its current
 *                       identity (`cumulativeProfit >= resetCost`).
 *                       The reset deducts `resetCost` from the counter
 *                       (clamped to ≥ 0); if the budget is short, the
 *                       reset is *deferred* — the agent must keep
 *                       extracting value from the doomed identity until
 *                       it has paid for the cleansing. A lifetime
 *                       `resetBudget` (default 200) caps total spend.
 *
 * **Economic-rationality contract (R-ATTACK-WHITEWASH 4, task 12.2,
 * design §9.4 gap-fix 3, Property P14).** The reset frequency is a
 * monotonically non-increasing function of `resetCost`: holding the
 * profit-arrival rate `λ` (mean credit per round from successful
 * high-value defaults) fixed, the steady-state reset rate is `λ /
 * resetCost`. Doubling `resetCost` halves the steady-state rate; very
 * large `resetCost` collapses the rate toward zero because the agent
 * can never accumulate enough profit to afford a reset within the run
 * horizon. This generalises across routers because the gating consumes
 * only `jobPriceSats` from the runner-supplied `AttackDecisionContext`
 * — exactly the data any rational adversary observes from job
 * postings, regardless of the routing policy in force.
 */

import { prisma } from "../../db";
import { Attack, type AttackAgent, type AttackDecision, type AttackPostRoundResult, type AttackConfig, type AttackDecisionContext } from "./base";

/**
 * Identity-reset payload shape, locked by Property P11 (R-ATTACK-WHITEWASH 1,
 * R-ATTACK-FATAL 3) and the regression test
 * `__tests__/economicWhitewashing.reset-payload.spec.ts`.
 *
 * Every field listed here is a routing-affecting field per design §D.6.
 * The published reset table in design §D.6 is the source of truth; any
 * future change to the values below must be reflected in the table and
 * in the regression test, or the test will trip.
 */
export interface EconomicWhitewashingResetPayload {
  traceScore: number;
  riskTier: string;
  completionRate: number;
  repaymentRate: number;
  successfulEscrowRate: number;
  disputeRate: number;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  defaultedJobs: number;
  disputedJobs: number;
  defaultProbability: number;
  networkTrust: number;
  sybilRisk: number;
  scoreVolatility: number;
  totalEconomicVolume: number;
  stakeRatio: number;
}

/**
 * Build the cold-start identity-reset payload written by
 * `EconomicWhitewashingAttack.postRound` to `prisma.provider.update`.
 *
 * The payload is a pure literal — no provider state is read — so this
 * helper is deterministic and safe to call from regression tests
 * without a database. The values match design §D.6 verbatim and lock
 * R-ATTACK-FATAL 3 (`defaultProbability: 0.05`).
 */
export function buildResetPayload(): EconomicWhitewashingResetPayload {
  return {
    traceScore: 500,
    riskTier: "B",
    completionRate: 1.0,
    repaymentRate: 1.0,
    successfulEscrowRate: 1.0,
    disputeRate: 0.0,
    totalJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    defaultedJobs: 0,
    disputedJobs: 0,
    defaultProbability: 0.05, // Match initial honest value (R-ATTACK-FATAL 3)
    networkTrust: 0.1,
    sybilRisk: 0,
    scoreVolatility: 0, // CRITICAL: Reset volatility
    totalEconomicVolume: 0, // CRITICAL: Reset volume
    stakeRatio: 0,
  };
}

export class EconomicWhitewashingAttack extends Attack {
  readonly name = "economic-whitewashing";
  readonly description = "Economically rational identity reset based on cost-benefit analysis of reputation vs. reset cost.";

  private operatingCostPerJob: number;
  private resetCost: number;
  private resetBudget: number;
  private exploitThreshold: number;
  private defaultProbWhenExploiting: number;
  private stealthPhaseRounds: number;
  // R-ATTACK-WHITEWASH 5 / task 12.3 / design §9.4.
  // Multiplier above the median job price that defines "high-value".
  // Jobs with `jobPriceSats > medianJobPriceSats * volumeTargetMultiplier`
  // are targeted for exploitation; jobs below the threshold receive
  // honest behaviour to maintain score. Default 1.2 preserves the
  // prior hardcoded literal.
  private volumeTargetMultiplier: number;

  constructor(config: AttackConfig) {
    super(config);
    this.operatingCostPerJob = (config.params.operatingCostPerJob as number) ?? 5;
    // R-ATTACK-WHITEWASH 4 / task 12.2 / design §9.4 gap-fix 3.
    // `resetCost` is the per-reset price the adversary must already
    // have earned (in `cumulativeProfit`) before the next identity
    // reset is permitted. Property P14 (reset-frequency monotonicity)
    // depends on this being the *only* budget knob.
    this.resetCost = (config.params.resetCost as number) ?? 50;
    // `resetBudget` is the total lifetime budget per agent (design §9.4).
    // Once cumulative resets exceed this budget the agent can never reset
    // again, even if it continues earning profit. Default 200 means at
    // most 4 resets at resetCost=50 over the agent's lifetime.
    this.resetBudget = (config.params.resetBudget as number) ?? 200;
    this.exploitThreshold = (config.params.exploitThreshold as number) ?? 400;
    this.defaultProbWhenExploiting = (config.params.defaultProbWhenExploiting as number) ?? 0.9;
    this.stealthPhaseRounds = (config.params.stealthPhaseRounds as number) ?? 10;
    this.volumeTargetMultiplier = (config.params.volumeTargetMultiplier as number) ?? 1.2;
  }

  decide(agent: AttackAgent, round: number, _totalRounds: number, context?: AttackDecisionContext): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    // Track rounds since last reset
    if (!agent.state.roundsSinceReset) {
      agent.state.roundsSinceReset = 0;
    }
    agent.state.roundsSinceReset = (agent.state.roundsSinceReset as number) + 1;

    // Stealth phase after reset: behave honestly
    if ((agent.state.roundsSinceReset as number) < this.stealthPhaseRounds) {
      return { shouldDefault: false, reason: "whitewash_stealth_after_reset" };
    }

    // Check if in exploit phase (score is healthy)
    const isHealthy = (agent.state.isHealthy as boolean) ?? true;

    if (isHealthy) {
      // Exploit phase: target high-value jobs
      const isHighValue = context?.jobPriceSats && context?.medianJobPriceSats
        && context.jobPriceSats > context.medianJobPriceSats * this.volumeTargetMultiplier;

      if (isHighValue) {
        const shouldDefault = deterministicUnit(agent.providerId, round) < this.defaultProbWhenExploiting;
        if (shouldDefault) {
          // R-ATTACK-WHITEWASH 4 / task 12.2 / design §9.4. Credit the
          // adversary's per-agent cumulative profit with the job price
          // from the high-value default. The runner does not echo back
          // per-job outcomes, so the credit is recognised on intent —
          // this is the standard treatment for attack-side bookkeeping
          // (see `_adversaryBase.ts::JobsReceivedLedger` for the
          // analogous intent-credited routing-rate counter). The counter
          // is spent in `postRound` to gate identity resets.
          const cumProfit = (agent.state.cumulativeProfit as number) ?? 0;
          const jobPrice = context?.jobPriceSats ?? 0;
          agent.state.cumulativeProfit = cumProfit + jobPrice;
        }
        return {
          shouldDefault,
          reason: shouldDefault ? "whitewash_exploit_high_value" : "whitewash_selective",
        };
      }

      // Low-value jobs: be honest to maintain score
      return { shouldDefault: false, reason: "whitewash_maintain_score" };
    }

    // Score is low: minimal activity while waiting for reset
    const shouldDefault = deterministicUnit(agent.providerId, round) < 0.1;
    return {
      shouldDefault,
      reason: shouldDefault ? "whitewash_low_score_default" : "whitewash_waiting_reset",
    };
  }

  async postRound(round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];

    for (const agent of this.agents.filter((a) => a.isMalicious)) {
      try {
        const provider = await prisma.provider.findUnique({
          where: { id: agent.providerId },
          select: { traceScore: true },
        });

        if (!provider) continue;

        // Decision: Should I reset?
        if (provider.traceScore < this.exploitThreshold) {
          // R-ATTACK-WHITEWASH 4 / task 12.2 / design §9.4 gap-fix 3.
          // Economically rational reset gating: the adversary may only
          // reset when its `cumulativeProfit` from the *current*
          // identity exceeds `resetCost`. If the budget is short the
          // reset is *deferred* — the agent has to keep extracting
          // value from the doomed identity until it has paid for the
          // cleansing. This is the mechanism that makes reset
          // frequency a decreasing function of `resetCost` per
          // Property P14: doubling `resetCost` doubles the profit
          // required per cleansing, halving the steady-state rate.
          const cumulativeProfit = (agent.state.cumulativeProfit as number) ?? 0;

          // Budget gate: cannot afford the reset yet — keep exploiting
          // or go honest until enough profit is accumulated.
          if (cumulativeProfit < this.resetCost) {
            actions.push(
              `whitewash_budget_short: ${agent.providerId.substring(0, 8)} (profit=${cumulativeProfit.toFixed(2)}<${this.resetCost})`
            );
            continue;
          }

          // Lifetime budget gate: total resets spent cannot exceed
          // `resetBudget`. Once exhausted the agent can never reset
          // again regardless of profit.
          const totalResetSpend = (agent.state.totalResetSpend as number) ?? 0;
          if (totalResetSpend + this.resetCost > this.resetBudget) {
            actions.push(
              `whitewash_lifetime_budget_exhausted: ${agent.providerId.substring(0, 8)} (spent=${totalResetSpend}/${this.resetBudget})`
            );
            continue;
          }

          // RESET IDENTITY - Complete reset of all routing-relevant fields
          // Payload defined by `buildResetPayload()` and locked by
          // Property P11 in __tests__/economicWhitewashing.reset-payload.spec.ts.
          await prisma.provider.update({
            where: { id: agent.providerId },
            data: buildResetPayload(),
          });

          // Reset agent state
          agent.state.roundsSinceReset = 0;
          agent.state.isHealthy = true;
          // R-ATTACK-WHITEWASH 4 / task 12.2 / design §9.4. Charge the
          // reset against the agent's cumulative profit (clamped to >= 0
          // so a tiny accounting drift cannot leave the counter in a
          // negative state from which the next reset would never fire).
          agent.state.cumulativeProfit = Math.max(0, cumulativeProfit - this.resetCost);
          // Track lifetime reset spend for the budget cap.
          agent.state.totalResetSpend = totalResetSpend + this.resetCost;

          actions.push(`whitewash_reset: ${agent.providerId.substring(0, 8)} (score was ${provider.traceScore})`);
        } else {
          // EXPLOIT PHASE
          agent.state.isHealthy = provider.traceScore > 700;
        }
      } catch (e) {
        console.warn(`Economic whitewashing error for ${agent.providerId}: ${e}`);
      }
    }

    return { actions };
  }
}

function deterministicUnit(providerId: string, round: number): number {
  let hash = 2166136261;
  const input = `${providerId}:whitewash:${round}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}
