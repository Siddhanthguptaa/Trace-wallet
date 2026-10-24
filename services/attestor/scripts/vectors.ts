/**
 * ScoreAttestation golden vectors for D3 (contracts/test/vectors/score_attestation.json).
 * Deterministic: fixed anvil dev keys, fixed fields, RFC 6979 signatures.
 *   pnpm --filter @hypnexis/attestor vectors     (writes the file)
 * test/signer.test.ts regenerates and requires byte-equality; test/anvil.test.ts checks every
 * digest against CORE's TypedData.sol on anvil.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, getAddress, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DOMAIN_TYPEHASH,
  SCORE_ATTESTATION_TYPEHASH,
  SCORE_ATTESTATION_TYPE_STRING,
  type ScoreAttestation,
  accountDomainSeparator,
  encodeAttestation,
  scoreAttestationDigest,
  scoreAttestationStructHash,
  scoreAttestationTypedData,
} from '../../../packages/shared/src/attestor/typedData.ts';
import { AttestationSigner } from '../src/signer.ts';
import { BUILD_ROOT, DEV_KEYS } from './lib/devchain.ts';

export const VECTORS_PATH = join(BUILD_ROOT, 'contracts', 'test', 'vectors', 'score_attestation.json');

const WALLET_A = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3');
const WALLET_B = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512');
const SHOP = getAddress('0x000000000000000000000000000000000000bEEF');
const NEW_SHOP = getAddress('0x0000000000000000000000000000000000C0FFEE');

interface CaseIn {
  name: string;
  chainId: number;
  wallet: Address;
  recipient: Address;
  tier: number;
  validUntil: number;
  epoch: bigint;
  key: Hex;
  /** what an account at (chainId, wallet) with attestor = attestor key and attestEpoch = epoch must decide */
  expectProven: boolean;
  note: string;
}

async function signRaw(key: Hex, chainId: number, wallet: Address, a: ScoreAttestation): Promise<Hex> {
  return privateKeyToAccount(key).signTypedData(scoreAttestationTypedData(chainId, wallet, a));
}

