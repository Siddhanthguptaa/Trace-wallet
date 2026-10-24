import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Read-only cross-check against the attestor's port of the same TRACE functions (itself checked
// against the vendored Trace_CIKM fork to 1e-12 by lane ATT).
import * as att from '../../attestor/src/trace/port.ts';
import {
  CUSUM_H,
  CUSUM_H_SENSITIVE,
  CUSUM_K,
  CUSUM_K_SENSITIVE,
  pageCusum,
  updateCUSUMScore,
  updateCUSUMSensitive,
} from '../src/cusum.ts';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('TRACE CUSUM port', () => {
  it('constants equal the attestor port', () => {
    assert.equal(CUSUM_K, att.CUSUM_K);
    assert.equal(CUSUM_H, att.CUSUM_H);
    assert.equal(CUSUM_K_SENSITIVE, att.CUSUM_K_SENSITIVE);
    assert.equal(CUSUM_H_SENSITIVE, att.CUSUM_H_SENSITIVE);
  });

  it('updates equal the attestor port on 5 random outcome streams of 400', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const r = lcg(seed);
      const pFail = 0.05 + 0.15 * seed;
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      for (let i = 0; i < 400; i++) {
        const o: 0 | 1 = r() < pFail ? 0 : 1;
        const mine = updateCUSUMScore(a, o);
        const theirs = att.updateCUSUMScore(b, o);
        assert.deepEqual(mine, theirs);
        const mineS = updateCUSUMSensitive(c, o);
        const theirsS = att.updateCUSUMSensitive(d, o);
        assert.deepEqual(mineS, theirsS);
        [a, b, c, d] = [mine.newScore, theirs.newScore, mineS.newScore, theirsS.newScore];
      }
    }
  });

  it('hand vectors: 7 straight failures alarm, 6 do not; a success drains 0.375', () => {
    let s = 0;
    for (let i = 0; i < 6; i++) s = updateCUSUMScore(s, 0).newScore;
    assert.equal(s, 3.75);
    assert.equal(updateCUSUMScore(s, 0).alarm, true);
    assert.equal(updateCUSUMScore(s, 1).newScore, 3.375);
    assert.equal(updateCUSUMScore(0, 1).newScore, 0);
    assert.equal(updateCUSUMScore(Number.NaN, 0).newScore, 0.625);
  });

  it('pageCusum is the same recursion with a real-valued observation', () => {
    const r = lcg(42);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < 200; i++) {
      const o: 0 | 1 = r() < 0.4 ? 0 : 1;
      const t = updateCUSUMScore(s1, o);
      const p = pageCusum(s2, 1 - o, 1 - CUSUM_K, CUSUM_H);
      assert.ok(Math.abs(t.newScore - p.newScore) < 1e-3, `step ${i}`);
      assert.equal(t.alarm, p.alarm);
      s1 = t.newScore;
      s2 = t.newScore; // follow TRACE's rounded path
    }
    const p = pageCusum(0.2, 0.5, 0.1, 0.5);
    assert.ok(Math.abs(p.newScore - 0.6) < 1e-12 && p.alarm);
    assert.ok(Math.abs(pageCusum(0.2, Number.NaN, 0.1, 0.5).newScore - 0.1) < 1e-12);
    assert.equal(pageCusum(0.05, 0, 0.1, 0.5).newScore, 0);
  });
});
