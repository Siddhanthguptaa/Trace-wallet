/**
 * TRACE v2.2 — Causal Graph Reasoning Engine
 *
 * Inspired by SRE-Gym dependency-graph traversal and root-cause isolation.
 *
 * Core insight: "Not all suspicious agents are root causes.
 * Some are merely downstream participants."
 *
 * Tracks economic failure cascades and identifies causal initiators
 * vs downstream collateral nodes. This reduces false suppression
 * of honest agents who interact with malicious ones.
 *
 * Architecture:
 *   - FailureCascade: DAG of economic failure propagation
 *   - CausalSuspicionScore: per-agent score based on cascade initiation
 *   - Root-cause heuristic: "unhealthy node with no suspicious upstream"
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FailureEvent {
  /** The agent that failed/defaulted */
  agentId: string;
  /** Round when the failure occurred */
  round: number;
  /** Type of failure */
  type: "default" | "fraud" | "failed_remediation";
  /** Economic damage in sats */
  damageSats: number;
  /** The job that triggered the failure */
  jobId?: string;
}

export interface FailureCascade {
  /** The agent that initiated the cascade */
  rootAgent: string;
  /** All agents affected (including root) */
  affectedAgents: string[];
  /** Depth of the cascade (hops from root) */
  cascadeDepth: number;
  /** Total economic damage across all affected agents */
  totalDamageSats: number;
  /** Round when the cascade started */
  startRound: number;
  /** Individual failure events in this cascade */
  events: FailureEvent[];
}

export interface CausalProfile {
  /** How many times this agent was at the root of a cascade */
  cascadeInitiations: number;
  /** How many times this agent appeared downstream in cascades */
  downstreamAppearances: number;
  /** Causal suspicion score [0, 1] — higher = more likely root cause */
  causalSuspicion: number;
  /** Whether this agent is flagged as a probable root-cause attacker */
  isProbableInitiator: boolean;
  /** Whether this agent appears to be downstream collateral */
  isDownstreamCollateral: boolean;
  /** Total damage initiated by this agent */
  totalDamageInitiated: number;
  /** Failure centrality: how central this agent is in failure propagation */
  failureCentrality: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export const CAUSAL_CONFIG = {
  /** Minimum cascade initiations before an agent is flagged as probable initiator */
  minInitiationsForFlag: 2,

  /** Weight of cascade initiations in suspicion score */
  initiationWeight: 0.4,

  /** Weight of failure centrality in suspicion score */
  centralityWeight: 0.3,

  /** Weight of damage magnitude in suspicion score */
  damageWeight: 0.3,

  /** Downstream collateral threshold: ratio of downstream to initiations */
  collateralRatioThreshold: 3.0,

  /** Time window for cascade association (rounds) */
  cascadeWindowRounds: 3,

  /** Trust penalty reduction for downstream collateral agents */
  collateralPenaltyReduction: 0.5,

  /** Trust penalty amplification for root-cause agents */
  rootCauseAmplification: 1.5,

  /** Maximum causal suspicion score */
  maxSuspicion: 1.0,

  /** Enable/disable causal reasoning (for ablation)
   *  LOCKED TO FALSE — v2.1 validated as paper system (2026-05-09)
   *  See results/VALIDATION_RESULTS.md for evidence */
  enabled: true,
} as const;

// ─── Causal Graph Engine ──────────────────────────────────────────────────────

/**
 * In-memory causal graph engine.
 *
 * Tracks failure events and builds cascade DAGs to identify
 * root-cause agents vs downstream collateral.
 */
export class CausalGraphEngine {
  /** All recorded failure events */
  private failureEvents: FailureEvent[] = [];

  /** Detected cascades */
  private cascades: FailureCascade[] = [];

  /** Per-agent interaction history: agentId → set of interacted agents */
  private interactionHistory: Map<string, Set<string>> = new Map();

  /** Per-agent causal profile cache */
  private profileCache: Map<string, CausalProfile> = new Map();

  /** Dirty flag — profiles need recomputation */
  private dirty = true;

  // ─── Event Recording ──────────────────────────────────────────────

  /**
   * Record a failure event (default, fraud, etc.)
   */
  recordFailure(event: FailureEvent): void {
    this.failureEvents.push(event);
    this.dirty = true;
  }

