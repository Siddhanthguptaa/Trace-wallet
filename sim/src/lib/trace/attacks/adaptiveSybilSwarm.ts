/**
 * TRACE v2.5 — Adaptive Sybil Swarm
 * 
 * A tiered adversarial model that mimics sophisticated multi-identity attacks:
 * 
 * 1. SEEDERS: Long-lived identities that perform honest work initially 
 *    to embed themselves in the incumbent trust core.
 * 2. AMPLIFIERS: Mid-tier identities that provide "cross-trust" to Exploiters,
 *    creating artificial diversity signals.
 * 3. EXPLOITERS: High-frequency default identities that "burst" attack
 *    once their score/trust exceeds a threshold.
 * 
 * Adaptive Behavior:
 * - Activation Delay: Exploiters wait for a "Trust Threshold" before defaulting.
 * - Mutation: If an Exploiter's score drops below a floor, it "mutates" (resets).
 */

import { prisma } from "../../db";
import { Attack, type AttackAgent, type AttackDecision, type AttackPostRoundResult, type AttackConfig, type AttackDecisionContext } from "./base";

export class AdaptiveSybilSwarmAttack extends Attack {
  readonly name = "adaptive-sybil-swarm";
  readonly description = "Tiered sybil attack with seeders, amplifiers, and exploiters that adapt based on trust thresholds.";

  private seedRatio: number;
  private amplifierRatio: number;
  private activationThreshold: number;
  private burstRate: number;
  private stealthRate: number;
  private stealthPhaseRounds: number;

  constructor(config: AttackConfig) {
    super(config);
    this.seedRatio = (config.params.seedRatio as number) ?? 0.2;
    this.amplifierRatio = (config.params.amplifierRatio as number) ?? 0.3;
    this.activationThreshold = (config.params.activationThreshold as number) ?? 600;
    this.burstRate = (config.params.burstRate as number) ?? 0.8;
    this.stealthRate = (config.params.stealthRate as number) ?? 0.05;
    this.stealthPhaseRounds = (config.params.stealthPhaseRounds as number) ?? 10;
  }

  decide(agent: AttackAgent, round: number, _totalRounds: number, _context?: AttackDecisionContext): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    // Initialize agent role
    if (!agent.state.role) {
      const malicious = this.agents.filter(a => a.isMalicious);
      const idx = malicious.findIndex(a => a.providerId === agent.providerId);
      const nSeeders = Math.ceil(malicious.length * this.seedRatio);
      const nAmplifiers = Math.ceil(malicious.length * this.amplifierRatio);
      
      if (idx < nSeeders) {
        agent.state.role = "seeder";
      } else if (idx < nSeeders + nAmplifiers) {
        agent.state.role = "amplifier";
      } else {
        agent.state.role = "exploiter";
      }
    }

    // Stealth phase: all agents honest
    if (round < this.stealthPhaseRounds) {
      return { shouldDefault: false, reason: `${agent.state.role}_stealth_phase` };
    }

    // Seeders and amplifiers stay mostly honest
    if (agent.state.role === "seeder" || agent.state.role === "amplifier") {
      const shouldDefault = deterministicUnit(agent.providerId, round) < 0.01;
      return {
        shouldDefault,
        reason: shouldDefault ? `${agent.state.role}_rare_default` : `${agent.state.role}_honest`,
      };
    }

    // Exploiters: adaptive based on score
    const routeCount = ((agent.state.routeCount as number | undefined) ?? 0) + 1;
    agent.state.routeCount = routeCount;
    
    // Check if activated (would need provider score, use state as proxy)
    const isActivated = (agent.state.activated as boolean) ?? false;
    const defaultRate = isActivated ? this.burstRate : this.stealthRate;
    const shouldDefault = deterministicUnit(agent.providerId, routeCount) < defaultRate;
    
    return {
      shouldDefault,
      reason: shouldDefault 
        ? (isActivated ? "exploiter_burst" : "exploiter_probe")
        : "exploiter_building_trust",
    };
  }

  async postRound(round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];
    
    // Skip stealth phase
    if (round < this.stealthPhaseRounds) {
      return { actions: ["sybil_swarm_stealth_phase"] };
    }

    const malicious = this.agents.filter((a) => a.isMalicious);
    if (malicious.length < 2) return { actions };

    const nSeeders = Math.ceil(malicious.length * this.seedRatio);
    const nAmplifiers = Math.ceil(malicious.length * this.amplifierRatio);
    
    const seeders = malicious.slice(0, nSeeders);
    const amplifiers = malicious.slice(nSeeders, nSeeders + nAmplifiers);
    const exploiters = malicious.slice(nSeeders + nAmplifiers);

    // Edge budget scales with sqrt(N)
    const edgeBudget = Math.ceil(Math.sqrt(malicious.length));
    
    for (let i = 0; i < edgeBudget && i < seeders.length && amplifiers.length > 0; i++) {
      const s = seeders[i];
      const a = amplifiers[i % amplifiers.length];
      
      try {
        await upsertFakeEdge(s.providerId, a.providerId, 500);
        actions.push(`seeder→amplifier: ${s.providerId.substring(0, 8)}→${a.providerId.substring(0, 8)}`);
      } catch (e) {
        // Graceful fallback on DB error
        console.warn(`Failed to create trust edge: ${e}`);
      }
    }

    // Amplifier → Exploiter edges
    for (let i = 0; i < edgeBudget && amplifiers.length > 0 && exploiters.length > 0; i++) {
      const a = amplifiers[i % amplifiers.length];
      const ex = exploiters[i % exploiters.length];
      
      try {
        await upsertFakeEdge(a.providerId, ex.providerId, 200);
        actions.push(`amplifier→exploiter: ${a.providerId.substring(0, 8)}→${ex.providerId.substring(0, 8)}`);
      } catch (e) {
        console.warn(`Failed to create trust edge: ${e}`);
      }
    }

    // Update exploiter activation status based on score
    for (const ex of exploiters) {
      try {
        const provider = await prisma.provider.findUnique({
          where: { id: ex.providerId },
          select: { traceScore: true },
        });
        
        if (provider && provider.traceScore >= this.activationThreshold) {
          ex.state.activated = true;
        }
      } catch (e) {
        console.warn(`Failed to check provider score: ${e}`);
      }
    }

    return { actions };
  }
}

function deterministicUnit(providerId: string, round: number): number {
  let hash = 2166136261;
  const input = `${providerId}:sybil-swarm:${round}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
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
