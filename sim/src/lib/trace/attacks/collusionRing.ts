/**
 * A4 — Collusion Ring Attack
 *
 * Multiple malicious agents coordinate to:
 *   - Generate fake co-jobs between each other
 *   - Exchange fake positive interactions
 *   - Inflate each other's repayment history
 *   - Manipulate graph trust via circular patterns
 *
 * Unlike Sybil: colluders also do real jobs (sometimes defaulting)
 * while secretly boosting each other's metrics.
 *
 * Tests:
 *   - Graph robustness against coordinated manipulation
 *   - Circular pattern detection
 *   - Whether inflated trust translates to routing dominance
 *
 * Configurable params:
 *   - boostPerRound: artificial score boost per colluder per round [default: 15]
 *   - defaultRate: rate at which colluders default on real jobs [default: 0.15]
 *   - exploitDefaultRate: post-build-up default rate once routed [default: 0.75]
 *   - fakeCoJobs: fake co-job edges created per round [default: sqrt(maliciousCount)*3]
 *   - honestInterleaveFraction: fraction of fake edges replaced by honest-looking
 *       edges to random honest agents [default: 0.3] — see Task 11.2 / R-ATTACK-RING 2.
 *       Maintains plausible honest job histories alongside fake co-job records.
 *   - hopSchedule: per-round rotation of hop offsets for multi-hop indirect chains
 *       [default: [1]] — see Task 11.1 / R-ATTACK-RING 1.
 *       Each round selects ONE offset from the schedule (cycling), so each
 *       participant contributes exactly one out-edge per round. This ensures
 *       the ring is sparse: at most 2 directed edges per participant (one in,
 *       one out) forming a cycle of length ≥ 3.
 *
 * --------------------------------------------------------------------------
 * Topology — multi-hop indirect chains (R-ATTACK-RING 1, Task 11.1)
 * --------------------------------------------------------------------------
 * The ring topology is a sparse, indirect chain rather than a near-clique.
 * For a malicious population of size k (≥ 3), each round selects a single
 * hop offset from `hopSchedule` (cycling through the array by round number).
 * Ring member i contributes exactly one fake co-job edge to node
 * `(i + hop) % k` where `hop` is the active offset for that round.
 *
 * Sparsity invariant: each participant has at most 2 directed edges per
 * round — exactly one outgoing edge (to its successor at the active hop
 * offset) and exactly one incoming edge (from its predecessor at the same
 * offset). This forms a directed cycle of length k ≥ 3.
 *
 * With the default `hopSchedule = [1]` and k = 3 this yields exactly the
 * A→B→C→A pattern named in the requirement (R-ATTACK-RING 1: "multi-hop
 * indirect chains, for example A→B→C→A trust laundering"). Larger k with
 * `hopSchedule = [1]` yields a single Hamiltonian cycle through the
 * malicious population.
 *
 * Theoretical justification — trust-laundering chains. A direct-clique
 * heuristic that scores edges by direct adjacency cannot collapse a
 * pure cycle: no two ring members share a direct trust edge in both
 * directions, and the only way to associate two non-adjacent ring members
 * is to traverse the cycle through one or more intermediaries. This is
 * structurally analogous to financial "trust laundering": A's trust in B
 * propagates to C only via B, so detection requires multi-hop reasoning
 * rather than direct neighbour inspection.
 *
 * Per-round rotation. A schedule like `[1, 3]` rotates between hop-1
 * edges on even rounds and hop-3 edges on odd rounds. Each individual
 * round still produces exactly k directed edges (one per participant),
 * preserving the sparsity invariant. Over multiple rounds the accumulated
 * graph thickens, but any single-round snapshot remains a simple cycle.
 *
 * Edge density vs. clique. In any single round, the topology produces
 * exactly k directed edges — linear in k — versus k·(k−1) ≈ k² edges
 * for a clique. At k=10 this is 10 edges per round; the equivalent
 * clique would be 90. The ring is therefore O(k)-sparse while still
 * forming a single Strongly Connected Component (SCC size = k),
 * satisfying R-ATTACK-BUDGET 5 (SCC > 1 by round ≥ 10) without giving
 * direct-clique detectors an easy signal.
 *
 * Generalisability. Indirect-chain topologies generalise to any
 * graph-aware router that scores edges by direct adjacency. They are
 * not specific to TRACE's `detectDenseSubgraphRisk` /
 * `runTarjanSCC` — any defender that does not perform multi-hop
 * traversal sees a low-density graph rather than a colluder ring.
 */

