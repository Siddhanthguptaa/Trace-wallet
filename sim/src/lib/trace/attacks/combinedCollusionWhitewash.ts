/**
 * Combined collusion + selective default + whitewash (Final_implementation.md).
 * Optional adaptive endorsement intensity via params.adaptive === true.
 */

import { prisma } from "../../db";
import {
  Attack,
  type AttackAgent,
  type AttackDecision,
  type AttackPostRoundResult,
  type AttackConfig,
  type AttackDecisionContext,
} from "./base";
import { AdaptiveCollusionAdversary } from "./adaptiveAdversary";
import { resetProviderIdentity } from "./whitewashing";

export class CombinedCollusionWhitewashAttack extends Attack {
  readonly name = "combined-collusion-whitewash";
  readonly description =
    "Honest build phase, selective high-value defaults, collusion-ring edges, optional adaptive rate, TRACE reset when trust collapses.";

  private buildRounds: number;
  /** Compare (traceScore / 1000) to this threshold for whitewash trigger. */
  private trustExitThreshold: number;
  private maxResets: number;
  private adaptive: AdaptiveCollusionAdversary | null;

  constructor(config: AttackConfig) {
    super(config);
    this.buildRounds = (config.params.buildRounds as number) ?? 20;
    this.trustExitThreshold = (config.params.trustExitThreshold as number) ?? 0.2;
    this.maxResets = (config.params.maxResets as number) ?? 3;
    const jobsPerRound = (config.params.jobsPerRound as number) ?? 3;
    this.adaptive =
      config.params.adaptive === true
        ? new AdaptiveCollusionAdversary({ jobsPerRound })
        : null;
  }

  /**
   * Per-routing bookkeeping for the combined collusion + whitewash
   * attack. Overrides the `Attack.observeRoutingHook` extension point
   * introduced by Task 13.2 — the base class's `observeRouting` already
   * populates the shared `jobsReceivedLedger` for malicious selections,
   * so this hook only forwards to the optional adaptive endorsement
   * adversary's own routing tracker. Calling the ledger here would
   * double-count and is explicitly forbidden by the
   * `observeRoutingHook` contract.
   */
  protected override observeRoutingHook(
    selectedProviderId: string,
    round: number,
    maliciousIds: Set<string>,
  ): void {
    this.adaptive?.observeRouting(selectedProviderId, round, maliciousIds);
  }

  decide(
    agent: AttackAgent,
    round: number,
    _totalRounds: number,
    context?: AttackDecisionContext
  ): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }
    if (round < this.buildRounds) {
      return { shouldDefault: false, reason: "combined_build_history" };
    }
    const job = context?.jobPriceSats ?? 0;
    const med = context?.medianJobPriceSats ?? job;
    if (med > 0 && job > med * 1.2) {
      return { shouldDefault: true, reason: "combined_selective_high_value" };
    }
    return { shouldDefault: false, reason: "combined_active_moderate" };
  }

  async postRound(round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];
    const malicious = this.agents.filter((a) => a.isMalicious);
    if (malicious.length < 2) return { actions };

    const maliciousIds = new Set(malicious.map((m) => m.providerId));

    if (round >= this.buildRounds) {
      let intensity = 1;
      if (this.adaptive) {
        intensity = this.adaptive.getEndorsementIntensity(round, maliciousIds);
      }
      const fakeCount = Math.max(1, Math.round(intensity));

      for (let i = 0; i < Math.min(fakeCount, malicious.length); i++) {
        const src = malicious[i];
        const tgt = malicious[(i + 1) % malicious.length];

        const existing = await prisma.trustEdge.findUnique({
          where: {
            sourceProviderId_targetProviderId: {
              sourceProviderId: src.providerId,
              targetProviderId: tgt.providerId,
            },
          },
        });

        if (existing) {
          await prisma.trustEdge.update({
            where: { id: existing.id },
            data: {
              successfulCoJobs: { increment: 1 },
              economicVolume: { increment: 30 },
              weight: existing.weight + 0.3,
              lastInteraction: new Date(),
            },
          });
        } else {
          await prisma.trustEdge.create({
            data: {
              sourceProviderId: src.providerId,
              targetProviderId: tgt.providerId,
              successfulCoJobs: 1,
              economicVolume: 30,
              escrowReliability: 1.0,
              weight: 1.2,
            },
          });
        }
        actions.push(
          `combined_ring: ${src.providerId.substring(0, 8)} → ${tgt.providerId.substring(0, 8)}`
        );
      }
    }

    for (const agent of malicious) {
      if (!agent.state.resetCount) agent.state.resetCount = 0;
      if ((agent.state.resetCount as number) >= this.maxResets) continue;

      const provider = await prisma.provider.findUnique({
        where: { id: agent.providerId },
        select: { traceScore: true },
      });
      if (!provider) continue;

      const normalized = provider.traceScore / 1000;
      if (normalized < this.trustExitThreshold) {
        await resetProviderIdentity(agent.providerId);
        agent.state.resetCount = (agent.state.resetCount as number) + 1;
        actions.push(`combined_whitewash: ${agent.providerId} (#${agent.state.resetCount})`);
      }
    }

    return { actions };
  }
}
