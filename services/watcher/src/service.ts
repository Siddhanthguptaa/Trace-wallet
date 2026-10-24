/**
 * WatcherService: per-account detectors (detectors.ts) fed by the chain source and by approval-request
 * reports, and a freeze sender that turns an alarm into a freeze tx through the watcher role.
 */
import { type Address, getAddress } from 'viem';
import type { AccountReader } from './chain.ts';
import type { ChainSource, DecodedEvent } from './chain.ts';
import { type Alarm, Watcher, type WatcherConfig, type WatcherEvent } from './detectors.ts';
import type { FreezeResult, FreezeSender } from './freezer.ts';

export type ConfigOverride = Partial<{ [K in keyof WatcherConfig]: Partial<WatcherConfig[K]> }>;

export interface AlarmRecord {
  account: Address;
  alarm: Alarm;
  freeze: FreezeResult | null;
}

export class WatcherService {
  private readonly watchers = new Map<string, Watcher>();
  private readonly caps = new Map<string, bigint>(); // `${account}:${asset}` -> 24 h global cap
  private readonly accounts: Address[];
  private readonly config: ConfigOverride | undefined;
  private readonly reader: AccountReader | null;
  private readonly freezer: FreezeSender;
  private readonly source: ChainSource | null;
  private readonly staticCaps: Record<string, bigint>;
  private readonly log?: (m: string) => void;
  /** freezes that failed (RPC error); retried on every tick until sent or the key is seen frozen */
  private readonly retry = new Map<string, { account: Address; agentKey: Address; why: string }>();
  readonly alarms: AlarmRecord[] = [];

  constructor(opts: {
    accounts: Address[];
    freezer: FreezeSender;
    reader?: AccountReader | null;
    source?: ChainSource | null;
    config?: ConfigOverride;
    /** asset -> cap override (used when no reader, or to pin caps in tests) */
    caps?: Record<string, bigint>;
    log?: (m: string) => void;
  }) {
    this.accounts = opts.accounts.map((a) => getAddress(a));
    this.freezer = opts.freezer;
    this.reader = opts.reader ?? null;
    this.source = opts.source ?? null;
    this.config = opts.config;
    this.staticCaps = Object.fromEntries(Object.entries(opts.caps ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.log = opts.log;
  }

  watcherOf(account: Address): Watcher {
    const k = account.toLowerCase();
    let w = this.watchers.get(k);
    if (!w) {
      w = new Watcher((asset) => this.caps.get(`${k}:${asset.toLowerCase()}`), this.config);
      this.watchers.set(k, w);
    }
    return w;
  }

  private async ensureCap(account: Address, asset: Address) {
    const key = `${account.toLowerCase()}:${asset.toLowerCase()}`;
    if (this.caps.has(key)) return;
    const pinned = this.staticCaps[asset.toLowerCase()];
    if (pinned !== undefined) {
      this.caps.set(key, pinned);
      return;
    }
    if (!this.reader) return;
    const cap = await this.reader.globalCap(account, asset).catch(() => undefined);
    if (cap !== undefined) this.caps.set(key, cap);
  }

  /** Feed events of one account; sends a freeze for every new alarm on a key not yet frozen. */
  async ingest(account: Address, events: WatcherEvent[]): Promise<AlarmRecord[]> {
    const w = this.watcherOf(account);
    const raised: AlarmRecord[] = [];
    for (const e of events) {
      if (e.kind === 'spend') await this.ensureCap(account, e.asset);
      if (e.kind === 'unfrozen') {
        this.freezer.forget(account, e.agentKey);
        this.retry.delete(`${account.toLowerCase()}:${e.agentKey.toLowerCase()}`);
      }
      for (const alarm of w.observe(e)) {
        const rec: AlarmRecord = { account: getAddress(account), alarm, freeze: null };
        if (!w.isFrozen(alarm.agentKey)) {
          const why = `${alarm.detector}: ${alarm.detail}`;
          rec.freeze = await this.freezer.ensureFrozen(account, alarm.agentKey, why);
          if (rec.freeze.status === 'sent' || rec.freeze.status === 'already') {
            w.observe({ kind: 'frozen', agentKey: alarm.agentKey, ts: alarm.ts });
          } else if (rec.freeze.status === 'error') {
            this.retry.set(`${account.toLowerCase()}:${alarm.agentKey.toLowerCase()}`, { account, agentKey: alarm.agentKey, why });
          }
        }
        this.log?.(`alarm ${alarm.detector} key=${alarm.agentKey} account=${account} -> ${rec.freeze?.status ?? 'already frozen'}`);
        this.alarms.push(rec);
        raised.push(rec);
      }
    }
    return raised;
  }

  async ingestDecoded(decoded: DecodedEvent[]): Promise<AlarmRecord[]> {
    const out: AlarmRecord[] = [];
    for (const d of decoded) out.push(...(await this.ingest(d.account, [d.event])));
    return out;
  }

  /** An owner-approval request reported by the approval service (or the agent tools layer). */
  approvalRequest(account: Address, agentKey: Address, ts = Math.floor(Date.now() / 1000)): Promise<AlarmRecord[]> {
    return this.ingest(account, [{ kind: 'approval_request', agentKey, ts }]);
  }

  /** Retry failed freezes, then one poll of the chain source. */
  async tick(): Promise<AlarmRecord[]> {
    for (const [k, r] of [...this.retry]) {
      const w = this.watcherOf(r.account);
      if (w.isFrozen(r.agentKey)) {
        this.retry.delete(k);
        continue;
      }
      const res = await this.freezer.ensureFrozen(r.account, r.agentKey, r.why);
      if (res.status !== 'error') this.retry.delete(k);
      if (res.status === 'sent' || res.status === 'already') w.observe({ kind: 'frozen', agentKey: r.agentKey, ts: Math.floor(Date.now() / 1000) });
    }
    if (!this.source) return [];
    return this.ingestDecoded(await this.source.poll());
  }

  pendingRetries(): number {
    return this.retry.size;
  }

  state(ts = Math.floor(Date.now() / 1000)) {
    const accounts: Record<string, Record<string, unknown>> = {};
    for (const [acc, w] of this.watchers) {
      accounts[acc] = Object.fromEntries(w.keysSeen().map((k) => [k, w.snapshot(k as Address, ts)]));
    }
    return {
      accounts,
      watched: this.accounts,
      alarms: this.alarms.map((r) => ({ account: r.account, ...r.alarm, freeze: r.freeze?.status ?? 'already_frozen' })),
    };
  }
}
