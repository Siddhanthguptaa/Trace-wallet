/**
 * Freeze sender: calls freeze(agentKey) on the account from the watcher key when a detector alarms.
 * Freezes are escalate-only on-chain (only the owner unfreezes, I13), so sending is idempotent and safe
 * to retry. One in-flight send per (account, agentKey). There is no unfreeze path here by design.
 */
import type { Address, Hex } from 'viem';
import type { AccountReader, FreezeWriter } from './chain.ts';

export type FreezeResult =
  | { account: Address; agentKey: Address; status: 'sent'; txHash: Hex; why: string }
  | { account: Address; agentKey: Address; status: 'already'; why: string }
  | { account: Address; agentKey: Address; status: 'skipped'; reason: string; why: string }
  | { account: Address; agentKey: Address; status: 'error'; reason: string; why: string };

export class FreezeSender {
  private readonly inflight = new Map<string, Promise<FreezeResult>>();
  private readonly sent = new Map<string, Hex>();
  private readonly writer: FreezeWriter | null;
  private readonly reader: AccountReader | null;
  private readonly watcher: Address;
  private readonly log?: (m: string) => void;

  constructor(deps: { writer: FreezeWriter | null; reader: AccountReader | null; watcher: Address; log?: (m: string) => void }) {
    this.writer = deps.writer;
    this.reader = deps.reader;
    this.watcher = deps.watcher;
    this.log = deps.log;
  }

  ensureFrozen(account: Address, agentKey: Address, why: string): Promise<FreezeResult> {
    const key = `${account.toLowerCase()}:${agentKey.toLowerCase()}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.send(key, account, agentKey, why).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Forget a key after the owner unfroze it, so the next alarm sends again. */
  forget(account: Address, agentKey: Address) {
    this.sent.delete(`${account.toLowerCase()}:${agentKey.toLowerCase()}`);
  }

  private async send(key: string, account: Address, agentKey: Address, why: string): Promise<FreezeResult> {
    if (this.sent.has(key)) return { account, agentKey, status: 'already', why };
    if (!this.writer) return { account, agentKey, status: 'skipped', reason: 'no_freeze_writer (no RPC or key)', why };
    try {
      if (this.reader) {
        const w = await this.reader.watcher(account).catch(() => null);
        if (!w || w.toLowerCase() !== this.watcher.toLowerCase()) {
          return { account, agentKey, status: 'skipped', reason: 'not_this_accounts_watcher', why };
        }
        if (await this.reader.isFrozen(account, agentKey).catch(() => false)) {
          return { account, agentKey, status: 'already', why };
        }
      }
      const txHash = await this.writer.freeze(account, agentKey);
      this.sent.set(key, txHash);
      this.log?.(`freeze(${agentKey}) on ${account}: ${txHash} [${why}]`);
      return { account, agentKey, status: 'sent', txHash, why };
    } catch (e) {
      return { account, agentKey, status: 'error', reason: (e as Error).message.split('\n')[0] ?? 'error', why };
    }
  }
}
