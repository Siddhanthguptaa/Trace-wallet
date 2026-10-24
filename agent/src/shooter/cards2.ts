/**
 * Raw-key cards that need the integrated modules (D1 one door, D2 meter, D3 payee tiers, owner
 * approvals, the freeze sandbox): batch / self-call / delegatecall shapes, gas griefing, replay,
 * greedy merchant, midnight double spend, multi-key cap, Sybil payees and a compromised attestor.
 * Parameters come from fixtures/deck_params.json; every card fires with the LEAKED agent key straight
 * at the wallet (`forceAgent`: no tools pre-check) and measures what reached attacker addresses.
 */
import { type Address, type Hex, erc20Abi, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Card, CardCtx } from './cards.ts';
import { deploy, deployWallet, send } from '../world/deploy.ts';
import { AgentTools } from '../tools/engine.ts';
import { agentCallData, erc20 as erc20enc, shop } from '../ops/encode.ts';
import { agentSignature } from '../ops/encode.ts';
import { buildOp, defaultGas, getNonce, opHash, sign65, submit } from '../ops/submitter.ts';
import { fire } from './fire.ts';
import { playLegitStream } from '../legit/stream.ts';
import { attackerAddresses, resolveBound, sybilAddress, totalToAttackers } from './measure.ts';
import { signAttestation } from '../mock/attestor.ts';
import { labelAddress } from '../world/policy.ts';
import { CONFIGS, type ConfigId, type LegitTotals, emptyLegit, ethOf, exec, params, rawCall, result, secondsToMidnight, setup, usdcOf, warp, withdrawTo, ownerOp } from './cardkit.ts';
import { devchain } from '../chain/anvil.ts';

const ALL = [...CONFIGS] as ConfigId[];
const isAgent = (c: ConfigId) => c === 'R3' || c === 'R4';
const forced = { forceAgent: true } as const;

async function legitFirst(ctx: CardCtx, tools: AgentTools): Promise<LegitTotals> {
  return playLegitStream(ctx.world, tools, { sellerBase: ctx.sellerBase });
}

// ------------------------------------------------------------------ batch / self-call / delegatecall

export const batch_selfcall_delegatecall: Card = {
  id: 'batch_selfcall_delegatecall',
  configs: ALL,
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('batch_selfcall_delegatecall');
    const drain = BigInt(p.drain as string);
    const { wallet, tools } = await setup(ctx);
    const legit = await legitFirst(ctx, tools);
    const attackers = attackerAddresses(w);
    const before = await totalToAttackers(w, attackers);
    const transfer = erc20enc.transfer(w.addrOf.attacker, drain);
    if (wallet.kind === 'eoa') {
      await fire(w, wallet, tools, w.usdc, 0n, transfer);
    } else if (wallet.kind === 'naive') {
      await rawCall(w, wallet, exec.executeBatch([{ target: w.usdc, value: 0n, data: transfer }])).catch(() => undefined);
      await rawCall(w, wallet, exec.execute(w.usdc, 0n, transfer)).catch(() => undefined);
      await fire(w, wallet, tools, wallet.address, 0n, exec.execute(w.usdc, 0n, transfer));
      await fire(w, wallet, tools, w.ep, 0n, withdrawTo(w.addrOf.attacker, 10n ** 18n));
      await fire(w, wallet, tools, w.usdc, 0n, transfer);
    } else {
      const setRecipient = encodeFunctionData({ abi: w.accountAbi, functionName: 'setRecipient', args: [w.addrOf.attacker, true] });
      await rawCall(w, wallet, exec.executeBatch([{ target: w.usdc, value: 0n, data: transfer }])).catch(() => undefined);
      await rawCall(w, wallet, exec.execute(w.usdc, 0n, transfer)).catch(() => undefined);
      await fire(w, wallet, tools, wallet.address, 0n, setRecipient, forced); // self-call: rewrite the policy
      await fire(w, wallet, tools, wallet.address, 0n, exec.execute(w.usdc, 0n, transfer), forced);
      await rawCall(w, wallet, agentCallData(w.usdc, 0n, transfer, 2)).catch(() => undefined); // no delegatecall op kind exists
      await fire(w, wallet, tools, w.ep, 0n, withdrawTo(w.addrOf.attacker, 10n ** 18n), forced);
      await fire(w, wallet, tools, w.usdc, 0n, transfer, forced);
    }
    return result(ctx, 'batch_selfcall_delegatecall', 'USDC', (await totalToAttackers(w, attackers)) - before, resolveBound(w, p.bound), legit);
  },
};

