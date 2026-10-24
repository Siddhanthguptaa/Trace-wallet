/**
 * A2 — Sybil Cluster Attack
 *
 * Creates fake providers that generate fake co-jobs between each other
 * to inflate trust graph edges and network trust scores.
 *
 * Lifecycle:
 *   1. Sybil agents participate in legitimate jobs (mostly honest)
 *   2. Between rounds, they create fake trust edges between each other
 *   3. Inflated network trust → higher TRACE scores → more routing
 *
 * Tests:
 *   - Sybil detection heuristics
 *   - Graph robustness against fake edge injection
 *   - Routing suppression of suspicious clusters
 *
 * Configurable params:
 *   - fakeEdgesPerRound: edges injected per round between sybils [default: 2]
 *   - fakeVolumePerEdge: sats volume on each fake edge [default: 50]
 *   - defaultRate: probability a malicious sybil defaults on a real job [default: 0.3]
 */

import { prisma } from "../../db";
import { Attack, type AttackAgent, type AttackDecision, type AttackPostRoundResult, type AttackConfig, type AttackDecisionContext } from "./base";
import { jobsReceivedLedger } from "./_adversaryBase";

export class SybilClusterAttack extends Attack {
  readonly name = "sybil-cluster";
  readonly description = "Fake providers create artificial trust edges to inflate network trust and manipulate routing.";

  private fakeEdgesPerRound: number;
  private fakeVolumePerEdge: number;
  private defaultRate: number;
  private stealthPhaseRounds: number;
  private burstJitterRange: number;
  private adaptiveEdgeBudget: number;
  private routedRounds: number[] = [];
  // Task 10.2 / R-ATTACK-SYBIL 3: Capability categories for diversity.
  private capabilityDistribution: string[];
  // Task 10.3 / R-ATTACK-SYBIL 4: Fraction of sybils set dormant after detection.
  private dormancyFraction: number;
  // Task 10.3 / R-ATTACK-SYBIL 4: Number of consecutive zero-routing rounds
  // before inferring detection for dormancy decisions.
  private dormancyDetectionK: number;

  constructor(config: AttackConfig) {
    super(config);
    this.fakeEdgesPerRound = (config.params.fakeEdgesPerRound as number) ?? 2;
    this.fakeVolumePerEdge = (config.params.fakeVolumePerEdge as number) ?? 50;
    this.defaultRate = (config.params.defaultRate as number) ?? 0.3;
    // Phase 2 Enhancement: Stealth phase before attack
    this.stealthPhaseRounds = (config.params.stealthPhaseRounds as number) ?? 10;
    // Task 10.1 / R-ATTACK-SYBIL 2: Per-agent burst jitter so all sybils
    // do not begin defaulting on the same round. Each agent's burst start is
    // stealthPhaseRounds + floor(hash(providerId) * burstJitterRange), giving
    // a deterministic offset in [0, burstJitterRange) rounds after the global
    // burst start. Uses FNV-1a hash (same pattern as strategicDefault).
    this.burstJitterRange = (config.params.burstJitterRange as number) ?? 5;
    this.adaptiveEdgeBudget = this.fakeEdgesPerRound;
    // Task 10.2 / R-ATTACK-SYBIL 3: Capability diversity. Sybil providers are
    // distributed across at least 3 capability categories using
    // deterministicHash(providerId) % categories.length for assignment
    // (Property P13). Default categories cover the three primary
    // job types in the marketplace.
    this.capabilityDistribution = (config.params.capabilityDistribution as unknown as string[]) ?? ["compute", "storage", "inference"];
    // Task 10.3 / R-ATTACK-SYBIL 4: Partial persistence after detection.
    // When a subset of sybils are inferred-detected, this fraction is set
    // dormant while the remainder continues exploitation.
    this.dormancyFraction = (config.params.dormancyFraction as number) ?? 0.5;
    // Task 10.3 / R-ATTACK-SYBIL 4: Consecutive zero-routing rounds threshold
    // for inferring detection in the dormancy decision path.
    this.dormancyDetectionK = (config.params.dormancyDetectionK as number) ?? 5;
  }

  /**
   * Task 10.2 / R-ATTACK-SYBIL 3: Override assignAgents to distribute sybil
   * providers across capability categories using deterministicHash(providerId) % categories.length.
   * Ensures at least min(3, maliciousCount) distinct capabilities are present
   * (Property P13).
   */
  override assignAgents(providerIds: string[], maliciousIds?: Set<string>): AttackAgent[] {
    const agents = super.assignAgents(providerIds, maliciousIds);
    // Assign capabilities to malicious agents via deterministic hash of providerId
    for (const agent of agents) {
      if (agent.isMalicious) {
        const hashValue = deterministicHash(agent.providerId);
        // Convert [0,1) float to integer index into capabilityDistribution
        const capIdx = Math.floor(hashValue * this.capabilityDistribution.length) % this.capabilityDistribution.length;
        agent.state.capability = this.capabilityDistribution[capIdx];
      }
    }
    return agents;
  }

