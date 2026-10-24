// Hypnexis X4 policy TRACE+EB(B), exactly as pre-registered in EXPERIMENTS.md X4:
//
//   Per job: if the exploration track can afford the job
//     (cumulative exploration spend + price <= B x cumulative total spend, this job included)
//   pick by Thompson sampling among unproven, non-flagged providers; otherwise pick
//   greedily (TRACE-no-bandit utility) among proven providers; if no provider is proven
//   yet, pick greedily among all non-flagged providers. Flagged providers are never picked.
//
// Implementation choices (fixed before any scored run, logged in DECISIONS.md):
//   - Candidates and utilities come from ONE TRACE scoring pass per job (selectProviderTRACE
//     with the no-bandit ablation), so TRACE's per-call side effects happen once per job,
//     as for every other policy. "Eligible" = TRACE's own eligibility (not hard-rejected,
//     utility >= 0).
//   - Exploration pick = TRACE-full's selection procedure (shared epsilon-wrapper + Thompson
//     on Beta(1+s, 3+f) x utility factor) restricted to eligible UNPROVEN providers.
//     "Price" = the pick's charged price (the runner's LCB-capped job value), and the
//     budget test uses exact integer arithmetic with B in percent.
//   - Greedy = TRACE-no-bandit's selection procedure (shared epsilon-wrapper + argmax)
//     restricted to eligible PROVEN providers, else to eligible non-flagged providers.
//   - If TRACE finds no eligible provider, fall back like TRACE (best utility, constraints
//     relaxed) but over non-flagged providers only; if all are flagged, the job is skipped.
//   - Budget counters live per buyer (one hook per buyer session).
import { prisma } from "../src/lib/db";
import { selectProviderTRACE, computeBayesianLCB } from "../src/lib/trace";
import { selectWinnerWithExploration } from "../src/lib/trace/traceRouter";
import type { SelectHook, SelectHookContext } from "./runnerHx";
import { simFlagged, simTier } from "./tierRule";

type Mode = "explore" | "greedyProven" | "greedyAll" | "fallback";

export interface EbStats {
  [k: string]: number;
}

/** The runner's charged job value (runner.ts, v4.4 risk-proportional capping). */
export function chargedPrice(
  p: { successfulJobs: number; failedJobs: number; priceSats: number },
  medianPrice: number | undefined,
): number {
  const median = medianPrice ?? p.priceSats;
  const providerLCB = computeBayesianLCB(p.successfulJobs, p.failedJobs * 2);
  const lcbRatio = Math.min(1.0, providerLCB / 0.5);
  const maxJobValue = Math.max(1, Math.round(median * lcbRatio));
  return Math.min(p.priceSats, maxJobValue);
}

