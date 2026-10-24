/**
 * Owner-approval checks straight against the REAL AgentAccount (no approval service in the loop):
 * hand-built OutcomeApproval slots, signed by the owner (or not), submitted through the EntryPoint.
 * Complements scripts/e2e.ts (which goes through the HTTP service) with the adversarial cases the
 * service would normally filter: over-maxOutflow, wrong chain, wrong account, tampered calldata,
 * expired / zero validUntil, non-owner signer, replay, cancelled nonce, empty maxOutflow.
 *   pnpm --filter @hypnexis/approval exec tsx scripts/account-checks.ts   -> results/m5_approval_account_checks.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, encodeFunctionData, getAddress, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOpHashV08 } from '@hypnexis/shared';
import {
  DirectSubmitter,
  type OutcomeApproval,
  decodeSignatureEnvelope,
  encodeApprovalSlot,
  encodeSignatureEnvelope,
  nextApprovalNonce,
  outcomeApprovalTypedData,
  signAgentOp,
} from '../../../packages/shared/src/approval/index.ts';
import { Deployer, accountAbi as stackAccountAbi } from '../../../scripts/lib/stack.ts';
import { BUILD_ROOT, DEV_KEYS, clients, findAnvil, startAnvil } from './lib/devchain.ts';
import { shopAbi, tokenAbi } from './lib/stubTarget.ts';
import target from './lib/realTarget.ts';

interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}

const POLICY_BLOCKED = keccak256(toBytes('PolicyBlocked(bytes32,address,address,bytes4,bytes)'));

async function main(): Promise<void> {
  const anvil = findAnvil();
  if (!anvil) throw new Error('anvil is required');
  const chain = await startAnvil(anvil);
  const checks: Check[] = [];
  try {
    const w = await target.setup(chain, { owner: DEV_KEYS.owner, agent: DEV_KEYS.agent, shop: DEV_KEYS.shop });
    const { pub } = clients(chain, DEV_KEYS.owner);
    const owner = privateKeyToAccount(DEV_KEYS.owner);
    const agent = privateKeyToAccount(DEV_KEYS.agent).address;
    const sub = new DirectSubmitter({ rpcUrl: chain.rpcUrl, chainId: chain.chainId, entryPoint: w.entryPoint, relayerKey: DEV_KEYS.relayer });
    const bal = () => pub.readContract({ address: w.token, abi: tokenAbi, functionName: 'balanceOf', args: [w.account] }) as Promise<bigint>;
    const order = (q: bigint) => encodeFunctionData({ abi: shopAbi, functionName: 'order', args: [q] });
    const accountAbi = stackAccountAbi();
    const now = async () => Number((await pub.getBlock()).timestamp);

    const add = (name: string, expected: string, observed: string) => checks.push({ name, expected, observed, pass: expected === observed });

    /** Build an op for `data` and a matching approval; `mutate` edits the approval before the owner signs. */
    async function build(data: Hex, mutate: (a: OutcomeApproval) => OutcomeApproval = (a) => a, signer = owner) {
      const nonce = await nextApprovalNonce(pub as never, w.account, agent, w.entryPoint);
      const s = await signAgentOp({ account: w.account, entryPoint: w.entryPoint, chainId: chain.chainId, agentKey: DEV_KEYS.agent, nonce, call: { target: w.shop, data } });
      const base: OutcomeApproval = {
        account: w.account,
        chainId: BigInt(chain.chainId),
        nonce,
        target: w.shop,
        selector: data.slice(0, 10) as Hex,
        payee: '0x0000000000000000000000000000000000000000',
        maxOutflow: [{ asset: w.token, amount: w.price * ((BigInt(`0x${data.slice(10)}`)) || 1n) }],
        callDataHash: keccak256(s.userOp.callData),
        validUntil: (await now()) + 3600,
      };
      const a = mutate(base);
      const ownerSig = await signer.signTypedData(outcomeApprovalTypedData(a) as never);
      const agentSig = decodeSignatureEnvelope(s.userOp.signature).sig;
      const op = { ...s.userOp, signature: encodeSignatureEnvelope({ sig: agentSig, approval: encodeApprovalSlot(a, ownerSig) }) };
      return { op, hash: getUserOpHashV08(op, w.entryPoint, chain.chainId), approval: a };
    }
    const blocked = (r: { logs?: readonly { address: string; topics: readonly string[] }[] }) =>
      (r.logs ?? []).some((l) => l.address.toLowerCase() === w.account.toLowerCase() && l.topics[0] === POLICY_BLOCKED);

    // 1. control: a valid approval executes, moves exactly maxOutflow
    const b0 = await bal();
    const ok1 = await build(order(1n));
    const r1 = await sub.submit(ok1.op, ok1.hash);
    add('valid approval executes (control)', 'included/success/moved=3000000', `${r1.status}/${r1.status === 'included' && r1.success && !blocked(r1)}/moved=${b0 - (await bal())}`.replace('/true/', '/success/'));
    // 2. replay of the executed op
    const r2 = await sub.submit(ok1.op, ok1.hash);
    add('replay of the executed op is rejected', 'rejected', r2.status);

    // 3. over-maxOutflow: owner signed 1 base unit less than the shop pulls -> blocked in execution, nothing moves
    const b3 = await bal();
    const o3 = await build(order(1n), (a) => ({ ...a, maxOutflow: [{ asset: w.token, amount: w.price - 1n }] }));
    const r3 = await sub.submit(o3.op, o3.hash);
    add('outflow above maxOutflow (+1 unit) is blocked, nothing moves', 'included/blocked/moved=0', `${r3.status}/${blocked(r3) ? 'blocked' : 'not-blocked'}/moved=${b3 - (await bal())}`);
    // 4. empty maxOutflow (missing asset = 0)
    const b4 = await bal();
    const o4 = await build(order(1n), (a) => ({ ...a, maxOutflow: [] }));
    const r4 = await sub.submit(o4.op, o4.hash);
    add('empty maxOutflow (missing asset = 0) blocks any outflow', 'included/blocked/moved=0', `${r4.status}/${blocked(r4) ? 'blocked' : 'not-blocked'}/moved=${b4 - (await bal())}`);
    // 5. wrong chain (typed data signed for chainId + 1)
    const o5 = await build(order(1n), (a) => ({ ...a, chainId: a.chainId + 1n }));
    add('approval signed for another chain is rejected', 'rejected', (await sub.submit(o5.op, o5.hash)).status);
    // 6. wrong account
    const o6 = await build(order(1n), (a) => ({ ...a, account: getAddress('0x00000000000000000000000000000000000000AA') }));
    add('approval signed for another account is rejected', 'rejected', (await sub.submit(o6.op, o6.hash)).status);
    // 7. tampered calldata: approval hashes order(1), op carries order(2)
    const nonce7 = await nextApprovalNonce(pub as never, w.account, agent, w.entryPoint);
    const s7 = await signAgentOp({ account: w.account, entryPoint: w.entryPoint, chainId: chain.chainId, agentKey: DEV_KEYS.agent, nonce: nonce7, call: { target: w.shop, data: order(2n) } });
    const o7 = await build(order(1n));
    const op7 = { ...s7.userOp, signature: encodeSignatureEnvelope({ sig: decodeSignatureEnvelope(s7.userOp.signature).sig, approval: decodeSignatureEnvelope(o7.op.signature).approval }) };
    add('approval of order(1) on an op carrying order(2) is rejected', 'rejected', (await sub.submit(op7, getUserOpHashV08(op7, w.entryPoint, chain.chainId))).status);
    // 8. expired and zero validUntil
    const o8 = await build(order(1n), (a) => ({ ...a, validUntil: 1 }));
    add('expired approval (validUntil in the past) is rejected', 'rejected', (await sub.submit(o8.op, o8.hash)).status);
    const o9 = await build(order(1n), (a) => ({ ...a, validUntil: 0 }));
    add('validUntil = 0 ("no expiry") is rejected', 'rejected', (await sub.submit(o9.op, o9.hash)).status);
    // 10. signed by the agent key, not the owner
    const o10 = await build(order(1n), (a) => a, privateKeyToAccount(DEV_KEYS.agent));
    add('approval signed by the agent key is rejected', 'rejected', (await sub.submit(o10.op, o10.hash)).status);
    // 11. owner cancels the nonce, then the approval is used
    const o11 = await build(order(1n));
    await new Deployer(chain, DEV_KEYS.owner).send(w.account, accountAbi, 'cancelApproval', [o11.approval.nonce]);
    add('approval whose nonce the owner cancelled is rejected', 'rejected', (await sub.submit(o11.op, o11.hash)).status);
    // 12. a cancelled approval nonce stays cancelled even for a fresh op that reuses it ...
    const o12a = await build(order(1n));
    add('a fresh op reusing the cancelled approval nonce is rejected', 'rejected', (await sub.submit(o12a.op, o12a.hash)).status);
    // 13. ... while an approval with a new owner-chosen nonce still executes (nothing was bricked)
    const b13 = await bal();
    const o13 = await build(order(1n), (a) => ({ ...a, nonce: a.nonce + 1_000_000n }));
    const r13 = await sub.submit(o13.op, o13.hash);
    add('a fresh valid approval (new owner-chosen nonce) still executes', `included/moved=${w.price}`, `${r13.status}/moved=${b13 - (await bal())}`);
    void (BUILD_ROOT as unknown as Address);

    const ok = checks.every((c) => c.pass);
    const out = { target: target.name, realAccount: true, chainId: chain.chainId, ok, passed: checks.filter((c) => c.pass).length, total: checks.length, checks, generatedAt: new Date().toISOString() };
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', 'm5_approval_account_checks.json'), `${JSON.stringify(out, null, 2)}\n`);
    for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
    console.log(`approval account checks: ${out.passed}/${out.total} ${ok ? 'ok' : 'FAILED'} -> results/m5_approval_account_checks.json`);
    if (!ok) process.exitCode = 1;
  } finally {
    chain.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
