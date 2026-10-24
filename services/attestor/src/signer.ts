/**
 * EIP-712 ScoreAttestation signer (IDEA.md 7.1). Signs PROVEN only: a negative attestation is
 * useless because the agent can always omit it; negatives go on-chain through flag(payee).
 * Refuses to exist if its key is (or equals) an agent key [A20].
 */
import { type Address, type Hex, getAddress } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  ATTESTATION_TTL_SECONDS,
  encodeAttestation,
  scoreAttestationDigest,
  scoreAttestationTypedData,
  type ScoreAttestation,
} from '../../../packages/shared/src/attestor/typedData.ts';
import { TIER_ENUM } from '../../../packages/shared/src/attestor/tier.ts';

export class KeySeparationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'KeySeparationError';
  }
}

/** uint48 max: validUntil must fit the account's validationData field. */
export const MAX_UINT48 = 2 ** 48 - 1;

export interface SignedAttestation {
  wallet: Address;
  chainId: number;
  recipient: Address;
  tier: number;
  validUntil: number;
  epoch: bigint;
  digest: Hex;
  signature: Hex;
  /** abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes sig): the userOp.signature slot. */
  attestation: Hex;
}

export function assertKeySeparation(attestor: Address, agents: Iterable<Address>, verifiers: Iterable<Address> = []): void {
  const a = attestor.toLowerCase();
  const agentSet = new Set([...agents].map((x) => x.toLowerCase()));
  if (agentSet.has(a)) throw new KeySeparationError(`attestor key ${attestor} is an agent key; refusing to start [A20]`);
  for (const v of verifiers) {
    if (agentSet.has(v.toLowerCase())) throw new KeySeparationError(`verifier ${v} is an agent key; agent-only outcomes must stay ignored [A22]`);
  }
}

export class AttestationSigner {
  readonly account: PrivateKeyAccount;
  readonly ttlSeconds: number;

  constructor(privateKey: Hex, opts: { agents?: Iterable<Address>; verifiers?: Iterable<Address>; ttlSeconds?: number } = {}) {
    this.account = privateKeyToAccount(privateKey);
    assertKeySeparation(this.account.address, opts.agents ?? [], opts.verifiers ?? []);
    this.ttlSeconds = opts.ttlSeconds ?? ATTESTATION_TTL_SECONDS;
  }

  get address(): Address {
    return this.account.address;
  }

  validUntil(nowSeconds: number): number {
    return Math.min(MAX_UINT48, Math.floor(nowSeconds) + this.ttlSeconds);
  }

  async signProven(p: { chainId: number; wallet: Address; recipient: Address; epoch: bigint; nowSeconds: number }): Promise<SignedAttestation> {
    const wallet = getAddress(p.wallet);
    const msg: ScoreAttestation = {
      recipient: getAddress(p.recipient),
      tier: TIER_ENUM.PROVEN,
      validUntil: this.validUntil(p.nowSeconds),
      epoch: p.epoch,
    };
    return this.sign(p.chainId, wallet, msg);
  }

  /** Low-level: used by signProven and the vector generator. Refuses any tier but PROVEN. */
  async sign(chainId: number, wallet: Address, msg: ScoreAttestation): Promise<SignedAttestation> {
    if (msg.tier !== TIER_ENUM.PROVEN) throw new Error(`refusing to sign tier ${msg.tier}: only PROVEN (1) is ever attested`);
    if (!Number.isInteger(msg.validUntil) || msg.validUntil < 0 || msg.validUntil > MAX_UINT48) throw new Error('validUntil out of uint48 range');
    const signature = await this.account.signTypedData(scoreAttestationTypedData(chainId, wallet, msg));
    return {
      wallet,
      chainId,
      recipient: msg.recipient,
      tier: msg.tier,
      validUntil: msg.validUntil,
      epoch: msg.epoch,
      digest: scoreAttestationDigest(chainId, wallet, msg),
      signature,
      attestation: encodeAttestation({ tier: msg.tier, validUntil: msg.validUntil, epoch: msg.epoch, signature }),
    };
  }
}
