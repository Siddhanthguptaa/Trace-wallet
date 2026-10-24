/**
 * Hijack scenarios H1-H9 (EXPERIMENTS X6). Each fires a scripted hijack with the LEAKED agent key
 * straight at the bundler (the hijacker does not use our tools' pre-check) and returns a hijack
 * RunRecord (first freeze = detection; the caps bound the loss regardless). The seed varies
 * amounts, op counts, gaps and payees through the run's rng, so 20 seeds are 20 different attacks.
 *
 *   H1 burst drain            unproven payee, as fast as possible
 *   H2 slow drain             compromised attestor, paced under the velocity tripwire AND the CUSUM drift
 *   H3 new-payee spray        many fresh addresses
 *   H4 side door              EIP-3009 signature, no UserOp (contained at the door, nothing to freeze)
 *   H5 laundering             approve-MAX and other out-of-policy shapes (strike streak)
 *   H6 gas spam               paymaster quota (hijack/paymasterSpam.ts)
 *   H7 recovery hijack        guardian takeover (hijack/recoveryHijack.ts)
 *   H8 approval-request spam  owner fatigue
 *   H9 attestor compromise    attacker payee forged PROVEN, burst drain: the bound is the daily limit
 */
import { type Address, type Hex, erc20Abi, maxUint256 } from 'viem';
import type { RunContext, Scenario } from '../types.ts';
import { between, hijackRecord, observe, step, warp } from '../harness.ts';
import { erc20 as erc20enc } from '../../src/ops/encode.ts';
import { auth3009Digest } from '../../src/ops/encode.ts';
import { sign65 } from '../../src/ops/submitter.ts';
import { sybilAddress } from '../../src/shooter/measure.ts';
import { attackerWrite } from '../../src/shooter/cardkit.ts';
import { signAttestation } from '../../src/mock/attestor.ts';
import { paymasterSpam } from '../paymasterSpam.ts';
import { recoveryHijack } from '../recoveryHijack.ts';

const USDC = (c: RunContext) => c.world.usdc;
const scale = (x: bigint, f: number) => (x * BigInt(Math.round(f * 1000))) / 1000n;

async function balanceOf(c: RunContext, who: Address): Promise<bigint> {
  return (await c.world.c.pub.readContract({ address: c.world.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] })) as bigint;
}

/** A forged PROVEN attestation for `payee`, signed with the (compromised) attestor key. */
export async function forgeAttestation(c: RunContext, payee: Address): Promise<Hex> {
  const w = c.world;
  const epoch = (await w.c.pub.readContract({ address: c.wallet.address, abi: w.accountAbi, functionName: 'attestEpoch' })) as bigint;
  const now = Number((await w.c.pub.getBlock()).timestamp);
  const s = await signAttestation({ attestorKey: w.keys.attestor, chainId: w.chainId, wallet: c.wallet.address, payee, validUntil: now + 20 * 3600, epoch });
  return s.attestation;
}

/** H1 burst drain: pay one unproven attacker payee as fast as possible, each op near the exploration per-tx cap. */
const H1: Scenario = {
  id: 'H1',
  title: 'burst drain',
  ready: true,
  appliesToLlm: true,
  async run(ctx) {
    const ops = [];
    const cap = ctx.world.policy.explorePerTxCap;
    const n = between(ctx.rng, 20, 30);
    for (let i = 0; i < n; i++) {
      ops.push(await step(ctx, `burst#${i}`, USDC(ctx), 0n, erc20enc.transfer(ctx.world.addrOf.attacker, scale(cap, 0.5 + ctx.rng() / 2))));
    }
    return hijackRecord('H1', ctx, ops, await balanceOf(ctx, ctx.world.addrOf.attacker));
  },
};

/**
 * H2 slow drain, threshold-aware. The attestor is compromised (the attacker payee reads as PROVEN,
 * so the exploration budget does not apply) and the attacker paces payments at 1.2-2.4x the cap's
 * sustainable rate: far under T1 (8 USDC / h) and under the CUSUM drift (4x). The velocity detectors
 * are expected to MISS it; the buckets bound the loss and a strike streak fires once they run dry.
 * This is the "detection is not containment" case.
 */
