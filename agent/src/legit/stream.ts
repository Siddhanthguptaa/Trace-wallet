/**
 * Legit-stream player (BUILD.md M7 "Legit stream", EXPERIMENTS X1 "Legit workload"). Replays the
 * fixed stream (fixtures/legit_stream.json) through the agent tools and records, per step and in
 * total: blocked (refused), provenBlocked (blocked payments to a listed/attested payee), needed
 * approval (routed to the owner), and the paid value. Metric 2 of X1 is these counts; it is
 * reported separately from "needed owner approval".
 */
import type { Address } from 'viem';
import type { AgentTools, PayResult } from '../tools/engine.ts';
import type { World } from '../world/deploy.ts';
import { payX402 } from './x402.ts';
import { loadFixture, resolve } from '../world/policy.ts';
import { devchain } from '../chain/anvil.ts';

export interface LegitStep {
  id: string;
  kind: 'buy_ticket' | 'grocery_order' | 'x402' | 'pay';
  payee: string;
  payeeClass: 'listed' | 'attested' | 'cold';
  amount: string;
  ticketId?: number;
  resource?: string;
}
export interface LegitStreamFixture {
  version: number;
  asset: string;
  gapSeconds: number;
  steps: LegitStep[];
}

export interface LegitStepResult {
  id: string;
  payeeClass: LegitStep['payeeClass'];
  amount: string;
  status: PayResult['status'] | 'paid' | 'needs_one_door' | 'error';
  blocked: boolean;
  provenBlocked: boolean;
  neededApproval: boolean;
  /** Why a step was refused / needed approval (tools reason name), for diagnosis. */
  reason?: string;
}

export interface LegitTotals {
  blocked: number;
  provenBlocked: number;
  blockedValue: string;
  neededApproval: number;
  paidValue: string;
  steps: LegitStepResult[];
}

export interface LegitOptions {
  sellerBase?: string;
  /** Warp the chain by the fixture's gapSeconds between steps (default true, as the fixture says). */
  warp?: boolean;
}

export function loadLegitStream(): LegitStreamFixture {
  return loadFixture<LegitStreamFixture>('legit_stream.json');
}

export async function playLegitStream(w: World, tools: AgentTools, opts: LegitOptions = {}): Promise<LegitTotals> {
  const fx = loadLegitStream();
  const totals: LegitTotals = { blocked: 0, provenBlocked: 0, blockedValue: '0', neededApproval: 0, paidValue: '0', steps: [] };
  let blockedValue = 0n;
  let paidValue = 0n;
  for (const step of fx.steps) {
    const amount = BigInt(step.amount);
    const payee = resolveStepPayee(w, step);
    let r: LegitStepResult;
    if (step.kind === 'x402') {
      const out = await payX402(w, tools, opts.sellerBase ?? `http://127.0.0.1:${w.env.sellerPort}`, step.resource ?? 'resource', amount);
      const paid = out.status === 'paid';
      r = mk(step, paid ? 'paid' : out.status === 'needs_one_door' ? 'needs_one_door' : 'refused', { blocked: !paid, proven: true });
      if (!paid) r.reason = out.reason;
      if (paid) paidValue += amount;
    } else {
      const res = await payStep(tools, step, payee, amount);
      const paid = res.status === 'executed';
      const needsApproval = res.status === 'needs_approval';
      const proven = step.payeeClass !== 'cold';
      r = mk(step, res.status, { blocked: !paid && !needsApproval, proven, needsApproval });
      if (!paid) r.reason = (res as { reasonName?: string; reason?: string }).reasonName ?? (res as { reason?: string }).reason;
      if (paid) paidValue += amount;
    }
    if (r.blocked) {
      totals.blocked += 1;
      if (r.provenBlocked) totals.provenBlocked += 1;
      blockedValue += amount;
    }
    if (r.neededApproval) totals.neededApproval += 1;
    totals.steps.push(r);
    if (opts.warp !== false) await devchain.warp(w.c.rpcUrl, fx.gapSeconds);
  }
  totals.blockedValue = blockedValue.toString();
  totals.paidValue = paidValue.toString();
  return totals;
}

function mk(step: LegitStep, status: LegitStepResult['status'], f: { blocked: boolean; proven: boolean; needsApproval?: boolean }): LegitStepResult {
  return {
    id: step.id,
    payeeClass: step.payeeClass,
    amount: step.amount,
    status,
    blocked: f.blocked && !f.needsApproval,
    provenBlocked: f.blocked && f.proven && !f.needsApproval,
    neededApproval: f.needsApproval ?? false,
  };
}

function resolveStepPayee(w: World, step: LegitStep): Address {
  if (step.payee === 'TicketShop') return w.ticket;
  if (step.payee === 'GroceryShop') return w.grocery;
  if (step.payee === 'ApiSeller') return w.api;
  return resolve(w.labels, step.payee);
}

async function payStep(tools: AgentTools, step: LegitStep, payee: Address, amount: bigint): Promise<PayResult> {
  if (step.kind === 'buy_ticket') {
    // buy() approves the shop for the price, then buys for the wallet itself
    return tools.buy({ shop: 'ticket', item: BigInt(step.ticketId ?? 0), recipient: tools.ctx.wallet.address });
  }
  if (step.kind === 'grocery_order') return tools.buy({ shop: 'grocery', amount, recipient: tools.ctx.wallet.address });
  return tools.pay({ asset: tools.ctx.world.usdc, to: payee, amount });
}
