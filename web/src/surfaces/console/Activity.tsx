import { useState } from 'react';
import s from './console.module.css';
import { useConsole, PageHead, ActivityList } from './kit';
import { useActivity } from '@/api/queries';
import { EmptyState, ErrorState, Glass, Loading, Segmented } from '@/components/ui';
import type { ActivityItem } from '@/chain/activity';

type Filter = 'all' | 'pay' | 'refused' | 'approvals' | 'safety' | 'vouchers';
const MATCH: Record<Filter, (k: ActivityItem['kind']) => boolean> = {
  all: () => true,
  pay: (k) => k === 'spent' || k === 'op',
  refused: (k) => k === 'op-reverted',
  approvals: (k) => k === 'approved',
  safety: (k) => k === 'flagged' || k === 'flag-cleared' || k === 'revoked' || k === 'policy' || k === 'epoch',
  vouchers: (k) => k.startsWith('voucher'),
};

export default function Activity() {
  const { wallet, policy } = useConsole();
  const activity = useActivity(wallet);
  const [filter, setFilter] = useState<Filter>('all');
  const items = activity.data?.filter((i) => MATCH[filter](i.kind)) ?? [];
  return (
    <>
      <PageHead title="Activity" updatedAt={activity.dataUpdatedAt}>
        Everything the wallet did in about the last day, read straight from the chain. Refusals in validation never reach the
        chain, so they appear in the agent's own log instead.
      </PageHead>
      <div className={s.filters}>
        <Segmented
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'pay', label: 'Payments' },
            { value: 'refused', label: 'Reverts' },
            { value: 'approvals', label: 'Approvals' },
            { value: 'safety', label: 'Safety' },
            { value: 'vouchers', label: 'x402 vouchers' },
          ]}
        />
      </div>
      <Glass pad>
        {activity.isPending ? (
          <Loading lines={6} />
        ) : activity.isError ? (
          <ErrorState error={activity.error} title="Can't read on-chain activity" onRetry={() => activity.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title={filter === 'all' ? 'Nothing in the last day' : 'Nothing of this kind in the last day'} />
        ) : (
          <ActivityList items={items} asset={policy.data?.assets[0]?.asset} />
        )}
      </Glass>
    </>
  );
}
