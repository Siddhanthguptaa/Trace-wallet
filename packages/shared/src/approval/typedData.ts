/**
 * OutcomeApproval EIP-712 (docs/api.md section 5, contracts/src/lib/TypedData.sol), signed by the
 * wallet OWNER in the wallet's domain {name "AgentAccount", version "1", chainId, verifyingContract =
 * account} and carried in the approval slot of the agent's userOp.signature (docs/api.md 4.4):
 *   approval = abi.encode(TypedData.OutcomeApproval approval, bytes ownerSig)
 * Golden vector: results/m1_typed_data_vectors.json (contract digest). Lane APPS (M5).
 */
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from 'viem';

export const APPROVAL_DOMAIN_NAME = 'AgentAccount';
export const APPROVAL_DOMAIN_VERSION = '1';
export const EIP712_DOMAIN_TYPE_STRING = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export const EIP712_DOMAIN_TYPEHASH = keccak256(toBytes(EIP712_DOMAIN_TYPE_STRING));
export const ASSET_AMOUNT_TYPE_STRING = 'AssetAmount(address asset,uint256 amount)';
export const ASSET_AMOUNT_TYPEHASH = keccak256(toBytes(ASSET_AMOUNT_TYPE_STRING));
export const OUTCOME_APPROVAL_TYPE_STRING =
  'OutcomeApproval(address account,uint256 chainId,uint256 nonce,address target,bytes4 selector,address payee,AssetAmount[] maxOutflow,bytes32 callDataHash,uint48 validUntil)' +
  ASSET_AMOUNT_TYPE_STRING;
export const OUTCOME_APPROVAL_TYPEHASH = keccak256(toBytes(OUTCOME_APPROVAL_TYPE_STRING));

/** Native ETH as a maxOutflow asset (docs/api.md 5). */
export const NATIVE_ASSET: Address = '0x0000000000000000000000000000000000000000';
export const MAX_UINT48 = 2 ** 48 - 1;

export const OUTCOME_APPROVAL_TYPES = {
  AssetAmount: [
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  OutcomeApproval: [
    { name: 'account', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'target', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'payee', type: 'address' },
    { name: 'maxOutflow', type: 'AssetAmount[]' },
    { name: 'callDataHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint48' },
  ],
} as const;

/** eth_signTypedData_v4 wants EIP712Domain listed in `types` (MetaMask); viem accepts it too. */
export const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

export interface AssetAmount {
  asset: Address;
  amount: bigint;
}

export interface OutcomeApproval {
  account: Address;
  chainId: bigint;
  nonce: bigint;
  target: Address;
  selector: Hex;
  payee: Address;
  maxOutflow: AssetAmount[];
  callDataHash: Hex;
  validUntil: number;
}

export function approvalDomain(chainId: number | bigint, account: Address) {
  return {
    name: APPROVAL_DOMAIN_NAME,
    version: APPROVAL_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: getAddress(account),
  } as const;
}

/** viem typed-data object. The domain chainId is the approval's own chainId field. */
export function outcomeApprovalTypedData(a: OutcomeApproval) {
  return {
    domain: approvalDomain(a.chainId, a.account),
    types: OUTCOME_APPROVAL_TYPES,
    primaryType: 'OutcomeApproval' as const,
    message: {
      account: a.account,
      chainId: a.chainId,
      nonce: a.nonce,
      target: a.target,
      selector: a.selector,
      payee: a.payee,
      maxOutflow: a.maxOutflow.map((x) => ({ asset: x.asset, amount: x.amount })),
      callDataHash: a.callDataHash,
      validUntil: a.validUntil,
    },
  };
}

/** EIP-712 digest via viem. Also the `approvalHash` the service reports (ApprovedExecuted). */
export function outcomeApprovalDigest(a: OutcomeApproval): Hex {
  return hashTypedData(outcomeApprovalTypedData(a));
}

/** Hand-built mirror of TypedData.sol (independent cross-check of the viem digest). */
export function approvalDomainSeparator(chainId: number | bigint, account: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [EIP712_DOMAIN_TYPEHASH, keccak256(toBytes(APPROVAL_DOMAIN_NAME)), keccak256(toBytes(APPROVAL_DOMAIN_VERSION)), BigInt(chainId), account],
    ),
  );
}

export function hashAssetAmounts(xs: readonly AssetAmount[]): Hex {
  const hs = xs.map((x) =>
    keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [ASSET_AMOUNT_TYPEHASH, x.asset, x.amount])),
  );
  return keccak256(hs.length ? encodePacked(hs.map(() => 'bytes32'), hs) : '0x');
}