export function makeEbHook(bPercent: number): SelectHook & { stats(): EbStats } {
  if (!Number.isInteger(bPercent) || bPercent < 0 || bPercent > 100) {
    throw new Error(`B must be an integer percent, got ${bPercent}`);
  }
  let cumTotal = 0;
  let cumExplore = 0;
  let pending: { id: string; mode: Mode; price: number } | null = null;
  const st = {
    jobs: 0,
    exploreJobs: 0,
    greedyProvenJobs: 0,
    greedyAllJobs: 0,
    fallbackJobs: 0,
    skippedJobs: 0,
    exploreAttempts: 0,
    exploreUnaffordable: 0,
    noUnprovenEligible: 0,
    exploreSpend: 0,
    totalSpend: 0,
    budgetViolations: 0,
    priceMismatches: 0,
    flaggedPicked: 0,
    unprovenPickedOutsideBudget: 0,
    flaggedSeen: 0,
  };

  const affordable = (price: number) => 100 * (cumExplore + price) <= bPercent * (cumTotal + price);

  return {
    async select(ctx: SelectHookContext) {
      const baseAblation = { ...(ctx.exploration.ablation ?? {}) } as Record<string, unknown>;
      const noBandit = { ...baseAblation, disableThompsonSampling: true };
      const thompson = { ...baseAblation };
      delete (thompson as any).disableThompsonSampling;

      const base = await selectProviderTRACE(ctx.capability, "TRACE", ctx.experimentId, undefined, {
        ...ctx.exploration,
        ablation: noBandit as any,
      });
      if (!base) {
        st.skippedJobs++;
        pending = null;
        return null;
      }
      const providers = await prisma.provider.findMany({ where: { capability: ctx.capability, isActive: true } });
      const pmap = new Map(providers.map((p) => [p.id, p]));
      const flagged = (id: string) => {
        const p = pmap.get(id);
        return p ? simFlagged(p) : true;
      };
      const tier = (id: string) => simTier(pmap.get(id)!);

      const nonFlaggedAll = base.candidates.filter((c) => !flagged(c.providerId));
      st.flaggedSeen += base.candidates.length - nonFlaggedAll.length;

      let pick: (typeof base.candidates)[number] | null = null;
      let mode: Mode = "greedyAll";

      if (base.selectionMode === "fallback") {
        // TRACE found no eligible provider: relax constraints over non-flagged only.
        const sorted = [...nonFlaggedAll].sort((a, b) => b.utility - a.utility);
        pick = sorted[0] ?? null;
        mode = "fallback";
      } else {
        const eligible = base.candidates
          .filter((c) => !c.rejected && c.utility >= 0 && !flagged(c.providerId))
          .sort((a, b) => b.utility - a.utility);
        const unproven = eligible.filter((c) => tier(c.providerId) === "UNPROVEN");
        const proven = eligible.filter((c) => tier(c.providerId) === "PROVEN");

        if (bPercent > 0) {
          if (unproven.length > 0) {
            st.exploreAttempts++;
            const { winner } = selectWinnerWithExploration(
              unproven,
              pmap,
              { ...ctx.exploration, ablation: thompson as any },
              "TRACE",
              ctx.round,
            );
            const price = chargedPrice(pmap.get(winner.providerId)!, ctx.medianPrice);
            if (affordable(price)) {
              pick = winner;
              mode = "explore";
            } else {
              st.exploreUnaffordable++;
            }
          } else {
            st.noUnprovenEligible++;
          }
        }
        if (!pick) {
          const pool = proven.length > 0 ? proven : eligible;
          mode = proven.length > 0 ? "greedyProven" : "greedyAll";
          if (pool.length > 0) {
            const { winner } = selectWinnerWithExploration(
              pool,
              pmap,
              { ...ctx.exploration, ablation: noBandit as any },
              "TRACE",
              ctx.round,
            );
            pick = winner;
          } else {
            // Every eligible provider is flagged: relax constraints over non-flagged only.
            const sorted = [...nonFlaggedAll].filter((c) => c.rejected || c.utility < 0).sort((a, b) => b.utility - a.utility);
            pick = sorted[0] ?? null;
            mode = "fallback";
          }
        }
      }

      if (!pick) {
        st.skippedJobs++;
        pending = null;
        return null;
      }
      const provider = pmap.get(pick.providerId)!;
      if (simFlagged(provider)) st.flaggedPicked++;
      if (mode !== "explore" && simTier(provider) === "UNPROVEN") st.unprovenPickedOutsideBudget++;
      pending = { id: provider.id, mode, price: chargedPrice(provider, ctx.medianPrice) };
      return {
        provider,
        utility: pick.utility,
        candidates: nonFlaggedAll, // the runner's within-round re-route can never reach a flagged provider
        policy: "TRACE",
        selectionMode: mode === "explore" ? "exploration" : mode === "fallback" ? "fallback" : "utility",
        epsilon: base.epsilon,
      } as Awaited<ReturnType<typeof selectProviderTRACE>>;
    },

    onCharged(providerId: string, priceSats: number) {
      st.jobs++;
      cumTotal += priceSats;
      st.totalSpend += priceSats;
      if (pending && pending.id === providerId) {
        if (pending.price !== priceSats) st.priceMismatches++;
        if (pending.mode === "explore") {
          cumExplore += priceSats;
          st.exploreSpend += priceSats;
          st.exploreJobs++;
        } else if (pending.mode === "greedyProven") st.greedyProvenJobs++;
        else if (pending.mode === "greedyAll") st.greedyAllJobs++;
        else st.fallbackJobs++;
      } else {
        st.priceMismatches++; // runner re-routed after our pick (cannot happen at 1 job/round)
      }
      if (100 * cumExplore > bPercent * cumTotal) st.budgetViolations++;
      pending = null;
    },

    stats() {
      return { ...st };
    },
  };
}