// ------------------------------------------------------------------ gas burn / griefing

export const gas_burn_griefing: Card = {
  id: 'gas_burn_griefing',
  configs: ALL,
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('gas_burn_griefing');
    const { wallet, tools } = await setup(ctx);
    const legit = await legitFirst(ctx, tools);
    const before = await ethOf(w, w.addrOf.attacker);
    const failing = shop.order(5_000_000n, wallet.address); // in policy, no allowance: reverts in execution
    if (wallet.kind === 'eoa') {
      const bal = await ethOf(w, wallet.address);
      const h = await w.c.wallet(wallet.agentKey).sendTransaction({ to: w.addrOf.attacker, value: bal, gas: 21_000n, gasPrice: 0n }).catch(() => undefined);
      if (h) await w.c.pub.waitForTransactionReceipt({ hash: h });
    } else {
      const g = w.policy.gas;
      const gas =
        wallet.kind === 'naive'
          ? { ...defaultGas(w), preVerificationGas: BigInt((p.r2 as { preVerificationGas: number }).preVerificationGas), maxFeePerGas: BigInt((p.r2 as { maxFeePerGas: string }).maxFeePerGas), maxPriorityFeePerGas: BigInt((p.r2 as { maxFeePerGas: string }).maxFeePerGas) }
          : { verificationGasLimit: BigInt(g.maxVerificationGas), callGasLimit: BigInt(g.maxCallGas), preVerificationGas: BigInt(g.maxPreVerificationGas), maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: g.maxFeePerGas };
      for (let i = 0; i < (p.tries as number); i++) {
        await fire(w, wallet, tools, w.grocery, 0n, failing, { ...forced, gas, beneficiary: w.addrOf.attacker });
      }
    }
    const lost = (await ethOf(w, w.addrOf.attacker)) - before;
    return result(ctx, 'gas_burn_griefing', 'ETH', lost, resolveBound(w, p.bound), legit);
  },
};

// ------------------------------------------------------------------ replay / wrong chain

export const replay_wrong_chain: Card = {
  id: 'replay_wrong_chain',
  configs: ALL,
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('replay_wrong_chain');
    const pay = BigInt(p.pay as string);
    const { wallet, tools } = await setup(ctx, isAgent(ctx.config) ? { extraAgentKeys: [w.keys.agent2] } : {});
    const legit = await legitFirst(ctx, tools);
    const transfer = erc20enc.transfer(w.addrOf.attacker, pay);
    if (wallet.kind === 'eoa') {
      await fire(w, wallet, tools, w.usdc, 0n, transfer); // a raw key signs anew
      return result(ctx, 'replay_wrong_chain', 'USDC', await usdcOf(w, w.addrOf.attacker), 0n, legit);
    }
    const callData = exec.execute(w.usdc, 0n, transfer);
    const legitOp = await ownerOp(w, wallet, callData);
    const first = await submit(w, [legitOp]);
    if (!first.validated || !first.success) throw new Error('replay card: the one legit owner payment must execute');
    const base = await usdcOf(w, w.addrOf.attacker);
    const ep2 = await deploy(w, w.arts.EntryPoint, []);
    await submit(w, [legitOp]); // same nonce
    await submit(w, [await ownerOp(w, wallet, callData, Number(p.otherChainId))]); // signed on another chain
    await submit(w, [await ownerOp(w, wallet, callData, undefined, ep2)]); // signed for another EntryPoint
    if (isAgent(ctx.config)) {
      // an agent op that borrows another session's nonce key
      const k2 = (await w.c.pub.readContract({ address: wallet.address, abi: w.accountAbi, functionName: 'nonceKeyOf', args: [w.addrOf.agent2, 0] })) as bigint;
      const op = buildOp(wallet.address, await getNonce(w, wallet.address, k2), agentCallData(w.usdc, 0n, transfer), defaultGas(w));
      op.signature = agentSignature(await sign65(wallet.agentKey, opHash(w, op)));
      await submit(w, [op]);
    }
    const lost = (await usdcOf(w, w.addrOf.attacker)) - base;
    return result(ctx, 'replay_wrong_chain', 'USDC', lost, 0n, legit);
  },
};

