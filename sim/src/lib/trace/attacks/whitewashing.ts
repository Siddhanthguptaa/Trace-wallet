/**
 * A1 — Whitewashing Attack
 *
 * Agents reset their identity after accumulating bad reputation.
 *
 * Lifecycle:
 *   1. Default/fail on jobs → accumulate bad scores
 *   2. "Delete" identity → re-register as a new provider
 *   3. Exploit cold-start bonus to get routed again
 *
 * Tests:
 *   - Cold-start exploitation resistance
 *   - Identity-reset profitability
 *   - Trust rebuild speed for fresh identities
 *
 * Configurable params:
 *   - defaultRate: probability of defaulting per round [default: 0.4]
 *   - resetThreshold: TRACE score below which the agent resets [default: 400]
 *   - maxResets: max number of identity resets [default: 3]
 */

import { prisma } from "../../db";
import { Attack, type AttackAgent, type AttackDecision, type AttackPostRoundResult, type AttackConfig, type AttackDecisionContext } from "./base";

export class WhitewashingAttack extends Attack {
  readonly name = "whitewashing";
  readonly description = "Agents reset identity after accumulating bad reputation to exploit cold-start bonuses.";

  private defaultRate: number;
  private resetThreshold: number;
  private maxResets: number;

  constructor(config: AttackConfig) {
    super(config);
    this.defaultRate = (config.params.defaultRate as number) ?? 0.4;
    this.resetThreshold = (config.params.resetThreshold as number) ?? 400;
    this.maxResets = (config.params.maxResets as number) ?? 3;
  }

  decide(agent: AttackAgent, _round: number, _totalRounds: number, _context?: AttackDecisionContext): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    const routeCount = ((agent.state.routeCount as number | undefined) ?? 0) + 1;
    agent.state.routeCount = routeCount;
    const shouldDefault = deterministicUnit(agent.providerId, routeCount) < this.defaultRate;
    return {
      shouldDefault,
      reason: shouldDefault ? "whitewash_default" : "whitewash_honest_round",
    };
  }

  async postRound(_round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];

    // Check if any malicious agent should reset identity
    for (const agent of this.agents.filter((a) => a.isMalicious)) {
      if (!agent.state.resetCount) agent.state.resetCount = 0;

      if ((agent.state.resetCount as number) >= this.maxResets) continue;

      const provider = await prisma.provider.findUnique({
        where: { id: agent.providerId },
        select: { traceScore: true, name: true, capability: true, priceSats: true, endpointUrl: true },
      });

      if (provider && provider.traceScore < this.resetThreshold) {
        await resetProviderIdentity(agent.providerId);
        agent.state.resetCount = (agent.state.resetCount as number) + 1;
        agent.state.routeCount = 0;
        actions.push(`whitewash_reset: ${agent.providerId} (reset #${agent.state.resetCount})`);
      }
    }

    return { actions };
  }
}

export async function resetProviderIdentity(providerId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.trustEdge.deleteMany({
      where: {
        OR: [
          { sourceProviderId: providerId },
          { targetProviderId: providerId },
        ],
      },
    });
    await tx.routingDecision.deleteMany({ where: { selectedProviderId: providerId } });
    await tx.economicEvent.deleteMany({ where: { providerId } });
    await tx.scoreHistory.deleteMany({ where: { providerId } });
    await tx.job.deleteMany({ where: { providerId } });

    // "Reset" identity by resetting public routing and reputation fields.
    // The provider id stays stable only because this simulator labels malicious
    // agents by id; economically this now behaves like a fresh registration.
    await tx.provider.update({
      where: { id: providerId },
      data: {
        reputationScore: 3.0,
        traceScore: 500,
        riskTier: "B",
        defaultProbability: 0.20,
        completionRate: 1.0,
        repaymentRate: 1.0,
        successfulEscrowRate: 1.0,
        disputeRate: 0.0,
        scoreVolatility: 0.0,
        totalJobs: 0,
        successfulJobs: 0,
        failedJobs: 0,
        defaultedJobs: 0,
        isBlocked: false,
        blockReason: null,
        disputedJobs: 0,
        totalEconomicVolume: 0,
        networkTrust: 0,
        sybilRisk: 0,
      },
    });
  });
}

function deterministicUnit(providerId: string, routeCount: number): number {
  let hash = 2166136261;
  const input = `${providerId}:whitewash:${routeCount}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}
