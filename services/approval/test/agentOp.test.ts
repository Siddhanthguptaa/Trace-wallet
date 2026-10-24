import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, recoverAddress } from 'viem';
import { getUserOpHashV08 } from '@hypnexis/shared';
import {
  OP_KIND,
  REASON,
  ROLE,
  RULE_OP,
  TARGET_ARG,
  agentOfNonce,
  declaredAmount,
  decodeAgentOp,
  decodeSignatureEnvelope,
  encodeAgentOp,
  encodeSignatureEnvelope,
  laneOfNonce,
  makeNonce,
  nonceKeyOfNonce,
  payeeFromRules,
  payeeHeuristic,
  reasonName,
  sequenceOfNonce,
  signAgentOp,
} from '../../../packages/shared/src/approval/index.ts';
import { ACCOUNT, AGENT, ENTRYPOINT, KEYS, LANE1_KEY, PAYEE, TOKEN, erc20, transferData } from './helpers.ts';

describe('agent op encoding (docs/api.md 4.1)', () => {
  it('round-trips a CALL op and reads the selector', () => {
    const cd = encodeAgentOp({ target: TOKEN, data: transferData() });
    expect(cd.slice(0, 10)).toBe('0x8dd7712f');
    const c = decodeAgentOp(cd);
    expect(c).toMatchObject({ kind: OP_KIND.CALL, target: TOKEN, value: 0n, selector: '0xa9059cbb' });
  });

  it('plain value send has selector 0x00000000', () => {
    const c = decodeAgentOp(encodeAgentOp({ target: PAYEE, value: 7n }));
    expect(c.selector).toBe('0x00000000');
    expect(c.value).toBe(7n);
  });

  it('refuses what PolicyCheck.decode refuses (OP_SHAPE)', () => {
    expect(() => decodeAgentOp('0xb61d27f6')).toThrow(/OP_SHAPE/);
    expect(() => decodeAgentOp(encodeAgentOp({ kind: 2, target: TOKEN }))).toThrow(/OP_SHAPE/);
    expect(() => decodeAgentOp(encodeAgentOp({ target: TOKEN, data: '0xaabb' }))).toThrow(/OP_SHAPE/);
  });
});

describe('signature envelope and nonces (docs/api.md 4.2 / 4.5)', () => {
  it('encodes role/sig/attestation/approval; a 65-byte sig is the owner role', () => {
    const sig = `0x${'11'.repeat(65)}` as const;
    const e = decodeSignatureEnvelope(encodeSignatureEnvelope({ sig, attestation: '0x1234' }));
    expect(e).toEqual({ role: ROLE.AGENT, sig, attestation: '0x1234', approval: '0x' });
    expect(decodeSignatureEnvelope(sig).role).toBe(ROLE.OWNER);
  });

  it('nonce = key << 64 | seq with key = agent << 32 | salt << 8 | lane', () => {
    const n = makeNonce(LANE1_KEY, 9n);
    expect(nonceKeyOfNonce(n)).toBe(LANE1_KEY);
    expect(sequenceOfNonce(n)).toBe(9n);
    expect(laneOfNonce(n)).toBe(1);
    expect(agentOfNonce(n)).toBe(AGENT);
  });

  it('signAgentOp signs the v0.8 userOpHash raw with the agent key and leaves the approval slot empty', async () => {
    const s = await signAgentOp({ account: ACCOUNT, entryPoint: ENTRYPOINT, chainId: 31337, agentKey: KEYS.agent, nonce: makeNonce(LANE1_KEY, 0n), call: { target: TOKEN, data: transferData() } });
    expect(s.userOpHash).toBe(getUserOpHashV08(s.userOp, ENTRYPOINT, 31337));
    const env = decodeSignatureEnvelope(s.userOp.signature);
    expect(env.approval).toBe('0x');
    expect(await recoverAddress({ hash: s.userOpHash, signature: env.sig })).toBe(AGENT);
  });
});

describe('payee derivation (PolicyCheck.evalRules)', () => {
  const call = decodeAgentOp(encodeAgentOp({ target: TOKEN, data: transferData(PAYEE, 1n) }));
  it('PAYEE rule on arg 0 gives the transfer recipient', () => {
    expect(payeeFromRules(call, [{ argIndex: 0, op: RULE_OP.PAYEE, bound: 0n }])).toBe(PAYEE);
  });
  it('no PAYEE rule gives the zero address; TARGET_ARG gives the target', () => {
    expect(payeeFromRules(call, [{ argIndex: 0, op: RULE_OP.IN_RECIPIENTS, bound: 0n }])).toBe('0x0000000000000000000000000000000000000000');
    expect(payeeFromRules(call, [{ argIndex: TARGET_ARG, op: RULE_OP.PAYEE, bound: 0n }])).toBe(TOKEN);
  });
  it('heuristic: transfer arg 0, value send target, else zero', () => {
    expect(payeeHeuristic(call)).toBe(PAYEE);
    expect(payeeHeuristic(decodeAgentOp(encodeAgentOp({ target: PAYEE, value: 1n })))).toBe(PAYEE);
    const approve = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [PAYEE, 3n] });
    expect(payeeHeuristic(decodeAgentOp(encodeAgentOp({ target: TOKEN, data: approve })))).toBe('0x0000000000000000000000000000000000000000');
  });
  it('declaredAmount decodes transfer / approve amounts and native value', () => {
    expect(declaredAmount(call)).toEqual({ asset: TOKEN, amount: 1n });
    const approve = encodeFunctionData({ abi: erc20, functionName: 'approve', args: [PAYEE, 3n] });
    expect(declaredAmount(decodeAgentOp(encodeAgentOp({ target: TOKEN, data: approve })))).toEqual({ asset: TOKEN, amount: 3n, spender: getAddress(PAYEE) });
    expect(declaredAmount(decodeAgentOp(encodeAgentOp({ target: PAYEE, value: 5n })))).toEqual({ asset: '0x0000000000000000000000000000000000000000', amount: 5n });
  });
});

describe('reason codes (docs/api.md 7.1)', () => {
  it('names codes and argument-rule details', () => {
    expect(REASON.APPROVAL).toBe(17);
    expect(REASON.PAYMASTER).toBe(20);
    expect(reasonName(REASON.TARGET)).toBe('TARGET');
    expect(reasonName(REASON.ARG_RULE | (2 << 8))).toBe('ARG_RULE(2)');
    expect(reasonName(99)).toBe('UNKNOWN_99');
  });
});
