/**
 * Outflow simulation (IDEA 7.3): eth_call against current state with the ApprovalSimulator runtime
 * put at the account address by a state override, so the call runs as the account (same balances,
 * allowances, msg.sender). Outflow per asset uses the D2 meter formula (docs/api.md 9). The owner
 * signs maxOutflow = this result; the account enforces it, so a wrong simulation can only block.
 * SIMULATION_MODE=declared is BUILD M5's fallback: maxOutflow = the decoded amount.
 */
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, getAddress } from 'viem';
import { type AgentCall, type AssetAmount, NATIVE_ASSET, declaredAmount } from '../../../packages/shared/src/approval/index.ts';
import { SIMULATOR_RUNTIME, simulatorAbi } from './simulatorArtifact.ts';

export interface Tracked {
  assets: Address[];
  spenders: Address[];
  nfts: Address[];
}

export interface Simulation {
  mode: 'eth_call' | 'declared';
  ok: boolean;
  /** asset -> amount, zero entries dropped, sorted by asset address (native = 0x0 first). */
  outflows: AssetAmount[];
  /** decoded amount of transfer / approve / increaseAllowance, or the native value. */
  declared: { asset: Address; amount: bigint; spender?: Address } | null;
  revertData?: Hex;
  gasUsed?: bigint;
  tracked?: Tracked;
  warnings: string[];
}

export interface SimRequest {
  target: Address;
  value: bigint;
  data: Hex;
  entryPoint: Address;
  tokens: Address[];
  spenders: Address[];
  nfts: Address[];
}

export function simulateCalldata(q: SimRequest): Hex {
  return encodeFunctionData({ abi: simulatorAbi, functionName: 'simulate', args: [q] });
}

export interface SimRaw {
  ok: boolean;
  ret: Hex;
  nativeOut: bigint;
  tokenOut: readonly bigint[];
  nftOut: readonly bigint[];
  gasUsed: bigint;
}

export function decodeSimResult(data: Hex): SimRaw {
  return decodeFunctionResult({ abi: simulatorAbi, functionName: 'simulate', data }) as SimRaw;
}

export function sortOutflows(xs: AssetAmount[]): AssetAmount[] {
  const m = new Map<string, AssetAmount>();
  for (const x of xs) {
    if (x.amount <= 0n) continue;
    const k = x.asset.toLowerCase();
    const prev = m.get(k);
    m.set(k, { asset: getAddress(x.asset), amount: (prev?.amount ?? 0n) + x.amount });
  }
  return [...m.values()].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : BigInt(a.asset) > BigInt(b.asset) ? 1 : 0));
}

export function outflowsFromRaw(raw: SimRaw, q: SimRequest): AssetAmount[] {
  const xs: AssetAmount[] = [{ asset: NATIVE_ASSET, amount: raw.nativeOut }];
  q.tokens.forEach((t, i) => xs.push({ asset: t, amount: raw.tokenOut[i] ?? 0n }));
  q.nfts.forEach((t, i) => xs.push({ asset: t, amount: raw.nftOut[i] ?? 0n }));
  return sortOutflows(xs);
}

/** de-duplicated union, checksummed; drops the zero address (native is always measured). */
export function unionAddrs(...lists: Address[][]): Address[] {
  const s = new Map<string, Address>();
  for (const l of lists) for (const a of l) if (BigInt(a) !== 0n) s.set(a.toLowerCase(), getAddress(a));
  return [...s.values()];
}

export function stateOverrideFor(account: Address) {
  return [{ address: account, code: SIMULATOR_RUNTIME as Hex }];
}

export function declaredSimulation(call: AgentCall): Simulation {
  const d = declaredAmount(call);
  const warnings = ['declared mode: maxOutflow = decoded amount, effects not simulated'];
  return { mode: 'declared', ok: true, outflows: d ? sortOutflows([{ asset: d.asset, amount: d.amount }]) : [], declared: d, warnings };
}

export function simulationToJson(s: Simulation) {
  return {
    mode: s.mode,
    ok: s.ok,
    outflows: s.outflows.map((x) => ({ asset: x.asset, amount: x.amount.toString() })),
    declared: s.declared ? { ...s.declared, amount: s.declared.amount.toString() } : null,
    ...(s.revertData ? { revertData: s.revertData } : {}),
    ...(s.gasUsed !== undefined ? { gasUsed: s.gasUsed.toString() } : {}),
    ...(s.tracked ? { tracked: s.tracked } : {}),
    warnings: s.warnings,
  };
}