// ------------------------------------------------------------------ greedy merchant

export const greedy_merchant: Card = {
  id: 'greedy_merchant',
  configs: ALL,
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('greedy_merchant');
    const price = BigInt(p.price as string);
    const greedy = await deploy(w, w.arts.GreedyMerchant, [w.usdc, price, w.addrOf.attacker]);
    const buy = '0xa6f2ae3a' as Hex; // buy()
    const { wallet, tools } = await setup(ctx, {
      extraRules: [{ target: greedy, selector: buy, rules: [] }],
      extraRecipients: [greedy],
      extraSpenders: [greedy],
      ownerApprovals: [{ spender: greedy, amount: BigInt(p.ownerAllowance as string) }],
    });
    const legit = await legitFirst(ctx, tools);
    const before = await usdcOf(w, w.addrOf.attacker);
    await fire(w, wallet, tools, greedy, 0n, shop.greedyBuy(), forced);
    return result(ctx, 'greedy_merchant', 'USDC', (await usdcOf(w, w.addrOf.attacker)) - before, resolveBound(w, p.bound), legit);
  },
};

// ------------------------------------------------------------------ midnight double spend

export const midnight_double_spend: Card = {
  id: 'midnight_double_spend',
  configs: ALL,
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('midnight_double_spend');
    const shopAddr = labelAddress(p.payee ? `hypnexis.attack.${p.payee}` : 'hypnexis.attack.ColludingShop');
    const { wallet, tools } = await setup(ctx, { extraRecipients: [shopAddr] });
    const startBal = await usdcOf(w, wallet.address);
    const legit = await legitFirst(ctx, tools);
    const payment = BigInt(p.payment as string);
    const tries = p.triesEachSide as number;
    await warp(w, await secondsToMidnight(w, p.secondsBeforeMidnight as number));
    for (let i = 0; i < tries; i++) await fire(w, wallet, tools, w.usdc, 0n, erc20enc.transfer(shopAddr, payment), forced);
    await warp(w, (p.secondsBeforeMidnight as number) + (p.secondsAfterMidnight as number));
    for (let i = 0; i < tries; i++) await fire(w, wallet, tools, w.usdc, 0n, erc20enc.transfer(shopAddr, payment), forced);
    // windowOutflow: the wallet's total USDC outflow during the card, legit stream included (one 24 h window).
    const outflow = startBal - (await usdcOf(w, wallet.address));
    return result(ctx, 'midnight_double_spend', 'USDC', outflow, resolveBound(w, p.bound), legit, `windowOutflow incl. legit ${legit.paidValue}`);
  },
};

// ------------------------------------------------------------------ multi-key cap

export const multi_key_cap: Card = {
  id: 'multi_key_cap',
  configs: ALL,
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('multi_key_cap');
    const shopAddr = labelAddress('hypnexis.attack.ColludingShop');
    const keys = isAgent(ctx.config) ? [w.keys.agent2, w.keys.agent3] : [];
    const { wallet, tools } = await setup(ctx, { extraRecipients: [shopAddr], extraAgentKeys: keys });
    const legit = await legitFirst(ctx, tools);
    await warp(w, p.warpBefore as number);
    const before = await usdcOf(w, shopAddr);
    const payment = BigInt(p.payment as string);
    const tries = p.triesPerKey as number;
    const signers = [wallet.agentKey, ...keys];
    for (const key of signers) {
      const asKey = { ...wallet, agentKey: key, agentAddress: privateKeyToAccount(key).address };
      for (let i = 0; i < tries; i++) await fire(w, asKey, new AgentTools({ world: w, wallet: asKey, attestorUrl: '' }), w.usdc, 0n, erc20enc.transfer(shopAddr, payment), forced);
    }
    const attackOutflow = (await usdcOf(w, shopAddr)) - before;
    return result(ctx, 'multi_key_cap', 'USDC', attackOutflow, resolveBound(w, p.bound), legit, `attackOutflow over ${signers.length} key(s)`);
  },
};

// ------------------------------------------------------------------ Sybil payees (forged attestations, then a spray)

