/**
 * Approval store on the built-in node:sqlite (BUILD.md Conventions: no native builds). No on-chain
 * pending store (IDEA 7.3: it would let a hijacked agent burn gas credit on spam).
 */
import { DatabaseSync } from 'node:sqlite';
import type { Address, Hex } from 'viem';

export type RequestStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'expired' | 'reverted';

export interface RequestRow {
  id: string;
  account: Address;
  chainId: number;
  agent: Address;
  /** PackedUserOperation JSON (bigints as decimal strings), agent-signed, approval slot empty. */
  userOp: string;
  userOpHash: Hex;
  nonce: string;
  note: string;
  /** OutcomeApprovalJson */
  approval: string;
  approvalHash: Hex;
  /** simulation JSON */
  simulation: string;
  status: RequestStatus;
  ownerSig: Hex | null;
  finalSig: Hex | null;
  txHash: Hex | null;
  success: boolean | null;
  blocked: boolean | null;
  reason: string | null;
  /** measured outflows JSON from the account's Decision event */
  outflows: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type AttemptOutcome = 'accepted' | 'refused' | 'rate_limited';

const COLS: Record<keyof RequestRow, string> = {
  id: 'id',
  account: 'account',
  chainId: 'chain_id',
  agent: 'agent',
  userOp: 'user_op',
  userOpHash: 'user_op_hash',
  nonce: 'nonce',
  note: 'note',
  approval: 'approval',
  approvalHash: 'approval_hash',
  simulation: 'simulation',
  status: 'status',
  ownerSig: 'owner_sig',
  finalSig: 'final_sig',
  txHash: 'tx_hash',
  success: 'success',
  blocked: 'blocked',
  reason: 'reason',
  outflows: 'outflows',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  expiresAt: 'expires_at',
};

type SqlVal = string | number | null;

function toSql(k: keyof RequestRow, v: unknown): SqlVal {
  if (v === null || v === undefined) return null;
  if (k === 'success' || k === 'blocked') return v ? 1 : 0;
  if (k === 'account' || k === 'agent' || k === 'userOpHash') return String(v).toLowerCase();
  return v as SqlVal;
}

function fromSql(r: Record<string, SqlVal>): RequestRow {
  const o: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(COLS)) {
    const v = r[c];
    if (k === 'success' || k === 'blocked') o[k] = v === null ? null : Number(v) === 1;
    else if (k === 'chainId' || k === 'createdAt' || k === 'updatedAt' || k === 'expiresAt') o[k] = Number(v);
    else o[k] = v;
  }
  return o as unknown as RequestRow;
}

export class Store {
  private db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, chain_id INTEGER NOT NULL, agent TEXT NOT NULL,
        user_op TEXT NOT NULL, user_op_hash TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL, note TEXT NOT NULL,
        approval TEXT NOT NULL, approval_hash TEXT NOT NULL, simulation TEXT NOT NULL, status TEXT NOT NULL,
        owner_sig TEXT, final_sig TEXT, tx_hash TEXT, success INTEGER, blocked INTEGER, reason TEXT, outflows TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_key ON requests (account, agent, status);
      CREATE TABLE IF NOT EXISTS attempts (account TEXT NOT NULL, agent TEXT NOT NULL, ts INTEGER NOT NULL, outcome TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_key ON attempts (account, agent, ts);
    `);
  }

  insert(r: RequestRow): void {
    const keys = Object.keys(COLS) as (keyof RequestRow)[];
    this.db
      .prepare(`INSERT INTO requests (${keys.map((k) => COLS[k]).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((k) => toSql(k, r[k])));
  }

  get(id: string): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Record<string, SqlVal> | undefined;
    return r ? fromSql(r) : undefined;
  }

  byUserOpHash(h: Hex): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE user_op_hash = ?').get(h.toLowerCase()) as Record<string, SqlVal> | undefined;
    return r ? fromSql(r) : undefined;
  }

  /** compare-and-set on status when `from` is given; false if the row was not in `from`. */
  update(id: string, patch: Partial<RequestRow>, from?: RequestStatus[]): boolean {
    const keys = (Object.keys(patch) as (keyof RequestRow)[]).filter((k) => k !== 'id');
    const now = Math.floor(Date.now() / 1000);
    const sets = [...keys.map((k) => `${COLS[k]} = ?`), 'updated_at = ?'];
    const vals: SqlVal[] = [...keys.map((k) => toSql(k, patch[k])), patch.updatedAt ?? now, id];
    let sql = `UPDATE requests SET ${sets.join(', ')} WHERE id = ?`;
    if (from?.length) {
      sql += ` AND status IN (${from.map(() => '?').join(', ')})`;
      vals.push(...from);
    }
    return Number(this.db.prepare(sql).run(...vals).changes) > 0;
  }

  list(f: { account?: Address; agent?: Address; status?: RequestStatus; limit?: number } = {}): RequestRow[] {
    const w: string[] = [];
    const v: SqlVal[] = [];
    if (f.account) (w.push('account = ?'), v.push(f.account.toLowerCase()));
    if (f.agent) (w.push('agent = ?'), v.push(f.agent.toLowerCase()));
    if (f.status) (w.push('status = ?'), v.push(f.status));
    const sql = `SELECT * FROM requests ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY created_at DESC, id LIMIT ?`;
    v.push(Math.min(f.limit ?? 100, 500));
    return (this.db.prepare(sql).all(...v) as Record<string, SqlVal>[]).map(fromSql);
  }

  /** other pending requests that use the same EntryPoint nonce (only one can ever execute). */
  pendingWithNonce(account: Address, nonce: string, exceptId: string): RequestRow[] {
    return (
      this.db
        .prepare("SELECT * FROM requests WHERE account = ? AND nonce = ? AND id != ? AND status IN ('pending', 'approved')")
        .all(account.toLowerCase(), nonce, exceptId) as Record<string, SqlVal>[]
    ).map(fromSql);
  }

  pendingCount(account: Address, agent: Address): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM requests WHERE account = ? AND agent = ? AND status = 'pending'")
      .get(account.toLowerCase(), agent.toLowerCase()) as { c: number };
    return Number(r.c);
  }

  addAttempt(account: Address, agent: Address, outcome: AttemptOutcome, ts = Math.floor(Date.now() / 1000)): void {
    this.db.prepare('INSERT INTO attempts (account, agent, ts, outcome) VALUES (?, ?, ?, ?)').run(account.toLowerCase(), agent.toLowerCase(), ts, outcome);
  }

  /** attempts since `since` (unix s), by outcome. */
  attemptsSince(account: Address, agent: Address, since: number): Record<AttemptOutcome, number> {
    const rows = this.db
      .prepare('SELECT outcome, COUNT(*) AS c FROM attempts WHERE account = ? AND agent = ? AND ts > ? GROUP BY outcome')
      .all(account.toLowerCase(), agent.toLowerCase(), since) as Array<{ outcome: AttemptOutcome; c: number }>;
    const out: Record<AttemptOutcome, number> = { accepted: 0, refused: 0, rate_limited: 0 };
    for (const r of rows) out[r.outcome] = Number(r.c);
    return out;
  }

  close(): void {
    this.db.close();
  }
}
