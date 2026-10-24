/**
 * TRACE v2.3 — Temporal-Causal Trust Evolution Engine
 *
 * Core insight: "Colluders are not merely structurally suspicious —
 * they evolve suspiciously over time."
 *
 * Instead of asking "Who looks suspicious right now?",
 * TRACE v2.3 asks "How did this trust pattern evolve?"
 *
 * Three integrated subsystems:
 *   1. Trust Velocity & Acceleration — detect unnaturally rapid trust growth
 *   2. Entropy Trajectory — distinguish organic vs artificial diversification
 *   3. Reciprocal Amplification — detect mutual trust inflation loops
 *
 * Design principles:
 *   - Percentile-based thresholds (not hardcoded constants)
 *   - Fully explainable — every score has a decomposition
 *   - Lightweight — no ML, no training, pure temporal statistics
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Single snapshot of an agent's trust state */
export interface TrustSnapshot {
  round: number;
  traceScore: number;
  entropy: number;
  routingShare: number;      // fraction of jobs routed to this agent this round
  interactionCount: number;  // cumulative interactions
  diversityScore: number;    // from counterparty entropy
}

/** Per-agent temporal trust profile */
export interface TemporalProfile {
  /** Trust velocity: rate of score change per round */
  trustVelocity: number;
  /** Trust acceleration: rate of velocity change */
  trustAcceleration: number;
  /** Trust velocity risk: how abnormally fast this agent gained trust [0,1] */
  trustVelocityRisk: number;
  /** Entropy slope: rate of entropy change over time */
  entropySlope: number;
  /** Whether a suspicous entropy burst was detected */
  entropyBurstDetected: boolean;
  /** Diversity maturity: how naturally did diversity emerge? [0,1] */
  diversityMaturity: number;
  /** Reciprocal amplification risk: mutual trust inflation [0,1] */
  reciprocalAmplificationRisk: number;
  /** Economic depth: log-scaled cumulative trust investment [0,1] */
  economicDepth: number;
  /** Composite temporal-causal risk [0,1] */
  temporalRisk: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export const TEMPORAL_CONFIG = {
  // ── Trust Velocity ──────────────────────────────────────────────
  /** Minimum rounds of history before velocity analysis activates */
  minHistoryRounds: 8,
  /** Percentile above which velocity is flagged (ecosystem-relative) */
  velocityFlagPercentile: 0.85,
  /** Weight of velocity risk in composite score */
  velocityWeight: 0.25,

  // ── Entropy Trajectory ──────────────────────────────────────────
  /** Window (rounds) for entropy slope computation */
  entropySlopeWindow: 10,
  /** Threshold: entropy increase per round that triggers burst flag */
  entropyBurstThreshold: 0.15,
  /** Rounds of low entropy before a burst is suspicious */
  lowEntropyPhaseMinRounds: 5,
  /** Low entropy threshold */
  lowEntropyThreshold: 0.5,
  /** Weight of diversity maturity in composite */
  diversityMaturityWeight: 0.20,

  // ── Reciprocal Amplification ────────────────────────────────────
  /** Minimum interactions in a pair to analyze reciprocity */
  minPairInteractions: 3,
  /** Symmetry threshold: above this, pair is flagged as suspicious */
  symmetryFlagThreshold: 0.85,
  /** Weight of reciprocal risk in composite */
  reciprocalWeight: 0.25,

  // ── Economic Trust Maturation ───────────────────────────────────
  /** Minimum cumulative sats for full economic depth */
  fullDepthSats: 500,
  /** Weight of economic depth deficit in composite */
  economicDepthWeight: 0.15,
  /** Reputation inertia: high-trust agents change this much slower */
  inertiaMultiplier: 0.5,

  // ── Composite ───────────────────────────────────────────────────
  /** Weight of acceleration in composite */
  accelerationWeight: 0.15,

  /** Enable/disable temporal analysis (for ablation)
   *  LOCKED TO FALSE — v2.1 validated as paper system (2026-05-09)
   *  See results/VALIDATION_RESULTS.md for evidence */
  enabled: true,
} as const;

// ─── Temporal Trust Engine ────────────────────────────────────────────────────

/**
 * In-memory temporal trust evolution engine.
 *
 * Records per-agent trust snapshots over time and computes
 * behavioral trajectory metrics for routing decisions.
 */
export class TemporalTrustEngine {
  /** Per-agent trust history: agentId → snapshots ordered by round */
  private history: Map<string, TrustSnapshot[]> = new Map();

