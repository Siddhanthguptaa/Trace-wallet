import { createPublicClient, http, type Hex } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { describe, expect, it } from 'vitest';
import {
  BASE_CHAIN_ID,
  ENTRYPOINT_V08_ADDRESS,
  entryPointDomainSeparator,
  entryPointV08Abi,
  getUserOpHashV08,
  isEip7702InitCode,
  loadConfig,
  packUint128Pair,
  packUserOp,
  unpackUint128Pair,
  unpackUserOp,
  userOpStructHash,
  type UserOperationV08,
} from '../src/index.ts';
import { keccak256, concat } from 'viem';

const BASIC: UserOperationV08 = {
  sender: '0x1234567890123456789012345678901234567890',
  nonce: 7n,
  callData: '0xb61d27f60000000000000000000000000000000000000000000000000000000000000001',
  callGasLimit: 100_000n,
  verificationGasLimit: 250_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  signature: '0x',
};

const FULL: UserOperationV08 = {
  ...BASIC,
  nonce: (5n << 64n) | 3n,
  factory: '0x9999999999999999999999999999999999999999',
  factoryData: '0xdeadbeef',
  paymaster: '0x8888888888888888888888888888888888888888',
  paymasterVerificationGasLimit: 60_000n,
  paymasterPostOpGasLimit: 40_000n,
  paymasterData: '0xcafe',
  signature: '0x01',
};

/**
 * Recorded from the live Base EntryPoint v0.8 (0x4337...f108, chainId 8453) via eth_call
 * getUserOpHash during M0. Lets the parity check run offline.
 */
const LIVE_VECTORS: Record<'BASIC' | 'FULL', Hex> = {
  BASIC: '0xaa6d8f9e38f7895d54e9295a41a94344c7d469ff5753f11e2c8bc5a48c811c6e',
  FULL: '0x6c0063b416212d876bc5ee5774857899cc4611ff4de47371a56c61796694f5e2',
};

describe('packUserOp / unpackUserOp', () => {
  it('packs gas pairs as high128 << 128 | low128', () => {
    const p = packUserOp(BASIC);
    expect(unpackUint128Pair(p.accountGasLimits)).toEqual([250_000n, 100_000n]);
    expect(unpackUint128Pair(p.gasFees)).toEqual([1_000_000n, 2_000_000_000n]);
    expect(p.initCode).toBe('0x');
    expect(p.paymasterAndData).toBe('0x');
    expect(packUint128Pair(1n, 2n)).toBe(`0x${'0'.repeat(31)}1${'0'.repeat(31)}2`);
  });

  it('packs initCode and paymasterAndData (20 + 16 + 16 + data bytes)', () => {
    const p = packUserOp(FULL);
    expect(p.initCode).toBe('0x9999999999999999999999999999999999999999deadbeef');
    expect(p.paymasterAndData.length).toBe(2 + 2 * (20 + 16 + 16 + 2));
    expect(p.paymasterAndData.endsWith('cafe')).toBe(true);
  });

  it('round-trips', () => {
    expect(unpackUserOp(packUserOp(BASIC))).toEqual(BASIC);
    expect(unpackUserOp(packUserOp(FULL))).toEqual(FULL);
  });

  it('rejects values above uint128', () => {
    expect(() => packUserOp({ ...BASIC, callGasLimit: 1n << 128n })).toThrow(RangeError);
  });
});

describe('getUserOpHashV08', () => {
  it('equals keccak(0x1901 || domainSeparator || structHash) written out by hand', () => {
    for (const op of [BASIC, FULL]) {
      const p = packUserOp(op);
      const manual = keccak256(
        concat(['0x1901', entryPointDomainSeparator(ENTRYPOINT_V08_ADDRESS, BASE_CHAIN_ID), userOpStructHash(p)]),
      );
      expect(getUserOpHashV08(p, ENTRYPOINT_V08_ADDRESS, BASE_CHAIN_ID)).toBe(manual);
    }
  });

  it("matches viem's independent v0.8 implementation", () => {
    for (const op of [BASIC, FULL]) {
      const theirs = getUserOperationHash({
        chainId: BASE_CHAIN_ID,
        entryPointAddress: ENTRYPOINT_V08_ADDRESS,
        entryPointVersion: '0.8',
        userOperation: op,
      });
      expect(getUserOpHashV08(packUserOp(op), ENTRYPOINT_V08_ADDRESS, BASE_CHAIN_ID)).toBe(theirs);
    }
  });

  it('matches the recorded live EntryPoint v0.8 vectors (offline)', () => {
    expect(getUserOpHashV08(packUserOp(BASIC), ENTRYPOINT_V08_ADDRESS, BASE_CHAIN_ID)).toBe(LIVE_VECTORS.BASIC);
    expect(getUserOpHashV08(packUserOp(FULL), ENTRYPOINT_V08_ADDRESS, BASE_CHAIN_ID)).toBe(LIVE_VECTORS.FULL);
  });

  it('refuses EIP-7702 initCode', () => {
    expect(isEip7702InitCode('0x7702')).toBe(true);
    expect(isEip7702InitCode(`0x7702${'00'.repeat(18)}abcd`)).toBe(true);
    expect(isEip7702InitCode('0x9999999999999999999999999999999999999999')).toBe(false);
    expect(() =>
      getUserOpHashV08({ ...packUserOp(BASIC), initCode: '0x7702' }, ENTRYPOINT_V08_ADDRESS, BASE_CHAIN_ID),
    ).toThrow(/7702/);
  });
});

describe('parity with the live EntryPoint v0.8 on Base (BASE_RPC)', () => {
  it('TypeScript hash == getUserOpHash via eth_call', { timeout: 60_000 }, async (ctx) => {
    const cfg = loadConfig();
    const client = createPublicClient({ transport: http(cfg.BASE_RPC, { timeout: 15_000, retryCount: 2 }) });
    const results: Record<string, { ts: Hex; live: Hex }> = {};
    try {
      for (const [name, op] of Object.entries({ BASIC, FULL })) {
        const p = packUserOp(op);
        const live = await client.readContract({
          address: cfg.ENTRYPOINT_V08 as `0x${string}`,
          abi: entryPointV08Abi,
          functionName: 'getUserOpHash',
          args: [p],
        });
        results[name] = { ts: getUserOpHashV08(p, cfg.ENTRYPOINT_V08 as `0x${string}`, BASE_CHAIN_ID), live };
      }
    } catch (err) {
      console.warn(`skip: BASE_RPC ${cfg.BASE_RPC} unreachable (${(err as Error).message.split('\n')[0]})`);
      ctx.skip();
      return;
    }
    console.info(`live EntryPoint v0.8 hashes: ${JSON.stringify(results)}`);
    for (const r of Object.values(results)) expect(r.ts).toBe(r.live);
  });
});
