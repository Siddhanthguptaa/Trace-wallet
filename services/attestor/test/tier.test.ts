/** Tier cases: shared rule == sim's pre-registered rule; decision-code map; decide() is fail-closed. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVEN_LCB_THRESHOLD,
  TIER_ENUM,
  lcb95,
  sybilFlagged,
  tierFromDecisionCode,
  tierFromEvidence,
} from '../../../packages/shared/src/attestor/tier.ts';
import { decide } from '../src/decision.ts';
import type { ProviderView } from '../src/trace/port.ts';

const SIM_VECTORS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sim', 'hx', 'tier_vectors.json');

const view = (o: Partial<ProviderView>): ProviderView => ({
  id: 'p',
  totalJobs: 0,
  successfulJobs: 0,
  failedJobs: 0,
  disputedJobs: 0,
  traceScore: 755,
  defaultProbability: 0.2,
  sybilRisk: 0,
  networkTrust: 0,
  scoreVolatility: 0,
  cusumScore: 0,
  cusumSensitive: 0,
  stakeSats: 0,
  price: 20,
  ...o,
});

describe('tier rule', () => {
  it.runIf(existsSync(SIM_VECTORS))('matches sim/hx/tier_vectors.json (the pre-registered X4 rule)', () => {
    const v = JSON.parse(readFileSync(SIM_VECTORS, 'utf8')) as {
      threshold: number;
      vectors: Array<{ successes: number; failures: number; flagged: boolean; lcb95: number; tier: string }>;
    };
    expect(PROVEN_LCB_THRESHOLD).toBe(v.threshold);
    expect(v.vectors.length).toBeGreaterThan(5);
    for (const x of v.vectors) {
      expect(lcb95(x.successes, x.failures)).toBe(x.lcb95);
      expect(tierFromEvidence(x)).toBe(x.tier);
    }
  });

  it('cold start and 2 successes are UNPROVEN; 3 clean successes are PROVEN; 3+1 is not', () => {
    expect(tierFromEvidence({ successes: 0, failures: 0, flagged: false })).toBe('UNPROVEN');
    expect(tierFromEvidence({ successes: 2, failures: 0, flagged: false })).toBe('UNPROVEN');
    expect(tierFromEvidence({ successes: 3, failures: 0, flagged: false })).toBe('PROVEN');
    expect(tierFromEvidence({ successes: 3, failures: 1, flagged: false })).toBe('UNPROVEN');
    expect(tierFromEvidence({ successes: 100, failures: 0, flagged: true })).toBe('FLAGGED');
  });

  it('decision-code adapter (IDEA 7.5): only ROUTE is PROVEN; unknown codes are FLAGGED', () => {
    expect(tierFromDecisionCode('ROUTE')).toBe('PROVEN');
    expect(tierFromDecisionCode('ROUTE_WITH_CAUTION')).toBe('UNPROVEN');
    expect(tierFromDecisionCode(null)).toBe('UNPROVEN');
    expect(tierFromDecisionCode(undefined)).toBe('UNPROVEN');
    for (const c of ['HOLD', 'INVESTIGATE', 'REFER', 'QUARANTINE', 'SOMETHING_NEW', 'route']) expect(tierFromDecisionCode(c)).toBe('FLAGGED');
    expect(TIER_ENUM.PROVEN).toBe(1);
  });

  it('Sybil flag = the router hard filters (> 0.5, or > 0.15 with a failure)', () => {
    expect(sybilFlagged({ sybilRisk: 0.51, failedJobs: 0 })).toBe(true);
    expect(sybilFlagged({ sybilRisk: 0.5, failedJobs: 0 })).toBe(false);
    expect(sybilFlagged({ sybilRisk: 0.16, failedJobs: 1 })).toBe(true);
    expect(sybilFlagged({ sybilRisk: 0.16, failedJobs: 0 })).toBe(false);
  });
});

describe('decide()', () => {
  it('maps hard filters to codes', () => {
    expect(decide(view({}))).toMatchObject({ code: null, tier: 'UNPROVEN', reason: 'cold_start' });
    expect(decide(view({ totalJobs: 3, successfulJobs: 3 }))).toMatchObject({ code: 'ROUTE', tier: 'PROVEN' });
    expect(decide(view({ totalJobs: 2, successfulJobs: 2 }))).toMatchObject({ code: 'ROUTE_WITH_CAUTION', tier: 'UNPROVEN', reason: 'lcb_below_threshold' });
    expect(decide(view({ totalJobs: 5, successfulJobs: 5, sybilRisk: 0.9 }))).toMatchObject({ code: 'QUARANTINE', tier: 'FLAGGED', reason: 'sybil_risk_too_high' });
    expect(decide(view({ totalJobs: 5, successfulJobs: 4, failedJobs: 1, sybilRisk: 0.2 }))).toMatchObject({ code: 'QUARANTINE', reason: 'sybil_failure_interaction' });
    expect(decide(view({ totalJobs: 10, successfulJobs: 4, failedJobs: 6, cusumScore: 4.3 }))).toMatchObject({ code: 'HOLD', tier: 'FLAGGED' });
    expect(decide(view({ totalJobs: 6, successfulJobs: 4, failedJobs: 2 }))).toMatchObject({ code: 'INVESTIGATE', tier: 'FLAGGED' });
    expect(decide(view({ totalJobs: 4, successfulJobs: 4, traceScore: 250 }))).toMatchObject({ code: 'ROUTE_WITH_CAUTION', reason: 'trace_score_too_low' });
    expect(decide(view({ totalJobs: 4, successfulJobs: 4, defaultProbability: 0.6 }))).toMatchObject({ code: 'ROUTE_WITH_CAUTION', reason: 'default_prob_too_high' });
  });

  it('PROVEN implies the pre-registered X4 PROVEN rule (randomised)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let proven = 0;
    for (let i = 0; i < 5000; i++) {
      const s = Math.floor(rnd() * 40);
      const f = Math.floor(rnd() * 8);
      const v = view({
        totalJobs: s + f,
        successfulJobs: s,
        failedJobs: f,
        sybilRisk: rnd() < 0.3 ? rnd() : 0,
        cusumScore: rnd() * 6,
        traceScore: 200 + rnd() * 800,
        defaultProbability: rnd() * 0.7,
      });
      const d = decide(v);
      if (d.tier === 'PROVEN') {
        proven++;
        expect(tierFromEvidence({ successes: s, failures: f, flagged: sybilFlagged(v) })).toBe('PROVEN');
      }
      if (s + f === 0) expect(d.tier).toBe('UNPROVEN');
      if (sybilFlagged(v) && s + f > 0) expect(d.tier).toBe('FLAGGED');
    }
    expect(proven).toBeGreaterThan(100);
  });
});