  /** Per-pair reciprocal interaction counts: "A|B" → {aToB, bToA} */
  private reciprocalCounts: Map<string, { aToB: number; bToA: number }> = new Map();

  /** Per-agent cumulative economic volume (sats) */
  private economicVolume: Map<string, number> = new Map();

  /** Cached ecosystem velocity distribution for percentile thresholds */
  private velocityCache: number[] | null = null;
  private velocityCacheDirty = true;

  // ─── Recording ────────────────────────────────────────────────────

  /**
   * Record a trust snapshot for an agent at a given round.
   */
  recordSnapshot(agentId: string, snapshot: TrustSnapshot): void {
    if (!this.history.has(agentId)) {
      this.history.set(agentId, []);
    }
    this.history.get(agentId)!.push(snapshot);
    this.velocityCacheDirty = true;
  }

  /**
   * Record a directed trust-building interaction (A successfully served B).
   */
  recordTrustInteraction(fromAgent: string, toAgent: string, amountSats: number): void {
    const key = pairKey(fromAgent, toAgent);
    const reverseKey = pairKey(toAgent, fromAgent);

    // Track A→B direction
    if (!this.reciprocalCounts.has(key)) {
      this.reciprocalCounts.set(key, { aToB: 0, bToA: 0 });
    }
    this.reciprocalCounts.get(key)!.aToB++;

    // Also track in B→A record (the reverse direction)
    if (!this.reciprocalCounts.has(reverseKey)) {
      this.reciprocalCounts.set(reverseKey, { aToB: 0, bToA: 0 });
    }
    this.reciprocalCounts.get(reverseKey)!.bToA++;

    // Track economic volume
    this.economicVolume.set(
      fromAgent,
      (this.economicVolume.get(fromAgent) ?? 0) + amountSats
    );
  }

  // ─── Trust Velocity & Acceleration ────────────────────────────────

  /**
   * Compute trust velocity: rate of TRACE score change per round.
   *
   *   v_t = (S_t - S_{t-k}) / k
   *
   * Uses the last `k` rounds for smoothing.
   */
  private computeVelocity(snapshots: TrustSnapshot[], windowSize = 5): number {
    if (snapshots.length < 2) return 0;

    const n = snapshots.length;
    const k = Math.min(windowSize, n - 1);
    const current = snapshots[n - 1].traceScore;
    const past = snapshots[n - 1 - k].traceScore;

    return (current - past) / k;
  }

  /**
   * Compute trust acceleration: rate of velocity change.
   *
   *   a_t = (v_t - v_{t-1}) / Δt
   */
  private computeAcceleration(snapshots: TrustSnapshot[], windowSize = 5): number {
    if (snapshots.length < 3) return 0;

    const n = snapshots.length;
    const midpoint = Math.floor(n / 2);

    const recentSlice = snapshots.slice(midpoint);
    const earlySlice = snapshots.slice(0, midpoint + 1);

    const recentVelocity = this.computeVelocity(recentSlice, windowSize);
    const earlyVelocity = this.computeVelocity(earlySlice, windowSize);

    const dt = recentSlice.length;
    return dt > 0 ? (recentVelocity - earlyVelocity) / dt : 0;
  }

  /**
   * Compute velocity risk using ecosystem-relative percentile thresholds.
   *
   * NOT hardcoded — adapts to the actual population distribution.
   */
  private computeVelocityRisk(agentId: string): number {
    const snapshots = this.history.get(agentId);
    if (!snapshots || snapshots.length < TEMPORAL_CONFIG.minHistoryRounds) return 0;

    const velocity = this.computeVelocity(snapshots);
    if (velocity <= 0) return 0; // Only flag rapid growth, not decline

    // Build ecosystem velocity distribution if stale
    if (this.velocityCacheDirty) {
      this.velocityCache = [];
      for (const [, hist] of this.history) {
        if (hist.length >= TEMPORAL_CONFIG.minHistoryRounds) {
          this.velocityCache.push(this.computeVelocity(hist));
        }
      }
      this.velocityCache.sort((a, b) => a - b);
      this.velocityCacheDirty = false;
    }

    if (!this.velocityCache || this.velocityCache.length < 3) return 0;

    // Percentile rank of this agent's velocity
    const rank = this.velocityCache.filter((v) => v <= velocity).length;
    const percentile = rank / this.velocityCache.length;

    // Risk scales from 0 at percentile threshold to 1.0 at max
    if (percentile < TEMPORAL_CONFIG.velocityFlagPercentile) return 0;

    const excess = (percentile - TEMPORAL_CONFIG.velocityFlagPercentile) /
      (1 - TEMPORAL_CONFIG.velocityFlagPercentile);
    return Math.min(excess, 1.0);
  }

