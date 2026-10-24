/**
 * Decision codes (IDEA.md 7.5) from the TRACE router's hard filters, then the shared tier map.
 * Misbehaviour signals flag; thin evidence never does (cold start and low LCB stay UNPROVEN).
 */
import {
  type DecisionCode,
  type Tier,
  PROVEN_LCB_THRESHOLD,
  lcb95,
  sybilFlagged,
  tierFromDecisionCode,
} from '../../../packages/shared/src/attestor/tier.ts';
import { CUSUM_H, ROUTING_CONSTRAINTS, hardFilterReason, type ProviderView } from './trace/port.ts';

export interface Decision {
  code: DecisionCode | null;
  tier: Tier;
  reason: string;
}

export function decide(p: ProviderView): Decision {
  const out = (code: DecisionCode | null, reason: string): Decision => ({ code, tier: tierFromDecisionCode(code), reason });
  if (p.totalJobs === 0) return out(null, 'cold_start');
  if (sybilFlagged(p)) return out('QUARANTINE', p.sybilRisk > ROUTING_CONSTRAINTS.maxSybilRisk ? 'sybil_risk_too_high' : 'sybil_failure_interaction');
  if (Number.isFinite(p.cusumScore) && p.cusumScore > CUSUM_H) return out('HOLD', 'cusum_alarm');
  if (p.totalJobs >= ROUTING_CONSTRAINTS.minJobsForFailureFilter && p.failedJobs / p.totalJobs > ROUTING_CONSTRAINTS.maxFailureRate) {
    return out('INVESTIGATE', 'failure_rate_too_high');
  }
  if (p.disputedJobs > ROUTING_CONSTRAINTS.maxActiveDisputes) return out('REFER', 'too_many_disputes');
  const filter = hardFilterReason(p);
  if (filter) return out('ROUTE_WITH_CAUTION', filter);
  if (lcb95(p.successfulJobs, p.failedJobs) >= PROVEN_LCB_THRESHOLD) return out('ROUTE', 'lcb_proven');
  return out('ROUTE_WITH_CAUTION', 'lcb_below_threshold');
}
