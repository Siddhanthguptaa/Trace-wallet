/**
 * TRACE / SatsCredit — Public API
 *
 * Re-exports all TRACE modules for clean imports:
 *   import { updateScoreAfterEvent, selectProviderTRACE } from "@/lib/trace";
 */

// Configuration
export {
  TRACE_WEIGHTS,
  TRACE_BASE_SCORE,
  TRACE_MAX_SCORE,
  TRACE_MIN_SCORE,
  RISK_TIERS,
  ROUTING_UTILITY,
  TRACE_ROUTING_PRESETS,
  ROUTING_CONSTRAINTS,
  EXPLORATION_CONFIG,
  EIGENTRUST_CONFIG,
  TRUSTFLOW_CONFIG,
  TRACE_HARDENING,
  SPECTRAL_GAP_CONFIG,
  CUSUM_SENSITIVE_SUPPRESSION,
  GHOST_MODULE_FLAGS,
  applyGhostModuleFlags,
  COLD_START,
  SCORE_DELTAS,
  TRUST_DECAY,
  COUNTERPARTY_DIVERSITY,
  REPEATED_PAIR,
  ECONOMIC_VOLUME_WEIGHTING,
  snapshotConfig,
  applyTraceRoutingPreset,
  type RiskTier,
  type RoutingPolicy,
  type TraceRoutingPreset,
} from "./config";

// Score Engine
export {
  computeTraceScore,
  computeDefaultProbability,
  computeRiskTier,
  updateScoreAfterEvent,
  computeBayesianLCB,
  updateCUSUMScore,
  updateCUSUMSensitive,
  CUSUM_H,
  CUSUM_H_SENSITIVE,
  CUSUM_K,
  CUSUM_K_SENSITIVE,
  type TraceScoreInput,
  type TraceScoreResult,
  type EconomicEventType,
} from "./traceScore";

// Trust Graph
export {
  updateTrustEdge,
  computeNetworkTrust,
  computeAllNetworkTrust,
  computeAllNetworkTrustWithMeta,
  persistAllNetworkTrust,
  computeCounterpartyEntropy,
  computePersonalizedPageRank,
  computeWeightedEntropy,
  buildEdgeCache,
  buildLocalTrustMatrix,
  computeTrustFlowScores,
  providerProfileEmbedding,
  computeSpectralGap,
  detectSybilClusters,
  updateSybilRiskScores,
  applyTemporalDecay,
  type EdgeCache,
  type SybilCluster,
  type NetworkTrustResult,
} from "./trustGraph";

// Router
export {
  selectProviderTRACE,
  computeEigenTrustScores,
  computeEigenTrustUtility,
  computeTrustFlowUtility,
  recordProviderDefault,
  getLastDefaultRound,
  getEffectiveCooldownRounds,
  resetCooldownTracker,
  resetTrustInertiaTracker,
  enableAdaptiveInertiaAlpha,
  recordRoundFailureRate,
  getRoundSuspicion,
  resetRoundAnomalyTracker,
  resetRoutingWindowTracker,
  type CandidateScore,
  type RoutingResult,
  type RoutingExplorationOptions,
} from "./traceRouter";

// v2.2: Adaptive Configuration
export {
  ADAPTIVE_SCALING,
  computeScaleFactor,
  effectiveCliquePenalty,
  effectiveSybilPenalty,
  computeEntropyConfidence,
  confidenceWeightedEntropyPenalty,
  computeMaturityFactor,
  effectiveDecayConstant,
} from "./adaptiveConfig";

// v2.2: Causal Graph Engine
export {
  causalGraph,
  CausalGraphEngine,
  CAUSAL_CONFIG,
  type FailureEvent,
  type FailureCascade,
  type CausalProfile,
} from "./causalGraph";

// v2.3: Temporal-Causal Trust Evolution
export {
  temporalEngine,
  TemporalTrustEngine,
  TEMPORAL_CONFIG,
  EMPTY_TEMPORAL_PROFILE,
  type TrustSnapshot,
  type TemporalProfile,
} from "./temporalTrust";

// Real LLM provider agents (paper / systems evaluation)
export {
  HonestLLMProvider,
  MaliciousLLMProvider,
  buildMixedFleet,
  defaultOpenAiFleet,
  defaultSarvamFleet,
  defaultLocalLlamaFleet,
  defaultGroqFleet,
  defaultTogetherFleet,
  type TaskRequest,
  type AgentBackendConfig,
} from "./providers";