  // ─── Entropy Trajectory ───────────────────────────────────────────

  /**
   * Compute entropy slope: rate of entropy change over recent window.
   *
   *   m_e = dEntropy / dt  (linear regression slope)
   */
  private computeEntropySlope(snapshots: TrustSnapshot[]): number {
    const window = TEMPORAL_CONFIG.entropySlopeWindow;
    const recent = snapshots.slice(-window);
    if (recent.length < 3) return 0;

    // Simple linear regression on entropy over rounds
    const n = recent.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += recent[i].entropy;
      sumXY += i * recent[i].entropy;
      sumX2 += i * i;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;

    return (n * sumXY - sumX * sumY) / denom;
  }

  /**
   * Detect suspicious entropy burst: long low-entropy phase followed by
   * sudden diversification. This is collusion camouflage behavior.
   */
  private detectEntropyBurst(snapshots: TrustSnapshot[]): boolean {
    if (snapshots.length < TEMPORAL_CONFIG.lowEntropyPhaseMinRounds + 3) return false;

    const cfg = TEMPORAL_CONFIG;

    // Find how many early rounds had low entropy
    let lowEntropyRounds = 0;
    for (const s of snapshots) {
      if (s.entropy < cfg.lowEntropyThreshold) {
        lowEntropyRounds++;
      } else {
        break; // First non-low round ends the phase
      }
    }

    if (lowEntropyRounds < cfg.lowEntropyPhaseMinRounds) return false;

    // Check for rapid entropy increase after the low phase
    const postLowSnapshots = snapshots.slice(lowEntropyRounds);
    if (postLowSnapshots.length < 2) return false;

    const slope = this.computeEntropySlope(postLowSnapshots);
    return slope > cfg.entropyBurstThreshold;
  }

  /**
   * Compute diversity maturity: how naturally did diversity emerge?
   *
   * High maturity = gradual, organic diversification
   * Low maturity = sudden burst or artificial pattern
   *
   * Returns [0, 1] where 1 = fully mature, 0 = suspicious
   */
  private computeDiversityMaturity(snapshots: TrustSnapshot[]): number {
    if (snapshots.length < 4) return 0.5; // Neutral for insufficient data

    // Compute entropy trajectory smoothness
    const entropies = snapshots.map((s) => s.entropy);
    const diffs: number[] = [];
    for (let i = 1; i < entropies.length; i++) {
      diffs.push(entropies[i] - entropies[i - 1]);
    }

    if (diffs.length === 0) return 0.5;

    // Smoothness = inverse of diff variance (normalized)
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length;

    // Low variance = smooth growth = organic = high maturity
    // High variance = burst pattern = suspicious = low maturity
    const smoothness = 1 / (1 + variance * 10);

    // Also penalize burst detection
    const burstPenalty = this.detectEntropyBurst(snapshots) ? 0.3 : 0;

    return Math.max(0, Math.min(1, smoothness - burstPenalty));
  }

  // ─── Reciprocal Amplification ─────────────────────────────────────