import { prisma } from "../../db";
import { Attack, type AttackAgent, type AttackDecision, type AttackPostRoundResult, type AttackConfig, type AttackDecisionContext } from "./base";

export class CollusionRingAttack extends Attack {
  readonly name = "collusion-ring";
  readonly description = "Coordinated malicious agents inflate each other's trust via fake interactions and mutual boosting.";

  private boostPerRound: number;
  private defaultRate: number;
  private exploitDefaultRate: number;
  private fakeCoJobs: number;
  private hopSchedule: number[];
  private adaptiveTargetRoutingShare: number;
  private adaptiveInterval: number;
  private adaptiveFakeCoJobs: number;
  private routedRounds: number[] = [];
  // Task 11.2 / R-ATTACK-RING 2: Fraction of fake edges replaced by honest-looking edges.
  private honestInterleaveFraction: number;

  constructor(config: AttackConfig) {
    super(config);
    this.boostPerRound = (config.params.boostPerRound as number) ?? 15;
    this.defaultRate = (config.params.defaultRate as number) ?? 0.15;
    this.exploitDefaultRate = (config.params.exploitDefaultRate as number) ?? 0.75;
    // v3.0 Audit Fix E3: Increased edge budget from sqrt(N) to sqrt(N)*3.
    // The previous sqrt(N) budget was structurally underpowered — honest agents
    // accumulate ~5 edges/round naturally, so the adversary's graph manipulation
    // was smaller than honest agents' natural edge accumulation. Tripling the
    // multiplier tests TRACE's breaking point more rigorously.
    const expectedMalicious = Math.floor(config.totalAgents * config.maliciousRatio);
    const scaledDefault = Math.max(2, Math.floor(Math.sqrt(expectedMalicious) * 3.0));
    this.fakeCoJobs = (config.params.fakeCoJobs as number) ?? scaledDefault;
    // Task 11.1 / R-ATTACK-RING 1 — multi-hop indirect chains.
    //
    // `hopSchedule` is a per-round rotation of hop offsets. Each round
    // selects ONE offset from the schedule (cycling by round number),
    // so each participant contributes exactly one out-edge per round.
    // This enforces the sparsity invariant: at most 2 directed edges
    // per participant (one in, one out) forming a cycle of length ≥ 3.
    //
    // The previous mesh injected edges at offsets {+1, +2} from each
    // ring member simultaneously, which is structurally a near-clique
    // within a small 2-step neighbourhood and trivially detected by
    // direct-clique heuristics (e.g. `detectDenseSubgraphRisk`).
    //
    // R-ATTACK-RING 1 requires the topology to be a multi-hop indirect
    // chain — A→B→C→A trust laundering — so each ring member's fake
    // co-job edge targets a node one or more hops away in the malicious
    // permutation. With `hopSchedule = [1]` this yields the canonical
    // A→B→C→A cycle. With `hopSchedule = [1, 3]` the topology rotates
    // between hop-1 cycles on even rounds and hop-3 cycles on odd
    // rounds — each individual round remains a simple cycle.
    //
    // Note on the schema. `config.params` accepts `number[]` per
    // `AttackConfig.params` in `base.ts`. An undefined or empty
    // schedule falls back to `[1]` so the audited default is always
    // a pure A→B→C→A cycle.
    const rawHopSchedule = (config.params.hopSchedule as number[] | undefined) ?? [1];
    this.hopSchedule = rawHopSchedule.length > 0 ? rawHopSchedule : [1];
    this.adaptiveTargetRoutingShare = (config.params.adaptiveTargetRoutingShare as number) ?? 0.08;
    this.adaptiveInterval = (config.params.adaptiveInterval as number) ?? 10;
    this.adaptiveFakeCoJobs = this.fakeCoJobs;
    // Task 11.2 / R-ATTACK-RING 2: Honest-history interleaving fraction.
    // Every Nth fake edge (where N = 1/honestInterleaveFraction) is replaced by
    // a legitimate-looking edge to a random honest agent, maintaining plausible
    // honest job histories alongside fake co-job records.
    this.honestInterleaveFraction = (config.params.honestInterleaveFraction as number) ?? 0.3;
  }

