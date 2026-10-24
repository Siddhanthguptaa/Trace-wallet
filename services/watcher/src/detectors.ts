/**
 * Off-chain hijack detectors for one wallet (EXPERIMENTS X6, IDEA 13 "Watcher service").
 *
 * Three detector families, each reported separately (X6 reports them separately and combined):
 *  - spend_cusum: one-sided Page CUSUM on the agent's binned spend stream, per (agent key, asset).
 *    x_t = spend in bin t / the asset's 24 h global cap (burst + ratePerDay), reference value
 *    k_bin = k * binSeconds / 86400 (k = multiple of the cap's sustainable rate), alarm iff S > h
 *    (h in fractions of the daily cap). Empty bins count as x = 0. Exact per-bin recursion.
 *  - revert_streak / revert_cusum: on the per-op outcome stream (Decision = ok; PolicyBlocked or a
 *    reverted UserOp = failure): a consecutive-failure streak, and TRACE's default-risk Bernoulli CUSUM
 *    (ported verbatim, cusum.ts) with alarm threshold `cusumH`.
 *  - approval_rate: owner-approval requests per sliding window (H8 approval fatigue).
 *
 * Alarms fire once per (key, detector) until the owner unfreezes the key (an `unfrozen` event resets
 * every detector of that key). Alarms keep firing after a freeze so X6 can time each detector.
 * The thresholds below are placeholders: lane X1 fixes them on dev seeds 1-3 (X6), never on scored seeds.
 */
import type { Address } from 'viem';
import { CUSUM_H, pageCusum, updateCUSUMScore } from './cusum.ts';

export type DetectorName = 'spend_cusum' | 'revert_streak' | 'revert_cusum' | 'approval_rate';

export interface WatcherConfig {
  spend: {
    /** bin width of the spend stream (s) */
    binSeconds: number;
    /** reference value as a multiple of the cap's sustainable rate (cap / 24 h) */
    k: number;
    /** alarm threshold, in fractions of the asset's 24 h global cap */
    h: number;
  };
  revert: {
    /** alarm at this many consecutive failed agent ops */
    streakMax: number;
    /** alarm threshold of TRACE's outcome CUSUM (TRACE default 4.2) */
    cusumH: number;
  };
  approval: {
    windowSeconds: number;
    /** alarm when more than `max` approval requests fall in the window */
    max: number;
  };
}

/**
 * Documented defaults (placeholders until X1 fixes them on dev seeds). Demo policy (cap 20 USDC / 24 h):
 * spend_cusum drains 4 x 20 / 24 = 3.33 USDC per hour and alarms once the excess passes 6 USDC
 * (e.g. 6.3 USDC within 5 minutes, 7.7 within 30 minutes); revert_streak alarms on the 4th failure in a
 * row; revert_cusum (TRACE K 0.625, H 4.2) after 7 straight failures or a sustained >= 37.5% failure rate;
 * approval_rate on the 7th request within an hour.
 */
export const DEFAULT_CONFIG: WatcherConfig = {
  spend: { binSeconds: 300, k: 4, h: 0.3 },
  revert: { streakMax: 4, cusumH: CUSUM_H },
  approval: { windowSeconds: 3600, max: 6 },
};

export type WatcherEvent =
  | { kind: 'spend'; agentKey: Address; asset: Address; amount: bigint; ts: number }
  | { kind: 'outcome'; agentKey: Address; ok: boolean; ts: number; why?: string }
  | { kind: 'approval_request'; agentKey: Address; ts: number }
  | { kind: 'frozen'; agentKey: Address; ts: number; by?: Address }
  | { kind: 'unfrozen'; agentKey: Address; ts: number };

export interface Alarm {
  agentKey: Address;
  detector: DetectorName;
  ts: number;
  value: number;
  threshold: number;
  detail: string;
}

interface SpendState {
  /** S at the end of bin `bin - 1` */
  sBefore: number;
  /** current bin index */
  bin: number;
  /** sum of x (cap fractions) observed in the current bin */
  binSum: number;
}

interface KeyState {
  spend: Map<string, SpendState>;
  streak: number;
  traceCusum: number;
  approvals: number[];
  alarmed: Set<DetectorName>;
  frozen: boolean;
}

export type CapOf = (asset: Address) => bigint | undefined;

const lc = (a: string) => a.toLowerCase();

/** Cap fraction of `amount` (6-decimal precision is plenty for thresholds of ~0.01). */
export function capFraction(amount: bigint, cap: bigint): number {
  if (cap <= 0n) return 0;
  return Number((amount * 1_000_000n) / cap) / 1_000_000;
}

function mergeConfig(c?: Partial<{ [K in keyof WatcherConfig]: Partial<WatcherConfig[K]> }>): WatcherConfig {
  return {
    spend: { ...DEFAULT_CONFIG.spend, ...(c?.spend ?? {}) },
    revert: { ...DEFAULT_CONFIG.revert, ...(c?.revert ?? {}) },
    approval: { ...DEFAULT_CONFIG.approval, ...(c?.approval ?? {}) },
  };
}

export class Watcher {
  readonly config: WatcherConfig;
  private readonly capOf: CapOf;
  private readonly keys = new Map<string, KeyState>();

  constructor(capOf: CapOf, config?: Partial<{ [K in keyof WatcherConfig]: Partial<WatcherConfig[K]> }>) {
    this.capOf = capOf;
    this.config = mergeConfig(config);
  }