  /**
   * Compute reciprocal amplification risk for an agent.
   *
   * Detects mutual trust inflation loops where A↔B repeatedly
   * amplify each other's trust unnaturally.
   */
  private computeReciprocalRisk(agentId: string): number {
    const cfg = TEMPORAL_CONFIG;
    let maxSymmetry = 0;
    let suspiciousPairCount = 0;
    let totalPairs = 0;

    for (const [key, counts] of this.reciprocalCounts) {
      // Only look at pairs involving this agent
      const [a] = key.split("|");
      if (a !== agentId) continue;

      totalPairs++;
      const totalInteractions = counts.aToB + counts.bToA;
      if (totalInteractions < cfg.minPairInteractions) continue;

      // Symmetry: how balanced is the mutual reinforcement?
      // 1.0 = perfectly balanced (suspicious)
      // 0.0 = completely one-sided (normal)
      const symmetry = 1 - Math.abs(counts.aToB - counts.bToA) / totalInteractions;

      if (symmetry > maxSymmetry) maxSymmetry = symmetry;
      if (symmetry > cfg.symmetryFlagThreshold) suspiciousPairCount++;
    }

    if (totalPairs === 0) return 0;

    // Risk = fraction of pairs that are suspiciously symmetric × max symmetry
    const pairFraction = suspiciousPairCount / totalPairs;
    return Math.min(1.0, pairFraction * maxSymmetry);
  }

  // ─── Economic Depth ───────────────────────────────────────────────

  /**
   * Compute economic depth: log-scaled measure of cumulative
   * trust investment. Makes trust expensive to manufacture.
   *
   *   depth = log(1 + volume / fullDepthSats) / log(2)
   *
   * Capped at 1.0 (full depth).
   */
  private computeEconomicDepth(agentId: string): number {
    const volume = this.economicVolume.get(agentId) ?? 0;
    const raw = Math.log(1 + volume / TEMPORAL_CONFIG.fullDepthSats) / Math.log(2);
    return Math.min(raw, 1.0);
  }

  // ─── Composite Profile ────────────────────────────────────────────

  /**
   * Compute the full temporal-causal profile for an agent.
   *
   * This is the main entry point for routing integration.
   * Returns a fully decomposed, explainable profile.
   */
  computeProfile(agentId: string): TemporalProfile {
    if (!TEMPORAL_CONFIG.enabled) {
      return neutralProfile();
    }

    const snapshots = this.history.get(agentId) ?? [];

    const trustVelocity = snapshots.length >= 2
      ? this.computeVelocity(snapshots) : 0;
    const trustAcceleration = snapshots.length >= 3
      ? this.computeAcceleration(snapshots) : 0;
    const trustVelocityRisk = this.computeVelocityRisk(agentId);
    const entropySlope = this.computeEntropySlope(snapshots);
    const entropyBurstDetected = this.detectEntropyBurst(snapshots);
    const diversityMaturity = this.computeDiversityMaturity(snapshots);
    const reciprocalAmplificationRisk = this.computeReciprocalRisk(agentId);
    const economicDepth = this.computeEconomicDepth(agentId);

    // Composite temporal risk: weighted sum of individual risks
    const cfg = TEMPORAL_CONFIG;
    const accelerationRisk = Math.min(1, Math.max(0, trustAcceleration * 0.1));
    const diversityDeficit = 1 - diversityMaturity;
    const depthDeficit = 1 - economicDepth;

    const temporalRisk = Math.min(1.0,
      cfg.velocityWeight * trustVelocityRisk +
      cfg.accelerationWeight * accelerationRisk +
      cfg.diversityMaturityWeight * diversityDeficit +
      cfg.reciprocalWeight * reciprocalAmplificationRisk +
      cfg.economicDepthWeight * depthDeficit
    );

    return {
      trustVelocity: round4(trustVelocity),
      trustAcceleration: round4(trustAcceleration),
      trustVelocityRisk: round4(trustVelocityRisk),
      entropySlope: round4(entropySlope),
      entropyBurstDetected,
      diversityMaturity: round4(diversityMaturity),
      reciprocalAmplificationRisk: round4(reciprocalAmplificationRisk),
      economicDepth: round4(economicDepth),
      temporalRisk: round4(temporalRisk),
    };
  }

  /**
   * Get the temporal risk penalty for routing utility.
   *
   * Scaled to [0, 0.15] — a meaningful but not overwhelming penalty.
   */
  getTemporalPenalty(agentId: string): number {
    if (!TEMPORAL_CONFIG.enabled) return 0;
    return this.computeProfile(agentId).temporalRisk * 0.15;
  }