  /**
   * Per-routing bookkeeping for the Sybil-cluster attack. Overrides the
   * `Attack.observeRoutingHook` extension point introduced by Task 13.2 —
   * the base class's `observeRouting` already populates the shared
   * `jobsReceivedLedger` for malicious selections, so this hook only
   * maintains the attack's own `routingExposure` counter and per-round
   * routing tally used by `updateAdaptiveEdgeBudget`. Calling the ledger
   * here would double-count and is explicitly forbidden by the
   * `observeRoutingHook` contract.
   */
  protected override observeRoutingHook(
    selectedProviderId: string,
    round: number,
    maliciousIds: Set<string>,
  ): void {
    if (!maliciousIds.has(selectedProviderId)) return;

    const agent = this.agents.find((a) => a.providerId === selectedProviderId);
    if (!agent) return;

    const exposure = (agent.state.routingExposure as number | undefined) ?? 0;
    agent.state.routingExposure = exposure + 1;
    this.routedRounds.push(round);
  }

  decide(agent: AttackAgent, round: number, _totalRounds: number, _context?: AttackDecisionContext): AttackDecision {
    // Sybil agents are mostly honest on real jobs; occasional defaults create fraud exposure.
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    // Task 10.3 / R-ATTACK-SYBIL 4: Partial persistence after detection.
    // If this agent is already marked dormant from a prior round, return early.
    if (agent.state.sybilDormant) {
      return { shouldDefault: false, reason: "sybil_dormant" };
    }

    // Check for detection using configurable dormancyDetectionK and apply
    // dormancy to a configurable fraction of detected sybils.
    if (this.isInferredDetected(agent, round, this.dormancyDetectionK)) {
      // Use deterministic hash to decide if this agent becomes dormant
      const dormancyRoll = deterministicHash(agent.providerId + ":dormancy");
      if (dormancyRoll < this.dormancyFraction) {
        agent.state.sybilDormant = true;
        return { shouldDefault: false, reason: "sybil_dormant" };
      }
      // Remaining fraction continues exploitation
    }

    // Task 10.1 / R-ATTACK-SYBIL 2: Per-agent burst-start jitter so the swarm
    // does not produce a synchronised default signal at round = stealthPhaseRounds.
    // Deterministic per-agent hash (FNV-1a, matches strategicDefault.ts) yields a
    // uniform offset in [0, burstJitterRange) rounds after the global burst start.
    // Reproducible across seeds for the same providerId.
    const globalBurstStart = this.stealthPhaseRounds;
    const jitterUnit = deterministicHash(agent.providerId); // [0, 1)
    const agentBurstStart = globalBurstStart + Math.floor(jitterUnit * this.burstJitterRange);
    if (round < agentBurstStart) {
      return { shouldDefault: false, reason: "sybil_pre_burst_jitter" };
    }

    const routeCount = ((agent.state.routeCount as number | undefined) ?? 0) + 1;
    agent.state.routeCount = routeCount;
    const shouldDefault = deterministicUnit(agent.providerId, routeCount) < this.defaultRate;
    return {
      shouldDefault,
      reason: shouldDefault ? "sybil_opportunistic_default" : "sybil_honest_on_real_jobs",
    };
  }

  async postRound(round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];
    const malicious = this.agents.filter((a) => a.isMalicious);

    if (malicious.length < 2) return { actions };

    // Phase 2 Enhancement: Stealth phase - behave honestly to build initial trust
    if (round < this.stealthPhaseRounds) {
      return { actions: ["sybil_stealth_phase"] };
    }

    // Phase 2 Enhancement: Adaptive edge budget based on routing success
    const effectiveEdgeBudget = this.updateAdaptiveEdgeBudget(round, malicious.length);

    // v3.0 Audit Fix E3: Increased edge budget multiplier from sqrt(N) to sqrt(N)*3.
    // Tests TRACE's graph defenses under stronger adversarial pressure.
    //
    // Task 10.4 / R-ATTACK-BUDGET confirmation:
    //   - `fakeEdgesPerRound` scales with sqrt(maliciousCount) via the
    //     `scaledEdgeBudget = Math.floor(Math.sqrt(malicious.length) * 3.0)` floor.
    //   - Edge injection rotates through different agent pairs using
    //     `startIdx = round % malicious.length` as offset, preventing static
    //     three-agent star topologies (R-ATTACK-BUDGET 3).
    const scaledEdgeBudget = Math.max(
      effectiveEdgeBudget,
      Math.floor(Math.sqrt(malicious.length) * 3.0)
    );

    // Rotate starting index each round so different sybils participate
    // instead of always using indices 0, 1, 2.
    const startIdx = round % malicious.length;

