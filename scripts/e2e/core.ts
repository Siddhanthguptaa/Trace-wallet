/**
 * Account core end-to-end (problem statement Phase 1) on the REAL AgentAccount through the real
 * EntryPoint: the owner path, the in-policy agent path, the policy clauses (allowed contracts and
 * functions, recipient arguments, per-transaction limit, expiry, owner-only admin), signature /
 * nonce / chain-id validation, replay, revocation and the exploration track for unproven payees.
 *   pnpm exec tsx scripts/e2e/core.ts  ->  results/m1_core_e2e.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Hex, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEV, addr, warp } from '../lib/anvil.ts';
import { BUILD_ROOT } from '../lib/stack.ts';
import { agentOpCallData, policyInput, TIER, TRACK } from '../lib/policy.ts';
import { agentEnvelope, epNonce, nonceKeyOf, opHash, signAgentOp, signOwnerOp, submitOps, unsignedOp } from '../lib/ops.ts';
import { TICKET_PRICE, checker, demoCalls, erc20, makeWorld, shopCalls, sig65 } from '../lib/world.ts';

const executeAbi = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'dest', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'func', type: 'bytes' }], outputs: [] }] as const;
const batchAbi = [{ type: 'function', name: 'executeBatch', stateMutability: 'nonpayable', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], outputs: [] }] as const;

async function main(): Promise<void> {
  const w = await makeWorld();
  const { checks, add } = checker();
  const metrics: Record<string, string | number | boolean> = {};
  try {
    const relayer = addr('relayer');
    const attacker = addr('attacker');
    const shop = w.api; // owner-listed
    const sub = (op: Parameters<typeof submitOps>[2][number]) => submitOps(w.d, w.stack, [op], relayer, DEV.relayer);
    const state = (r: { validated: boolean; success: boolean; has: (n: string) => boolean }) =>
      !r.validated ? 'rejected' : r.has('PolicyBlocked') ? 'blocked' : r.success ? 'executed' : 'reverted';
    const agentOp = async (target: `0x${string}`, data: Hex, o: { value?: bigint; key?: Hex } = {}) => {
      const s = await signAgentOp(w.d, w.stack, w.chainId, { account: w.account, agentKey: o.key ?? DEV.agent, target, data, value: o.value });
      return { ...s, r: await sub(s.op) };
    };
    const lens = async (target: `0x${string}`, data: Hex) =>
      w.d.read<{ ok: boolean; reasonCode: number }>(w.stack.lens, w.stack.abi.lens, 'checkPolicy', [w.account, w.agent, agentOpCallData(target, 0n, data), '0x']);

    // ---- owner path
    const ownerCall = encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [w.usdc, 0n, erc20.transfer(shop, 1_000_000n)] });
    const o1 = await signOwnerOp(w.d, w.stack, w.chainId, { account: w.account, ownerKey: DEV.owner, callData: ownerCall });
    const ro = await sub(o1.op);
    add('owner-signed op (execute) through the EntryPoint executes', 'executed', state(ro));
    add('owner op: the payee received 1 USDC', '1000000', String(await w.usdcBalance(shop)));
    const ownerBatch = encodeFunctionData({ abi: batchAbi, functionName: 'executeBatch', args: [[{ target: w.usdc, value: 0n, data: erc20.transfer(shop, 1n) }]] });
    const ob = await signOwnerOp(w.d, w.stack, w.chainId, { account: w.account, ownerKey: DEV.owner, callData: ownerBatch });
    add('owner op: executeBatch is allowed for the owner', 'executed', state(await sub(ob.op)));
    const so = await signOwnerOp(w.d, w.stack, w.chainId, { account: w.account, ownerKey: DEV.attacker, callData: ownerCall });
    add('an owner-shaped op signed by a stranger is rejected', 'rejected', state(await sub(so.op)));

    // ---- in-policy agent
    const a1 = await agentOp(w.usdc, erc20.transfer(shop, 500_000n));
    add('agent: in-policy transfer to an owner-listed payee executes', 'executed', state(a1.r));
    const dec = a1.r.events.find((e) => e.eventName === 'Decision');
    add('agent: the Decision is PROVEN / NORMAL track', `${TIER.PROVEN}/${TRACK.NORMAL}`, `${dec?.args.tier}/${dec?.args.track}`);
    add('agent: approve the listed ticket shop for the price', 'executed', state((await agentOp(w.usdc, erc20.approve(w.ticket, TICKET_PRICE))).r));
    add('agent: buy a ticket for the account itself executes', 'executed', state((await agentOp(w.ticket, shopCalls.buy(1n, w.account))).r));

    // ---- policy clauses
    add('contracts and functions: a call outside the allowlist (ticket.transferFrom) is rejected', 'rejected', state((await agentOp(w.ticket, '0x23b872dd' + '0'.repeat(192) as Hex)).r));
    add('argument rule: buy(ticket, attacker) is rejected (recipient must be the account)', 'rejected', state((await agentOp(w.ticket, shopCalls.buy(2n, attacker))).r));
    add('argument rule: setApprovalForAll(attacker) is rejected', 'rejected', state((await agentOp(w.ticket, shopCalls.setApprovalForAll(attacker, true))).r));
    add('argument rule: approve(attacker, 1) is rejected (spender must be listed)', 'rejected', state((await agentOp(w.usdc, erc20.approve(attacker, 1n))).r));
    add('argument rule: approve(listed, MAX) is rejected (LTE per-tx cap)', 'rejected', state((await agentOp(w.usdc, erc20.approve(w.grocery, 2n ** 256n - 1n))).r));
    add('per-transaction limit: transfer 11 USDC (cap 10) is rejected', 'rejected', state((await agentOp(w.usdc, erc20.transfer(shop, 11_000_000n))).r));
    add('allowed recipients: 1 USDC to an unlisted payee is refused (over the exploration per-tx cap)', 'rejected', state((await agentOp(w.usdc, erc20.transfer(attacker, 1_000_000n))).r));
    const lensRes = await lens(w.usdc, erc20.transfer(attacker, 1_000_000n));
    metrics.lensReasonUnlisted1USDC = lensRes.reasonCode;
    const ex = await agentOp(w.usdc, erc20.transfer(attacker, 100_000n));
    const exDec = ex.r.events.find((e) => e.eventName === 'Decision');
    add('unproven payee: 0.1 USDC executes on the exploration track (UNPROVEN / EXPLORE)', `executed/${TIER.UNPROVEN}/${TRACK.EXPLORE}`, `${state(ex.r)}/${exDec?.args.tier}/${exDec?.args.track}`);
    add('admin from the agent path: a self-call to setRecipient is rejected', 'rejected', state((await agentOp(w.account, encodeFunctionData({ abi: w.A, functionName: 'setRecipient', args: [attacker, true] }))).r));
    add('admin from the agent path: execute(...) on the account is rejected', 'rejected', state((await agentOp(w.account, ownerCall)).r));
    add('admin from the agent path: EntryPoint.withdrawTo is rejected', 'rejected', state((await agentOp(w.stack.entryPoint, encodeFunctionData({ abi: w.stack.abi.entryPoint, functionName: 'withdrawTo', args: [attacker, 10n ** 18n] }))).r));
    const raw = unsignedOp(w.account, await epNonce(w.d, w.stack, w.account, await nonceKeyOf(w.d, w.stack, w.account, w.agent)), ownerBatch);
    raw.signature = agentEnvelope(await sig65(DEV.agent, opHash(raw, w.stack, w.chainId)));
    add('an agent-signed executeBatch (owner entry point) is rejected', 'rejected', state(await sub(raw)));
    const k2 = unsignedOp(w.account, await epNonce(w.d, w.stack, w.account, await nonceKeyOf(w.d, w.stack, w.account, w.agent)), agentOpCallData(w.usdc, 0n, erc20.transfer(shop, 1n), 2));
    k2.signature = agentEnvelope(await sig65(DEV.agent, opHash(k2, w.stack, w.chainId)));
    add('an unknown op kind (a delegatecall-style kind 2) is rejected', 'rejected', state(await sub(k2)));
    add('owner-only admin: a stranger cannot change the policy', false, await w.tryTx(DEV.attacker, 'setRecipient', [attacker, true]));
    add('owner-only admin: the agent key cannot change the policy', false, await w.tryTx(DEV.agent, 'setRecipient', [attacker, true]));

    // ---- signatures, nonces, chain id, replay
    const good = await signAgentOp(w.d, w.stack, w.chainId, { account: w.account, agentKey: DEV.agent, target: w.usdc, data: erc20.transfer(shop, 10_000n) });
    add('control: a fresh in-policy op executes', 'executed', state(await sub(good.op)));
    add('replay: the same op again (nonce used) is rejected', 'rejected', state(await sub(good.op)));
    const wc = unsignedOp(w.account, await epNonce(w.d, w.stack, w.account, await nonceKeyOf(w.d, w.stack, w.account, w.agent)), agentOpCallData(w.usdc, 0n, erc20.transfer(shop, 10_000n)));
    wc.signature = agentEnvelope(await sig65(DEV.agent, opHash(wc, w.stack, w.chainId + 1)));
    add('wrong chain id: an op signed for chain id + 1 is rejected', 'rejected', state(await sub(wc)));
    const sg = await signAgentOp(w.d, w.stack, w.chainId, { account: w.account, agentKey: DEV.attacker, target: w.usdc, data: erc20.transfer(shop, 10_000n) });
    add('an op signed by a key with no session is rejected', 'rejected', state(await sub(sg.op)));
    const bad = unsignedOp(w.account, 2n ** 64n, agentOpCallData(w.usdc, 0n, erc20.transfer(shop, 10_000n)));
    bad.signature = agentEnvelope(await sig65(DEV.agent, opHash(bad, w.stack, w.chainId)));
    add('a nonce key that does not belong to the session is rejected', 'rejected', state(await sub(bad)));

    // ---- expiry and revocation
    await w.own('revoke', [w.agent]);
    add('revocation: the revoked key is rejected', 'rejected', state((await agentOp(w.usdc, erc20.transfer(shop, 1n))).r));
    const k3 = privateKeyToAccount(DEV.agent2).address;
    await w.own('setPolicy', [
      k3,
      policyInput({
        validAfter: w.now - 1,
        validUntil: w.now + 3600,
        assets: [{ asset: w.usdc, perTxCap: 10_000_000n, burst: 10_000_000n, ratePerDay: 10_000_000n }],
        calls: demoCalls({ usdc: w.usdc, ticket: w.ticket, grocery: w.grocery }),
      }),
    ]);
    const before = await agentOp(w.usdc, erc20.transfer(shop, 1n), { key: DEV.agent2 });
    add('expiry: before validUntil the short-lived session executes', 'executed', state(before.r));
    await warp(w.anvil.rpcUrl, 7200);
    const after = await agentOp(w.usdc, erc20.transfer(shop, 1n), { key: DEV.agent2 });
    add('expiry: an op after validUntil is rejected (EntryPoint-enforced; no TIMESTAMP in validation)', 'rejected', state(after.r));

    const ok = checks.every((c) => c.pass);
    const out = { realAccount: true, chainId: w.chainId, ok, passed: checks.filter((c) => c.pass).length, total: checks.length, account: w.account, metrics, checks, generatedAt: new Date().toISOString() };
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', 'm1_core_e2e.json'), `${JSON.stringify(out, null, 2)}\n`);
    for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
    console.log(`core e2e (real account): ${out.passed}/${out.total} ${ok ? 'ok' : 'FAILED'} -> results/m1_core_e2e.json`);
    if (!ok) process.exitCode = 1;
  } finally {
    w.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
