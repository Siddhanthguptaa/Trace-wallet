/**
 * Card measurement (BUILD.md Conventions "Card results"). Tracks funds that reach attacker-
 * controlled addresses and the total asset outflow in the card's 24 h window, so a card can report
 * either `lostBaseUnits` or a window-outflow bound. Addresses that count as "attacker": the
 * attacker EOA, every hypnexis.attack.* / hypnexis.sybil.* label, and the GreedyMerchant treasury.
 */
import { type Address, erc20Abi, getAddress } from 'viem';
import type { World } from '../world/deploy.ts';
import { labelAddress } from '../world/policy.ts';

export interface CardResult {
  card: string;
  config: string;
  chainMode: string;
  asset: string;
  lostBaseUnits: string;
  beyondPolicyBaseUnits: string;
  legitBlocked: number;
  legitProvenBlocked: number;
  legitBlockedValue: string;
  legitNeededApproval: number;
  success: boolean;
  /** Harness-only diagnostics (not part of the published schema; dropped by the aggregator). */
  notes?: string;
}

export function attackerAddresses(w: World, extra: Address[] = []): Address[] {
  const set = new Set<string>();
  const add = (a: Address) => set.add(getAddress(a));
  add(w.addrOf.attacker);
  add(labelAddress('hypnexis.attack.ColludingShop'));
  add(labelAddress('hypnexis.attack.ProvenPayee'));
  for (const e of extra) add(e);
  return [...set].map((a) => getAddress(a as Address));
}

export function sybilAddress(i: number): Address {
  return labelAddress(`hypnexis.sybil.${i}`);
}

export async function usdcOf(w: World, who: Address): Promise<bigint> {
  return w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}

export async function totalToAttackers(w: World, attackers: Address[]): Promise<bigint> {
  let sum = 0n;
  for (const a of attackers) sum += await usdcOf(w, a);
  return sum;
}

export function beyond(measured: bigint, bound: bigint): bigint {
  return measured > bound ? measured - bound : 0n;
}

/** Resolve the announced bound names in deck_params.json to base units. */
export function resolveBound(w: World, name: string): bigint {
  const p = w.policy;
  switch (name) {
    case '0':
      return 0n;
    case 'gasCredit':
      return p.gasCredit;
    case 'globalCap24h':
      return p.globalCap.burst + p.globalCap.ratePerDay;
    case 'exploreCap24h':
      return p.exploreCap.burst + p.exploreCap.ratePerDay;
    case 'price':
      return p.shops.greedyPrice;
    default:
      if (/^\d+$/.test(name)) return BigInt(name);
      throw new Error(`unknown bound ${name}`);
  }
}
