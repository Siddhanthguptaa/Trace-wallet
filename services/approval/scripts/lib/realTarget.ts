/**
 * E2ETarget for the REAL AgentAccount (INT). E2E_TARGET_MODULE=<this file> makes scripts/e2e.ts run
 * the approval flows (approved, tampered price +1, replay, PAYEE transfer, foreign key) against the
 * forge artifacts in contracts/out: libraries linked (ApprovalLib included), EntryPoint v0.8, a live
 * agent session with the order(qty) and PAYEE-transfer rules, and the owner-granted standing allowance
 * that the shop pulls from. Token and shop are the test-only StubToken / StubShop.
 */
import type { Abi, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Deployer, createAccount, deployStack } from '../../../../scripts/lib/stack.ts';
import { RULE_OP, TARGET_ARG, TRANSFER, policyInput, sel } from '../../../../scripts/lib/policy.ts';
import { STUB_SOURCE, compile, findSolc, type DevChain } from './devchain.ts';
import { PAYEE, shopAbi, tokenAbi, type E2EKeys, type E2ETarget, type E2EWorld } from './stubTarget.ts';
import { encodeFunctionData } from 'viem';

void TARGET_ARG;

const target: E2ETarget = {
  name: 'AgentAccount (contracts/out, libraries linked) + EntryPoint v0.8 + StubToken / StubShop',
  realAccount: true,
  async setup(chain: DevChain, keys: E2EKeys): Promise<E2EWorld> {
    const solc = findSolc();
    if (!solc) throw new Error('solc 0.8.28 is required for the StubToken / StubShop (SOLC)');
    const arts = compile(solc, [STUB_SOURCE]);
    const tokenArt = arts.StubToken!;
    const shopArt = arts.StubShop!;
    const owner = privateKeyToAccount(keys.owner).address;
    const agent = privateKeyToAccount(keys.agent).address;

    const d = new Deployer(chain, keys.owner);
    const stack = await deployStack(d);
    const token = await d.deploy({ name: 'StubToken', abi: tokenArt.abi as Abi, bytecode: tokenArt.bytecode, linkReferences: {} });
    const price = 3_000_000n;
    const shop = await d.deploy({ name: 'StubShop', abi: shopArt.abi as Abi, bytecode: shopArt.bytecode, linkReferences: {} }, [token, price], keys.shop);
    const account = await createAccount(d, stack, owner, 0n);
    const A = stack.abi.account;
    const now = Number((await d.pub.getBlock()).timestamp);

    await d.send(token, tokenAbi as Abi, 'mint', [account, 50_000_000n]);
    await d.send(account, A, 'addDeposit', [], keys.owner, 10n ** 18n);
    await d.send(account, A, 'setGlobalCap', [token, 10_000_000n, 10_000_000n]);
    await d.send(account, A, 'setTrackedSpenders', [[shop]]);
    await d.send(
      account,
      A,
      'setPolicy',
      [
        agent,
        policyInput({
          validAfter: now - 1,
          validUntil: now + 6 * 86400,
          assets: [{ asset: token, perTxCap: 10_000_000n, burst: 10_000_000n, ratePerDay: 10_000_000n }],
          calls: [
            { target: shop, selector: sel('order(uint256)') },
            { target: token, selector: TRANSFER, rules: [{ argIndex: 0, op: RULE_OP.PAYEE }] },
          ],
        }),
      ],
    );
    // owner-granted standing allowance the shop pulls from (approve-then-pull)
    await d.send(account, A, 'execute', [token, 0n, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [shop, 20_000_000n] })]);
    void (shopAbi as unknown as Hex);
    return {
      account,
      entryPoint: stack.entryPoint,
      token,
      shop,
      price,
      payee: PAYEE,
      async setPrice(p: bigint) {
        await d.send(shop, shopAbi as Abi, 'setPrice', [p], keys.shop);
      },
    };
  },
};

export default target;
export type { Address };
