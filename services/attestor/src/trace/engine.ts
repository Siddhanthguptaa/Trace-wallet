/**
 * Scores every payee from the accepted outcomes, using the TRACE port (./port.ts).
 *
 * EVM adapter (DECISIONS.md, ATT): one accepted outcome = one TRACE job of the payee and one
 * trust-edge update wallet -> payee; volume unit = 0.01 token (USDC cents); round = floor(ts /
 * roundSeconds). Graph signals (Sybil risk, network trust, PPR, contamination) are computed once
 * over all edges, then each payee's jobs are replayed through the fork's per-job event sequence.
 */
import type { Address } from 'viem';
import type { DecisionCode, Tier } from '../../../../packages/shared/src/attestor/tier.ts';
import { decide } from '../decision.ts';
import {
  type Edge,
  type PortJob,
  type ProviderView,
  type UtilityBreakdown,
  buildEdgeCache,
  computeAllNetworkTrust,
  computeBayesianLCB,
  computeNeighborhoodContamination,
  computeRiskTier,
  computePersonalizedPageRank,
  computeSybilRisk,
  computeTraceUtility,
  hardFilterReason,
  pprSeeds,
  replayScore,
  updateTrustEdge,
} from './port.ts';

export interface OutcomeRecord {
  id: string;
  source: 'x402' | 'owner' | 'verifier';
  wallet: Address;
  payee: Address;
  success: boolean;
  amount: bigint;
  decimals: number;
  /** unix seconds */
  ts: number;
}

export interface PayeeProfile {
  payee: Address;
  totalJobs: number;
  successes: number;
  failures: number;
  lcb95: number;
  traceScore: number;
  riskTier: string;
  defaultProbability: number;
  scoreVolatility: number;
  cusumScore: number;
  cusumSensitive: number;
  sybilRisk: number;
  networkTrust: number;
  hardFilter: string | null;
  utility: UtilityBreakdown | null;
  code: DecisionCode | null;
  tier: Tier;
  reason: string;
}

export interface EngineOptions {
  roundSeconds?: number;
  /** unix ms used for network-trust edge decay; defaults to the newest outcome. */
  nowMs?: number;
}

const lower = (a: string) => a.toLowerCase() as Address;

/** 1 volume unit = 0.01 token; at least 1 so dust still counts as a job. */
export function volumeUnits(amount: bigint, decimals: number): number {
  const shift = decimals - 2;
  const units = shift >= 0 ? Number(amount / 10n ** BigInt(shift)) : Number(amount) * 10 ** -shift;
  return Math.max(1, Math.round(units));
}

export function coldProfile(payee: Address): PayeeProfile {
  return {
    payee: lower(payee),
    totalJobs: 0,
    successes: 0,
    failures: 0,
    lcb95: computeBayesianLCB(0, 0),
    traceScore: 500,
    riskTier: 'C',
    defaultProbability: 0.2,
    scoreVolatility: 0,
    cusumScore: 0,
    cusumSensitive: 0,
    sybilRisk: 0,
    networkTrust: 0,
    hardFilter: null,
    utility: null,
    code: null,
    tier: 'UNPROVEN',
    reason: 'cold_start',
  };
}

export function scoreAll(outcomes: OutcomeRecord[], opts: EngineOptions = {}): Map<Address, PayeeProfile> {
  const roundSeconds = opts.roundSeconds ?? 3600;
  const sorted = [...outcomes].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nodesSet = new Set<string>();
  const edgeMap = new Map<string, Edge>();
  const jobsBy = new Map<string, PortJob[]>();
  const failureRounds = new Map<string, Set<number>>();
  const priceSum = new Map<string, number>();
  let newestMs = 0;

  for (const o of sorted) {
    const w = lower(o.wallet);
    const p = lower(o.payee);
    nodesSet.add(w);
    nodesSet.add(p);
    const units = volumeUnits(o.amount, o.decimals);
    const round = Math.floor(o.ts / roundSeconds);
    const at = o.ts * 1000;
    newestMs = Math.max(newestMs, at);
    const key = `${w}→${p}`;
    const next = updateTrustEdge(edgeMap.get(key), w, p, units, o.success, at);
    if (next) edgeMap.set(key, next);
    if (!jobsBy.has(p)) jobsBy.set(p, []);
    jobsBy.get(p)!.push({ success: o.success, price: units, round, defaulted: false });
    priceSum.set(p, (priceSum.get(p) ?? 0) + units);
    if (!o.success) {
      if (!failureRounds.has(p)) failureRounds.set(p, new Set());
      failureRounds.get(p)!.add(round);
    }
  }

  const nodes = [...nodesSet];
  const edges = [...edgeMap.values()];
  const sybil = computeSybilRisk(nodes, edges, failureRounds);
  const trust = computeAllNetworkTrust(nodes, edges, opts.nowMs ?? newestMs);

  const views = new Map<string, ProviderView>();
  for (const id of nodes) {
    const jobs = jobsBy.get(id) ?? [];
    const graph = { networkTrust: trust.get(id) ?? 0, sybilRisk: sybil.get(id) ?? 0 };
    const s = replayScore(jobs, graph);
    views.set(id, {
      id,
      totalJobs: s.metrics.totalJobs,
      successfulJobs: s.metrics.successfulJobs,
      failedJobs: s.metrics.failedJobs,
      disputedJobs: s.metrics.disputedJobs,
      traceScore: s.traceScore,
      defaultProbability: jobs.length ? s.defaultProbability : 0.2,
      sybilRisk: graph.sybilRisk,
      networkTrust: graph.networkTrust,
      scoreVolatility: s.scoreVolatility,
      cusumScore: s.cusumScore,
      cusumSensitive: s.cusumSensitive,
      stakeSats: 0,
      price: jobs.length ? (priceSum.get(id) ?? 0) / jobs.length : 0,
    });
  }

  const all = [...views.values()];
  const cache = buildEdgeCache(edges);
  const ppr = computePersonalizedPageRank(cache, pprSeeds(all));
  const contamination = computeNeighborhoodContamination(cache, sybil);
  const trustMap = new Map(all.map((v) => [v.id, (1 + Math.max(0, v.successfulJobs)) / (4 + Math.max(0, v.successfulJobs) + Math.max(0, v.failedJobs))]));
  const maxPrice = Math.max(...all.map((v) => v.price), 1);

  const out = new Map<Address, PayeeProfile>();
  for (const [id, jobs] of jobsBy) {
    const v = views.get(id)!;
    const d = decide(v);
    out.set(id as Address, {
      payee: id as Address,
      totalJobs: v.totalJobs,
      successes: v.successfulJobs,
      failures: v.failedJobs,
      lcb95: computeBayesianLCB(v.successfulJobs, v.failedJobs),
      traceScore: v.traceScore,
      riskTier: computeRiskTier(v.traceScore),
      defaultProbability: v.defaultProbability,
      scoreVolatility: v.scoreVolatility,
      cusumScore: v.cusumScore,
      cusumSensitive: v.cusumSensitive,
      sybilRisk: v.sybilRisk,
      networkTrust: v.networkTrust,
      hardFilter: jobs.length ? hardFilterReason(v) : null,
      utility: computeTraceUtility(v, maxPrice, nodes.length, cache, contamination, ppr, trustMap),
      code: d.code,
      tier: d.tier,
      reason: d.reason,
    });
  }
  return out;
}

