import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packUserOp, type UserOperationV08 } from '../userop.ts';
import {
  AGENT_PAYMASTER_MIN_POSTOP_GAS,
  GAS_FIELD,
  QuotaExceededError,
  agentPaymasterAbi,
  agentPaymasterFields,
  buildPaymasterAndData,
  decodePaymasterAndData,
  gasCapViolations,
  quotaAvailableAt,
  quotaValidAfter,
  requiredPrefund,
  type AgentPaymasterGasCaps,
  type AgentQuotaState,
} from './index.ts';

const PM = '0xA4AD4f68d0b91CFD19687c881e50f3A00242828c';
const VECTORS = fileURLToPath(new URL('../../../../results/m12_paymaster_vectors.json', import.meta.url));

const caps: AgentPaymasterGasCaps = {
  maxFeePerGas: 2_000_000_000n,
  callGasLimit: 1_000_000n,
  verificationGasLimit: 500_000n,
  preVerificationGas: 100_000n,
  paymasterVerificationGasLimit: 150_000n,
  paymasterPostOpGasLimit: 100_000n,
};

const gas = {
  callGasLimit: 300_000n,
  verificationGasLimit: 150_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymasterVerificationGasLimit: 80_000n,
  paymasterPostOpGasLimit: 50_000n,
};

describe('paymasterAndData', () => {
  it('round-trips and matches packUserOp', () => {
    const pmd = buildPaymasterAndData({ paymaster: PM, verificationGasLimit: 80_000n, postOpGasLimit: 50_000n });
    expect(decodePaymasterAndData(pmd)).toEqual({
      paymaster: PM,
      verificationGasLimit: 80_000n,
      postOpGasLimit: 50_000n,
      data: '0x',
    });
    const op: UserOperationV08 = {
      sender: PM,
      nonce: 0n,
      callData: '0x',
      signature: '0x',
      ...gas,
      ...agentPaymasterFields({ paymaster: PM, verificationGasLimit: 80_000n, postOpGasLimit: 50_000n }),
    };
    expect(packUserOp(op).paymasterAndData).toBe(pmd);
    expect(decodePaymasterAndData(buildPaymasterAndData({ paymaster: PM, data: '0x1234' })).data).toBe('0x1234');
  });

  it('rejects bad input', () => {
    expect(() => decodePaymasterAndData('0x1234')).toThrow();
    expect(() => buildPaymasterAndData({ paymaster: PM, postOpGasLimit: 1n << 128n })).toThrow(RangeError);
  });
});

describe('gas caps and prefund', () => {
  it('requiredPrefund = sum of gas limits x maxFeePerGas', () => {
    expect(requiredPrefund(gas)).toBe(630_000n * 1_000_000_000n);
  });

  it('flags every field above its cap and the postOp floor', () => {
    expect(gasCapViolations(gas, caps)).toEqual([]);
    expect(gasCapViolations({ ...gas, maxFeePerGas: caps.maxFeePerGas + 1n }, caps)[0]).toMatchObject({
      field: GAS_FIELD.MAX_FEE_PER_GAS,
      kind: 'cap',
    });
    expect(gasCapViolations({ ...gas, callGasLimit: caps.callGasLimit + 1n }, caps)[0]?.field).toBe(GAS_FIELD.CALL_GAS);
    expect(gasCapViolations({ ...gas, paymasterPostOpGasLimit: 101_000n }, caps)[0]?.field).toBe(GAS_FIELD.PM_POSTOP_GAS);
    expect(gasCapViolations({ ...gas, paymasterPostOpGasLimit: AGENT_PAYMASTER_MIN_POSTOP_GAS - 1n }, caps)).toEqual([
      { field: GAS_FIELD.PM_POSTOP_GAS, value: AGENT_PAYMASTER_MIN_POSTOP_GAS - 1n, cap: AGENT_PAYMASTER_MIN_POSTOP_GAS, kind: 'postOpFloor' },
    ]);
  });
});

describe('quota admission (mirrors AgentPaymaster._admit + lib/Buckets)', () => {
  const q: AgentQuotaState = {
    burst: 5_000_000_000_000_000n,
    ratePerDay: 5_000_000_000_000_000n,
    level: 100_000_000_000_000n,
    lastRefill: 1_800_000_000n,
    pending: 0n,
  };
  const maxCost = 630_000_000_000_000n;

  it('validAfter is the first second the bucket holds the need, minus 1', () => {
    const va = quotaValidAfter(q, maxCost);
    expect(quotaAvailableAt(q, va + 1n)).toBeGreaterThanOrEqual(maxCost);
    expect(quotaAvailableAt(q, va)).toBeLessThan(maxCost);
    expect(quotaValidAfter({ ...q, level: maxCost }, maxCost)).toBe(0n);
  });

  it('refuses what can never fit', () => {
    expect(() => quotaValidAfter({ ...q, burst: maxCost - 1n }, maxCost)).toThrow(QuotaExceededError);
    expect(() => quotaValidAfter({ ...q, ratePerDay: 0n }, maxCost)).toThrow(QuotaExceededError);
    expect(() => quotaValidAfter({ ...q, pending: q.burst }, 1n)).toThrow(QuotaExceededError);
  });

  it('available caps at burst and subtracts holds', () => {
    expect(quotaAvailableAt(q, q.lastRefill + 30n * 86_400n)).toBe(q.burst);
    expect(quotaAvailableAt({ ...q, pending: 1n }, q.lastRefill)).toBe(q.level - 1n);
  });

  it.runIf(existsSync(VECTORS))('matches the forge vectors (results/m12_paymaster_vectors.json)', () => {
    const v = JSON.parse(readFileSync(VECTORS, 'utf8'));
    const pmd = buildPaymasterAndData({
      paymaster: v.paymaster,
      verificationGasLimit: BigInt(v.paymasterVerificationGasLimit),
      postOpGasLimit: BigInt(v.paymasterPostOpGasLimit),
    });
    expect(pmd.toLowerCase()).toBe(String(v.paymasterAndData).toLowerCase());
    const prefund = requiredPrefund({
      callGasLimit: BigInt(v.callGasLimit),
      verificationGasLimit: BigInt(v.verificationGasLimit),
      preVerificationGas: BigInt(v.preVerificationGas),
      maxFeePerGas: BigInt(v.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(v.maxFeePerGas),
      paymasterVerificationGasLimit: BigInt(v.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: BigInt(v.paymasterPostOpGasLimit),
    });
    expect(prefund).toBe(BigInt(v.maxCost));
    const va = quotaValidAfter(
      {
        burst: BigInt(v.burst),
        ratePerDay: BigInt(v.ratePerDay),
        level: BigInt(v.level),
        lastRefill: BigInt(v.lastRefill),
        pending: BigInt(v.pending),
      },
      prefund,
    );
    expect(va).toBe(BigInt(v.validAfter));
  });

  it('ABI parses', () => {
    expect(agentPaymasterAbi.some((x) => x.type === 'function' && x.name === 'registerAgent')).toBe(true);
  });
});