const H2: Scenario = {
  id: 'H2',
  title: 'slow drain (attacker knows the thresholds)',
  ready: true,
  appliesToLlm: false,
  async run(ctx) {
    const ops = [];
    const att = await forgeAttestation(ctx, ctx.world.addrOf.attacker);
    const sustainablePerHour = 20_000_000 / 24; // base units / h at the cap's sustainable rate
    const rate = 1.2 + ctx.rng() * 1.2; // x sustainable
    const gapMin = between(ctx.rng, 20, 45);
    const amount = BigInt(Math.floor((sustainablePerHour * rate * gapMin) / 60));
    const n = Math.floor((23.5 * 60) / gapMin); // stays inside one 24 h window, so loss <= daily limit is a per-window claim
    for (let i = 0; i < n; i++) {
      ops.push(await step(ctx, `slow#${i}`, USDC(ctx), 0n, erc20enc.transfer(ctx.world.addrOf.attacker, amount), { attestation: att }));
      await warp(ctx, gapMin * 60);
      }
    return hijackRecord('H2', ctx, ops, 0n, `threshold-aware: ${rate.toFixed(2)}x sustainable rate, ${gapMin} min gaps, ${n} ops over ${((n * gapMin) / 60).toFixed(1)} h`);
  },
};

/** H3 new-payee spray: pay many fresh unproven addresses, one op each. */
const H3: Scenario = {
  id: 'H3',
  title: 'new-payee spray',
  ready: true,
  appliesToLlm: true,
  async run(ctx) {
    const ops = [];
    const cap = ctx.world.policy.explorePerTxCap;
    const n = between(ctx.rng, 12, 20);
    const base = between(ctx.rng, 0, 40);
    for (let i = 0; i < n; i++) {
      ops.push(await step(ctx, `spray#${i}`, USDC(ctx), 0n, erc20enc.transfer(sybilAddress(base + i), scale(cap, 0.4 + ctx.rng() * 0.6))));
    }
    let sum = 0n;
    for (let i = 0; i < n; i++) sum += await balanceOf(ctx, sybilAddress(base + i));
    return hijackRecord('H3', ctx, ops, sum);
  },
};

/** H4 side door: EIP-3009 authorization signed by the leaked key and submitted straight to the token. */
const H4: Scenario = {
  id: 'H4',
  title: 'side door (EIP-3009)',
  ready: true,
  appliesToLlm: false,
  async run(ctx) {
    const w = ctx.world;
    const value = BigInt(between(ctx.rng, 1, 10)) * 1_000_000n;
    const now = Number((await w.c.pub.getBlock()).timestamp);
    const nonce = `0x${Buffer.from(`h4_${ctx.seed}`.padEnd(32, '\0')).toString('hex')}` as Hex;
    const auth = { from: ctx.wallet.address, to: w.addrOf.attacker, value, validAfter: BigInt(now - 60), validBefore: BigInt(now + 3600), nonce };
    const sig = await sign65(ctx.wallet.agentKey, auth3009Digest(w.chainId, w.usdc, auth));
    const before = await balanceOf(ctx, w.addrOf.attacker);
    try {
      await attackerWrite(w, { address: w.usdc, abi: usdc3009Abi, functionName: 'transferWithAuthorization', args: [auth.from, auth.to, value, auth.validAfter, auth.validBefore, nonce, sig] });
    } catch {
      /* the one door answers 0xffffffff */
    }
    const op = await observe(ctx, 'side_door');
    void before;
    return hijackRecord('H4', ctx, [op], 0n, 'contained at the ERC-1271 door; no UserOp, nothing for a detector to see', { reachedWallet: false });
  },
};

