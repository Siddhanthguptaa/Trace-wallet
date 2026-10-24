/**
 * E2ETarget for the REAL AgentAccount (INT). Set E2E_TARGET_MODULE to this file's path to run
 * scripts/e2e.ts against the forge artifacts in contracts/out (libraries linked, EntryPoint v0.8
 * deployed on the dev chain). The served wallet is an AgentAccount whose attestor is the service's
 * attestor key; "is this payee PROVEN under this attestation?" is answered by the account's own
 * policyCheck on a native value send by a live agent session (tier 1 = PROVEN).
 */
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Deployer, type Stack, createAccount, deployStack } from '../../../../scripts/lib/stack.ts';
import { NATIVE, TARGET_ARG, TIER, RULE_OP, agentOpCallData, policyInput } from '../../../../scripts/lib/policy.ts';
import { DEV_KEYS, type DevChain } from './devchain.ts';
import type { E2ETarget } from '../e2e.ts';

const stacks = new Map<string, { d: Deployer; stack: Stack; agent: Address }>();

const target: E2ETarget = {
  name: 'AgentAccount (contracts/out, libraries linked) + EntryPoint v0.8',
  realAccount: true,
  async deployWallet(chain: DevChain, o: { ownerKey: Hex; attestor: Address }): Promise<Address> {
    const d = new Deployer(chain, o.ownerKey);
    const stack = await deployStack(d);
    const owner = privateKeyToAccount(o.ownerKey).address;
    const account = await createAccount(d, stack, owner, 0n);
    const A = stack.abi.account;
    const now = Number((await d.pub.getBlock()).timestamp);
    const agent = privateKeyToAccount(DEV_KEYS.agent).address;
    await d.send(account, A, 'setAttestor', [o.attestor]);
    // a native-value agent session: ANY_TARGET plain send with a PAYEE rule, so every payee is judged by its tier
    await d.send(account, A, 'setGlobalCap', [NATIVE, 10n ** 16n, 10n ** 16n]);
    await d.send(account, A, 'setPolicy', [
      agent,
      policyInput({
        validAfter: now - 1,
        validUntil: now + 6 * 86400,
        assets: [{ asset: NATIVE, perTxCap: 5n * 10n ** 15n, burst: 10n ** 16n, ratePerDay: 10n ** 16n }],
        calls: [{ target: NATIVE, selector: '0x00000000', rules: [{ argIndex: TARGET_ARG, op: RULE_OP.PAYEE }] }],
      }),
    ]);
    stacks.set(account.toLowerCase(), { d, stack, agent });
    return account;
  },
  async checkProven(_chain: DevChain, wallet: Address, payee: Address, attestation: Hex): Promise<boolean> {
    const s = stacks.get(wallet.toLowerCase());
    if (!s) throw new Error('unknown wallet');
    const callData = agentOpCallData(payee, 1n, '0x');
    const [reason, tier] = await s.d.read<[number, number, number, number]>(wallet, s.stack.abi.account, 'policyCheck', [s.agent, callData, attestation, '0x']);
    return Number(reason) === 0 && Number(tier) === TIER.PROVEN;
  },
};

export default target;
