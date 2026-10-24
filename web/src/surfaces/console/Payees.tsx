import { useMemo, useState } from 'react';
import { isAddress, getAddress, type Address } from 'viem';
import s from './console.module.css';
import { useConsole, PageHead, Section, OwnerOnly, useOwnerWrite, WriteStatus } from './kit';
import { useActivity, useAttestation } from '@/api/queries';
import { Amount, Button, EmptyState, Glass, Hex, HoldButton, TextField, TrackBadge } from '@/components/ui';
import { relativeTime, dateTime } from '@/domain/units';
import type { Track } from '@/domain/tracks';
import type { Asset } from '@/api/schemas';

type Row = { payee: Address; listed: boolean; flagged: boolean; paid: bigint; last?: number };

export default function Payees() {
  const { wallet, policy, isOwner } = useConsole();
  const p = policy.data!;
  const activity = useActivity(wallet);
  const writer = useOwnerWrite(wallet);
  const asset = p.assets[0]?.asset;
  const [add, setAdd] = useState('');

  const rows = useMemo(() => {
    const m = new Map<string, Row>();
    const get = (a: Address) => {
      const k = a.toLowerCase();
      let r = m.get(k);
      if (!r) {
        r = { payee: a, listed: false, flagged: false, paid: 0n };
        m.set(k, r);
      }
      return r;
    };
    p.recipients.forEach((a) => (get(a).listed = true));
    p.flagged.forEach((a) => (get(a).flagged = true));
    for (const i of activity.data ?? []) {
      if ((i.kind === 'spent' || i.kind === 'approved') && i.payee) {
        const r = get(i.payee);
        if (i.amount && (!i.asset || !asset || i.asset.toLowerCase() === asset.address.toLowerCase())) r.paid += i.amount;
        if (i.timestamp && (!r.last || i.timestamp > r.last)) r.last = i.timestamp;
      }
    }
    return [...m.values()].sort((a, b) => Number(b.flagged) - Number(a.flagged) || (b.last ?? 0) - (a.last ?? 0));
  }, [p, activity.data, asset]);

  const addErr = add && !isAddress(add) ? 'Not a valid address' : null;

  return (
    <>
      <PageHead title="Payees" updatedAt={policy.dataUpdatedAt}>
        Who the agent can pay, and on which track. Owner-listed payees are proven. Others are proven only with a valid TRACE
        attestation; anything missing or expired counts as unproven.
      </PageHead>

      <Glass pad>
        <Section title="TRACE attestor">
          <dl className={s.kv}>
            <div>
              <dt>Attestor key</dt>
              <dd>{p.attestor ? <Hex value={p.attestor} /> : <span className={s.dim}>None. Only owner-listed payees are proven.</span>}</dd>
            </div>
            <div>
              <dt>Current epoch</dt>
              <dd>{p.attestEpoch}</dd>
            </div>
          </dl>
          <p className={s.dim}>The attestor can flag payees. It cannot clear a flag, raise a cap or touch the owner settings.</p>
          {isOwner ? (
            <div className={s.editorActions}>
              <HoldButton disabled={writer.busy} onConfirm={() => writer.run('Void all attestations', 'bumpEpoch', [])}>
                Hold to void every attestation
              </HoldButton>
            </div>
          ) : null}
        </Section>
      </Glass>

      <Glass pad>
        <Section title={`Payees (${rows.length})`}>
          {rows.length === 0 ? (
            <EmptyState title="No payees yet">Add a recipient you trust, or let the agent meet new ones inside the exploration budget.</EmptyState>
          ) : (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">Payee</th>
                    <th scope="col">Track</th>
                    <th scope="col">Why</th>
                    <th scope="col" className={s.num}>
                      Paid, last day
                    </th>
                    <th scope="col" className={s.num}>
                      Last paid
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <PayeeRow
                      key={r.payee}
                      r={r}
                      wallet={wallet}
                      epoch={p.attestEpoch}
                      asset={asset}
                      isOwner={isOwner}
                      busy={writer.busy}
                      onRemove={() => writer.run('Remove recipient', 'setRecipient', [r.payee, false])}
                      onList={() => writer.run('List recipient', 'setRecipient', [r.payee, true])}
                      onClear={() => writer.run('Clear flag', 'unflag', [r.payee])}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {isOwner ? (
            <form
              className={s.inline}
              onSubmit={(e) => {
                e.preventDefault();
                if (isAddress(add)) writer.run('List recipient', 'setRecipient', [getAddress(add), true]).then((ok) => ok && setAdd(''));
              }}
            >
              <TextField label="List a recipient you trust" placeholder="0x…" mono value={add} onChange={(e) => setAdd(e.target.value.trim())} error={addErr} />
              <Button type="submit" variant="primary" disabled={!isAddress(add) || writer.busy}>
                List recipient
              </Button>
            </form>
          ) : null}
          <OwnerOnly isOwner={isOwner} />
          <WriteStatus state={writer.state} />
        </Section>
      </Glass>
    </>
  );
}

function PayeeRow({
  r,
  wallet,
  epoch,
  asset,
  isOwner,
  busy,
  onRemove,
  onList,
  onClear,
}: {
  r: Row;
  wallet: Address;
  epoch: number;
  asset?: Asset;
  isOwner: boolean;
  busy: boolean;
  onRemove: () => void;
  onList: () => void;
  onClear: () => void;
}) {
  const att = useAttestation(r.listed || r.flagged ? undefined : wallet, r.payee);
  let track: Track = 'unproven';
  let why = 'No attestation';
  if (r.flagged) {
    track = 'flagged';
    why = 'Flagged by the attestor or owner';
  } else if (r.listed) {
    track = 'proven';
    why = 'Listed by you';
  } else if (att.isPending) {
    why = 'Checking TRACE…';
  } else if (att.isError) {
    why = 'Attestor unreachable, so unproven';
  } else if (att.data && 'tier' in att.data) {
    const valid = att.data.validUntil * 1000 > Date.now() && att.data.epoch === epoch;
    if (att.data.tier === 'PROVEN' && valid) {
      track = 'proven';
      why = `Attested until ${dateTime(att.data.validUntil)}`;
    } else if (att.data.tier === 'PROVEN') {
      why = att.data.epoch !== epoch ? 'Attestation from an old epoch' : 'Attestation expired';
    }
  }
  return (
    <tr>
      <td>
        <Hex value={r.payee} />
      </td>
      <td>
        <TrackBadge track={track} />
      </td>
      <td className={s.why}>{why}</td>
      <td className={s.num}>{asset ? <Amount value={r.paid} decimals={asset.decimals} symbol={asset.symbol} /> : '–'}</td>
      <td className={s.num}>{r.last ? relativeTime(r.last) : '–'}</td>
      <td>
        {isOwner ? (
          <div className={s.rowActions}>
            {r.flagged ? (
              <Button size="small" onClick={onClear} disabled={busy}>
                Clear flag
              </Button>
            ) : null}
            {r.listed ? (
              <Button size="small" variant="ghost" onClick={onRemove} disabled={busy}>
                Remove
              </Button>
            ) : !r.flagged ? (
              <Button size="small" variant="ghost" onClick={onList} disabled={busy}>
                List
              </Button>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}
