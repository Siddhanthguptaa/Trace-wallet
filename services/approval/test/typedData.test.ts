import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Hex, getAddress, hashTypedData, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  OUTCOME_APPROVAL_TYPEHASH,
  approvalDomainSeparator,
  approvalFromJson,
  approvalFromV4Json,
  approvalToJson,
  approvalTypedDataV4Json,
  decodeApprovalSlot,
  encodeApprovalSlot,
  outcomeApprovalDigest,
  outcomeApprovalDigestManual,
  outcomeApprovalStructHash,
  outcomeApprovalTypedData,
  recoverApprovalSigner,
} from '../../../packages/shared/src/approval/index.ts';
import { BUILD_ROOT, SVC_ROOT } from '../scripts/lib/devchain.ts';
import { KEYS, OWNER } from './helpers.ts';

const m1 = JSON.parse(readFileSync(join(BUILD_ROOT, 'results', 'm1_typed_data_vectors.json'), 'utf8'));
const m1Approval = approvalFromJson({ ...m1.outcomeApproval, chainId: String(m1.outcomeApproval.chainId), nonce: String(m1.outcomeApproval.nonce) });
const vectors = JSON.parse(readFileSync(join(SVC_ROOT, 'vectors', 'outcome_approval.json'), 'utf8'));

describe('OutcomeApproval typed data == contract (results/m1_typed_data_vectors.json)', () => {
  it('typehash, domain separator, struct hash and digest equal the M1 contract vector', () => {
    expect(OUTCOME_APPROVAL_TYPEHASH).toBe(m1.outcomeApprovalTypehash);
    expect(approvalDomainSeparator(m1.chainId, m1.verifyingContract)).toBe(m1.domainSeparator);
    expect(outcomeApprovalStructHash(m1Approval)).toBe(m1.outcomeApproval.structHash);
    expect(outcomeApprovalDigest(m1Approval)).toBe(m1.outcomeApproval.digest);
    expect(outcomeApprovalDigestManual(m1Approval)).toBe(m1.outcomeApproval.digest);
  });

  it('empty maxOutflow hashes as keccak256("") in both builders', () => {
    const a = { ...m1Approval, maxOutflow: [] };
    expect(outcomeApprovalDigestManual(a)).toBe(outcomeApprovalDigest(a));
  });

  it('eth_signTypedData_v4 JSON (EIP712Domain in types, decimal strings) hashes to the same digest', () => {
    const v4 = approvalTypedDataV4Json(m1Approval);
    expect(v4.types.EIP712Domain).toBeDefined();
    const back = approvalFromV4Json(JSON.parse(JSON.stringify(v4)));
    expect(back).toEqual(m1Approval);
    expect(hashTypedData({ ...v4, message: outcomeApprovalTypedData(back).message } as never)).toBe(m1.outcomeApproval.digest);
  });

  it('approval slot round-trips and the owner signature recovers', async () => {
    const sig = await privateKeyToAccount(KEYS.owner).signTypedData(outcomeApprovalTypedData(m1Approval));
    const slot = encodeApprovalSlot(m1Approval, sig);
    const d = decodeApprovalSlot(slot);
    expect(d.approval).toEqual(m1Approval);
    expect(d.ownerSig).toBe(sig);
    expect(await recoverApprovalSigner(d.approval, d.ownerSig)).toBe(OWNER);
    expect(approvalFromJson(approvalToJson(m1Approval))).toEqual(m1Approval);
  });
});

describe('EIP-712 vectors (vectors/outcome_approval.json)', () => {
  it('has the M1 case first, equal to the contract digest', () => {
    expect(vectors.cases[0].name).toBe('m1_vector');
    expect(vectors.cases[0].digest).toBe(m1.outcomeApproval.digest);
    expect(vectors.m1ContractDigest).toBe(m1.outcomeApproval.digest);
    expect(vectors.typeString).toBe(
      'OutcomeApproval(address account,uint256 chainId,uint256 nonce,address target,bytes4 selector,address payee,AssetAmount[] maxOutflow,bytes32 callDataHash,uint48 validUntil)AssetAmount(address asset,uint256 amount)',
    );
    expect(keccak256(toBytes(vectors.typeString))).toBe(OUTCOME_APPROVAL_TYPEHASH);
  });

  for (const c of vectors.cases as Array<Record<string, unknown>>) {
    it(`case ${String(c.name)}: hashes, slot and signer recompute (valid=${String(c.valid)})`, async () => {
      const a = approvalFromJson(c.approval as never);
      expect(approvalDomainSeparator(a.chainId, a.account)).toBe(c.domainSeparator);
      expect(outcomeApprovalStructHash(a)).toBe(c.structHash);
      expect(outcomeApprovalDigest(a)).toBe(c.digest);
      expect(outcomeApprovalDigestManual(a)).toBe(c.digest);
      expect(encodeApprovalSlot(a, c.signature as Hex)).toBe(c.approvalSlot);
      const rec = getAddress(await recoverApprovalSigner(a, c.signature as Hex));
      expect(rec).toBe(c.recovered);
      expect(rec === OWNER).toBe(c.valid);
    });
  }

  it('every replay / tamper case is invalid and every owner-signed case is valid', () => {
    const byName = Object.fromEntries((vectors.cases as Array<{ name: string; valid: boolean }>).map((c) => [c.name, c.valid]));
    for (const n of ['agent_signed', 'replay_wrong_chain', 'replay_wrong_account', 'replay_used_on_other_call', 'tampered_max_outflow_plus_one', 'tampered_payee']) {
      expect(byName[n]).toBe(false);
    }
    for (const n of ['m1_vector', 'base_mainnet_usdc_transfer', 'empty_max_outflow', 'native_send', 'max_values']) expect(byName[n]).toBe(true);
  });
});