    // Inject fake trust edges between sybil agents in a rotating window
    let edgesCreated = 0;
    for (let offset = 0; offset < malicious.length && edgesCreated < scaledEdgeBudget; offset++) {
      const i = (startIdx + offset) % malicious.length;
      const j = (i + 1) % malicious.length;
      const sourceId = malicious[i].providerId;
      const targetId = malicious[j].providerId;

      try {
        // Upsert fake trust edge (forward)
        const existing = await prisma.trustEdge.findUnique({
          where: { sourceProviderId_targetProviderId: { sourceProviderId: sourceId, targetProviderId: targetId } },
        });

        if (existing) {
          await prisma.trustEdge.update({
            where: { id: existing.id },
            data: {
              successfulCoJobs: { increment: 1 },
              economicVolume: { increment: this.fakeVolumePerEdge },
              weight: existing.weight + 0.5,
              lastInteraction: new Date(),
            },
          });
        } else {
          await prisma.trustEdge.create({
            data: {
              sourceProviderId: sourceId,
              targetProviderId: targetId,
              successfulCoJobs: 1,
              economicVolume: this.fakeVolumePerEdge,
              escrowReliability: 1.0,
              weight: 1.5,
            },
          });
        }

        // Reverse edge (bidirectional trust)
        const existingReverse = await prisma.trustEdge.findUnique({
          where: { sourceProviderId_targetProviderId: { sourceProviderId: targetId, targetProviderId: sourceId } },
        });

        if (existingReverse) {
          await prisma.trustEdge.update({
            where: { id: existingReverse.id },
            data: {
              successfulCoJobs: { increment: 1 },
              economicVolume: { increment: this.fakeVolumePerEdge },
              weight: existingReverse.weight + 0.5,
              lastInteraction: new Date(),
            },
          });
        } else {
          await prisma.trustEdge.create({
            data: {
              sourceProviderId: targetId,
              targetProviderId: sourceId,
              successfulCoJobs: 1,
              economicVolume: this.fakeVolumePerEdge,
              escrowReliability: 1.0,
              weight: 1.5,
            },
          });
        }

        edgesCreated++;
        actions.push(`sybil_fake_edge: ${sourceId.substring(0, 8)} ↔ ${targetId.substring(0, 8)} (+${this.fakeVolumePerEdge} sats)`);
      } catch (error) {
        // Graceful fallback: log error but continue with other edges
        console.error(`Sybil edge creation failed: ${error}`);
      }
    }

    return { actions };
  }

  private updateAdaptiveEdgeBudget(round: number, maliciousCount: number): number {
    // Adaptive behavior: increase edge budget if not getting routed enough
    const adaptiveInterval = 10;
    if (round > this.stealthPhaseRounds && round % adaptiveInterval === 0) {
      const windowStart = round - adaptiveInterval;
      const recentRoutes = this.routedRounds.filter((r) => r >= windowStart && r < round).length;
      
      // Target: at least 5% routing share for sybil cluster
      const targetShare = 0.05;
      const jobsPerRound = 5; // default from config
      const observedShare = recentRoutes / Math.max(1, adaptiveInterval * jobsPerRound);

      if (observedShare < targetShare) {
        // Not getting routed enough - increase edge budget
        this.adaptiveEdgeBudget = Math.min(maliciousCount, this.adaptiveEdgeBudget + 1);
      } else if (observedShare > targetShare * 2) {
        // Getting routed too much - reduce to stay stealthy
        this.adaptiveEdgeBudget = Math.max(1, this.adaptiveEdgeBudget - 1);
      }
    }

    return this.adaptiveEdgeBudget;
  }

  /**
   * Task 10.2 / R-ATTACK-SYBIL 3: Override toJSON to record the capability
   * distribution in the attack's serialised output. This enables per-cell
   * parameter snapshots to include the distribution for audit verification.
   */
  override toJSON() {
    const base = super.toJSON();
    // Compute the actual distribution of capabilities across malicious agents
    const malicious = this.agents.filter((a) => a.isMalicious);
    const distributionCounts: Record<string, number> = {};
    for (const agent of malicious) {
      const cap = (agent.state.capability as string) ?? "unassigned";
      distributionCounts[cap] = (distributionCounts[cap] ?? 0) + 1;
    }
    return {
      ...base,
      capabilityDistribution: this.capabilityDistribution,
      capabilityAssignment: distributionCounts,
      distinctCapabilities: Object.keys(distributionCounts).length,
    };
  }
}

function deterministicUnit(providerId: string, round: number): number {
  let hash = 2166136261;
  const input = `${providerId}:${round}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

// Task 10.1 / R-ATTACK-SYBIL 2: Deterministic per-agent FNV-1a hash for
// reproducible burst-jitter offsets. Mirrors strategicDefault.ts::deterministicHash
// so jitter is stable across seeds for the same providerId.
function deterministicHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}
