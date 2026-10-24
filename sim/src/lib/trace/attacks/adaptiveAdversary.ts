/**
 * Adaptive collusion adversary — adjusts endorsement intensity from observed routing share.
 * (Final_implementation.md — partial adaptive adversary.)
 */

export class AdaptiveCollusionAdversary {
  private routingHistory = new Map<string, number[]>();
  private currentEndorsementRate = 0.5;
  private readonly targetRoutingShare: number;
  private readonly adaptationInterval: number;
  private readonly jobsPerRound: number;

  constructor(opts?: {
    targetRoutingShare?: number;
    adaptationInterval?: number;
    jobsPerRound?: number;
  }) {
    this.targetRoutingShare = opts?.targetRoutingShare ?? 0.25;
    this.adaptationInterval = opts?.adaptationInterval ?? 10;
    this.jobsPerRound = Math.max(1, opts?.jobsPerRound ?? 5);
  }

  observeRouting(selectedAgentId: string, round: number, maliciousIds: Set<string>): void {
    if (!maliciousIds.has(selectedAgentId)) return;
    const hist = this.routingHistory.get(selectedAgentId) ?? [];
    hist.push(round);
    this.routingHistory.set(selectedAgentId, hist);
  }

  /** Returns endorsement intensity [0, 1] for graph manipulation this round. */
  getEndorsementIntensity(round: number, maliciousIds: Set<string>): number {
    if (round % this.adaptationInterval !== 0 || round === 0) {
      return this.currentEndorsementRate;
    }

    const windowStart = round - this.adaptationInterval;
    let maliciousSelections = 0;
    for (const [id, rounds] of this.routingHistory) {
      if (!maliciousIds.has(id)) continue;
      maliciousSelections += rounds.filter((r) => r >= windowStart).length;
    }

    const denom = this.adaptationInterval * this.jobsPerRound;
    const actualShare = denom > 0 ? maliciousSelections / denom : 0;

    if (actualShare < this.targetRoutingShare - 0.05) {
      this.currentEndorsementRate = Math.min(1.0, this.currentEndorsementRate + 0.15);
    } else if (actualShare > this.targetRoutingShare + 0.05) {
      this.currentEndorsementRate = Math.max(0.1, this.currentEndorsementRate - 0.1);
    }

    return this.currentEndorsementRate;
  }
}
