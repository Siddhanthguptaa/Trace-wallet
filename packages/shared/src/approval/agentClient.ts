/**
 * Agent side of an approval request (for the tools layer, M7 `/request_approval`, and the M5 e2e):
 * build a lane-1 agent op, sign its v0.8 userOpHash with the agent key, and leave the approval slot
 * empty for the owner. The agent key never sees the owner key. Lane APPS (M5).
 */
import { type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type PackedUserOperation, getUserOpHashV08, packUint128Pair } from '../userop.ts';
import { approvalAccountAbi, entryPointHandleOpsAbi } from './abi.ts';
import { LANE, encodeAgentOp, encodeSignatureEnvelope } from './agentOp.ts';

export interface AgentOpGas {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Fits the demo fixture caps (docs/api.md 11: 500k call, 300k verification, 100k pre-verification). */
export const DEFAULT_AGENT_GAS: AgentOpGas = {
  callGasLimit: 400_000n,
  verificationGasLimit: 280_000n,
  preVerificationGas: 60_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

export interface SignedAgentOp {
  userOp: PackedUserOperation;
  userOpHash: Hex;
  agent: Address;
}

export async function signAgentOp(o: {
  account: Address;
  entryPoint: Address;
  chainId: number;
  agentKey: Hex;
  nonce: bigint;
  call: { target: Address; value?: bigint; data?: Hex; kind?: number };
  gas?: AgentOpGas;
  attestation?: Hex;
  /** approval slot; empty when filing a request with the approval service. */
  approval?: Hex;
}): Promise<SignedAgentOp> {
  const g = o.gas ?? DEFAULT_AGENT_GAS;
  const agent = privateKeyToAccount(o.agentKey);
  const unsigned: PackedUserOperation = {
    sender: o.account,
    nonce: o.nonce,
    initCode: '0x',
    callData: encodeAgentOp(o.call),
    accountGasLimits: packUint128Pair(g.verificationGasLimit, g.callGasLimit),
    preVerificationGas: g.preVerificationGas,
    gasFees: packUint128Pair(g.maxPriorityFeePerGas, g.maxFeePerGas),
    paymasterAndData: '0x',
    signature: '0x',
  };
  const userOpHash = getUserOpHashV08(unsigned, o.entryPoint, o.chainId);
  const sig = await agent.sign({ hash: userOpHash }); // raw ECDSA, no EIP-191 prefix (docs/api.md 4.2)
  return {
    userOp: { ...unsigned, signature: encodeSignatureEnvelope({ sig, attestation: o.attestation, approval: o.approval }) },
    userOpHash,
    agent: agent.address,
  };
}

/** The next lane-1 (approval) nonce of `agent` on `account`: nonceKeyOf(agent, 1) + EntryPoint.getNonce. */
export async function nextApprovalNonce(pub: PublicClient, account: Address, agent: Address, entryPoint: Address): Promise<bigint> {
  const key = (await pub.readContract({ address: account, abi: approvalAccountAbi, functionName: 'nonceKeyOf', args: [agent, LANE.APPROVAL] })) as bigint;
  if (key === 0n) throw new Error(`${agent} has no session on ${account}`);
  return (await pub.readContract({ address: entryPoint, abi: entryPointHandleOpsAbi, functionName: 'getNonce', args: [account, key] })) as bigint;
}