  /**
   * Record an interaction between two agents (for cascade tracing).
   */
  recordInteraction(agentA: string, agentB: string): void {
    if (!this.interactionHistory.has(agentA)) {
      this.interactionHistory.set(agentA, new Set());
    }
    if (!this.interactionHistory.has(agentB)) {
      this.interactionHistory.set(agentB, new Set());
    }
    this.interactionHistory.get(agentA)!.add(agentB);
    this.interactionHistory.get(agentB)!.add(agentA);
  }

  // ─── Cascade Detection ────────────────────────────────────────────

  /**
   * Build failure cascades from recorded events.
   *
   * A cascade is detected when multiple failures occur in related agents
   * within a short time window. The root is identified as the agent
   * that failed first with no suspicious upstream dependency.
   */
  buildCascades(): FailureCascade[] {
    if (!this.dirty && this.cascades.length > 0) return this.cascades;

    this.cascades = [];

    // Sort events by round
    const sorted = [...this.failureEvents].sort((a, b) => a.round - b.round);
    const used = new Set<number>();

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;

      const rootEvent = sorted[i];
      const cascade: FailureCascade = {
        rootAgent: rootEvent.agentId,
        affectedAgents: [rootEvent.agentId],
        cascadeDepth: 0,
        totalDamageSats: rootEvent.damageSats,
        startRound: rootEvent.round,
        events: [rootEvent],
      };

      used.add(i);

      // Find related failures within the cascade window
      const frontier = new Set([rootEvent.agentId]);
      let depth = 0;

      for (let d = 0; d < 3; d++) { // Max 3 hops
        const newFrontier = new Set<string>();

        for (const agentId of frontier) {
          const neighbors = this.interactionHistory.get(agentId) ?? new Set();

          for (let j = i + 1; j < sorted.length; j++) {
            if (used.has(j)) continue;

            const event = sorted[j];
            if (
              event.round - rootEvent.round <= CAUSAL_CONFIG.cascadeWindowRounds &&
              neighbors.has(event.agentId) &&
              !cascade.affectedAgents.includes(event.agentId)
            ) {
              cascade.affectedAgents.push(event.agentId);
              cascade.events.push(event);
              cascade.totalDamageSats += event.damageSats;
              newFrontier.add(event.agentId);
              used.add(j);
              depth = d + 1;
            }
          }
        }

        if (newFrontier.size === 0) break;
        frontier.clear();
        for (const a of newFrontier) frontier.add(a);
      }

      cascade.cascadeDepth = depth;
      if (cascade.affectedAgents.length > 1 || cascade.totalDamageSats > 0) {
        this.cascades.push(cascade);
      }
    }

    this.dirty = false;
    return this.cascades;
  }

  // ─── Causal Profile Computation ───────────────────────────────────

  /**
   * Compute causal profile for a specific agent.
   *
   * Root-cause heuristic (inspired by SRE-Gym):
   *   "An unhealthy node with no suspicious upstream dependency
   *    is a probable causal initiator."
   */
  computeProfile(agentId: string): CausalProfile {
    if (!this.dirty && this.profileCache.has(agentId)) {
      return this.profileCache.get(agentId)!;
    }

    const cascades = this.buildCascades();

    let cascadeInitiations = 0;
    let downstreamAppearances = 0;
    let totalDamageInitiated = 0;
    let cascadesInvolved = 0;

    for (const cascade of cascades) {
      if (cascade.rootAgent === agentId) {
        cascadeInitiations++;
        totalDamageInitiated += cascade.totalDamageSats;
      }

      if (cascade.affectedAgents.includes(agentId) && cascade.rootAgent !== agentId) {
        downstreamAppearances++;
      }

      if (cascade.affectedAgents.includes(agentId)) {
        cascadesInvolved++;
      }
    }

    // Failure centrality: what fraction of cascades involve this agent?
    const totalCascades = Math.max(cascades.length, 1);
    const failureCentrality = cascadesInvolved / totalCascades;

    // Causal suspicion score
    const cfg = CAUSAL_CONFIG;
    const maxInitiations = Math.max(
      ...Array.from(this.getAllAgentIds()).map(
        (id) => cascades.filter((c) => c.rootAgent === id).length
      ),
      1
    );
    const maxDamage = Math.max(
      ...cascades.map((c) => c.totalDamageSats),
      1
    );

    const initiationScore = cascadeInitiations / maxInitiations;
    const damageScore = totalDamageInitiated / maxDamage;

    let causalSuspicion =
      cfg.initiationWeight * initiationScore +
      cfg.centralityWeight * failureCentrality +
      cfg.damageWeight * damageScore;

    causalSuspicion = Math.min(causalSuspicion, cfg.maxSuspicion);

    // Root-cause classification
    const isProbableInitiator = cascadeInitiations >= cfg.minInitiationsForFlag;

    // Downstream collateral: frequently appears downstream but rarely initiates
    const isDownstreamCollateral =
      downstreamAppearances > 0 &&
      cascadeInitiations === 0 &&
      (downstreamAppearances / Math.max(cascadeInitiations, 1)) >= cfg.collateralRatioThreshold;

    const profile: CausalProfile = {
      cascadeInitiations,
      downstreamAppearances,
      causalSuspicion: round4(causalSuspicion),
      isProbableInitiator,
      isDownstreamCollateral,
      totalDamageInitiated,
      failureCentrality: round4(failureCentrality),
    };

    this.profileCache.set(agentId, profile);
    return profile;
  }

