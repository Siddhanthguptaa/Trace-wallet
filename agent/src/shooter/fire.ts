/**
 * "Fire a call under a wallet config" — the primitive every raw-key card uses. The leaked agent
 * key drives all four configs:
 *   R1 (eoa)   : a direct transaction from the agent EOA (no policy).
 *   R2 (naive) : EntryPoint handleOps of NaiveAccount.executeAgent(target, value, data), raw sig.
 *   R3/R4 (agent): the agent tools pipeline (check -> attest -> submit).
 * Returns whether value moved (executed and not undone), plus the raw submit result for diagnosis.
 */
import { type Address, type Hex, encodeFunctionData } from 'viem';
import type { Wallet, World } from '../world/deploy.ts';
import type { AgentTools } from '../tools/engine.ts';
import { agentCallData } from '../ops/encode.ts';
import { buildOp, defaultGas, executed, getNonce, sign65, submit, type OpGas, type SubmitResult } from '../ops/submitter.ts';

export interface FireResult {
  moved: boolean;
  validated: boolean;
  success: boolean;
  policyBlocked: boolean;
  res?: SubmitResult;
}

const naiveAbi = [
  { type: 'function', name: 'executeAgent', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
] as const;

export interface FireOptions {
  gas?: OpGas;
  /** Attacker runs the bundler (gas-burn card): handleOps beneficiary = the attacker. */
  beneficiary?: Address;
  /** Skip the tools' pre-check and fire the agent op anyway (to measure what reaches execution). */
  forceAgent?: boolean;
  /** ScoreAttestation bytes to pack into the signature slot (a compromised attestor's forgery). */
  attestation?: Hex;
}

export async function fire(w: World, wallet: Wallet, tools: AgentTools, target: Address, value: bigint, data: Hex, o: FireOptions = {}): Promise<FireResult> {
  if (wallet.kind === 'eoa') {
    try {
      const hash = await w.c.wallet(wallet.agentKey).sendTransaction({ to: target, data, value, gas: 5_000_000n });
      const r = await w.c.pub.waitForTransactionReceipt({ hash });
      return { moved: r.status === 'success', validated: true, success: r.status === 'success', policyBlocked: false };
    } catch {
      return { moved: false, validated: false, success: false, policyBlocked: false };
    }
  }
  if (wallet.kind === 'naive') {
    const callData = encodeFunctionData({ abi: naiveAbi, functionName: 'executeAgent', args: [target, value, data] });
    const nonce = await getNonce(w, wallet.address, 0n);
    const op = buildOp(wallet.address, nonce, callData, o.gas ?? defaultGas(w));
    op.signature = await sign65(wallet.agentKey, (await import('../ops/submitter.ts')).opHash(w, op));
    const res = await submit(w, [op], o.beneficiary ?? w.addrOf.relayer);
    return { moved: executed(res), validated: res.validated, success: res.success, policyBlocked: res.policyBlocked, res };
  }
  // agent (R3/R4): go through the tools unless forced
  if (!o.forceAgent) {
    const pr = await tools.execute(target, value, data);
    const moved = pr.status === 'executed';
    return { moved, validated: pr.status !== 'refused' || !!pr.userOpHash, success: moved, policyBlocked: pr.status === 'refused' && pr.reason === 'policy_blocked' };
  }
  const nonceKey = (await w.c.pub.readContract({ address: wallet.address, abi: w.accountAbi, functionName: 'nonceKeyOf', args: [wallet.agentAddress, 0] })) as bigint;
  const nonce = await getNonce(w, wallet.address, nonceKey);
  const op = buildOp(wallet.address, nonce, agentCallData(target, value, data), o.gas ?? defaultGas(w));
  op.signature = (await import('../ops/encode.ts')).agentSignature(await sign65(wallet.agentKey, (await import('../ops/submitter.ts')).opHash(w, op)), o.attestation ?? '0x');
  const res = await submit(w, [op], o.beneficiary ?? w.addrOf.relayer);
  return { moved: executed(res), validated: res.validated, success: res.success, policyBlocked: res.policyBlocked, res };
}