  /**
   * Get reputation inertia multiplier for trust updates.
   *
   * High economic depth → slower trust changes (harder to manipulate).
   * Low economic depth → normal trust changes.
   */
  getReputationInertia(agentId: string): number {
    if (!TEMPORAL_CONFIG.enabled) return 1.0;
    const depth = this.computeEconomicDepth(agentId);
    // Mature agents: trust changes are dampened by inertia
    // Inertia of 0.5 at full depth, 1.0 at zero depth
    return 1.0 - (depth * (1 - TEMPORAL_CONFIG.inertiaMultiplier));
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /** Reset all temporal data (for new experiments) */
  reset(): void {
    this.history.clear();
    this.reciprocalCounts.clear();
    this.economicVolume.clear();
    this.velocityCache = null;
    this.velocityCacheDirty = true;
  }

  /** Get summary statistics */
  getSummary(): {
    trackedAgents: number;
    avgHistoryLength: number;
    reciprocalPairs: number;
  } {
    let totalHistory = 0;
    for (const [, hist] of this.history) totalHistory += hist.length;
    return {
      trackedAgents: this.history.size,
      avgHistoryLength: this.history.size > 0 ? totalHistory / this.history.size : 0,
      reciprocalPairs: this.reciprocalCounts.size,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const temporalEngine = new TemporalTrustEngine();

// ─── R-GHOST identity profile (design §3.4, Task 5.1) ────────────────────────
/**
 * Zero-contribution `TemporalProfile` consumed by `computeTraceUtility` (and
 * any runner snapshot path) when `GHOST_MODULE_FLAGS.TEMPORAL_ENABLED === false`
 * (design §3.4, R-GHOST 4). Substituting this constant for the live
 * `temporalEngine.computeProfile(agentId)` call lets the gating layer bypass
 * the engine without altering the shape of the surrounding code.
 *
 * Identity values, verified field-by-field against the empty-history return
 * path inside `TemporalTrustEngine.computeProfile` (which returns
 * `neutralProfile()` when the disable-flag is set):
 *
 *   - All risk fields (`trustVelocityRisk`, `reciprocalAmplificationRisk`,
 *     `temporalRisk`) and all derivative fields (`trustVelocity`,
 *     `trustAcceleration`, `entropySlope`) are `0`. They flow into
 *     additively-weighted utility terms, so `0` contributes nothing.
 *   - `diversityMaturity` is `1.0` because it is a `[0, 1]` multiplier whose
 *     **deficit** `(1 - diversityMaturity)` enters `temporalRisk`. `1.0`
 *     means full maturity, i.e. zero deficit, i.e. zero contribution.
 *   - `economicDepth` is `0` because the deficit `(1 - economicDepth)` would
 *     otherwise be amplified into the temporal-risk sum; with the flag off
 *     we want `temporalRisk = 0`, which is achieved by zero deficit weight
 *     overall (the consuming branch in Task 5.2 does not multiply the
 *     deficit when the flag is off).
 *   - `entropyBurstDetected` is `false` (no burst detected on the empty
 *     trajectory).
 *
 * The on-disk parity test (Property P5, design §3.5) generates 100 provider
 * populations at n=100 and asserts that, with the flag off, every field of
 * `CandidateScore.breakdown` and the resulting `utility` agree to within
 * `1e-9` against a reference computation that physically inlines this
 * identity profile.
 *
 * Task 5.2 wires this constant into the call sites in `computeTraceUtility`
 * and the runner snapshots; Task 5.1 introduces only the constant itself.
 */
export const EMPTY_TEMPORAL_PROFILE: TemporalProfile = {
  trustVelocity: 0,
  trustAcceleration: 0,
  trustVelocityRisk: 0,
  entropySlope: 0,
  entropyBurstDetected: false,
  diversityMaturity: 1.0,
  reciprocalAmplificationRisk: 0,
  economicDepth: 0,
  temporalRisk: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function neutralProfile(): TemporalProfile {
  return {
    trustVelocity: 0,
    trustAcceleration: 0,
    trustVelocityRisk: 0,
    entropySlope: 0,
    entropyBurstDetected: false,
    diversityMaturity: 1.0,
    reciprocalAmplificationRisk: 0,
    economicDepth: 0,
    temporalRisk: 0,
  };
}

function pairKey(a: string, b: string): string {
  return `${a}|${b}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
