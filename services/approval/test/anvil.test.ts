/**
 * Contract-backed checks on anvil (skipped with a note if anvil / solc 0.8.28 are missing):
 *  - checked-in simulator runtime == fresh compile of contracts/ApprovalSimulator.sol
 *  - every EIP-712 vector digest == contracts/src/lib/TypedData.sol (via the stub's pure helper)
 *  - eth_call + state-override simulation measures transfer, allowance pull, approve growth, native
 *  - in-process service + DirectSubmitter: approved op executes; maxOutflow one unit short is blocked
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Abi, type Address, type Hex, encodeFunctionData, getAddress } from 'viem';
import {
  DirectSubmitter,
  approvalFromJson,
  decodeAgentOp,
  encodeAgentOp,
  nextApprovalNonce,
  outcomeApprovalTypedData,
  signAgentOp,
} from '../../../packages/shared/src/approval/index.ts';
import { ViemApprovalChain } from '../src/chain.ts';
import { loadApprovalConfig } from '../src/config.ts';
import { ApprovalService } from '../src/service.ts';
import { SIMULATOR_RUNTIME } from '../src/simulatorArtifact.ts';
import { outflowsFromRaw } from '../src/simulate.ts';
import { Store } from '../src/store.ts';
import { DEV_KEYS, type DevChain, SIMULATOR_SOURCE, SVC_ROOT, clients, compile, findAnvil, findSolc, startAnvil } from '../scripts/lib/devchain.ts';
import { type E2EWorld, type StubArtifacts, compileStubWorld, shopAbi, stubTarget, tokenAbi } from '../scripts/lib/stubTarget.ts';
import { privateKeyToAccount } from 'viem/accounts';

const anvilBin = findAnvil();
const solc = findSolc();
const ready = !!anvilBin && !!solc;
if (!ready) console.warn('[approval] anvil or solc 0.8.28 missing: anvil tests skipped');

describe.skipIf(!ready)('approval on anvil (stub account + EntryPoint v0.8)', () => {
  let chain: DevChain;
  let art: StubArtifacts;
  let w: E2EWorld;
  let vc: ViemApprovalChain;
  const agent = privateKeyToAccount(DEV_KEYS.agent).address;

  beforeAll(async () => {
    art = compileStubWorld(solc!);
    chain = await startAnvil(anvilBin!);
    w = await stubTarget(art).setup(chain, { owner: DEV_KEYS.owner, agent: DEV_KEYS.agent, shop: DEV_KEYS.shop });
    vc = new ViemApprovalChain(chain.chainId, chain.rpcUrl);
  }, 120_000);
  afterAll(() => chain?.stop());

  const bal = (who: Address) => clients(chain, DEV_KEYS.owner).pub.readContract({ address: w.token, abi: tokenAbi, functionName: 'balanceOf', args: [who] });

  it('checked-in simulator runtime equals a fresh compile', () => {
    expect(compile(solc!, [SIMULATOR_SOURCE]).ApprovalSimulator!.runtime).toBe(SIMULATOR_RUNTIME);
  });

  it('every vector digest equals TypedData.sol on-chain', async () => {
    const v = JSON.parse(readFileSync(join(SVC_ROOT, 'vectors', 'outcome_approval.json'), 'utf8'));
    const { pub } = clients(chain, DEV_KEYS.owner);
    for (const c of v.cases) {
      const a = approvalFromJson(c.approval);
      const [ds, sh, dg] = (await pub.readContract({
        address: w.account,
        abi: art.account.abi as Abi,
        functionName: 'approvalDigestFor',
        args: [a.chainId, a.account, { ...a, maxOutflow: a.maxOutflow }],
      })) as [Hex, Hex, Hex];
      expect([ds, sh, dg], c.name).toEqual([c.domainSeparator, c.structHash, c.digest]);
    }
  });

  it('simulation measures pulls, transfers, approve growth and native value without changing state', async () => {
    const tracked = { tokens: [w.token], spenders: [w.shop], nfts: [] as Address[] };
    const q = (target: Address, data: Hex, value = 0n) => ({ target, value, data, entryPoint: w.entryPoint, ...tracked });
    const before = await bal(w.account);
    const order = q(w.shop, encodeFunctionData({ abi: shopAbi, functionName: 'order', args: [2n] }));
    expect(outflowsFromRaw(await vc.simulate(w.account, order), order)).toEqual([{ asset: w.token, amount: 6_000_000n }]);
    const tr = q(w.token, encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [w.payee, 500_000n] }));
    expect(outflowsFromRaw(await vc.simulate(w.account, tr), tr)).toEqual([{ asset: w.token, amount: 500_000n }]);
    const ap = q(w.token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [w.shop, 20_000_007n] }));
    expect(outflowsFromRaw(await vc.simulate(w.account, ap), ap)).toEqual([{ asset: w.token, amount: 7n }]);
    const nat = q(w.payee, '0x', 12345n);
    expect(outflowsFromRaw(await vc.simulate(w.account, nat), nat)).toEqual([{ asset: '0x0000000000000000000000000000000000000000', amount: 12345n }]);
    const bad = q(w.token, encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [w.payee, 10n ** 12n] }));
    expect((await vc.simulate(w.account, bad)).ok).toBe(false);
    expect(await bal(w.account)).toBe(before);
  });

  it('service flow: approved op executes exactly maxOutflow; one unit short is blocked (PolicyBlocked, nothing moved)', async () => {
    const cfg = loadApprovalConfig({ CHAIN_ID: String(chain.chainId), RPC_URL: chain.rpcUrl, ENTRYPOINT: w.entryPoint });
    const sub = new DirectSubmitter({ rpcUrl: chain.rpcUrl, chainId: chain.chainId, entryPoint: w.entryPoint, relayerKey: DEV_KEYS.relayer });
    const svc = new ApprovalService({ cfg, store: new Store(), chain: vc, submitter: sub });
    const { pub } = clients(chain, DEV_KEYS.owner);
    const owner = privateKeyToAccount(DEV_KEYS.owner);
    const file = async () => {
      const nonce = await nextApprovalNonce(pub as never, w.account, agent, w.entryPoint);
      const s = await signAgentOp({ account: w.account, entryPoint: w.entryPoint, chainId: chain.chainId, agentKey: DEV_KEYS.agent, nonce, call: { target: w.shop, data: encodeFunctionData({ abi: shopAbi, functionName: 'order', args: [1n] }) } });
      return (await svc.create({ account: w.account, chainId: chain.chainId, userOp: s.userOp })) as { id: string };
    };
    const sign = async (id: string) => {
      const td = (await svc.typedData(id)) as { message: never };
      return owner.signTypedData(outcomeApprovalTypedData(approvalFromJson(td.message)));
    };

    const shopBefore = await bal(w.shop);
    const r1 = await file();
    const s1 = await svc.submitSignature(r1.id, { signature: await sign(r1.id) }, true);
    expect(s1).toMatchObject({ status: 'executed', success: true, blocked: false });
    expect(await bal(w.shop)).toBe(shopBefore + w.price);
    expect((s1.maxOutflow as { amount: string }[])[0]!.amount).toBe(w.price.toString());

    const r2 = await file();
    const sig2 = await sign(r2.id);
    await w.setPrice(w.price + 1n);
    const s2 = await svc.submitSignature(r2.id, { signature: sig2 }, true);
    expect(s2).toMatchObject({ status: 'reverted', blocked: true });
    expect(String(s2.reason)).toContain('OutflowAboveApproval');
    expect(await bal(w.shop)).toBe(shopBefore + w.price);
    await w.setPrice(w.price);
    expect(decodeAgentOp(encodeAgentOp({ target: w.shop })).target).toBe(getAddress(w.shop));
  }, 60_000);
});
