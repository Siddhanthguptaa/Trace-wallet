/**
 * EIP-712 OutcomeApproval test vectors (IDEA 7.3, [A18]) -> vectors/outcome_approval.json.
 * Owner = anvil key #0, agent = #1. Case m1_vector reuses results/m1_typed_data_vectors.json fields,
 * so its digest must equal the contract digest written by M1_TypedData.t.sol. Replay cases reuse a
 * valid signature on a changed message: each must recover to someone other than the owner.
 * test/typedData.test.ts recomputes every case; test/anvil.test.ts checks each digest against
 * contracts/src/lib/TypedData.sol on anvil.
 *   pnpm --filter @hypnexis/approval vectors
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Hex, getAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  type OutcomeApproval,
  approvalDomainSeparator,
  approvalFromJson,
  approvalToJson,
  encodeApprovalSlot,
  makeNonce,
  outcomeApprovalDigest,
  outcomeApprovalStructHash,
  outcomeApprovalTypedData,
  recoverApprovalSigner,
} from '../../../packages/shared/src/approval/index.ts';
import { BUILD_ROOT, DEV_KEYS, SVC_ROOT } from './lib/devchain.ts';

const owner = privateKeyToAccount(DEV_KEYS.owner);
const agent = privateKeyToAccount(DEV_KEYS.agent);
const m1 = JSON.parse(readFileSync(join(BUILD_ROOT, 'results', 'm1_typed_data_vectors.json'), 'utf8')) as {
  outcomeApproval: Parameters<typeof approvalFromJson>[0] & { digest: Hex; structHash: Hex };
};

const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const WALLET_A = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
const WALLET_B = getAddress('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
const SHOP = getAddress('0x3333333333333333333333333333333333333333');
const MAX256 = (1n << 256n) - 1n;

const base: OutcomeApproval = approvalFromJson({ ...m1.outcomeApproval, chainId: String(m1.outcomeApproval.chainId), nonce: String(m1.outcomeApproval.nonce) });
const lane1Key = (BigInt(agent.address) << 32n) | (0xa11cen << 8n) | 1n;

const signedCases: Array<{ name: string; approval: OutcomeApproval; signer: 'owner' | 'agent'; note: string }> = [
  { name: 'm1_vector', approval: base, signer: 'owner', note: 'fields of results/m1_typed_data_vectors.json; digest must equal the contract digest' },
  {
    name: 'base_mainnet_usdc_transfer',
    approval: {
      account: WALLET_A,
      chainId: 8453n,
      nonce: makeNonce(lane1Key, 0n),
      target: USDC,
      selector: '0xa9059cbb',
      payee: SHOP,
      maxOutflow: [{ asset: USDC, amount: 5_000_000n }],
      callDataHash: keccak256(toHex('transfer(shop, 5 USDC)')),
      validUntil: 1_800_000_000,
    },
    signer: 'owner',
    note: 'lane-1 nonce, chainId 8453',
  },
  {
    name: 'empty_max_outflow',
    approval: { ...base, account: WALLET_B, nonce: 1n, maxOutflow: [], payee: '0x0000000000000000000000000000000000000000' },
    signer: 'owner',
    note: 'call that moves nothing; keccak256 of empty AssetAmount[] encoding',
  },
  {
    name: 'native_send',
    approval: {
      ...base,
      account: WALLET_A,
      nonce: 2n,
      target: SHOP,
      selector: '0x00000000',
      payee: SHOP,
      maxOutflow: [{ asset: '0x0000000000000000000000000000000000000000', amount: 10n ** 15n }],
    },
    signer: 'owner',
    note: 'plain value send: selector 0, payee = target (TARGET_ARG), native asset 0x0',
  },
  {
    name: 'max_values',
    approval: { ...base, nonce: MAX256, validUntil: 2 ** 48 - 1, maxOutflow: [{ asset: USDC, amount: MAX256 }] },
    signer: 'owner',
    note: 'uint256 / uint48 maxima',
  },
  { name: 'agent_signed', approval: base, signer: 'agent', note: 'signed by the agent key: the account must refuse (signer != owner)' },
];

function mutate(a: OutcomeApproval, name: string): OutcomeApproval {
  switch (name) {
    case 'replay_wrong_chain':
      return { ...a, chainId: 8453n };
    case 'replay_wrong_account':
      return { ...a, account: WALLET_B };
    case 'replay_used_on_other_call':
      return { ...a, callDataHash: keccak256(toHex('another call')) };
    case 'tampered_max_outflow_plus_one':
      return { ...a, maxOutflow: a.maxOutflow.map((x, i) => (i === 0 ? { ...x, amount: x.amount + 1n } : x)) };
    case 'tampered_payee':
      return { ...a, payee: getAddress('0x000000000000000000000000000000000000dEaD') };
    default:
      throw new Error(name);
  }
}

async function main(): Promise<void> {
  const cases = [];
  const sigOf = new Map<string, Hex>();
  for (const c of signedCases) {
    const key = c.signer === 'owner' ? owner : agent;
    const signature = await key.signTypedData(outcomeApprovalTypedData(c.approval));
    sigOf.set(c.name, signature);
    const recovered = await recoverApprovalSigner(c.approval, signature);
    cases.push(entry(c.name, c.note, c.approval, signature, recovered));
  }
  for (const name of ['replay_wrong_chain', 'replay_wrong_account', 'replay_used_on_other_call', 'tampered_max_outflow_plus_one', 'tampered_payee']) {
    const a = mutate(base, name);
    const signature = sigOf.get('m1_vector')!;
    cases.push(entry(name, 'owner signature of m1_vector on a changed message: must not verify', a, signature, await recoverApprovalSigner(a, signature)));
  }
  const out = {
    description: 'OutcomeApproval EIP-712 vectors (docs/api.md 5 / 16). Domain {AgentAccount, 1, chainId, verifyingContract = account}. valid = signature recovers the owner.',
    owner: owner.address,
    agent: agent.address,
    typeString: 'OutcomeApproval(address account,uint256 chainId,uint256 nonce,address target,bytes4 selector,address payee,AssetAmount[] maxOutflow,bytes32 callDataHash,uint48 validUntil)AssetAmount(address asset,uint256 amount)',
    m1ContractDigest: m1.outcomeApproval.digest,
    cases,
  };
  mkdirSync(join(SVC_ROOT, 'vectors'), { recursive: true });
  writeFileSync(join(SVC_ROOT, 'vectors', 'outcome_approval.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${cases.length} cases; m1_vector digest ${cases[0]!.digest === m1.outcomeApproval.digest ? '==' : '!='} contract digest`);

  function entry(name: string, note: string, a: OutcomeApproval, signature: Hex, recovered: string) {
    return {
      name,
      note,
      approval: approvalToJson(a),
      domainSeparator: approvalDomainSeparator(a.chainId, a.account),
      structHash: outcomeApprovalStructHash(a),
      digest: outcomeApprovalDigest(a),
      signature,
      recovered: getAddress(recovered),
      valid: getAddress(recovered) === owner.address,
      approvalSlot: encodeApprovalSlot(a, signature),
    };
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