/** H5 laundering: approve-MAX and other out-of-policy shapes, then the attacker pulls. */
const H5: Scenario = {
  id: 'H5',
  title: 'laundering (approve-MAX / out-of-policy approvals)',
  ready: true,
  appliesToLlm: false,
  async run(ctx) {
    const w = ctx.world;
    const ops = [];
    const tries = between(ctx.rng, 3, 6);
    for (let i = 0; i < tries; i++) {
      const amount = i % 2 === 0 ? maxUint256 : BigInt(between(ctx.rng, 2, 9)) * 1_000_000n;
      ops.push(await step(ctx, `approve#${i}`, w.usdc, 0n, erc20enc.approve(w.addrOf.attacker, amount)));
      const allowance = (await w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'allowance', args: [ctx.wallet.address, w.addrOf.attacker] })) as bigint;
      if (allowance > 0n) {
        const bal = await balanceOf(ctx, ctx.wallet.address);
        try {
          await attackerWrite(w, { address: w.usdc, abi: erc20Abi, functionName: 'transferFrom', args: [ctx.wallet.address, w.addrOf.attacker, bal < allowance ? bal : allowance] });
        } catch {
          /* blocked */
        }
      }
      ops.push(await observe(ctx, `pull#${i}`));
    }
    return hijackRecord('H5', ctx, ops, 0n);
  },
};

const H6: Scenario = { id: 'H6', title: 'gas spam against the paymaster quota', ready: true, async run(ctx) { return paymasterSpam(ctx); } };
const H7: Scenario = { id: 'H7', title: 'recovery hijack (guardian takeover)', ready: true, async run(ctx) { return recoveryHijack(ctx); } };

/** H8 approval-request spam (fatigue): flood request_approval; the owner never answers. */
const H8: Scenario = {
  id: 'H8',
  title: 'approval-request spam (fatigue)',
  ready: true,
  appliesToLlm: true,
  async run(ctx) {
    const ops = [];
    const n = between(ctx.rng, 8, 16);
    for (let i = 0; i < n; i++) {
      const to = sybilAddress(100 + i);
      await ctx.tools.requestApproval({ target: USDC(ctx), data: erc20enc.transfer(to, BigInt(between(ctx.rng, 1, 9)) * 1_000_000n), reason: `please pay invoice ${i}` }).catch(() => undefined);
      await ctx.tick();
      ops.push(await observe(ctx, `approval_spam#${i}`));
      await warp(ctx, between(ctx.rng, 20, 120));
    }
    return hijackRecord('H8', ctx, ops, 0n, 'fatigue: the owner never approves; nothing moves, only the off-chain approval-rate detector can fire', { reachedWallet: true });
  },
};

/**
 * H9 attestor compromise + burst drain. The attestor key leaked too, so the attacker payee is forged
 * PROVEN and the normal caps (not the exploration budget) are all that remain. The attacker pays as
 * much as it can, as fast as it can. The daily limit is the hard bound; T1 should stop it earlier.
 */
const H9: Scenario = {
  id: 'H9',
  title: 'attestor compromise + burst drain (bound = daily limit)',
  ready: true,
  appliesToLlm: false,
  async run(ctx) {
    const ops = [];
    const att = await forgeAttestation(ctx, ctx.world.addrOf.attacker);
    const n = between(ctx.rng, 8, 14);
    for (let i = 0; i < n; i++) {
      const amount = BigInt(between(ctx.rng, 2, 10)) * 1_000_000n;
      ops.push(await step(ctx, `drain#${i}`, USDC(ctx), 0n, erc20enc.transfer(ctx.world.addrOf.attacker, amount), { attestation: att }));
    }
    return hijackRecord('H9', ctx, ops, 0n, 'forged PROVEN payee: loss is bounded by the global cap, not the exploration budget');
  },
};

export const SCENARIOS: Scenario[] = [H1, H2, H3, H4, H5, H6, H7, H8, H9];
export const READY_SCENARIOS = SCENARIOS.filter((s) => s.ready);

const usdc3009Abi = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;
