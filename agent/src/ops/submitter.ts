/**
 * UserOp build / sign / submit for the harness: direct `EntryPoint.handleOps` from the relayer key
 * (no bundler; BUILD.md Layout "Submitter"). Validation failures surface as a reverted estimate
 * (FailedOp) and nothing is mined, like Foundry's `try ep.handleOps`.
 */
import {
  type Abi,
  type Address,
  type Hex,
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  BaseError,
  ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { type PackedUserOperation, getUserOpHashV08, packUint128Pair } from '@hypnexis/shared';
import type { World } from '../world/deploy.ts';
import { agentSignature } from './encode.ts';

export interface OpGas {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export function defaultGas(w: World): OpGas {
  const g = w.policy.opGas;
  return {
    verificationGasLimit: BigInt(g.verificationGasLimit),
    callGasLimit: BigInt(g.callGasLimit),
    preVerificationGas: BigInt(g.preVerificationGas),
    maxFeePerGas: g.maxFeePerGas,
    maxPriorityFeePerGas: g.maxPriorityFeePerGas,
  };
}

export function buildOp(sender: Address, nonce: bigint, callData: Hex, gas: OpGas, paymasterAndData: Hex = '0x'): PackedUserOperation {
  return {
    sender,
    nonce,
    initCode: '0x',
    callData,
    accountGasLimits: packUint128Pair(gas.verificationGasLimit, gas.callGasLimit),
    preVerificationGas: gas.preVerificationGas,
    gasFees: packUint128Pair(gas.maxPriorityFeePerGas, gas.maxFeePerGas),
    paymasterAndData,
    signature: '0x',
  };
}

export function opHash(w: World, op: PackedUserOperation, chainId: number = w.chainId, ep: Address = w.ep): Hex {
  return getUserOpHashV08(op, ep, chainId);
}

/** Raw 65-byte ECDSA (r ++ s ++ v) over a digest, no EIP-191 prefix (4.2). */
export async function sign65(pk: Hex, digest: Hex): Promise<Hex> {
  return sign({ hash: digest, privateKey: pk, to: 'hex' });
}

export async function signOwner(w: World, op: PackedUserOperation, pk: Hex = w.keys.owner, hashChainId?: number, hashEp?: Address): Promise<PackedUserOperation> {
  return { ...op, signature: await sign65(pk, opHash(w, op, hashChainId, hashEp)) };
}

export async function signAgent(w: World, op: PackedUserOperation, pk: Hex, attestation: Hex = '0x', approval: Hex = '0x'): Promise<PackedUserOperation> {
  return { ...op, signature: agentSignature(await sign65(pk, opHash(w, op)), attestation, approval) };
}

export interface SubmitResult {
  /** Passed validation (handleOps did not revert). */
  validated: boolean;
  /** UserOperationEvent.success (false = the target reverted, or a non-sandboxed wallet reverted). */
  success: boolean;
  policyBlocked: boolean;
  frozen: boolean;
  txHash?: Hex;
  actualGasCost?: bigint;
  failedOp?: string;
  blockReason?: Hex;
  logs: { address: Address; eventName: string; args: Record<string, unknown> }[];
}

export async function getNonce(w: World, sender: Address, key: bigint): Promise<bigint> {
  return w.c.pub.readContract({ address: w.ep, abi: w.arts.EntryPoint.abi, functionName: 'getNonce', args: [sender, key] }) as Promise<bigint>;
}

function decodeFailedOp(w: World, e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data) return `${rev.data.errorName}(${(rev.data.args ?? []).map(String).join(', ')})`;
    const raw = (e.walk((x) => typeof (x as { data?: unknown }).data === 'string') as { data?: Hex } | null)?.data;
    if (raw) {
      try {
        const d = decodeErrorResult({ abi: w.arts.EntryPoint.abi, data: raw });
        return `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
      } catch {
        return raw;
      }
    }
    return e.shortMessage;
  }
  return String(e);
}

/** handleOps([ops], beneficiary) from the relayer. Never throws on a refusal. */
export async function submit(w: World, ops: PackedUserOperation[], beneficiary: Address = w.addrOf.relayer, relayerPk: Hex = w.keys.relayer): Promise<SubmitResult> {
  const data = encodeFunctionData({ abi: w.arts.EntryPoint.abi, functionName: 'handleOps', args: [ops, beneficiary] });
  const from = privateKeyToAccount(relayerPk).address;
  let gas: bigint;
  try {
    gas = await w.c.pub.estimateGas({ account: from, to: w.ep, data });
  } catch (e) {
    return { validated: false, success: false, policyBlocked: false, frozen: false, failedOp: decodeFailedOp(w, e), logs: [] };
  }
  const hash = await w.c.wallet(relayerPk).sendTransaction({ to: w.ep, data, gas: (gas * 3n) / 2n + 100_000n });
  const r = await w.c.pub.waitForTransactionReceipt({ hash });
  const out: SubmitResult = { validated: r.status === 'success', success: false, policyBlocked: false, frozen: false, txHash: hash, logs: [] };
  if (r.status !== 'success') return { ...out, failedOp: 'handleOps reverted on-chain' };
  for (const log of r.logs) {
    const abi: Abi = log.address.toLowerCase() === w.ep.toLowerCase() ? w.arts.EntryPoint.abi : w.accountAbi;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
      out.logs.push({ address: log.address, eventName: ev.eventName, args: ev.args });
      if (ev.eventName === 'UserOperationEvent') {
        out.success = ev.args.success as boolean;
        out.actualGasCost = ev.args.actualGasCost as bigint;
      }
      if (ev.eventName === 'PolicyBlocked') {
        out.policyBlocked = true;
        out.blockReason = ev.args.reason as Hex;
      }
      if (ev.eventName === 'AgentFrozen') out.frozen = true;
    } catch {
      /* foreign event (token Transfer etc.) */
    }
  }
  return out;
}

/** True if the op both executed and was not undone by the sandbox. */
export function executed(r: SubmitResult): boolean {
  return r.validated && r.success && !r.policyBlocked;
}
