/** Attestor store on the built-in node:sqlite (BUILD.md Conventions: no native builds). */
import { DatabaseSync } from 'node:sqlite';
import type { Address, Hex } from 'viem';
import type { OutcomeRecord } from './trace/engine.ts';

export interface FlagRow {
  wallet: Address;
  payee: Address;
  txHash: Hex | null;
  status: 'sent' | 'already';
  ts: number;
}

export class Store {
  private db: DatabaseSync;
  /** bumps on every accepted outcome; the scoring cache keys on it. */
  version = 0;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outcomes (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, wallet TEXT NOT NULL, payee TEXT NOT NULL,
        success INTEGER NOT NULL, amount TEXT NOT NULL, decimals INTEGER NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wallets (address TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS flags (
        wallet TEXT NOT NULL, payee TEXT NOT NULL, tx_hash TEXT, status TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY (wallet, payee));
    `);
    this.version = this.outcomeCount();
  }

  /** false if the id was already stored (replayed report). */
  addOutcome(r: OutcomeRecord): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO outcomes (id, source, wallet, payee, success, amount, decimals, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.source, r.wallet.toLowerCase(), r.payee.toLowerCase(), r.success ? 1 : 0, r.amount.toString(), r.decimals, r.ts);
    if (Number(res.changes) === 0) return false;
    this.version++;
    this.addWallet(r.wallet, r.ts);
    return true;
  }

  outcomes(): OutcomeRecord[] {
    const rows = this.db.prepare('SELECT * FROM outcomes ORDER BY ts, id').all() as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      id: String(r.id),
      source: String(r.source) as OutcomeRecord['source'],
      wallet: String(r.wallet) as Address,
      payee: String(r.payee) as Address,
      success: Number(r.success) === 1,
      amount: BigInt(String(r.amount)),
      decimals: Number(r.decimals),
      ts: Number(r.ts),
    }));
  }

  hasOutcome(id: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM outcomes WHERE id = ?').get(id) !== undefined;
  }

  outcomeCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS c FROM outcomes').get() as { c: number }).c);
  }

  addWallet(wallet: Address, ts = Math.floor(Date.now() / 1000)): void {
    this.db.prepare('INSERT OR IGNORE INTO wallets (address, first_seen) VALUES (?, ?)').run(wallet.toLowerCase(), ts);
  }

  wallets(): Address[] {
    return (this.db.prepare('SELECT address FROM wallets ORDER BY first_seen, address').all() as Array<{ address: string }>).map(
      (r) => r.address as Address,
    );
  }

  markFlag(wallet: Address, payee: Address, txHash: Hex | null, status: FlagRow['status']): void {
    this.db
      .prepare('INSERT OR REPLACE INTO flags (wallet, payee, tx_hash, status, ts) VALUES (?, ?, ?, ?, ?)')
      .run(wallet.toLowerCase(), payee.toLowerCase(), txHash, status, Math.floor(Date.now() / 1000));
  }

  flagRow(wallet: Address, payee: Address): FlagRow | undefined {
    const r = this.db.prepare('SELECT * FROM flags WHERE wallet = ? AND payee = ?').get(wallet.toLowerCase(), payee.toLowerCase()) as
      | Record<string, string | number | null>
      | undefined;
    if (!r) return undefined;
    return { wallet: String(r.wallet) as Address, payee: String(r.payee) as Address, txHash: (r.tx_hash as Hex) ?? null, status: String(r.status) as FlagRow['status'], ts: Number(r.ts) };
  }

  flags(): FlagRow[] {
    return (this.db.prepare('SELECT * FROM flags ORDER BY ts').all() as Array<Record<string, string | number | null>>).map((r) => ({
      wallet: String(r.wallet) as Address,
      payee: String(r.payee) as Address,
      txHash: (r.tx_hash as Hex) ?? null,
      status: String(r.status) as FlagRow['status'],
      ts: Number(r.ts),
    }));
  }

  close(): void {
    this.db.close();
  }
}
