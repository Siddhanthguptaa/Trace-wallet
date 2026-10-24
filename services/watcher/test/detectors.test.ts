import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Address } from 'viem';
import { DEFAULT_CONFIG, Watcher, type WatcherEvent, capFraction, replay } from '../src/detectors.ts';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
const OTHER = '0x00000000000000000000000000000000000000aa' as Address;
const KEY = '0x1111111111111111111111111111111111111111' as Address;
const KEY2 = '0x2222222222222222222222222222222222222222' as Address;
const CAP = 20_000_000n; // demo: 10 USDC burst + 10 USDC / day
const T0 = 1_800_000_000; // a 5-minute bin boundary
const capOf = (a: Address) => (a.toLowerCase() === USDC.toLowerCase() ? CAP : undefined);
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const spend = (ts: number, amount: bigint, agentKey = KEY, asset = USDC): WatcherEvent => ({ kind: 'spend', agentKey, asset, amount, ts });
const outcome = (ts: number, ok: boolean, agentKey = KEY): WatcherEvent => ({ kind: 'outcome', agentKey, ok, ts });

/** Brute-force Page CUSUM over explicit bins (the reference the incremental code must match). */
function bruteSpendScore(events: Array<[number, number]>, tEnd: number) {
  const { binSeconds, k } = DEFAULT_CONFIG.spend;
  const kb = (k * binSeconds) / 86400;
  const first = Math.floor(events[0]![0] / binSeconds);
  const last = Math.floor(tEnd / binSeconds);
  let s = 0;
  for (let b = first; b <= last; b++) {
    const x = events.filter(([t]) => Math.floor(t / binSeconds) === b).reduce((acc, [, f]) => acc + f, 0);
    s = Math.max(0, s + x - kb);
  }
  return s;
}

describe('spend CUSUM', () => {
  it('matches a brute-force per-bin CUSUM on a random stream', () => {
    const w = new Watcher(capOf, { spend: { h: 1e9 } }); // never alarm; compare scores
    const evs: Array<[number, number]> = [];
    let t = T0;
    let seed = 7;
    for (let i = 0; i < 300; i++) {
      seed = (seed * 48271) % 2147483647;
      t += seed % 900; // 0-15 min gaps, several events per bin
      const amt = usdc(((seed >> 3) % 2000) / 1000); // 0-2 USDC
      w.observe(spend(t, amt));
      evs.push([t, capFraction(amt, CAP)]);
      if (i % 37 === 0) {
        const snap = w.snapshot(KEY, t)!;
        assert.ok(Math.abs((snap.spend[USDC.toLowerCase()] ?? 0) - bruteSpendScore(evs, t)) < 1e-9, `event ${i}`);
      }
    }
    const tEnd = t + 7200;
    assert.ok(Math.abs((w.snapshot(KEY, tEnd)!.spend[USDC.toLowerCase()] ?? 0) - bruteSpendScore(evs, tEnd)) < 1e-9);
  });

  it('H1 burst: alarms once the excess passes h of the daily cap (6.28 USDC in one bin)', () => {
    const w = new Watcher(capOf);
    assert.equal(w.observe(spend(T0, usdc(3))).length, 0);
    assert.equal(w.observe(spend(T0 + 10, usdc(3.2))).length, 0); // 6.2 USDC: S = 0.31 - 0.0139 < 0.3
    const a = w.observe(spend(T0 + 20, usdc(0.2)));
    assert.equal(a.length, 1);
    assert.equal(a[0]!.detector, 'spend_cusum');
    assert.ok(a[0]!.value > DEFAULT_CONFIG.spend.h);
    assert.equal(w.observe(spend(T0 + 30, usdc(5))).length, 0, 'one alarm per detector until reset');
  });

  it('L1 steady shopping (2 USDC every 2 h for a day) never alarms', () => {
    const w = new Watcher(capOf);
    for (let i = 0; i < 12; i++) assert.equal(w.observe(spend(T0 + i * 7200, usdc(2))).length, 0);
  });

  it('L4 heavy x402 use (0.1 USDC every minute for 2 h = 12 USDC) never alarms', () => {
    const w = new Watcher(capOf);
    for (let i = 0; i < 120; i++) assert.equal(w.observe(spend(T0 + i * 60, usdc(0.1))).length, 0);
  });

  it('ignores assets without a cap, zero amounts, and keys are separate', () => {
    const w = new Watcher(capOf);
    assert.equal(w.observe(spend(T0, 10n ** 30n, KEY, OTHER)).length, 0);
    assert.equal(w.observe(spend(T0, 0n)).length, 0);
    w.observe(spend(T0, usdc(5)));
    assert.equal(w.observe(spend(T0 + 1, usdc(5), KEY2)).length, 0, 'KEY2 has its own CUSUM');
  });

  it('empty bins drain the statistic', () => {
    const w = new Watcher(capOf);
    w.observe(spend(T0, usdc(5))); // S = 0.25 - 0.0139
    assert.equal(w.observe(spend(T0 + 6 * 3600, usdc(5))).length, 0, 'drained after 6 h');
  });
});