  private key(agentKey: Address): KeyState {
    const k = lc(agentKey);
    let s = this.keys.get(k);
    if (!s) {
      s = { spend: new Map(), streak: 0, traceCusum: 0, approvals: [], alarmed: new Set(), frozen: false };
      this.keys.set(k, s);
    }
    return s;
  }

  private kBin(): number {
    const { k, binSeconds } = this.config.spend;
    return (k * binSeconds) / 86400;
  }

  /** Spend CUSUM state rolled to bin `bin` (pure; does not mutate). */
  private rolled(st: SpendState, bin: number): SpendState {
    if (bin <= st.bin) return st;
    const kb = this.kBin();
    let s = Math.max(0, st.sBefore + st.binSum - kb); // close the current bin
    s = Math.max(0, s - kb * (bin - st.bin - 1)); // empty bins in between
    return { sBefore: s, bin, binSum: 0 };
  }

  private fire(out: Alarm[], s: KeyState, a: Alarm) {
    if (s.alarmed.has(a.detector)) return;
    s.alarmed.add(a.detector);
    out.push(a);
  }

  /** Feed one event; returns the alarms it raised (each detector at most once per key until reset). */
  observe(e: WatcherEvent): Alarm[] {
    const out: Alarm[] = [];
    if (e.kind === 'unfrozen') {
      this.keys.delete(lc(e.agentKey)); // owner intervened: fresh start for every detector
      return out;
    }
    const s = this.key(e.agentKey);
    switch (e.kind) {
      case 'frozen':
        s.frozen = true;
        break;
      case 'spend': {
        const cap = this.capOf(e.asset);
        if (cap === undefined || cap <= 0n || e.amount <= 0n) break;
        const { binSeconds, h } = this.config.spend;
        const bin = Math.floor(e.ts / binSeconds);
        const prev = s.spend.get(lc(e.asset)) ?? { sBefore: 0, bin, binSum: 0 };
        const st = this.rolled(prev, bin); // an out-of-order (older) event lands in the current bin
        st.binSum += capFraction(e.amount, cap);
        s.spend.set(lc(e.asset), st);
        const { newScore, alarm } = pageCusum(st.sBefore, st.binSum, this.kBin(), h);
        if (alarm) {
          this.fire(out, s, {
            agentKey: e.agentKey,
            detector: 'spend_cusum',
            ts: e.ts,
            value: newScore,
            threshold: h,
            detail: `spend CUSUM ${newScore.toFixed(4)} > ${h} of the daily cap (asset ${e.asset})`,
          });
        }
        break;
      }
      case 'outcome': {
        s.streak = e.ok ? 0 : s.streak + 1;
        s.traceCusum = updateCUSUMScore(s.traceCusum, e.ok ? 1 : 0).newScore;
        const { streakMax, cusumH } = this.config.revert;
        if (s.streak >= streakMax) {
          this.fire(out, s, {
            agentKey: e.agentKey,
            detector: 'revert_streak',
            ts: e.ts,
            value: s.streak,
            threshold: streakMax,
            detail: `${s.streak} failed agent ops in a row${e.why ? ` (last: ${e.why})` : ''}`,
          });
        }
        if (s.traceCusum > cusumH) {
          this.fire(out, s, {
            agentKey: e.agentKey,
            detector: 'revert_cusum',
            ts: e.ts,
            value: s.traceCusum,
            threshold: cusumH,
            detail: `TRACE outcome CUSUM ${s.traceCusum} > ${cusumH}`,
          });
        }
        break;
      }
      case 'approval_request': {
        const { windowSeconds, max } = this.config.approval;
        s.approvals.push(e.ts);
        s.approvals = s.approvals.filter((t) => t > e.ts - windowSeconds);
        if (s.approvals.length > max) {
          this.fire(out, s, {
            agentKey: e.agentKey,
            detector: 'approval_rate',
            ts: e.ts,
            value: s.approvals.length,
            threshold: max,
            detail: `${s.approvals.length} approval requests in ${windowSeconds} s`,
          });
        }
        break;
      }
    }
    return out;
  }

  isFrozen(agentKey: Address): boolean {
    return this.keys.get(lc(agentKey))?.frozen ?? false;
  }

  /** Detector state of one key at time `ts` (spend scores rolled to ts). */
  snapshot(agentKey: Address, ts: number) {
    const s = this.keys.get(lc(agentKey));
    if (!s) return null;
    const bin = Math.floor(ts / this.config.spend.binSeconds);
    const spend: Record<string, number> = {};
    for (const [asset, st] of s.spend) {
      const r = this.rolled(st, bin);
      spend[asset] = Math.max(0, r.sBefore + r.binSum - this.kBin());
    }
    const approvals = s.approvals.filter((t) => t > ts - this.config.approval.windowSeconds).length;
    return { spend, streak: s.streak, traceCusum: s.traceCusum, approvals, alarmed: [...s.alarmed], frozen: s.frozen };
  }

  keysSeen(): string[] {
    return [...this.keys.keys()];
  }
}

/** Offline replay (X6 runner): feed events in order, return every alarm with its event index. */
export function replay(
  events: WatcherEvent[],
  capOf: CapOf,
  config?: Partial<{ [K in keyof WatcherConfig]: Partial<WatcherConfig[K]> }>,
): Array<Alarm & { index: number }> {
  const w = new Watcher(capOf, config);
  const out: Array<Alarm & { index: number }> = [];
  events.forEach((e, index) => {
    for (const a of w.observe(e)) out.push({ ...a, index });
  });
  return out;
}
