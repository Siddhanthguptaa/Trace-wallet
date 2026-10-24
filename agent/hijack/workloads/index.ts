/**
 * Legit workloads L1-L4 (EXPERIMENTS X6). Each drives honest agent activity on the X6 wallet THROUGH
 * THE TOOLS (an honest agent uses the pre-check) with a seeded schedule, and returns a legit
 * RunRecord; a freeze during a legit run is a FALSE freeze. These measure the cost of the detectors.
 * The schedules are ours (self-graded, synthetic): amounts, counts and gaps are drawn from the run's
 * rng inside the ranges below, which are written to be plausible-heavy rather than convenient.
 */
import type { Op, RunContext, Workload } from '../types.ts';
import { between, legitRecord, observe, warp } from '../harness.ts';
import { playLegitStream } from '../../src/legit/stream.ts';
import { sybilAddress } from '../../src/shooter/measure.ts';

const USDC1 = 1_000_000n;

async function after(ctx: RunContext, label: string): Promise<Op> {
  await ctx.tick();
  return observe(ctx, label);
}

/** L1 steady shopping: 3-5 grocery buys of 1-3 USDC spread through the day. */
const L1: Workload = {
  id: 'L1',
  title: 'steady shopping',
  ready: true,
  async run(ctx) {
    const ops: Op[] = [];
    const n = between(ctx.rng, 3, 5);
    for (let i = 0; i < n; i++) {
      await ctx.tools.buy({ shop: 'grocery', amount: BigInt(between(ctx.rng, 1, 3)) * USDC1, recipient: ctx.world.addrOf.owner }).catch(() => undefined);
      ops.push(await after(ctx, `grocery#${i}`));
      await warp(ctx, between(ctx.rng, 2, 8) * 3600);
    }
    return legitRecord('L1', ctx, ops);
  },
};

/** L2 bursty-legit "sale day": 4-7 buys of 1-3 USDC, minutes apart, inside one hour. */
const L2: Workload = {
  id: 'L2',
  title: 'bursty-legit sale day',
  ready: true,
  async run(ctx) {
    const ops: Op[] = [];
    const n = between(ctx.rng, 4, 7);
    for (let i = 0; i < n; i++) {
      await ctx.tools.buy({ shop: 'grocery', amount: BigInt(between(ctx.rng, 1, 3)) * USDC1, recipient: ctx.world.addrOf.owner }).catch(() => undefined);
      ops.push(await after(ctx, `sale#${i}`));
      await warp(ctx, between(ctx.rng, 120, 600));
    }
    return legitRecord('L2', ctx, ops, 'several buys near the caps within one hour: the velocity tripwire and the spend CUSUM are tested for false positives');
  },
};

/** L3 new-shop onboarding: the legit stream plus 2-5 fresh honest payees the same day (cold start, within the exploration per-tx cap). */
const L3: Workload = {
  id: 'L3',
  title: 'new-shop onboarding',
  ready: true,
  async run(ctx) {
    const totals = await playLegitStream(ctx.world, ctx.tools, { sellerBase: ctx.sellerBase });
    const ops: Op[] = [await after(ctx, 'legit_stream')];
    const k = between(ctx.rng, 2, 5);
    const base = 200 + between(ctx.rng, 0, 30);
    for (let i = 0; i < k; i++) {
      await ctx.tools.pay({ asset: ctx.world.usdc, to: sybilAddress(base + i), amount: BigInt(between(ctx.rng, 50, 200)) * 1000n }).catch(() => undefined);
      ops.push(await after(ctx, `new_payee#${i}`));
      await warp(ctx, between(ctx.rng, 60, 600));
    }
    return legitRecord('L3', ctx, ops, `legit stream blocked=${totals.blocked} neededApproval=${totals.neededApproval}`);
  },
};

/** L4 heavy API use: 6-15 small payments (0.05-0.2 USDC) to the listed API seller, a few minutes apart. */
const L4: Workload = {
  id: 'L4',
  title: 'heavy API use',
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const ops: Op[] = [];
    const n = between(ctx.rng, 6, 15);
    for (let i = 0; i < n; i++) {
      await ctx.tools.pay({ asset: w.usdc, to: w.api, amount: BigInt(between(ctx.rng, 50, 200)) * 1000n }).catch(() => undefined);
      ops.push(await after(ctx, `api#${i}`));
      await warp(ctx, between(ctx.rng, 60, 400));
    }
    return legitRecord('L4', ctx, ops, 'many small payments to a listed API seller');
  },
};

export const WORKLOADS: Workload[] = [L1, L2, L3, L4];
export const READY_WORKLOADS = WORKLOADS.filter((w) => w.ready);