export function outcomeApprovalStructHash(a: OutcomeApproval): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes4' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint48' },
      ],
      [
        OUTCOME_APPROVAL_TYPEHASH,
        a.account,
        a.chainId,
        a.nonce,
        a.target,
        a.selector,
        a.payee,
        hashAssetAmounts(a.maxOutflow),
        a.callDataHash,
        a.validUntil,
      ],
    ),
  );
}

export function outcomeApprovalDigestManual(a: OutcomeApproval): Hex {
  return keccak256(
    encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', approvalDomainSeparator(a.chainId, a.account), outcomeApprovalStructHash(a)]),
  );
}

export async function recoverApprovalSigner(a: OutcomeApproval, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...outcomeApprovalTypedData(a), signature });
}

const APPROVAL_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'account', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'target', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'payee', type: 'address' },
    {
      name: 'maxOutflow',
      type: 'tuple[]',
      components: [
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
    { name: 'callDataHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint48' },
  ],
} as const;

const SLOT_PARAMS = [APPROVAL_TUPLE, { type: 'bytes' }] as const;

/** The approval slot: abi.encode(OutcomeApproval, bytes ownerSig) (docs/api.md 4.4). */
export function encodeApprovalSlot(a: OutcomeApproval, ownerSig: Hex): Hex {
  return encodeAbiParameters(SLOT_PARAMS, [
    {
      account: a.account,
      chainId: a.chainId,
      nonce: a.nonce,
      target: a.target,
      selector: a.selector,
      payee: a.payee,
      maxOutflow: a.maxOutflow.map((x) => ({ asset: x.asset, amount: x.amount })),
      callDataHash: a.callDataHash,
      validUntil: a.validUntil,
    },
    ownerSig,
  ]);
}

export function decodeApprovalSlot(slot: Hex): { approval: OutcomeApproval; ownerSig: Hex } {
  const [t, ownerSig] = decodeAbiParameters(SLOT_PARAMS, slot);
  return {
    approval: {
      account: getAddress(t.account),
      chainId: t.chainId,
      nonce: t.nonce,
      target: getAddress(t.target),
      selector: t.selector,
      payee: getAddress(t.payee),
      maxOutflow: t.maxOutflow.map((x) => ({ asset: getAddress(x.asset), amount: x.amount })),
      callDataHash: t.callDataHash,
      validUntil: Number(t.validUntil),
    },
    ownerSig,
  };
}

/** JSON form (bigints as decimal strings) for HTTP bodies and vector files. */
export interface OutcomeApprovalJson {
  account: Address;
  chainId: string;
  nonce: string;
  target: Address;
  selector: Hex;
  payee: Address;
  maxOutflow: { asset: Address; amount: string }[];
  callDataHash: Hex;
  validUntil: number;
}

export function approvalToJson(a: OutcomeApproval): OutcomeApprovalJson {
  return {
    account: a.account,
    chainId: a.chainId.toString(),
    nonce: a.nonce.toString(),
    target: a.target,
    selector: a.selector,
    payee: a.payee,
    maxOutflow: a.maxOutflow.map((x) => ({ asset: x.asset, amount: x.amount.toString() })),
    callDataHash: a.callDataHash,
    validUntil: a.validUntil,
  };
}

export function approvalFromJson(j: OutcomeApprovalJson): OutcomeApproval {
  return {
    account: getAddress(j.account),
    chainId: BigInt(j.chainId),
    nonce: BigInt(j.nonce),
    target: getAddress(j.target),
    selector: j.selector,
    payee: getAddress(j.payee),
    maxOutflow: j.maxOutflow.map((x) => ({ asset: getAddress(x.asset), amount: BigInt(x.amount) })),
    callDataHash: j.callDataHash,
    validUntil: Number(j.validUntil),
  };
}

/**
 * The JSON a wallet signs with eth_signTypedData_v4 (MetaMask later [A15]): EIP712Domain in types,
 * numbers as decimal strings. `typedDataFromV4Json` turns it back into the viem object.
 */
export function approvalTypedDataV4Json(a: OutcomeApproval) {
  const j = approvalToJson(a);
  return {
    domain: { name: APPROVAL_DOMAIN_NAME, version: APPROVAL_DOMAIN_VERSION, chainId: Number(a.chainId), verifyingContract: getAddress(a.account) },
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...OUTCOME_APPROVAL_TYPES },
    primaryType: 'OutcomeApproval' as const,
    message: j,
  };
}

export function approvalFromV4Json(v4: { message: OutcomeApprovalJson }): OutcomeApproval {
  return approvalFromJson(v4.message);
}