export async function buildVectors(): Promise<Record<string, unknown>> {
  const attestor = new AttestationSigner(DEV_KEYS.attestor);
  const base = { recipient: SHOP, tier: 1, validUntil: 1_767_225_600, epoch: 1n };
  const cases: CaseIn[] = [
    { name: 'proven_local', chainId: 31337, wallet: WALLET_A, ...base, key: DEV_KEYS.attestor, expectProven: true, note: 'anvil chain, epoch 1' },
    { name: 'proven_base', chainId: 8453, wallet: WALLET_A, ...base, key: DEV_KEYS.attestor, expectProven: true, note: 'Base mainnet chain id' },
    { name: 'proven_epoch2', chainId: 31337, wallet: WALLET_A, ...base, epoch: 2n, key: DEV_KEYS.attestor, expectProven: true, note: 'valid only after bumpEpoch to 2' },
    { name: 'proven_wallet_b', chainId: 31337, wallet: WALLET_B, ...base, recipient: NEW_SHOP, key: DEV_KEYS.attestor, expectProven: true, note: 'another wallet and payee' },
    {
      name: 'proven_max_fields',
      chainId: 31337,
      wallet: WALLET_A,
      recipient: SHOP,
      tier: 1,
      validUntil: 2 ** 48 - 1,
      epoch: 2n ** 64n - 1n,
      key: DEV_KEYS.attestor,
      expectProven: true,
      note: 'uint48 / uint64 maxima',
    },
    { name: 'tier_unproven_signed', chainId: 31337, wallet: WALLET_A, ...base, tier: 2, key: DEV_KEYS.attestor, expectProven: false, note: 'valid attestor signature over tier 2: never upgrades (only tier 1 does)' },
    { name: 'tier_flagged_signed', chainId: 31337, wallet: WALLET_A, ...base, tier: 3, key: DEV_KEYS.attestor, expectProven: false, note: 'tier 3 signature: never upgrades' },
    { name: 'wrong_signer_agent', chainId: 31337, wallet: WALLET_A, ...base, key: DEV_KEYS.agent, expectProven: false, note: 'signed by the agent key, not the attestor' },
  ];

  const outCases = [];
  for (const c of cases) {
    const msg: ScoreAttestation = { recipient: c.recipient, tier: c.tier, validUntil: c.validUntil, epoch: c.epoch };
    const signature = c.key === DEV_KEYS.attestor && c.tier === 1 ? (await attestor.sign(c.chainId, c.wallet, msg)).signature : await signRaw(c.key, c.chainId, c.wallet, msg);
    outCases.push({
      name: c.name,
      note: c.note,
      chainId: String(c.chainId),
      wallet: c.wallet,
      recipient: c.recipient,
      tier: String(c.tier),
      validUntil: String(c.validUntil),
      epoch: c.epoch.toString(),
      domainSeparator: accountDomainSeparator(c.chainId, c.wallet),
      structHash: scoreAttestationStructHash(msg),
      digest: scoreAttestationDigest(c.chainId, c.wallet, msg),
      signer: privateKeyToAccount(c.key).address,
      signature,
      attestation: encodeAttestation({ tier: c.tier, validUntil: c.validUntil, epoch: c.epoch, signature }),
      expectProven: c.expectProven,
    });
  }

  // Replays: a valid proven_local attestation checked in the wrong context must fail.
  const p = outCases[0]!;
  const pMsg: ScoreAttestation = { recipient: SHOP, tier: 1, validUntil: base.validUntil, epoch: 1n };
  const replay = async (name: string, chainId: number, wallet: Address, epoch: bigint, recipient: Address, note: string) => {
    const ctxMsg = { ...pMsg, epoch, recipient };
    const recovered = await recoverTypedDataAddress({ ...scoreAttestationTypedData(chainId, wallet, ctxMsg), signature: p.signature as Hex });
    return {
      name,
      note,
      fromCase: p.name,
      attestation: p.attestation,
      checkChainId: String(chainId),
      checkWallet: wallet,
      checkRecipient: recipient,
      checkEpoch: epoch.toString(),
      contextDigest: scoreAttestationDigest(chainId, wallet, ctxMsg),
      recoveredSigner: recovered,
      expectProven: false,
    };
  };
  const replays = [
    await replay('replay_wrong_chain', 8453, WALLET_A, 1n, SHOP, 'proven_local presented on Base (F25)'),
    await replay('replay_wrong_wallet', 31337, WALLET_B, 1n, SHOP, 'proven_local presented to another wallet (F25)'),
    await replay('replay_old_epoch', 31337, WALLET_A, 2n, SHOP, 'epoch-1 attestation after bumpEpoch to 2 (F25)'),
    await replay('replay_wrong_recipient', 31337, WALLET_A, 1n, NEW_SHOP, 'attestation for SHOP used to pay another payee'),
  ];

  return {
    description:
      'ScoreAttestation EIP-712 golden vectors (ATT lane, M6). Domain {name "AgentAccount", version "1", chainId, verifyingContract = wallet}. attestation = abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes sig) (the userOp.signature attestation slot). uints are decimal strings. Keys are anvil dev keys (public, test only). Regenerate: pnpm --filter @hypnexis/attestor vectors.',
    typeString: SCORE_ATTESTATION_TYPE_STRING,
    typeHash: SCORE_ATTESTATION_TYPEHASH,
    domainTypeHash: DOMAIN_TYPEHASH,
    domainName: 'AgentAccount',
    domainVersion: '1',
    tierEnum: { NONE: '0', PROVEN: '1', UNPROVEN: '2', FLAGGED: '3' },
    attestor: attestor.address,
    agent: privateKeyToAccount(DEV_KEYS.agent).address,
    cases: outCases,
    replays,
  };
}

export function serialize(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

if (process.argv[1] && /vectors\.ts$/.test(process.argv[1])) {
  const v = await buildVectors();
  writeFileSync(VECTORS_PATH, serialize(v));
  console.log(`wrote ${VECTORS_PATH} (${(v.cases as unknown[]).length} cases, ${(v.replays as unknown[]).length} replays)`);
}
