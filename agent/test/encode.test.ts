import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, getAddress, keccak256, slice, toHex } from 'viem';
import {
  OP_KIND,
  ROLE,
  agentCallData,
  agentSignature,
  auth3009Digest,
  decodeAgentCallData,
  decodePayee,
  declaredOutflow,
  decodeSignatureEnvelope,
  erc20,
  packNonce,
  x402Envelope,
} from '../src/ops/encode.ts';
import { SEL } from '../src/world/policy.ts';
import { decodeReason, approvable, R } from '../src/ops/reasons.ts';

const USDC = getAddress('0x0000000000000000000000000000000000000abc');
const TO = getAddress('0x00000000000000000000000000000000000000ff');

describe('agent op callData (docs/api.md 4.1)', () => {
  it('round-trips kind/target/value/data with the executeUserOp selector', () => {
    const data = erc20.transfer(TO, 5n);
    const cd = agentCallData(USDC, 0n, data);
    expect(slice(cd, 0, 4)).toBe(SEL.executeUserOp);
    const d = decodeAgentCallData(cd);
    expect(d.kind).toBe(OP_KIND.CALL);
    expect(d.target).toBe(USDC);
    expect(d.value).toBe(0n);
    expect(d.data).toBe(data);
  });
  it('rejects callData that is not an executeUserOp body', () => {
    expect(() => decodeAgentCallData('0xdeadbeef')).toThrow();
  });
});

describe('signature envelope (docs/api.md 4.2)', () => {
  it('round-trips the agent role with attestation and approval slots', () => {
    const env = agentSignature('0x1234', '0xaa', '0xbb');
    const d = decodeSignatureEnvelope(env);
    expect(d.role).toBe(ROLE.AGENT);
    expect(d.sig).toBe('0x1234');
    expect(d.attestation).toBe('0xaa');
    expect(d.approval).toBe('0xbb');
  });
});

describe('nonce packing (4.5)', () => {
  it('(nonceKey << 64) | seq', () => {
    expect(packNonce(7n, 3n)).toBe((7n << 64n) | 3n);
  });
});

describe('payee decode (2.4 AgentCall)', () => {
  it('decodes an ERC-20 transfer on an enabled asset', () => {
    const d = decodePayee(USDC, 0n, erc20.transfer(TO, 9n), [USDC]);
    expect(d).toEqual({ payee: TO, asset: USDC, amount: 9n });
  });
  it('treats a plain value send as a native payee', () => {
    const d = decodePayee(TO, 100n, '0x', [USDC]);
    expect(d?.payee).toBe(TO);
    expect(d?.asset).toBe('0x0000000000000000000000000000000000000000');
    expect(d?.amount).toBe(100n);
  });
  it('declaredOutflow counts an approve amount', () => {
    const out = declaredOutflow(USDC, 0n, erc20.approve(TO, 42n), [USDC]);
    expect(out).toContainEqual({ asset: USDC, amount: 42n });
  });
});

describe('x402 envelope + 3009 digest (4.6, 5)', () => {
  it('is well formed and distinct per value', () => {
    const nonce = keccak256(toHex('n'));
    const e = x402Envelope(TO, 5n, 0n, 10n, nonce, '0xabcd');
    const [mode] = decodeAbiParameters([{ type: 'uint8' }], slice(e, 0, 32));
    expect(mode).toBe(1);
    const a = { from: USDC, to: TO, value: 5n, validAfter: 0n, validBefore: 10n, nonce };
    const b = { ...a, value: 6n };
    expect(auth3009Digest(31337, USDC, a)).not.toBe(auth3009Digest(31337, USDC, b));
  });
});

describe('reason codes (7.1)', () => {
  it('splits code and detail', () => {
    const r = decodeReason(R.ARG_RULE | (2 << 8));
    expect(r.name).toBe('ARG_RULE');
    expect(r.detail).toBe(2);
  });
  it('an unlisted payee (RECIPIENT) is approvable, an argument-rule RECIPIENT is not', () => {
    expect(approvable(R.RECIPIENT, true)).toBe(true);
    expect(approvable(R.RECIPIENT, false)).toBe(false);
    expect(approvable(R.TARGET, true)).toBe(false);
    expect(approvable(R.PER_TX, true)).toBe(true);
  });
});
