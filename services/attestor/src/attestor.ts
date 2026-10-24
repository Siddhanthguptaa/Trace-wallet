/** The attestor service core: scoring cache, attestation, outcome reports, flag fan-out. */
import { type Address, getAddress } from 'viem';
import type { Tier } from '../../../packages/shared/src/attestor/tier.ts';
import type { AccountReader, FlagWriter, ReceiptVerifier } from './chain.ts';
import { FlagSender, type FlagResult } from './flagSender.ts';
import { ingest, type IngestResult } from './outcomes.ts';
import { AttestationSigner, type SignedAttestation } from './signer.ts';
import type { Store } from './store.ts';
import { type PayeeProfile, coldProfile, scoreAll } from './trace/engine.ts';

export type AttestorMode = 'trace' | 'scripted';

export interface AttestorOptions {
  chainId: number;
  signer: AttestationSigner;
  store: Store;
  reader?: AccountReader | null;
  writer?: FlagWriter | null;
  receipts?: ReceiptVerifier | null;
  verifiers?: Address[];
  agents?: Address[];
  /** "scripted" = D3-lite fallback (BUILD M6): real signatures, fixed tiers, no TRACE scoring. */
  mode?: AttestorMode;
  scriptedTiers?: Record<string, Tier>;
  /** epoch used when no account reader is configured (scripted/local tests only). */
  defaultEpoch?: bigint;
  roundSeconds?: number;
  /** unix seconds */
  now?: () => number;
  wallets?: Address[];
  log?: (m: string) => void;
}

export class EpochUnavailableError extends Error {}

export type AttestResult =
  | { kind: 'attestation'; tier: 'PROVEN'; code: string | null; reason: string; signed: SignedAttestation }
  | { kind: 'none'; tier: Tier; code: string | null; reason: string; flag?: FlagResult };

export type ReportResult = IngestResult & { tier?: Tier; code?: string | null; flags?: FlagResult[] };

export class Attestor {
  readonly chainId: number;
  readonly signer: AttestationSigner;
  readonly store: Store;
  readonly mode: AttestorMode;
  readonly flagSender: FlagSender;
  private reader: AccountReader | null;
  private receipts: ReceiptVerifier | null;
  private verifiers: Set<string>;
  private agents: Set<string>;
  private scripted: Map<string, Tier>;
  private defaultEpoch: bigint;
  private roundSeconds: number;
  private now: () => number;
  private cache: { version: number; profiles: Map<Address, PayeeProfile> } | null = null;

  constructor(o: AttestorOptions) {
    this.chainId = o.chainId;
    this.signer = o.signer;
    this.store = o.store;
    this.mode = o.mode ?? 'trace';
    this.reader = o.reader ?? null;
    this.receipts = o.receipts ?? null;
    this.verifiers = new Set((o.verifiers ?? []).map((a) => a.toLowerCase()));
    this.agents = new Set((o.agents ?? []).map((a) => a.toLowerCase()));
    this.scripted = new Map(Object.entries(o.scriptedTiers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.defaultEpoch = o.defaultEpoch ?? 1n;
    this.roundSeconds = o.roundSeconds ?? 3600;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    for (const w of o.wallets ?? []) this.store.addWallet(w);
    this.flagSender = new FlagSender({ store: o.store, writer: o.writer ?? null, reader: this.reader, attestor: o.signer.address, log: o.log });
  }

  profiles(): Map<Address, PayeeProfile> {
    if (this.mode === 'scripted') return new Map();
    if (!this.cache || this.cache.version !== this.store.version) {
      this.cache = { version: this.store.version, profiles: scoreAll(this.store.outcomes(), { roundSeconds: this.roundSeconds }) };
    }
    return this.cache.profiles;
  }

  profile(payee: Address): PayeeProfile {
    const p = payee.toLowerCase() as Address;
    if (this.mode === 'scripted') {
      const tier = this.scripted.get(p) ?? 'UNPROVEN';
      const code = tier === 'PROVEN' ? 'ROUTE' : tier === 'FLAGGED' ? 'QUARANTINE' : null;
      return { ...coldProfile(p), tier, code, reason: `scripted:${tier}` };
    }
    return this.profiles().get(p) ?? coldProfile(p);
  }

  async epochOf(wallet: Address): Promise<bigint> {
    if (!this.reader) return this.defaultEpoch;
    try {
      return await this.reader.attestEpoch(wallet);
    } catch (e) {
      throw new EpochUnavailableError(`cannot read attestEpoch() of ${wallet}: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  async attest(wallet: Address, payee: Address): Promise<AttestResult> {
    const w = getAddress(wallet);
    const p = getAddress(payee);
    this.store.addWallet(w, this.now());
    const prof = this.profile(p);
    if (prof.tier === 'PROVEN') {
      const epoch = await this.epochOf(w);
      const signed = await this.signer.signProven({ chainId: this.chainId, wallet: w, recipient: p, epoch, nowSeconds: this.now() });
      return { kind: 'attestation', tier: 'PROVEN', code: prof.code, reason: prof.reason, signed };
    }
    if (prof.tier === 'FLAGGED') {
      const flag = await this.flagSender.ensureFlagged(w, p);
      return { kind: 'none', tier: 'FLAGGED', code: prof.code, reason: prof.reason, flag };
    }
    return { kind: 'none', tier: prof.tier, code: prof.code, reason: prof.reason };
  }

  async report(body: unknown): Promise<ReportResult> {
    const r = await ingest(body, {
      chainId: this.chainId,
      verifiers: this.verifiers,
      agents: this.agents,
      reader: this.reader,
      receipts: this.receipts,
      now: this.now,
      has: (id) => this.store.hasOutcome(id),
    });
    if (r.status !== 'accepted') return r;
    if (!this.store.addOutcome(r.record)) return { status: 'duplicate', id: r.record.id };
    const prof = this.profile(r.record.payee);
    const flags = await this.syncFlags();
    return { ...r, tier: prof.tier, code: prof.code, flags };
  }

  /** flag(payee) on every known wallet for every FLAGGED payee (idempotent). */
  async syncFlags(): Promise<FlagResult[]> {
    const wallets = this.store.wallets();
    const out: FlagResult[] = [];
    for (const prof of this.profiles().values()) {
      if (prof.tier === 'FLAGGED') out.push(...(await this.flagSender.flagEverywhere(prof.payee, wallets)));
    }
    if (this.mode === 'scripted') {
      for (const [payee, tier] of this.scripted) {
        if (tier === 'FLAGGED') out.push(...(await this.flagSender.flagEverywhere(payee as Address, wallets)));
      }
    }
    return out;
  }
}