describe('revert detectors', () => {
  it('revert_streak alarms on the 4th failure in a row; a success resets the streak', () => {
    const w = new Watcher(capOf);
    for (let i = 0; i < 3; i++) assert.equal(w.observe(outcome(T0 + i, false)).length, 0);
    w.observe(outcome(T0 + 3, true));
    for (let i = 0; i < 3; i++) assert.equal(w.observe(outcome(T0 + 10 + i, false)).length, 0);
    const a = w.observe(outcome(T0 + 20, false));
    assert.deepEqual(
      a.map((x) => x.detector),
      ['revert_streak'],
    );
  });

  it('revert_cusum (TRACE) catches a 50% failure rate the streak misses', () => {
    const w = new Watcher(capOf);
    const fired: string[] = [];
    for (let i = 0; i < 200; i++) {
      // fail, fail, ok, ok, fail, ok ... never 4 in a row
      const ok = [false, false, true, true, false, true][i % 6]!;
      fired.push(...w.observe(outcome(T0 + i, ok)).map((x) => x.detector));
    }
    assert.deepEqual(fired, ['revert_cusum']);
  });

  it('a mostly-legit agent (5% failures) never trips revert_cusum', () => {
    const w = new Watcher(capOf);
    for (let i = 0; i < 400; i++) assert.equal(w.observe(outcome(T0 + i, i % 20 !== 7)).length, 0);
  });
});

describe('approval_rate', () => {
  it('alarms on the 7th request within an hour, not on 6 per hour', () => {
    const w = new Watcher(capOf);
    for (let i = 0; i < 6; i++) assert.equal(w.observe({ kind: 'approval_request', agentKey: KEY, ts: T0 + i * 60 }).length, 0);
    // the window slides: one hour after the first, the 7th is fine
    assert.equal(w.observe({ kind: 'approval_request', agentKey: KEY, ts: T0 + 3600 }).length, 0);
    const a = w.observe({ kind: 'approval_request', agentKey: KEY, ts: T0 + 3601 });
    assert.equal(a.length, 1);
    assert.equal(a[0]!.detector, 'approval_rate');
  });
});

describe('lifecycle', () => {
  it('unfrozen resets every detector of that key; frozen is tracked', () => {
    const w = new Watcher(capOf);
    w.observe({ kind: 'frozen', agentKey: KEY, ts: T0 });
    assert.equal(w.isFrozen(KEY), true);
    assert.equal(w.observe(spend(T0, usdc(9))).length, 1, 'alarms still reported while frozen (X6 timing)');
    w.observe({ kind: 'unfrozen', agentKey: KEY, ts: T0 + 1 });
    assert.equal(w.isFrozen(KEY), false);
    assert.equal(w.snapshot(KEY, T0 + 1), null);
    assert.equal(w.observe(spend(T0 + 2, usdc(9))).length, 1, 'fresh state alarms again');
  });

  it('replay returns alarms with event indices and honours overrides', () => {
    const evs: WatcherEvent[] = [spend(T0, usdc(1)), spend(T0 + 1, usdc(1)), outcome(T0 + 2, false), outcome(T0 + 3, false)];
    const out = replay(evs, capOf, { spend: { h: 0.05 }, revert: { streakMax: 2 } });
    assert.deepEqual(
      out.map((a) => [a.index, a.detector]),
      [
        [1, 'spend_cusum'],
        [3, 'revert_streak'],
      ],
    );
    assert.equal(DEFAULT_CONFIG.spend.h, 0.3, 'overrides do not leak into the defaults');
  });
});
