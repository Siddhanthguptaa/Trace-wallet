/**
 * v3.0 Audit Fix — Game-Theoretic Adversary
 *
 * A fully adaptive adversary that observes TRACE's internal state (scores,
 * sybilRisk, routing probabilities) and optimizes its strategy accordingly.
 *
 * This is the strongest possible adversary within the simulation framework:
 * - Reads its own TRACE score to decide when to exploit
 * - Monitors sybilRisk to know when it's being detected
 * - Tracks routing share to calibrate aggression
 * - Retreats when detection signals are high
 * - Exploits when trust is high and detection is low
 *
 * Purpose: Tests whether TRACE's advantage over baselines survives against
 * an adversary that specifically targets TRACE's decision boundaries.
 *
 * This attack does NOT:
 * - Read other agents' scores (no omniscience)
 * - Modify its own DB fields directly (no cheating)
 * - Know the policy being tested (policy-agnostic exploitation)
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

export class GameTheoreticAdversaryAttack extends Attack {
  readonly name = "game-theoretic-adversary";
  readonly description =
    "Fully adaptive adversary that reads TRACE internal state to optimize exploitation timing and retreat behavior.";

  private exploitScoreThreshold: number;
  private retreatSybilThreshold: number;
  private buildPhaseRounds: number;
  private maxExploitBurst: number;

  // Dynamic exploit gate (Option 2 — principled). Re-computed at the end of
  // every round in `postRound` as the 75th percentile of *all* active
  // providers' traceScores. The decision rule "exploit when own score is in
  // the top quartile of trust" replaces the legacy absolute threshold (650),
  // which was an unprincipled magic number that happened to be reachable on
  // synthetic score dynamics but not on real-graph (Bitcoin OTC) dynamics
  // where heterogeneous seeded edge reliability caps the malicious population
  // around traceScore ≈ 545.
  //
  // Observable to the adversary without oracle knowledge: the percentile is
  // computed from public traceScore values and does not depend on the
  // honest/malicious labels (the `notIn` filter is removed).
  //
  // Fallback: until the first `postRound` runs (round 0 decisions), the gate
  // falls back to `exploitScoreThreshold` from constructor params. Combined
  // with `buildPhaseRounds = 15`, the adversary is honest for the first 15
  // rounds anyway, so the fallback is dead code in practice.
  private dynamicExploitThreshold: number | null = null;
  private exploitPercentile: number;

  constructor(config: AttackConfig) {
    super(config);
    // Exploit when TRACE score is above this (trust is high)
    this.exploitScoreThreshold = (config.params.exploitScoreThreshold as number) ?? 650;
    // Retreat when sybilRisk exceeds this (being detected)
    this.retreatSybilThreshold = (config.params.retreatSybilThreshold as number) ?? 0.20;
    // Minimum honest rounds before first exploit attempt
    this.buildPhaseRounds = (config.params.buildPhaseRounds as number) ?? 15;
    // Max consecutive defaults before forced retreat
    this.maxExploitBurst = (config.params.maxExploitBurst as number) ?? 4;
    // v5.0: Configurable percentile for the dynamic exploit gate (default 75).
    // Used by runP75ThresholdSweep.ts to test sensitivity across p50-p90.
    this.exploitPercentile = (config.params.exploitPercentile as number) ?? 75;
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

    // Initialize state
    if (agent.state.phase === undefined) {
      agent.state.phase = "build";
      agent.state.burstCount = 0;
      agent.state.totalExploits = 0;
      agent.state.retreatUntil = 0;
    }

    // Forced retreat period
    if (round < (agent.state.retreatUntil as number)) {
      agent.state.burstCount = 0;
      return { shouldDefault: false, reason: "gta_forced_retreat" };
    }

    // Build phase: always honest
    if (round < this.buildPhaseRounds) {
      agent.state.phase = "build";
      return { shouldDefault: false, reason: "gta_build_phase" };
    }

    // Read own state from DB (cached in agent.state per round)
    const myScore = (agent.state.lastScore as number) ?? 500;
    const mySybilRisk = (agent.state.lastSybilRisk as number) ?? 0;

    // Decision logic: game-theoretic optimization
    // 1. If being detected (high sybilRisk), retreat immediately
    if (mySybilRisk > this.retreatSybilThreshold) {
      agent.state.phase = "retreat";
      agent.state.burstCount = 0;
      agent.state.retreatUntil = round + 10; // 10-round cooldown
      return { shouldDefault: false, reason: `gta_retreat_detected: sybilRisk=${mySybilRisk.toFixed(2)}` };
    }

    // 2. If trust is high enough and not at burst limit, exploit.
    //    The exploit gate is the principled 75th-percentile-of-active-scores
    //    computed at the end of the previous round (`postRound`). Falls back
    //    to the constructor param (default 650) for round 0 only, where the
    //    `buildPhaseRounds` gate above already forces honest behavior anyway.
    const exploitGate = this.dynamicExploitThreshold ?? this.exploitScoreThreshold;
    if (myScore >= exploitGate && (agent.state.burstCount as number) < this.maxExploitBurst) {
      // Preferentially target high-value jobs (rational profit maximization)
      const isHighValue = context?.jobPriceSats && context?.medianJobPriceSats
        && context.jobPriceSats > context.medianJobPriceSats * 1.2;

      if (isHighValue || (agent.state.burstCount as number) < 2) {
        agent.state.phase = "exploit";
        agent.state.burstCount = (agent.state.burstCount as number) + 1;
        agent.state.totalExploits = (agent.state.totalExploits as number) + 1;
        return {
          shouldDefault: true,
          reason: `gta_exploit: score=${myScore}, burst=${agent.state.burstCount}/${this.maxExploitBurst}`,
        };
      }
    }

    // 3. If burst limit reached, force retreat
    if ((agent.state.burstCount as number) >= this.maxExploitBurst) {
      agent.state.phase = "retreat";
      agent.state.burstCount = 0;
      agent.state.retreatUntil = round + 8;
      return { shouldDefault: false, reason: "gta_burst_limit_retreat" };
    }

    // 4. Default: stay honest, accumulate trust
    agent.state.phase = "build";
    return { shouldDefault: false, reason: `gta_accumulating: score=${myScore}` };
  }

  async postRound(round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];
    const malicious = this.agents.filter((a) => a.isMalicious);

    // Game-theoretic state update: read own TRACE scores and sybilRisk
    // This is the key differentiator — the adversary observes its own detection signals
    for (const agent of malicious) {
      try {
        const provider = await prisma.provider.findUnique({
          where: { id: agent.providerId },
          select: { traceScore: true, sybilRisk: true, networkTrust: true },
        });
        if (provider) {
          agent.state.lastScore = provider.traceScore;
          agent.state.lastSybilRisk = provider.sybilRisk;
          agent.state.lastNetworkTrust = provider.networkTrust;
        }
      } catch {
        // Non-fatal
      }
    }

    // Recompute the dynamic exploit threshold (Option 2 — principled).
    // 75th percentile of all active providers' traceScores. Public information
    // — no oracle knowledge of honest/malicious labels required.
    try {
      const allActive = await prisma.provider.findMany({
        where: { isActive: true },
        select: { traceScore: true },
      });
      if (allActive.length > 0) {
        const sorted = allActive.map((p) => p.traceScore).sort((a, b) => a - b);
        const idx = Math.floor(sorted.length * (this.exploitPercentile / 100));
        this.dynamicExploitThreshold = sorted[Math.min(idx, sorted.length - 1)];
      }
    } catch {
      // Non-fatal — keep prior threshold if any
    }

    // Sparse graph manipulation: create edges to honest-looking agents
    // (not between malicious agents — that's too detectable)
    if (round >= this.buildPhaseRounds && round % 3 === 0) {
      // Find top honest-looking providers to target for edge creation.
      // We avoid `notIn: [...maliciousIds]` because at large N (e.g. 5000+)
      // this generates a parameter list that exceeds SQLite's per-query
      // parameter limit. Instead we over-fetch by score and filter the
      // malicious agents out in JS using the in-memory set.
      const maliciousIdSet = new Set(malicious.map((a) => a.providerId));
      const candidatePool = await prisma.provider.findMany({
        where: {
          isActive: true,
          traceScore: { gte: 600 },
        },
        orderBy: { traceScore: "desc" },
        take: 3 + maliciousIdSet.size, // headroom so 3 honest survive the filter
        select: { id: true },
      });
      const honestTargets = candidatePool
        .filter((p) => !maliciousIdSet.has(p.id))
        .slice(0, 3);

      // Each malicious agent creates at most 1 edge to an honest target per cycle
      const edgeBudget = Math.min(malicious.length, honestTargets.length * 2);
      for (let i = 0; i < edgeBudget; i++) {
        const src = malicious[i % malicious.length];
        const tgt = honestTargets[i % honestTargets.length];

        // Only create edge if agent is in build/retreat phase (not exploiting)
        if (src.state.phase === "exploit") continue;

        try {
          const existing = await prisma.trustEdge.findUnique({
            where: {
              sourceProviderId_targetProviderId: {
                sourceProviderId: src.providerId,
                targetProviderId: tgt.id,
              },
            },
          });

          if (existing) {
            await prisma.trustEdge.update({
              where: { id: existing.id },
              data: {
                successfulCoJobs: { increment: 1 },
                economicVolume: { increment: 50 },
                weight: Math.min(existing.weight + 0.2, 5.0),
                lastInteraction: new Date(),
              },
            });
          } else {
            await prisma.trustEdge.create({
              data: {
                sourceProviderId: src.providerId,
                targetProviderId: tgt.id,
                successfulCoJobs: 1,
                economicVolume: 50,
                escrowReliability: 1.0,
                weight: 1.0,
              },
            });
          }
          actions.push(`gta_honest_edge: ${src.providerId.substring(0, 8)}→${tgt.id.substring(0, 8)}`);
        } catch {
          // Non-fatal
        }
      }
    }

    return { actions };
  }
}
