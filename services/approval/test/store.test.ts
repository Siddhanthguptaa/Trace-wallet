import { describe, expect, it } from 'vitest';
import { type RequestRow, Store } from '../src/store.ts';
import { ACCOUNT, AGENT } from './helpers.ts';

function row(id: string, over: Partial<RequestRow> = {}): RequestRow {
  return {
    id,
    account: ACCOUNT,
    chainId: 31337,
    agent: AGENT,
    userOp: '{}',
    userOpHash: `0x${id.padStart(64, '0')}`,
    nonce: '7',
    note: '',
    approval: '{}',
    approvalHash: '0x01',
    simulation: '{}',
    status: 'pending',
    ownerSig: null,
    finalSig: null,
    txHash: null,
    success: null,
    blocked: null,
    reason: null,
    outflows: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 100,
    ...over,
  };
}

describe('Store (node:sqlite)', () => {
  it('inserts, reads, and finds by userOpHash case-insensitively', () => {
    const s = new Store();
    s.insert(row('a1'));
    expect(s.get('a1')).toMatchObject({ id: 'a1', status: 'pending', success: null, chainId: 31337 });
    expect(s.byUserOpHash(`0x${'a1'.padStart(64, '0')}`.toUpperCase().replace('0X', '0x') as `0x${string}`)?.id).toBe('a1');
    expect(() => s.insert(row('a2', { userOpHash: `0x${'a1'.padStart(64, '0')}` }))).toThrow();
  });

  it('update is a compare-and-set on status', () => {
    const s = new Store();
    s.insert(row('b1'));
    expect(s.update('b1', { status: 'approved', ownerSig: '0xaa' }, ['pending'])).toBe(true);
    expect(s.update('b1', { status: 'approved' }, ['pending'])).toBe(false);
    expect(s.update('b1', { status: 'executed', success: true, blocked: false }, ['approved'])).toBe(true);
    expect(s.get('b1')).toMatchObject({ status: 'executed', success: true, blocked: false, ownerSig: '0xaa' });
  });

  it('counts pending per key, lists by filter, finds same-nonce siblings', () => {
    const s = new Store();
    s.insert(row('c1'));
    s.insert(row('c2'));
    s.insert(row('c3', { status: 'executed' }));
    expect(s.pendingCount(ACCOUNT, AGENT)).toBe(2);
    expect(s.list({ status: 'executed' }).map((r) => r.id)).toEqual(['c3']);
    expect(s.pendingWithNonce(ACCOUNT, '7', 'c1').map((r) => r.id)).toEqual(['c2']);
  });

  it('attempt windows', () => {
    const s = new Store();
    s.addAttempt(ACCOUNT, AGENT, 'accepted', 10);
    s.addAttempt(ACCOUNT, AGENT, 'refused', 20);
    s.addAttempt(ACCOUNT, AGENT, 'rate_limited', 30);
    expect(s.attemptsSince(ACCOUNT, AGENT, 0)).toEqual({ accepted: 1, refused: 1, rate_limited: 1 });
    expect(s.attemptsSince(ACCOUNT, AGENT, 15)).toEqual({ accepted: 0, refused: 1, rate_limited: 1 });
  });
});
