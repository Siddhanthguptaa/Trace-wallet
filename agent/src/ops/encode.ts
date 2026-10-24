/**
 * Pure encoders for agent ops (docs/api.md section 4). No I/O: unit-tested in test/encode.test.ts.
 */
import {
  type Address,
  type Hex,
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hashTypedData,
  size,
  slice,
} from 'viem';
import { SEL } from '../world/policy.ts';

export const OP_KIND = { CALL: 0, REGISTER_VOUCHER: 1 } as const;
export const ROLE = { OWNER: 0, AGENT: 1 } as const;
export const LANE = { NORMAL: 0, APPROVAL: 1 } as const;
export const MODE_X402 = 1;

const OP_BODY = [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] as const;
const SIG_ENVELOPE = [{ type: 'uint8' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }] as const;

/** userOp.callData = executeUserOp selector ++ abi.encode(kind, target, value, data) (4.1). */
export function agentCallData(target: Address, value: bigint, data: Hex, kind: number = OP_KIND.CALL): Hex {
  return concat([SEL.executeUserOp, encodeAbiParameters(OP_BODY, [kind, target, value, data])]);
}

export function decodeAgentCallData(callData: Hex): { kind: number; target: Address; value: bigint; data: Hex } {
  if (size(callData) < 4 || slice(callData, 0, 4).toLowerCase() !== SEL.executeUserOp) throw new Error('not an executeUserOp agent op');
  const [kind, target, value, data] = decodeAbiParameters(OP_BODY, slice(callData, 4));
  return { kind, target: getAddress(target), value, data };
}

/** userOp.signature for the agent role (4.2). */
export function agentSignature(sig: Hex, attestation: Hex = '0x', approval: Hex = '0x'): Hex {
  return encodeAbiParameters(SIG_ENVELOPE, [ROLE.AGENT, sig, attestation, approval]);
}

export function decodeSignatureEnvelope(sig: Hex): { role: number; sig: Hex; attestation: Hex; approval: Hex } {
  const [role, s, attestation, approval] = decodeAbiParameters(SIG_ENVELOPE, sig);
  return { role, sig: s, attestation, approval };
}

/** EntryPoint 2D nonce: (nonceKey << 64) | sequence (4.5). */
export function packNonce(nonceKey: bigint, seq: bigint): bigint {
  return (nonceKey << 64n) | seq;
}

/** REGISTER_VOUCHER body (4.1 proposal; D1 confirms): target = token, value = 0. */
export function voucherBody(to: Address, value: bigint, validAfter: bigint, validBefore: bigint, nonce: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    [to, value, validAfter, validBefore, nonce],
  );
}

/** x402 one-door envelope for isValidSignature (4.6; D1 confirms). */
export function x402Envelope(to: Address, value: bigint, validAfter: bigint, validBefore: bigint, nonce: Hex, agentSig: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes' }],
    [MODE_X402, to, value, validAfter, validBefore, nonce, agentSig],
  );
}

export interface Authorization3009 {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** USDC EIP-3009 typed data, domain {"USD Coin", "2", chainId, token} (5). */
export function auth3009TypedData(chainId: number, token: Address, a: Authorization3009) {
  return {
    domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: token },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: a,
  };
}

export function auth3009Digest(chainId: number, token: Address, a: Authorization3009): Hex {
  return hashTypedData(auth3009TypedData(chainId, token, a));
}

export const erc20 = {
  transfer: (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  approve: (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  transferFrom: (from: Address, to: Address, amount: bigint) =>
    encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [from, to, amount] }),
};

export const shopAbi = [
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ name: 'ticketId', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'order', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;
export const greedyAbi = [{ type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [], outputs: [] }] as const;

export const shop = {
  buyTicket: (id: bigint, recipient: Address) => encodeFunctionData({ abi: shopAbi, functionName: 'buy', args: [id, recipient] }),
  order: (amount: bigint, recipient: Address) => encodeFunctionData({ abi: shopAbi, functionName: 'order', args: [amount, recipient] }),
  setApprovalForAll: (op: Address, ok: boolean) => encodeFunctionData({ abi: shopAbi, functionName: 'setApprovalForAll', args: [op, ok] }),
  greedyBuy: () => encodeFunctionData({ abi: greedyAbi, functionName: 'buy', args: [] }),
};

/**
 * The payee and declared amount of a call, as the account decodes it (2.4 AgentCall): ERC-20
 * transfer on an enabled asset -> (to, amount); plain value send -> (target, value); else none.
 */
export function decodePayee(target: Address, value: bigint, data: Hex, assets: Address[]): { payee: Address; asset: Address; amount: bigint } | null {
  const isAsset = assets.some((a) => a.toLowerCase() === target.toLowerCase());
  if (isAsset && size(data) >= 68 && slice(data, 0, 4).toLowerCase() === SEL.transfer) {
    const [to, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], slice(data, 4));
    return { payee: getAddress(to), asset: getAddress(target), amount };
  }
  if (size(data) === 0 && value > 0n) return { payee: getAddress(target), asset: '0x0000000000000000000000000000000000000000', amount: value };
  return null;
}

/** Declared outflow of a call (what the tools can say before the meter measures it). */
export function declaredOutflow(target: Address, value: bigint, data: Hex, assets: Address[]): { asset: Address; amount: bigint }[] {
  const out: { asset: Address; amount: bigint }[] = [];
  const isAsset = assets.some((a) => a.toLowerCase() === target.toLowerCase());
  if (value > 0n) out.push({ asset: '0x0000000000000000000000000000000000000000', amount: value });
  if (isAsset && size(data) >= 68) {
    const sel = slice(data, 0, 4).toLowerCase();
    if (sel === SEL.transfer || sel === SEL.approve) {
      const [, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], slice(data, 4));
      out.push({ asset: getAddress(target), amount });
    }
  }
  return out;
}
