/**
 * EIP-712 types for D3 (IDEA.md 7.1 / 7.5).
 *
 * ScoreAttestation is signed by the attestor in the WALLET's domain
 * {name "AgentAccount", version "1", chainId, verifyingContract = wallet}; it must match
 * contracts/src/lib/TypedData.sol (CORE). The golden vectors live in
 * contracts/test/vectors/score_attestation.json (written by services/attestor/scripts/gen-vectors.ts).
 *
 * Outcome and DeliveryCheck are off-chain only (attestor input, [A22]); their domain has no
 * verifyingContract: {name "HypnexisAttestor", version "1", chainId}.
 */
import {
  type Address,
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from 'viem';
import { TIER_ENUM } from './tier.ts';

export const ACCOUNT_DOMAIN_NAME = 'AgentAccount';
export const ACCOUNT_DOMAIN_VERSION = '1';
export const DOMAIN_TYPEHASH = keccak256(
  toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

export const SCORE_ATTESTATION_TYPE_STRING = 'ScoreAttestation(address recipient,uint8 tier,uint48 validUntil,uint64 epoch)';
export const SCORE_ATTESTATION_TYPEHASH = keccak256(toBytes(SCORE_ATTESTATION_TYPE_STRING));

export const SCORE_ATTESTATION_TYPES = {
  ScoreAttestation: [
    { name: 'recipient', type: 'address' },
    { name: 'tier', type: 'uint8' },
    { name: 'validUntil', type: 'uint48' },
    { name: 'epoch', type: 'uint64' },
  ],
} as const;

/** Attestations last 24 h (IDEA 7.5, [A20]). */
export const ATTESTATION_TTL_SECONDS = 86_400;

export interface ScoreAttestation {
  recipient: Address;
  /** On-chain Tier enum value; only TIER_ENUM.PROVEN (1) upgrades a payee. */
  tier: number;
  /** unix seconds; folded into validationData by the account (never read TIMESTAMP). */
  validUntil: number;
  epoch: bigint;
}

export function scoreAttestationDomain(chainId: number | bigint, wallet: Address) {
  return {
    name: ACCOUNT_DOMAIN_NAME,
    version: ACCOUNT_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: wallet,
  } as const;
}

export function scoreAttestationTypedData(chainId: number | bigint, wallet: Address, a: ScoreAttestation) {
  return {
    domain: scoreAttestationDomain(chainId, wallet),
    types: SCORE_ATTESTATION_TYPES,
    primaryType: 'ScoreAttestation' as const,
    message: { recipient: a.recipient, tier: a.tier, validUntil: a.validUntil, epoch: a.epoch },
  };
}

/** viem's EIP-712 digest. */
export function scoreAttestationDigest(chainId: number | bigint, wallet: Address, a: ScoreAttestation): Hex {
  return hashTypedData(scoreAttestationTypedData(chainId, wallet, a));
}

/** Same digest built by hand, mirroring TypedData.sol line by line (independent cross-check). */
export function accountDomainSeparator(chainId: number | bigint, wallet: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_TYPEHASH, keccak256(toBytes(ACCOUNT_DOMAIN_NAME)), keccak256(toBytes(ACCOUNT_DOMAIN_VERSION)), BigInt(chainId), wallet],
    ),
  );
}

export function scoreAttestationStructHash(a: ScoreAttestation): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint8' }, { type: 'uint48' }, { type: 'uint64' }],
      [SCORE_ATTESTATION_TYPEHASH, a.recipient, a.tier, a.validUntil, a.epoch],
    ),
  );
}

export function scoreAttestationDigestManual(chainId: number | bigint, wallet: Address, a: ScoreAttestation): Hex {
  return keccak256(
    encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', accountDomainSeparator(chainId, wallet), scoreAttestationStructHash(a)]),
  );
}

export async function recoverScoreAttestationSigner(
  chainId: number | bigint,
  wallet: Address,
  a: ScoreAttestation,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ ...scoreAttestationTypedData(chainId, wallet, a), signature });
}

/**
 * The `attestation` slot of the agent's userOp.signature envelope (IDEA 7.1):
 * abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes attestorSig). Empty = none.
 * recipient is NOT encoded: the account binds it to the decoded payee of the op.
 */
const ATTESTATION_PARAMS = [{ type: 'uint8' }, { type: 'uint48' }, { type: 'uint64' }, { type: 'bytes' }] as const;

export function encodeAttestation(a: { tier: number; validUntil: number; epoch: bigint; signature: Hex }): Hex {
  return encodeAbiParameters(ATTESTATION_PARAMS, [a.tier, a.validUntil, a.epoch, a.signature]);
}

export function decodeAttestation(data: Hex): { tier: number; validUntil: number; epoch: bigint; signature: Hex } {
  const [tier, validUntil, epoch, signature] = decodeAbiParameters(ATTESTATION_PARAMS, data);
  return { tier, validUntil, epoch, signature };
}

export const PROVEN_TIER = TIER_ENUM.PROVEN;

// ---------------------------------------------------------------------------------------------
// Off-chain outcome evidence ([A22]): owner/verifier-signed outcomes and verifier delivery checks.

export const ATTESTOR_DOMAIN_NAME = 'HypnexisAttestor';
export const ATTESTOR_DOMAIN_VERSION = '1';

export function attestorDomain(chainId: number | bigint) {
  return { name: ATTESTOR_DOMAIN_NAME, version: ATTESTOR_DOMAIN_VERSION, chainId: BigInt(chainId) } as const;
}

/** A binary TRACE outcome of one paid job: success, or default (paid but not delivered). */
export const OUTCOME_TYPES = {
  Outcome: [
    { name: 'wallet', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'success', type: 'bool' },
    { name: 'ref', type: 'bytes32' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

export interface OutcomeMessage {
  wallet: Address;
  payee: Address;
  success: boolean;
  /** unique job reference (x402 tx hash, order id hash...); replays of the same ref are dropped. */
  ref: Hex;
  asset: Address;
  amount: bigint;
}

export function outcomeTypedData(chainId: number | bigint, m: OutcomeMessage) {
  return { domain: attestorDomain(chainId), types: OUTCOME_TYPES, primaryType: 'Outcome' as const, message: m };
}

/** Delivery check for an x402 purchase: ok iff httpStatus == 200 and the response schema matched. */
export const DELIVERY_CHECK_TYPES = {
  DeliveryCheck: [
    { name: 'wallet', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'txHash', type: 'bytes32' },
    { name: 'httpStatus', type: 'uint16' },
    { name: 'schemaOk', type: 'bool' },
  ],
} as const;

export interface DeliveryCheckMessage {
  wallet: Address;
  payee: Address;
  txHash: Hex;
  httpStatus: number;
  schemaOk: boolean;
}

export function deliveryCheckTypedData(chainId: number | bigint, m: DeliveryCheckMessage) {
  return { domain: attestorDomain(chainId), types: DELIVERY_CHECK_TYPES, primaryType: 'DeliveryCheck' as const, message: m };
}
