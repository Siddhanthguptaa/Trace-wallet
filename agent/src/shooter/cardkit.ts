/**
 * Shared helpers for the raw-key cards (cards.ts, cards2.ts): fixture parameters, wallet setup,
 * CardResult assembly, raw UserOp submission for the naive and agent accounts, owner-signed ops,
 * time warps and ETH measurement. Types come from cards.ts (type-only import: no runtime cycle).
 */
import { type Address, type Hex, encodeFunctionData, erc20Abi } from 'viem';
import type { CardCtx } from './cards.ts';
import { type Wallet, type WalletSetup, deployWallet } from '../world/deploy.ts';
import type { World } from '../world/deploy.ts';
import { AgentTools } from '../tools/engine.ts';
import { agentSignature } from '../ops/encode.ts';
import { buildOp, defaultGas, getNonce, opHash, sign65, submit, type OpGas, type SubmitResult } from '../ops/submitter.ts';
import { devchain } from '../chain/anvil.ts';
import { type playLegitStream } from '../legit/stream.ts';
import { type CardResult, beyond } from './measure.ts';
import { loadFixture } from '../world/policy.ts';

export const CONFIGS = ['R1', 'R2', 'R3', 'R4'] as const;
export type ConfigId = (typeof CONFIGS)[number];

export type LegitTotals = Awaited<ReturnType<typeof playLegitStream>>;

interface DeckParams {
  cards: { id: string; asset: string; bound: string; measured?: string; [k: string]: unknown }[];
}
const DECK = loadFixture<DeckParams>('deck_params.json');
export function params(id: string) {
  const p = DECK.cards.find((c) => c.id === id);
  if (!p) throw new Error(`deck_params.json has no card ${id}`);
  return p;
}

export async function setup(ctx: CardCtx, s: WalletSetup = {}): Promise<{ wallet: Wallet; tools: AgentTools }> {
  const wallet = await deployWallet(ctx.world, ctx.config, s);
  const tools = new AgentTools({ world: ctx.world, wallet, attestorUrl: ctx.config === 'R4' ? ctx.attestorUrl : '' });
  return { wallet, tools };
}

export const emptyLegit: LegitTotals = { blocked: 0, provenBlocked: 0, blockedValue: '0', neededApproval: 0, paidValue: '0', steps: [] };

export function result(ctx: CardCtx, id: string, asset: string, lost: bigint, boundUnits: bigint, legit: LegitTotals, notes?: string): CardResult {
  return {
    card: id,
    config: ctx.config,
    chainMode: ctx.world.env.cfg.CHAIN_MODE,
    asset,
    lostBaseUnits: lost.toString(),
    beyondPolicyBaseUnits: beyond(lost, boundUnits).toString(),
    legitBlocked: legit.blocked,
    legitProvenBlocked: legit.provenBlocked,
    legitBlockedValue: legit.blockedValue,
    legitNeededApproval: legit.neededApproval,
    success: lost > 0n,
    ...(notes ? { notes } : {}),
  };
}

const EXECUTE_ABI = [
  { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'dest', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'func', type: 'bytes' }], outputs: [] },
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }],
    outputs: [],
  },
] as const;
export const exec = {
  execute: (dest: Address, value: bigint, data: Hex) => encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [dest, value, data] }),
  executeBatch: (calls: { target: Address; value: bigint; data: Hex }[]) => encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'executeBatch', args: [calls] }),
};
export const WITHDRAW_TO_ABI = [{ type: 'function', name: 'withdrawTo', stateMutability: 'nonpayable', inputs: [{ name: 'withdrawAddress', type: 'address' }, { name: 'withdrawAmount', type: 'uint256' }], outputs: [] }] as const;
export const withdrawTo = (to: Address, amount: bigint) => encodeFunctionData({ abi: WITHDRAW_TO_ABI, functionName: 'withdrawTo', args: [to, amount] });

/** A UserOp with exactly this callData (no executeAgent / agent-op wrapping), signed by the leaked agent key. */
export async function rawCall(w: World, wallet: Wallet, callData: Hex, gas?: OpGas, beneficiary?: Address): Promise<SubmitResult> {
  const key = wallet.kind === 'agent'
    ? ((await w.c.pub.readContract({ address: wallet.address, abi: w.accountAbi, functionName: 'nonceKeyOf', args: [wallet.agentAddress, 0] })) as bigint)
    : 0n;
  const nonce = await getNonce(w, wallet.address, key);
  const op = buildOp(wallet.address, nonce, callData, gas ?? defaultGas(w));
  const sig = await sign65(wallet.agentKey, opHash(w, op));
  op.signature = wallet.kind === 'agent' ? agentSignature(sig) : sig;
  return submit(w, [op], beneficiary ?? w.addrOf.relayer);
}

/** An owner-signed UserOp (execute) on the naive or agent account; the hash can be taken for another chain / EntryPoint. */
export async function ownerOp(w: World, wallet: Wallet, callData: Hex, hashChainId?: number, hashEp?: Address) {
  const nonce = await getNonce(w, wallet.address, 0n);
  const op = buildOp(wallet.address, nonce, callData, defaultGas(w));
  op.signature = await sign65(w.keys.owner, opHash(w, op, hashChainId, hashEp));
  return op;
}

export const ethOf = (w: World, a: Address) => w.c.pub.getBalance({ address: a });
export const usdcOf = (w: World, a: Address) => w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

/** Seconds from now until `secondsBefore` before the next UTC midnight (rolls over a day if already inside it). */
export async function secondsToMidnight(w: World, secondsBefore: number): Promise<number> {
  const now = await devchain.now(w.c.rpcUrl);
  const next = (Math.floor(now / 86400) + 1) * 86400;
  let delta = next - secondsBefore - now;
  if (delta < 0) delta += 86400;
  return delta;
}
export const warp = (w: World, seconds: number) => devchain.warp(w.c.rpcUrl, seconds);

/** The attacker EOA submits a transaction and WAITS for it to be mined, so the next measurement cannot race it. A tx that would revert throws at gas estimation and is never sent. */
export async function attackerWrite(w: World, req: Parameters<ReturnType<World['c']['wallet']>['writeContract']>[0]): Promise<void> {
  const hash = await w.c.wallet(w.keys.attacker).writeContract(req);
  await w.c.pub.waitForTransactionReceipt({ hash });
}
