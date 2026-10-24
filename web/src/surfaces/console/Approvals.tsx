import { Link } from 'react-router-dom';
import s from './console.module.css';
import { useConsole, PageHead, Section } from './kit';
import { useApprovals } from '@/api/queries';
import { Amount, EmptyState, ErrorState, Glass, Hex, Loading, TrackBadge, Badge } from '@/components/ui';
import { relativeTime } from '@/domain/units';
import type { ApprovalSummary } from '@/api/schemas';

const STATUS: Record<ApprovalSummary['status'], string> = {
  pending: 'Waiting for you',
  signed: 'Signed',
  relayed: 'Sent',
  executed: 'Paid',
  used: 'Paid',
  reverted: 'Reverted',
  declined: 'Declined',
  expired: 'Expired',
};

export default function Approvals() {
  const { wallet } = useConsole();
  const all = useApprovals(wallet);
  const now = Date.now() / 1000;
  const pending = all.data?.filter((a) => a.status === 'pending' && a.expiresAt > now && !a.rateLimited) ?? [];
  const limited = all.data?.filter((a) => a.status === 'pending' && a.rateLimited) ?? [];
  const history = all.data?.filter((a) => !(a.status === 'pending' && a.expiresAt > now)) ?? [];

  return (
    <>
      <PageHead title="Approvals" updatedAt={all.dataUpdatedAt}>
        Requests the policy could not allow on its own. Each one is built from the decoded call and a simulation, never from the
        agent's description.
      </PageHead>
      {all.isPending ? (
        <Glass>
          <Loading lines={5} />
        </Glass>
      ) : all.isError ? (
        <Glass>
          <ErrorState error={all.error} title="Can't reach the approval service" onRetry={() => all.refetch()} />
        </Glass>
      ) : (
        <>
          <Glass pad>
            <Section title={`Waiting for you (${pending.length})`}>
              {pending.length ? <List items={pending} /> : <EmptyState title="Nothing to approve">The agent is working within its policy.</EmptyState>}
            </Section>
          </Glass>
          {limited.length ? (
            <Glass pad>
              <Section title={`Held back by the rate limit (${limited.length})`}>
                <p className={s.dim}>The agent asked too often. These open once older requests are answered.</p>
                <List items={limited} />
              </Section>
            </Glass>
          ) : null}
          <Glass pad>
            <Section title="History">
              {history.length ? <List items={history} /> : <EmptyState title="No past requests" />}
            </Section>
          </Glass>
        </>
      )}
    </>
  );
}

function List({ items }: { items: ApprovalSummary[] }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col" className={s.num}>
              Amount
            </th>
            <th scope="col">Payee</th>
            <th scope="col">Call</th>
            <th scope="col">Status</th>
            <th scope="col">Asked</th>
            <th scope="col">
              <span className="visually-hidden">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className={s.num}>
                <strong>
                  <Amount value={a.maxOutflow} decimals={a.asset.decimals} symbol={a.asset.symbol} sign="out" />
                </strong>
              </td>
              <td>
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Hex value={a.payee} />
                  <TrackBadge track={a.payeeTrack} />
                </span>
              </td>
              <td className={s.why}>{[a.targetLabel, a.functionName].filter(Boolean).join('.') || '–'}</td>
              <td>
                <Badge>{STATUS[a.status]}</Badge>
              </td>
              <td className={s.dim}>{relativeTime(a.createdAt)}</td>
              <td>
                <Link to={`/approve/${encodeURIComponent(a.id)}`}>{a.status === 'pending' ? 'Review' : 'Details'}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
