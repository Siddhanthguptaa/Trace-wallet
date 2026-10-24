/**
 * H6 gas spam against the paymaster quota (EXPERIMENTS X6, problem statement "sponsor gas with a
 * per-agent quota that spam cannot drain"). The leaked agent key sends in-policy ops that pass
 * validation and revert in execution (a grocery order with no allowance), through the owner's
 * AgentPaymaster, with the ATTACKER as the bundler beneficiary, so every sponsored wei lands in the
 * attacker's pocket. The quota is the bound: the attacker's ETH gain over any window of length t is
 * <= burst + ratePerDay x t / 1 day, and a second registered agent's quota is untouched.
 */
import { type Address, type Hex, erc20Abi } from 'viem';
import { buildPaymasterAndData } from '@hypnexis/shared/paymaster';
import type { RunContext, RunRecord } from './types.ts';
import { between, hijackRecord, observe, warp } from './harness.ts';
import { deploy, deployWallet, send } from '../src/world/deploy.ts';
import { agentCallData, shop } from '../src/ops/encode.ts';
import { buildOp, defaultGas, getNonce, opHash, sign65, submit } from '../src/ops/submitter.ts';
import { agentSignature } from '../src/ops/encode.ts';

const PM_VERIF = 80_000n;
const PM_POSTOP = 50_000n;

export async function paymasterSpam(ctx: RunContext): Promise<RunRecord> {
  const w = ctx.world;
  if (!w.paymasterArt) return hijackRecord('H6', ctx, [], 0n, 'pending: AgentPaymaster artifact missing (forge build)', { reachedWallet: true });
  const gas = defaultGas(w);
  const perOp = (gas.verificationGasLimit + gas.callGasLimit + gas.preVerificationGas + PM_VERIF + PM_POSTOP) * gas.maxFeePerGas; // wei reserved per op
  const burst = perOp * BigInt(between(ctx.rng, 6, 10)); // the quota fits 6-10 worst-case ops at once
  const rate = burst;

  const caps = {
    maxFeePerGas: gas.maxFeePerGas * 2n,
    callGasLimit: 500_000,
    verificationGasLimit: 300_000,
    preVerificationGas: 100_000,
    paymasterVerificationGasLimit: 100_000,
    paymasterPostOpGasLimit: 100_000,
  };
  const pm = await deploy(w, w.paymasterArt, [w.ep, w.addrOf.owner, caps]);
  const pmAbi = w.paymasterArt.abi;
  await send(w, w.keys.owner, pm, pmAbi, 'deposit', [], 2_000_000_000_000_000_000n);
  await send(w, w.keys.owner, pm, pmAbi, 'addStake', [86_400], 1_000_000_000_000_000_000n);

  // Agent A (the victim of the hijack) and agent B (an innocent second account on the same paymaster).
  const walletB = await deployWallet(w, 'X6', { salt: 66n });
  for (const acct of [ctx.wallet.address, walletB.address]) {
    await send(w, w.keys.owner, acct, w.accountAbi, 'setAgentPaymaster', [pm]);
    await send(w, w.keys.owner, pm, pmAbi, 'registerAgent', [acct, burst, rate]);
  }

  const pmd = buildPaymasterAndData({ paymaster: pm, verificationGasLimit: PM_VERIF, postOpGasLimit: PM_POSTOP });
  const depositOf = async () => (await w.c.pub.readContract({ address: w.ep, abi: w.arts.EntryPoint.abi, functionName: 'balanceOf', args: [pm] })) as bigint;
  const ethOf = (a: Address) => w.c.pub.getBalance({ address: a });
  const attackerEth0 = await ethOf(w.addrOf.attacker);
  const dep0 = await depositOf();
  const t0 = Number((await w.c.pub.getBlock()).timestamp);

  // A reverting-in-execution op signed by `who`'s agent key and sponsored by the paymaster.
  const sponsoredOp = async (account: Address, beneficiary: Address) => {
    const nonceKey = (await w.c.pub.readContract({ address: account, abi: w.accountAbi, functionName: 'nonceKeyOf', args: [ctx.wallet.agentAddress, 0] })) as bigint;
    const nonce = await getNonce(w, account, nonceKey);
    const callData = agentCallData(w.grocery, 0n, shop.order(1_000_000n, account)); // no allowance: reverts in execution
    const op = buildOp(account, nonce, callData, gas, pmd);
    op.signature = agentSignature(await sign65(ctx.wallet.agentKey, opHash(w, op)));
    return submit(w, [op], beneficiary);
  };

  const ops = [];
  let accepted = 0;
  let rejected = 0;
  const n = between(ctx.rng, 3 * Number(burst / perOp), 5 * Number(burst / perOp));
  for (let i = 0; i < n; i++) {
    const r = await sponsoredOp(ctx.wallet.address, w.addrOf.attacker);
    if (r.validated) accepted++;
    else rejected++;
    await ctx.tick();
    ops.push(await observe(ctx, `gas_spam#${i}`));
    await warp(ctx, between(ctx.rng, 1, 30)); // seconds apart: the attacker is hammering
  }

  const t1 = Number((await w.c.pub.getBlock()).timestamp);
  const attackerGain = (await ethOf(w.addrOf.attacker)) - attackerEth0;
  const drained = dep0 - (await depositOf());
  const windowBound = burst + (rate * BigInt(t1 - t0)) / 86_400n;

  // Agent B is untouched by A's spam: one sponsored op of its own still validates.
  const b = await sponsoredOp(walletB.address, w.addrOf.relayer);
  const bQuota = (await w.c.pub.readContract({ address: pm, abi: pmAbi, functionName: 'available', args: [walletB.address] })) as bigint;

  const boundHeld = attackerGain <= windowBound && drained <= windowBound * 2n && b.validated;
  return hijackRecord(
    'H6',
    ctx,
    ops,
    0n,
    `attacker bundler gain ${attackerGain} wei <= quota window bound ${windowBound} wei; ${accepted} sponsored, ${rejected} refused; second agent still sponsored: ${b.validated}`,
    {
      metrics: {
        attackerGainWei: attackerGain.toString(),
        depositDrainedWei: drained.toString(),
        quotaWindowBoundWei: windowBound.toString(),
        opsAccepted: accepted,
        opsRefused: rejected,
        otherAgentSponsored: b.validated,
        otherAgentQuotaLeftWei: bQuota.toString(),
        boundHeld,
      },
    },
  );
}

void erc20Abi;
export type { Hex };
