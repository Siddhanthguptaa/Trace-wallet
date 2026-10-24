/**
 * TRACE v2.5 — Adaptive Collusion Market
 * 
 * A sparse coordination model where attackers don't just form a clique,
 * but actively monitor the network state to optimize trust propagation.
 * 
 * 1. CLUSTER DETECTION: Attackers identify the most "open" honest hubs
 *    and target them for outbound trust to bypass entropy filters.
 * 2. INDIRECT PATHS: Trust is routed through 2-hop or 3-hop paths
 *    to minimize circularity signals.
 * 3. PHASED EXPLOITATION:
 *    - Phase A: Build Trust (Honest work, cross-trust).
 *    - Phase B: Harvest (Coordinated defaults on high-value jobs).
 */

import { prisma } from "../../db";
import { Attack, type AttackAgent, type AttackDecision, type AttackPostRoundResult, type AttackConfig, type AttackDecisionContext } from "./base";

export class AdaptiveCollusionMarketAttack extends Attack {
  readonly name = "adaptive-collusion-market";
  readonly description = "Sparse collusion network that targets honest hubs and adapts exploitation based on median attacker score.";

  private sparsity: number;
  private externalHubTargeting: number;
  private harvestThreshold: number;
  private buildPhaseRounds: number;

  constructor(config: AttackConfig) {
    super(config);
    this.sparsity = (config.params.sparsity as number) ?? 0.3;
    this.externalHubTargeting = (config.params.externalHubTargeting as number) ?? 5;
    this.harvestThreshold = (config.params.harvestThreshold as number) ?? 650;
    this.buildPhaseRounds = (config.params.buildPhaseRounds as number) ?? 30;
  }

  decide(agent: AttackAgent, round: number, _totalRounds: number, context?: AttackDecisionContext): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    // Build phase: mostly honest
    if (round < this.buildPhaseRounds) {
      const shouldDefault = deterministicUnit(agent.providerId, round) < 0.02;
      return {
        shouldDefault,
        reason: shouldDefault ? "collusion_market_probe" : "collusion_market_build_trust",
      };
    }

    // Harvest phase: check if collective score is high enough
    const isHarvesting = (agent.state.isHarvesting as boolean) ?? false;
    
    if (isHarvesting) {
      // Preferentially default on high-value jobs
      const isHighValue = context?.jobPriceSats && context?.medianJobPriceSats
        && context.jobPriceSats > context.medianJobPriceSats * 1.5;
      
      const defaultRate = isHighValue ? 0.9 : 0.7;
      const shouldDefault = deterministicUnit(agent.providerId, round) < defaultRate;
      
      return {
        shouldDefault,
        reason: shouldDefault 
          ? (isHighValue ? "collusion_market_harvest_high_value" : "collusion_market_harvest")
          : "collusion_market_harvest_selective",
      };
    }

    // Not harvesting yet: low default rate
    const shouldDefault = deterministicUnit(agent.providerId, round) < 0.05;
    return {
      shouldDefault,
      reason: shouldDefault ? "collusion_market_opportunistic" : "collusion_market_waiting",
    };
  }

  async postRound(round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];
    const malicious = this.agents.filter((a) => a.isMalicious);

    if (malicious.length < 2) return { actions };

    try {
      // 1. Target honest hubs for outbound entropy
      const honestHubs = await prisma.provider.findMany({
        where: { 
          isActive: true,
          id: { notIn: malicious.map(a => a.providerId) }
        },
        orderBy: { traceScore: "desc" },
        take: this.externalHubTargeting,
      });

      // 2. Build sparse internal trust network
      const edgeBudget = Math.ceil(malicious.length * this.sparsity);
      
      for (let i = 0; i < Math.min(edgeBudget, malicious.length); i++) {
        const attacker = malicious[i];
        
        // Sparse internal edges (multi-hop: skip one node)
        const targetIdx = (i + 2) % malicious.length;
        const target = malicious[targetIdx];
        
        if (target && target.providerId !== attacker.providerId) {
          try {
            await upsertFakeEdge(attacker.providerId, target.providerId, 100);
            actions.push(`collusion_internal: ${attacker.providerId.substring(0, 8)}→${target.providerId.substring(0, 8)}`);
          } catch (e) {
            console.warn(`Failed to create internal edge: ${e}`);
          }
        }

        // Target honest hubs (20% probability per hub)
        for (const hub of honestHubs) {
          if (deterministicUnit(attacker.providerId + hub.id, round) < 0.2) {
            try {
              await upsertFakeEdge(attacker.providerId, hub.id, 300);
              actions.push(`collusion_hub_target: ${attacker.providerId.substring(0, 8)}→${hub.id.substring(0, 8)}`);
            } catch (e) {
              console.warn(`Failed to create hub edge: ${e}`);
            }
          }
        }
      }

      // 3. Harvest decision based on median score
      const scores = await Promise.all(
        malicious.map(async (a) => {
          try {
            const p = await prisma.provider.findUnique({
              where: { id: a.providerId },
              select: { traceScore: true },
            });
            return p?.traceScore ?? 500;
          } catch {
            return 500;
          }
        })
      );
      
      scores.sort((a, b) => a - b);
      const medianScore = scores[Math.floor(scores.length / 2)] ?? 500;
      const isHarvesting = medianScore >= this.harvestThreshold;

      // Update all agents' harvest status
      for (const agent of malicious) {
        agent.state.isHarvesting = isHarvesting;
      }

      if (isHarvesting) {
        actions.push(`collusion_market_HARVEST_ACTIVATED (median=${medianScore})`);
      }

    } catch (e) {
      console.warn(`Adaptive collusion market postRound error: ${e}`);
    }

    return { actions };
  }
}

function deterministicUnit(input: string, round: number): number {
  let hash = 2166136261;
  const str = `${input}:collusion-market:${round}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Local helper to upsert a fake trust edge without importing from
 * `trustGraph.ts` (R-ATTACK-ADAPT 4, Property P15). Mirrors the
 * direct-prisma pattern used by `sybilCluster.ts` and `collusionRing.ts`.
 */
async function upsertFakeEdge(
  sourceProviderId: string,
  targetProviderId: string,
  volumeSats: number,
): Promise<void> {
  if (sourceProviderId === targetProviderId) return;
  const existing = await prisma.trustEdge.findUnique({
    where: {
      sourceProviderId_targetProviderId: { sourceProviderId, targetProviderId },
    },
  });
  if (existing) {
    await prisma.trustEdge.update({
      where: { id: existing.id },
      data: {
        successfulCoJobs: { increment: 1 },
        economicVolume: { increment: volumeSats },
        weight: Math.min(existing.weight + 0.5, 5.0),
        lastInteraction: new Date(),
      },
    });
  } else {
    await prisma.trustEdge.create({
      data: {
        sourceProviderId,
        targetProviderId,
        successfulCoJobs: 1,
        economicVolume: volumeSats,
        escrowReliability: 1.0,
        weight: 1.5,
      },
    });
  }
}
