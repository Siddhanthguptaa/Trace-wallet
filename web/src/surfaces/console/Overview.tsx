import { Link } from 'react-router-dom';
import s from './console.module.css';
import { useConsole, PageHead, Section, ActivityList, OwnerOnly, useOwnerWrite, WriteStatus } from './kit';
import { useActivity, useApprovals, useBudget } from '@/api/queries';
import { Amount, BucketGauge, EmptyState, ErrorState, Glass, Hex, HoldButton, Loading } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { dateTime, relativeTime } from '@/domain/units';
import type { SessionKey } from '@/api/schemas';

export function keyStatus(k: SessionKey, now = Date.now() / 1000): 'active' | 'expiring' | 'expired' | 'revoked' | 'scheduled' {
  if (k.revoked) return 'revoked';
  if (k.validUntil !== 0 && k.validUntil < now) return 'expired';
  if (k.validAfter > now) return 'scheduled';
  if (k.validUntil !== 0 && k.validUntil - now < 86_400) return 'expiring';
  return 'active';
}
const STATUS_LABEL = { active: 'Active', expiring: 'Expires within a day', expired: 'Expired', revoked: 'Revoked', scheduled: 'Not yet valid' };

export default function Overview() {
  const { wallet, policy, isOwner } = useConsole();
  const budget = useBudget(wallet);
  const activity = useActivity(wallet);
  const pending = useApprovals(wallet, 'pending');
  const writer = useOwnerWrite(wallet);
  const p = policy.data!;
  const primary = p.assets[0];
  const qs = `?wallet=${wallet}`;

  const globalBucket = primary ? budget.data?.buckets.find((b) => b.scope === 'global' && b.asset.toLowerCase() === primary.asset.address.toLowerCase()) : undefined;
  const exploreBucket = primary ? budget.data?.buckets.find((b) => b.scope === 'explore' && b.asset.toLowerCase() === primary.asset.address.toLowerCase()) : undefined;
  const next24 = (b?: { level: bigint; refillPerDay: bigint; cap: bigint }) => (b ? (b.level + b.refillPerDay < b.cap ? b.level + b.refillPerDay : b.cap) : undefined);
  const maxNow = next24(globalBucket);
  const maxExplore = next24(exploreBucket);

  return (
    <>
      <PageHead title="Overview" updatedAt={budget.dataUpdatedAt}>
        What the agent can still spend, what it did, and the switch that stops it.
      </PageHead>

      <Glass pad className={s.boundLine}>
        {primary && maxNow !== undefined ? (
          <>
            <span>Most the agent can move in the next 24 hours</span>
            <strong>
              <Amount value={maxNow} decimals={primary.asset.decimals} symbol={primary.asset.symbol} />
            </strong>
            {maxExplore !== undefined ? (
              <span>
                of which at most <Amount value={maxExplore} decimals={primary.asset.decimals} symbol={primary.asset.symbol} /> to
                unproven payees. The account cap is{' '}
                <Amount value={primary.globalCap} decimals={primary.asset.decimals} symbol={primary.asset.symbol} /> per 24 hours.
              </span>
            ) : null}
          </>
        ) : budget.isError ? (
          <ErrorState error={budget.error} title="Can't read the budgets" onRetry={() => budget.refetch()} />
        ) : (
          <Loading lines={2} />
        )}
      </Glass>

      <div className={s.grid2}>
        <Glass pad>
          <Section title="Budgets">
            {budget.isPending ? (
              <Loading lines={4} />
            ) : budget.isError ? (
              <ErrorState error={budget.error} onRetry={() => budget.refetch()} />
            ) : (
              <div className={s.gauges}>
                {p.assets.map((a) =>
                  budget.data.buckets
                    .filter((b) => b.asset.toLowerCase() === a.asset.address.toLowerCase())
                    .map((b) => <BucketGauge key={a.asset.address + b.scope + (b.agentKey ?? '')} bucket={b} decimals={a.asset.decimals} symbol={a.asset.symbol} />),
                )}
              </div>
            )}
          </Section>
        </Glass>

        <div style={{ display: 'grid', gap: 'var(--s-5)', alignContent: 'start' }}>
          <Glass pad>
            <Link to={`/console/approvals${qs}`} className={s.pendingLink}>
              <span>
                <span className={s.dim}>Waiting for you</span>
                <br />
                <span className={s.pendingNum}>{pending.data ? pending.data.length : '–'}</span>{' '}
                <span>{pending.data?.length === 1 ? 'approval' : 'approvals'}</span>
              </span>
              <Icon name="arrowRight" size={20} />
            </Link>
          </Glass>

          <Glass pad>
            <Section title="Agent keys">
              {p.keys.length === 0 ? (
                <EmptyState title="No agent key yet">Add one in Keys & safety.</EmptyState>
              ) : (
                p.keys.map((k) => {
                  const st = keyStatus(k);
                  return (
                    <div key={k.agentKey} className={s.keyRow}>
                      <div className={s.keyTop}>
                        <Hex value={k.agentKey} />
                        <span className={s.status} data-s={st}>
                          <span className={s.statusDot} aria-hidden="true" />
                          {STATUS_LABEL[st]}
                        </span>
                      </div>
                      <span className={s.dim}>
                        {k.validUntil ? `Valid until ${dateTime(k.validUntil)} (${relativeTime(k.validUntil)})` : 'No expiry set'}
                      </span>
                      {!k.revoked ? (
                        <HoldButton disabled={!isOwner || writer.busy} onConfirm={() => writer.run('Revoke agent key', 'revoke', [k.agentKey])}>
                          Hold to revoke this key
                        </HoldButton>
                      ) : null}
                    </div>
                  );
                })
              )}
              <OwnerOnly isOwner={isOwner} />
              <WriteStatus state={writer.state} />
            </Section>
          </Glass>
        </div>
      </div>

      <Glass pad>
        <Section title="Recent activity" aside={<Link to={`/console/activity${qs}`}>All activity</Link>}>
          {activity.isPending ? (
            <Loading lines={4} />
          ) : activity.isError ? (
            <ErrorState error={activity.error} title="Can't read on-chain activity" onRetry={() => activity.refetch()} />
          ) : activity.data.length === 0 ? (
            <EmptyState title="Nothing in the last day">Payments, reverts and approvals show up here with their transactions.</EmptyState>
          ) : (
            <ActivityList items={activity.data} asset={primary?.asset} limit={8} />
          )}
        </Section>
      </Glass>
    </>
  );
}