  /**
   * Per-routing bookkeeping for the collusion-ring attack. Overrides the
   * `Attack.observeRoutingHook` extension point introduced by Task 13.2 —
   * the base class's `observeRouting` already populates the shared
   * `jobsReceivedLedger` for malicious selections, so this hook only
   * maintains the attack's own `routingExposure` counter (consumed by
   * `decide` to switch into the high-default exploit phase) and the
   * per-round routing tally used by `updateAdaptiveEndorsementBudget`.
   * Calling the ledger here would double-count and is explicitly
   * forbidden by the `observeRoutingHook` contract.
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

  decide(agent: AttackAgent, round: number, totalRounds: number, _context?: AttackDecisionContext): AttackDecision {
    if (!agent.isMalicious) {
      return { shouldDefault: false, reason: "honest_agent" };
    }

    const attackStartRound = Math.floor(totalRounds * 0.6);
    const hasRealExposure = ((agent.state.routingExposure as number | undefined) ?? 0) > 0;
    const activeDefaultRate = round >= attackStartRound && hasRealExposure
      ? this.exploitDefaultRate
      : this.defaultRate;

    const shouldDefault = deterministicUnit(agent.providerId, round) < activeDefaultRate;

    // Task 11.2 / R-ATTACK-RING 2: Track honest job count for interleaving.
    if (!shouldDefault) {
      agent.state.honestJobCount = ((agent.state.honestJobCount as number) ?? 0) + 1;
    }

    return {
      shouldDefault,
      reason: shouldDefault
        ? (round >= attackStartRound ? "collusion_exploit_after_trust_building" : "collusion_probe_default")
        : "collusion_honest_round",
    };
  }

  async postRound(round: number, _totalRounds: number): Promise<AttackPostRoundResult> {
    const actions: string[] = [];
    const malicious = this.agents.filter((a) => a.isMalicious);

    if (malicious.length < 2) return { actions };

    const effectiveFakeCoJobs = this.updateAdaptiveEndorsementBudget(round, malicious.length);

    // Task 11.3 / R-ATTACK-RING 3, R-ATTACK-BUDGET 4:
    // Ring participation count is set as a function of sqrt(maliciousCount)
    // from round 1 — no ramp from 1. The constructor already computes
    // `fakeCoJobs = sqrt(maliciousCount) * 3` which seeds the adaptive
    // budget, but participation itself must be explicitly sqrt-scaled
    // from the first round to satisfy the requirement.
    //
    // The floor is ceil(sqrt(maliciousCount)) which ensures meaningful
    // ring formation even at small population sizes. We also keep the
    // ≥ 10% floor so SCC formation is robust under very small malicious
    // populations (R-ATTACK-BUDGET 5 / R-ATTACK-RING 5).
    const sqrtParticipation = Math.ceil(Math.sqrt(malicious.length));
    const minParticipation = Math.max(
      sqrtParticipation,
      Math.ceil(malicious.length * 0.10)
    );
    const participatingAgents = Math.min(
      malicious.length,
      Math.max(minParticipation, Math.ceil(effectiveFakeCoJobs * 1.2))
    );

    // Task 11.1 / R-ATTACK-RING 1 — multi-hop indirect chains.
    //
    // Sparsity invariant: each participant has at most 2 directed edges
    // per round (one in, one out) forming a cycle of length ≥ 3.
    //
    // Implementation: each round selects ONE hop offset from
    // `hopSchedule` by cycling through the array. This means each
    // participating agent contributes exactly one out-edge to the node
    // `hop` steps away in the malicious permutation, i.e.
    // ring[i] → ring[(i + hop) % ringSize].
    //
    // With the default `hopSchedule = [1]` and ringSize = 3 this
    // realises exactly the A→B→C→A trust-laundering chain named in
    // R-ATTACK-RING 1 — no two ring members share a direct trust edge
    // in both directions, so a direct-clique heuristic must traverse
    // the cycle through one or more intermediaries to associate two
    // non-adjacent ring members.
    //
    // The per-round rotation through the schedule means that over
    // multiple rounds the accumulated graph thickens (different hop
    // offsets create different cycle patterns), but any single-round
    // snapshot is always a simple directed cycle — O(k) edges, not
    // O(k²) as in a clique.
    //
    // Minimum ring size. The cycle must have length ≥ 3 to qualify as
    // a multi-hop indirect chain (a 2-cycle is just a mutual edge pair,
    // trivially detected). If fewer than 3 malicious agents exist, no
    // ring edges are created.
    const ringSize = malicious.length;

    // Enforce minimum cycle length ≥ 3 (R-ATTACK-RING 1).
    if (ringSize < 3) return { actions };

    // Select the active hop offset for this round by cycling through
    // the hopSchedule array. This ensures only ONE offset is active
    // per round, maintaining the sparsity invariant.
    const activeHop = this.hopSchedule[round % this.hopSchedule.length];

    // Skip degenerate cases where the hop would create self-loops.
    if (activeHop % ringSize === 0) return { actions };

    let edgesCreated = 0;
    // Task 11.2 / R-ATTACK-RING 2: Pre-compute honest agent list for interleaving.
    const honestAgents = this.agents.filter((a) => !a.isMalicious);
    for (let i = 0; i < participatingAgents && edgesCreated < effectiveFakeCoJobs; i++) {
      const src = malicious[i];
      const tgt = malicious[(i + activeHop) % ringSize];

      // Task 11.2 / R-ATTACK-RING 2: Honest-history interleaving.
      // Every Nth edge (where N ≈ 1/honestInterleaveFraction) is replaced by a
      // legitimate-looking edge from the colluder to a random honest agent,
      // maintaining plausible honest job histories alongside fake co-job records.
      const shouldInterleaveHonest =
        this.honestInterleaveFraction > 0 &&
        honestAgents.length > 0 &&
        ((edgesCreated + 1) % Math.max(1, Math.round(1 / this.honestInterleaveFraction)) === 0);

      if (shouldInterleaveHonest) {
        // Pick a deterministic honest target based on round and edge index
        const honestIdx = (round * 7 + edgesCreated) % honestAgents.length;
        const honestTarget = honestAgents[honestIdx];
        try {
          const existing = await prisma.trustEdge.findUnique({
            where: {
              sourceProviderId_targetProviderId: {
                sourceProviderId: src.providerId,
                targetProviderId: honestTarget.providerId,
              },
            },
          });

          if (existing) {
            await prisma.trustEdge.update({
              where: { id: existing.id },
              data: {
                successfulCoJobs: { increment: 1 },
                economicVolume: { increment: 20 },
                weight: existing.weight + 0.2,
                lastInteraction: new Date(),
              },
            });
          } else {
            await prisma.trustEdge.create({
              data: {
                sourceProviderId: src.providerId,
                targetProviderId: honestTarget.providerId,
                successfulCoJobs: 1,
                economicVolume: 20,
                escrowReliability: 1.0,
                weight: 1.0,
              },
            });
          }

          edgesCreated++;
          actions.push(
            `collusion_honest_interleave: ${src.providerId.substring(0, 8)} → ${honestTarget.providerId.substring(0, 8)}`
          );
        } catch (error) {
          console.error(`Collusion honest-interleave edge failed: ${error}`);
        }
        continue;
      }

      try {
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

        edgesCreated++;
        actions.push(
          `collusion_chain_edge[hop=${activeHop}]: ${src.providerId.substring(0, 8)} → ${tgt.providerId.substring(0, 8)}`
        );
      } catch (error) {
        // Graceful fallback: log error but continue with other edges
        console.error(`Collusion edge creation failed: ${error}`);
      }
    }

    // F3 fix: Removed fake stat inflation (totalJobs, reputationScore, etc.)
    // Attacks should only manipulate their actual attack surface (graph edges),
    // not directly inflate provider-level stats that conflict with recomputeMetrics().

    return { actions };
  }

  private updateAdaptiveEndorsementBudget(round: number, maliciousCount: number): number {
    if (round > 0 && round % this.adaptiveInterval === 0) {
      const windowStart = round - this.adaptiveInterval;
      const recentRoutes = this.routedRounds.filter((r) => r >= windowStart && r < round).length;
      const jobsPerRound = (this.config.params.jobsPerRound as number) ?? 5;
      const observedShare = recentRoutes / Math.max(1, this.adaptiveInterval * jobsPerRound);

      if (observedShare < this.adaptiveTargetRoutingShare) {
        this.adaptiveFakeCoJobs = Math.min(maliciousCount, this.adaptiveFakeCoJobs + 1);
      } else {
        this.adaptiveFakeCoJobs = Math.max(1, this.adaptiveFakeCoJobs - 1);
      }
    }

    return this.adaptiveFakeCoJobs;
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
