/**
 * Flag sender: calls flag(payee) on each wallet this attestor serves when a payee turns FLAGGED.
 * Flags are escalate-only on-chain (only the owner can unflag, I10), so sending is idempotent and
 * safe to retry. One in-flight send per (wallet, payee).
 */
import type { Address, Hex } from 'viem';
import type { AccountReader, FlagWriter } from './chain.ts';
import type { Store } from './store.ts';

export type FlagResult =
  | { wallet: Address; payee: Address; status: 'sent'; txHash: Hex }
  | { wallet: Address; payee: Address; status: 'already' }
  | { wallet: Address; payee: Address; status: 'skipped'; reason: string }
  | { wallet: Address; payee: Address; status: 'error'; reason: string };

export class FlagSender {
  private inflight = new Map<string, Promise<FlagResult>>();

  constructor(
    private deps: {
      store: Store;
      writer: FlagWriter | null;
      reader: AccountReader | null;
      attestor: Address;
      log?: (m: string) => void;
    },
  ) {}

  ensureFlagged(wallet: Address, payee: Address): Promise<FlagResult> {
    const key = `${wallet.toLowerCase()}:${payee.toLowerCase()}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.send(wallet, payee).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async flagEverywhere(payee: Address, wallets: Address[]): Promise<FlagResult[]> {
    return Promise.all(wallets.filter((w) => w.toLowerCase() !== payee.toLowerCase()).map((w) => this.ensureFlagged(w, payee)));
  }

  private async send(wallet: Address, payee: Address): Promise<FlagResult> {
    const { store, writer, reader, attestor, log } = this.deps;
    if (store.flagRow(wallet, payee)) return { wallet, payee, status: 'already' };
    if (!writer) return { wallet, payee, status: 'skipped', reason: 'no_flag_writer (no RPC or key)' };
    try {
      if (reader) {
        const onChainAttestor = await reader.attestor(wallet).catch(() => null);
        if (!onChainAttestor || onChainAttestor.toLowerCase() !== attestor.toLowerCase()) {
          return { wallet, payee, status: 'skipped', reason: 'not_this_wallets_attestor' };
        }
        if (await reader.isFlagged(wallet, payee).catch(() => false)) {
          store.markFlag(wallet, payee, null, 'already');
          return { wallet, payee, status: 'already' };
        }
      }
      const txHash = await writer.flag(wallet, payee);
      store.markFlag(wallet, payee, txHash, 'sent');
      log?.(`flag(${payee}) on ${wallet}: ${txHash}`);
      return { wallet, payee, status: 'sent', txHash };
    } catch (e) {
      return { wallet, payee, status: 'error', reason: (e as Error).message.split('\n')[0] ?? 'error' };
    }
  }
}
