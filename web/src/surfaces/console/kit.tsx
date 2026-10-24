import { useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Abi, Address, Hex as HexT } from 'viem';
import s from './console.module.css';
import { useWallet, waitForReceipt } from '@/chain/wallet';
import { accountAbi } from '@/chain/abi';
import type { usePolicy } from '@/api/queries';
import { Hex, DataAge, Amount, Badge } from '@/components/ui';
import { Icon } from '@/components/Icon';
import type { ActivityItem } from '@/chain/activity';
import type { Asset, Policy } from '@/api/schemas';
import { relativeTime } from '@/domain/units';

export type ConsoleCtx = {
  wallet: Address;
  policy: ReturnType<typeof usePolicy>;
  isOwner: boolean;
};
export const useConsole = () => useOutletContext<ConsoleCtx>();

export function PageHead({ title, children, updatedAt }: { title: string; children?: ReactNode; updatedAt?: number }) {
  return (
    <div className={s.pageHead}>
      <div>
        <h1>{title}</h1>
        {children ? <p className={s.pageLede}>{children}</p> : null}
      </div>
      {updatedAt ? <DataAge updatedAt={updatedAt} /> : null}
    </div>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function OwnerOnly({ isOwner }: { isOwner: boolean }) {
  if (isOwner) return null;
  return (
    <p className={s.ownerOnly}>
      <Icon name="lock" size={15} /> Read-only. Connect the owner wallet to change this.
    </p>
  );
}

type WriteState =
  | { status: 'idle' }
  | { status: 'wallet'; label: string }
  | { status: 'pending'; label: string; hash: HexT }
  | { status: 'confirmed'; label: string; hash: HexT }
  | { status: 'reverted'; label: string; hash: HexT }
  | { status: 'error'; label: string; message: string };

/** One owner transaction at a time, with honest progress: nothing is "done" until a receipt exists. */
export function useOwnerWrite(wallet: Address) {
  const w = useWallet();
  const qc = useQueryClient();
  const [state, setState] = useState<WriteState>({ status: 'idle' });
  const run = async (label: string, functionName: string, args: readonly unknown[], opts?: { address?: Address; abi?: Abi }) => {
    setState({ status: 'wallet', label });
    try {
      const hash = await w.write({ address: opts?.address ?? wallet, abi: (opts?.abi ?? accountAbi) as Abi, functionName, args });
      setState({ status: 'pending', label, hash });
      const r = await waitForReceipt(hash);
      setState({ status: r.status === 'success' ? 'confirmed' : 'reverted', label, hash });
      await qc.invalidateQueries();
      return r.status === 'success';
    } catch (e) {
      setState({ status: 'error', label, message: (e as Error).message });
      return false;
    }
  };
  return { state, run, reset: () => setState({ status: 'idle' }), busy: state.status === 'wallet' || state.status === 'pending' };
}

export function WriteStatus({ state }: { state: ReturnType<typeof useOwnerWrite>['state'] }) {
  if (state.status === 'idle') return null;
  return (
    <div className={s.write} role="status" aria-live="polite" data-status={state.status}>
      {state.status === 'wallet' ? (
        <span>{state.label}: confirm in MetaMask…</span>
      ) : state.status === 'pending' ? (
        <span>
          {state.label}: waiting for the transaction <Hex value={state.hash} kind="tx" />
        </span>
      ) : state.status === 'confirmed' ? (
        <span>
          <Icon name="check" size={15} /> {state.label}: confirmed <Hex value={state.hash} kind="tx" />
        </span>
      ) : state.status === 'reverted' ? (
        <span>
          <Icon name="cross" size={15} /> {state.label}: reverted. Nothing changed. <Hex value={state.hash} kind="tx" />
        </span>
      ) : (
        <span>
          <Icon name="alert" size={15} /> {state.label}: {state.message}
        </span>
      )}
    </div>
  );
}

/* ---------- Activity list (shared by Overview and Activity) ---------- */
const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  op: 'Operation executed',
  'op-reverted': 'Operation reverted',
  spent: 'Paid',
  approved: 'Owner-approved payment',
  flagged: 'Payee flagged by TRACE',
  'flag-cleared': 'Flag cleared by owner',
  revoked: 'Agent key revoked',
  policy: 'Policy changed',
  'voucher-registered': 'x402 voucher registered',
  'voucher-used': 'x402 voucher used',
  'voucher-reclaimed': 'x402 voucher reclaimed',
  epoch: 'Attestations voided (epoch bumped)',
};
const TRACK_NAMES = ['proven', 'unproven', 'flagged'] as const;

export function ActivityList({ items, asset, limit }: { items: ActivityItem[]; asset?: Asset; limit?: number }) {
  const list = limit ? items.slice(0, limit) : items;
  return (
    <ol className={s.activity}>
      {list.map((i) => (
        <li key={i.id} className={s.actRow} data-kind={i.kind}>
          <span className={s.actWhen}>{i.timestamp ? relativeTime(i.timestamp) : `block ${i.blockNumber}`}</span>
          <span className={s.actWhat}>
            <span className={s.actKind}>
              {i.kind === 'op-reverted' || i.kind === 'flagged' ? <Icon name="cross" size={14} /> : null}
              {KIND_LABEL[i.kind]}
            </span>
            {i.payee ? <Hex value={i.payee} /> : null}
            {i.kind === 'spent' && i.track !== undefined && TRACK_NAMES[i.track] ? <Badge>{TRACK_NAMES[i.track]} track</Badge> : null}
            {i.detail && i.kind === 'epoch' ? <span className={s.dim}>epoch {i.detail}</span> : null}
          </span>
          <span className={s.actAmt}>
            {i.amount !== undefined && asset ? <Amount value={i.amount} decimals={asset.decimals} symbol={asset.symbol} sign="out" /> : null}
          </span>
          <span className={s.actTx}>
            <Hex value={i.txHash} kind="tx" />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function assetFor(policy: Policy | undefined, addr: Address | undefined): Asset | undefined {
  if (!policy || !addr) return policy?.assets[0]?.asset;
  return policy.assets.find((a) => a.asset.address.toLowerCase() === addr.toLowerCase())?.asset;
}