export const sybil_payee: Card = {
  id: 'sybil_payee',
  configs: ALL,
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('sybil_payee');
    const { wallet, tools } = await setup(ctx);
    const legit = await legitFirst(ctx, tools);
    const addrs = Array.from({ length: 5 + (p.spray as number) }, (_, i) => sybilAddress(i));
    const before = await totalToAttackers(w, addrs);
    await warp(w, p.warpBefore as number);
    const amount = BigInt(p.forgedAmount as string);
    // the owner rotates the attestation epoch so the "old_epoch" forgery is genuinely stale (R4 only)
    if (ctx.config === 'R4') await send(w, w.keys.owner, wallet.address, w.accountAbi, 'bumpEpoch', []);
    const now = Number(BigInt((await w.c.pub.getBlock()).timestamp));
    const epoch = ctx.config === 'R4' ? ((await w.c.pub.readContract({ address: wallet.address, abi: w.accountAbi, functionName: 'attestEpoch' })) as bigint) : 0n;
    const otherWallet = getAddress('0x00000000000000000000000000000000000c0ffe');
    const forgeries: Record<string, { key: Hex; chainId: number; wallet: Address; validUntil: number; epoch: bigint }> = {
      attacker_signed: { key: w.keys.attackerAttestor, chainId: w.chainId, wallet: wallet.address, validUntil: now + 3600, epoch },
      expired: { key: w.keys.attestor, chainId: w.chainId, wallet: wallet.address, validUntil: now - 10, epoch },
      cross_wallet: { key: w.keys.attestor, chainId: w.chainId, wallet: otherWallet, validUntil: now + 3600, epoch },
      wrong_chain: { key: w.keys.attestor, chainId: w.chainId + 1, wallet: wallet.address, validUntil: now + 3600, epoch },
      old_epoch: { key: w.keys.attestor, chainId: w.chainId, wallet: wallet.address, validUntil: now + 3600, epoch: epoch > 0n ? epoch - 1n : 0n },
    };
    let i = 0;
    for (const name of p.forged as string[]) {
      const f = forgeries[name]!;
      const payee = sybilAddress(i++);
      const att = await signAttestation({ attestorKey: f.key, chainId: f.chainId, wallet: f.wallet, payee, validUntil: f.validUntil, epoch: f.epoch });
      await fire(w, wallet, tools, w.usdc, 0n, erc20enc.transfer(payee, amount), { ...forced, attestation: att.attestation });
    }
    for (let s = 0; s < (p.spray as number); s++) {
      await fire(w, wallet, tools, w.usdc, 0n, erc20enc.transfer(sybilAddress(i++), BigInt(p.sprayAmount as string)), forced);
    }
    return result(ctx, 'sybil_payee', 'USDC', (await totalToAttackers(w, addrs)) - before, resolveBound(w, p.bound), legit);
  },
};

// ------------------------------------------------------------------ compromised attestor (R4)

export const attestor_compromise: Card = {
  id: 'attestor_compromise',
  configs: ['R4'],
  ready: true,
  async run(ctx) {
    const w = ctx.world;
    const p = params('attestor_compromise');
    const { wallet, tools } = await setup(ctx);
    const legit = await legitFirst(ctx, tools);
    await warp(w, p.warpBefore as number);
    const proven = labelAddress('hypnexis.attack.ProvenPayee');
    const before = await usdcOf(w, proven);
    const epoch = (await w.c.pub.readContract({ address: wallet.address, abi: w.accountAbi, functionName: 'attestEpoch' })) as bigint;
    const now = Number(BigInt((await w.c.pub.getBlock()).timestamp));
    const att = await signAttestation({ attestorKey: w.keys.attestor, chainId: w.chainId, wallet: wallet.address, payee: proven, validUntil: now + 20 * 3600, epoch });
    for (let i = 0; i < (p.tries as number); i++) {
      await fire(w, wallet, tools, w.usdc, 0n, erc20enc.transfer(proven, BigInt(p.payment as string)), { ...forced, attestation: att.attestation });
    }
    return result(ctx, 'attestor_compromise', 'USDC', (await usdcOf(w, proven)) - before, resolveBound(w, p.bound), legit);
  },
};

void erc20Abi;
void deployWallet;
void devchain;
void emptyLegit;