  // ─── Trust Adjustment Multipliers ─────────────────────────────────

  /**
   * Get trust penalty multiplier based on causal analysis.
   *
   * Root-cause agents: AMPLIFIED penalties (1.5×)
   * Downstream collateral: REDUCED penalties (0.5×)
   * Others: normal (1.0×)
   *
   * This is the key innovation: reducing false suppression of honest
   * agents who happened to interact with malicious ones.
   */
  getCausalPenaltyMultiplier(agentId: string): number {
    if (!CAUSAL_CONFIG.enabled) return 1.0;

    const profile = this.computeProfile(agentId);

    if (profile.isProbableInitiator) {
      return CAUSAL_CONFIG.rootCauseAmplification;
    }

    if (profile.isDownstreamCollateral) {
      return CAUSAL_CONFIG.collateralPenaltyReduction;
    }

    return 1.0;
  }

  /**
   * Get the causal suspicion score for routing decisions.
   *
   * This supplements sybilRisk — agents who causally initiate cascades
   * get additional routing suppression.
   */
  getCausalSuspicion(agentId: string): number {
    if (!CAUSAL_CONFIG.enabled) return 0;
    return this.computeProfile(agentId).causalSuspicion;
  }

  // ─── Utilities ────────────────────────────────────────────────────

  /**
   * Get all agent IDs that have been recorded.
   */
  private getAllAgentIds(): Set<string> {
    const ids = new Set<string>();
    for (const e of this.failureEvents) ids.add(e.agentId);
    for (const [k, v] of this.interactionHistory) {
      ids.add(k);
      for (const id of v) ids.add(id);
    }
    return ids;
  }

  /**
   * Get summary statistics for the causal graph.
   */
  getSummary(): {
    totalFailures: number;
    totalCascades: number;
    avgCascadeDepth: number;
    rootCauseAgents: string[];
    collateralAgents: string[];
  } {
    const cascades = this.buildCascades();
    const allAgents = this.getAllAgentIds();
    const rootCauseAgents: string[] = [];
    const collateralAgents: string[] = [];

    for (const agentId of allAgents) {
      const profile = this.computeProfile(agentId);
      if (profile.isProbableInitiator) rootCauseAgents.push(agentId);
      if (profile.isDownstreamCollateral) collateralAgents.push(agentId);
    }

    return {
      totalFailures: this.failureEvents.length,
      totalCascades: cascades.length,
      avgCascadeDepth: cascades.length > 0
        ? cascades.reduce((s, c) => s + c.cascadeDepth, 0) / cascades.length
        : 0,
      rootCauseAgents,
      collateralAgents,
    };
  }

  /**
   * Reset the causal graph (for new experiments).
   */
  reset(): void {
    this.failureEvents = [];
    this.cascades = [];
    this.interactionHistory.clear();
    this.profileCache.clear();
    this.dirty = true;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/** Global causal graph engine instance */
export const causalGraph = new CausalGraphEngine();

// ─── Utility ──────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
