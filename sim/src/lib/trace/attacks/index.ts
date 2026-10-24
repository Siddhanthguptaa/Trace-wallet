/**
 * Attack Registry — Factory for all attack types.
 */

export { Attack, type AttackConfig, type AttackAgent, type AttackDecision, type AttackDecisionContext, type AttackPostRoundResult } from "./base";
export { StrategicDefaultAttack } from "./strategicDefault";
export { WhitewashingAttack } from "./whitewashing";
export { SybilClusterAttack } from "./sybilCluster";
export { CollusionRingAttack } from "./collusionRing";
export { CombinedCollusionWhitewashAttack } from "./combinedCollusionWhitewash";
export { AdaptiveCollusionAdversary } from "./adaptiveAdversary";
export { AdaptiveSybilSwarmAttack } from "./adaptiveSybilSwarm";
export { AdaptiveCollusionMarketAttack } from "./adaptiveCollusionMarket";
export { EconomicWhitewashingAttack } from "./economicWhitewashing";
export { GameTheoreticAdversaryAttack } from "./gameTheoreticAdversary";
export { GameTheoreticBehavioralAttack } from "./gameTheoreticBehavioral";

import type { AttackConfig } from "./base";
import { StrategicDefaultAttack } from "./strategicDefault";
import { WhitewashingAttack } from "./whitewashing";
import { SybilClusterAttack } from "./sybilCluster";
import { CollusionRingAttack } from "./collusionRing";
import { CombinedCollusionWhitewashAttack } from "./combinedCollusionWhitewash";
import { AdaptiveSybilSwarmAttack } from "./adaptiveSybilSwarm";
import { AdaptiveCollusionMarketAttack } from "./adaptiveCollusionMarket";
import { EconomicWhitewashingAttack } from "./economicWhitewashing";
import { GameTheoreticAdversaryAttack } from "./gameTheoreticAdversary";
import { GameTheoreticBehavioralAttack } from "./gameTheoreticBehavioral";

export type AttackType =
  | "strategic-default"
  | "whitewashing"
  | "sybil-cluster"
  | "collusion-ring"
  | "combined-collusion-whitewash"
  | "adaptive-sybil-swarm"
  | "economic-whitewashing"
  | "adaptive-collusion-market"
  | "game-theoretic-adversary"
  | "game-theoretic-behavioral"
  | "none";

export function createAttack(type: AttackType, config: AttackConfig) {
  switch (type) {
    case "strategic-default":
      return new StrategicDefaultAttack(config);
    case "whitewashing":
      return new WhitewashingAttack(config);
    case "sybil-cluster":
      return new SybilClusterAttack(config);
    case "collusion-ring":
      return new CollusionRingAttack(config);
    case "combined-collusion-whitewash":
      return new CombinedCollusionWhitewashAttack(config);
    case "adaptive-sybil-swarm":
      return new AdaptiveSybilSwarmAttack(config);
    case "economic-whitewashing":
      return new EconomicWhitewashingAttack(config);
    case "adaptive-collusion-market":
      return new AdaptiveCollusionMarketAttack(config);
    case "game-theoretic-adversary":
      return new GameTheoreticAdversaryAttack(config);
    case "game-theoretic-behavioral":
      return new GameTheoreticBehavioralAttack(config);
    case "none":
      return null;
    default:
      throw new Error(`Unknown attack type: ${type}`);
  }
}
