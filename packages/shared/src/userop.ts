import {
  concat,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  hexToBigInt,
  keccak256,
  numberToHex,
  pad,
  size,
  slice,
  toHex,
  type Address,
  type Hex,
} from 'viem';

/**
 * ERC-4337 EntryPoint v0.8 UserOperation helpers: pack/unpack and the v0.8 userOpHash, which is an
 * EIP-712 hash over the packed op with domain {name: "ERC4337", version: "1", chainId, entryPoint}.
 * Mirrors account-abstraction v0.8.0 UserOperationLib.encode + EntryPoint.getUserOpHash.
 */

export const ENTRYPOINT_V08_ADDRESS: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';

/** Unpacked form (RPC / bundler shape). */
export interface UserOperationV08 {
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;
}

/** On-chain PackedUserOperation (EntryPoint v0.7/v0.8 struct). */
export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export const MAX_UINT128 = (1n << 128n) - 1n;

function u128(name: string, v: bigint): bigint {
  if (v < 0n || v > MAX_UINT128) throw new RangeError(`${name} does not fit in uint128: ${v}`);
  return v;
}

function hex16(name: string, v: bigint): Hex {
  return pad(numberToHex(u128(name, v)), { size: 16 });
}

/** bytes32 = high128 << 128 | low128 (UserOperationLib.packUints). */
export function packUint128Pair(high: bigint, low: bigint): Hex {
  return pad(numberToHex((u128('high', high) << 128n) | u128('low', low)), { size: 32 });
}

export function unpackUint128Pair(packed: Hex): [high: bigint, low: bigint] {
  const v = hexToBigInt(packed);
  return [v >> 128n, v & MAX_UINT128];
}

export function packUserOp(op: UserOperationV08): PackedUserOperation {
  const initCode: Hex = op.factory ? concat([op.factory, op.factoryData ?? '0x']) : '0x';
  const paymasterAndData: Hex = op.paymaster
    ? concat([
        op.paymaster,
        hex16('paymasterVerificationGasLimit', op.paymasterVerificationGasLimit ?? 0n),
        hex16('paymasterPostOpGasLimit', op.paymasterPostOpGasLimit ?? 0n),
        op.paymasterData ?? '0x',
      ])
    : '0x';
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode,
    callData: op.callData,
    accountGasLimits: packUint128Pair(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: op.preVerificationGas,
    gasFees: packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData,
    signature: op.signature,
  };
}

export function unpackUserOp(p: PackedUserOperation): UserOperationV08 {
  const [verificationGasLimit, callGasLimit] = unpackUint128Pair(p.accountGasLimits);
  const [maxPriorityFeePerGas, maxFeePerGas] = unpackUint128Pair(p.gasFees);
  const op: UserOperationV08 = {
    sender: p.sender,
    nonce: p.nonce,
    callData: p.callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas: p.preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature: p.signature,
  };
  const initLen = size(p.initCode);
  if (initLen > 0) {
    if (initLen < 20) throw new Error('initCode shorter than a factory address');
    op.factory = getAddress(slice(p.initCode, 0, 20));
    op.factoryData = initLen > 20 ? slice(p.initCode, 20) : '0x';
  }
  const pmLen = size(p.paymasterAndData);
  if (pmLen > 0) {
    if (pmLen < 52) throw new Error('paymasterAndData shorter than 52 bytes');
    op.paymaster = getAddress(slice(p.paymasterAndData, 0, 20));
    op.paymasterVerificationGasLimit = hexToBigInt(slice(p.paymasterAndData, 20, 36));
    op.paymasterPostOpGasLimit = hexToBigInt(slice(p.paymasterAndData, 36, 52));
    op.paymasterData = pmLen > 52 ? slice(p.paymasterAndData, 52) : '0x';
  }
  return op;
}

/** v0.8 marks an EIP-7702 op by initCode starting with 0x7702 padded to 20 bytes (Eip7702Support). */
export const INITCODE_EIP7702_MARKER: Hex = '0x7702';

export function isEip7702InitCode(initCode: Hex): boolean {
  const len = size(initCode);
  if (len < 2) return false;
  const first20 = len >= 20 ? slice(initCode, 0, 20) : pad(initCode, { dir: 'right', size: 20 });
  return first20.toLowerCase() === pad(INITCODE_EIP7702_MARKER, { dir: 'right', size: 20 }).toLowerCase();
}

export const ENTRYPOINT_V08_EIP712_DOMAIN = { name: 'ERC4337', version: '1' } as const;

export const PACKED_USEROP_TYPES = {
  PackedUserOperation: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
  ],
} as const;

export const PACKED_USEROP_TYPEHASH: Hex = keccak256(
  toHex(
    'PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)',
  ),
);

function assertNot7702(initCode: Hex): void {
  if (isEip7702InitCode(initCode)) {
    throw new Error('EIP-7702 initCode is not supported: its hash needs the on-chain delegate (out of scope)');
  }
}

/** EIP-712 typed data for the v0.8 userOpHash (also what an EIP-712 wallet would sign). */
export function userOpTypedData(p: PackedUserOperation, entryPoint: Address, chainId: number | bigint) {
  assertNot7702(p.initCode);
  return {
    domain: { ...ENTRYPOINT_V08_EIP712_DOMAIN, chainId: Number(chainId), verifyingContract: entryPoint },
    types: PACKED_USEROP_TYPES,
    primaryType: 'PackedUserOperation' as const,
    message: {
      sender: p.sender,
      nonce: p.nonce,
      initCode: p.initCode,
      callData: p.callData,
      accountGasLimits: p.accountGasLimits,
      preVerificationGas: p.preVerificationGas,
      gasFees: p.gasFees,
      paymasterAndData: p.paymasterAndData,
    },
  };
}

/** EntryPoint v0.8 getUserOpHash. */
export function getUserOpHashV08(p: PackedUserOperation, entryPoint: Address, chainId: number | bigint): Hex {
  return hashTypedData(userOpTypedData(p, entryPoint, chainId));
}

/** keccak256(UserOperationLib.encode(op, 0)): the struct hash, written out field by field. */
export function userOpStructHash(p: PackedUserOperation): Hex {
  assertNot7702(p.initCode);
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        PACKED_USEROP_TYPEHASH,
        p.sender,
        p.nonce,
        keccak256(p.initCode),
        keccak256(p.callData),
        p.accountGasLimits,
        p.preVerificationGas,
        p.gasFees,
        keccak256(p.paymasterAndData),
      ],
    ),
  );
}

/** EIP-712 domain separator of an EntryPoint v0.8 deployment. */
export function entryPointDomainSeparator(entryPoint: Address, chainId: number | bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toHex(ENTRYPOINT_V08_EIP712_DOMAIN.name)),
        keccak256(toHex(ENTRYPOINT_V08_EIP712_DOMAIN.version)),
        BigInt(chainId),
        entryPoint,
      ],
    ),
  );
}
