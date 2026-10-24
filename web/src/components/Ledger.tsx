import { Fragment, useState } from 'react';
import s from './ledger.module.css';
import { Icon } from './Icon';
import { Amount, Hex, ReasonCode } from './ui';
import { CONFIGS, type ConfigId } from '@/domain/tracks';
import type { Cell, Metric2Cell, X1Table } from '@/api/schemas';

const GUARD_LABEL: Record<string, string> = {
  D1: 'D1 · one door',
  D2: 'D2 · measured limits',
  D3: 'D3 · two tracks',
  core: 'Core policy',
};

export function cellText(c: Cell): string {
  switch (c.outcome) {
    case 'lost':
      return 'Lost';
    case 'refused':
      return 'Refused';
    case 'bounded':
      return 'Bounded';
    case 'na':
      return 'Not applicable';
    default:
      return 'Awaiting run';
  }
}

function CellView({ c }: { c: Cell }) {
  const runs = c.runs ? <span className={s.runs}>{`${c.runs.k}/${c.runs.n}`}</span> : null;
  switch (c.outcome) {
    case 'lost':
      return (
        <span className={`${s.cell} ${s.lost}`}>
          <Icon name="cross" size={15} />
          {c.amount !== undefined && c.asset ? (
            <Amount value={c.amount} decimals={c.asset.decimals} symbol={c.asset.symbol} />
          ) : (
            'Lost'
          )}
          {runs}
        </span>
      );
    case 'refused':
      return (
        <span className={`${s.cell} ${s.refused}`}>
          <Icon name="check" size={15} />
          Refused
          {runs}
        </span>
      );
    case 'bounded':
      return (
        <span className={`${s.cell} ${s.bounded}`}>
          <Icon name="bounded" size={15} />
          {c.amount !== undefined && c.asset ? (
            <>
              ≤&nbsp;
              <Amount value={c.amount} decimals={c.asset.decimals} symbol={c.asset.symbol} />
            </>
          ) : (
            'Bounded'
          )}
          {runs}
        </span>
      );
    case 'na':
      return <span className={`${s.cell} ${s.na}`}>n/a</span>;
    default:
      return <span className={`${s.cell} ${s.pending}`}>Awaiting run</span>;
  }
}

function Metric2View({ c }: { c: Metric2Cell }) {
  const n = c.total !== undefined ? ` ${c.paid ?? 0}/${c.total}` : '';
  switch (c.outcome) {
    case 'paid':
      return (
        <span className={`${s.cell} ${s.refused}`}>
          <Icon name="check" size={15} />
          Paid{n}
        </span>
      );
    case 'blocked':
      return (
        <span className={`${s.cell} ${s.lost}`}>
          <Icon name="cross" size={15} />
          Blocked{n}
        </span>
      );
    case 'ping':
      return (
        <span className={`${s.cell} ${s.bounded}`}>
          <Icon name="alert" size={15} />
          Owner ping{n}
        </span>
      );
    default:
      return <span className={`${s.cell} ${s.pending}`}>Awaiting run</span>;
  }
}

function Receipt({ c, config, test }: { c: Cell; config: ConfigId; test?: string }) {
  const cfg = CONFIGS.find((x) => x.id === config)!;
  return (
    <div className={s.receipt}>
      <dl>
        <div>
          <dt>Wallet</dt>
          <dd>
            {cfg.id} · {cfg.label}
          </dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd>
            <CellView c={c} />
          </dd>
        </div>
        {c.reasonCode ? (
          <div>
            <dt>Why</dt>
            <dd>
              <ReasonCode code={c.reasonCode} />
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Transaction</dt>
          <dd>{c.txHash ? <Hex value={c.txHash} kind="tx" /> : <span className={s.muted}>None. Refused before it reached the chain.</span>}</dd>
        </div>
        {(c.test ?? test) ? (
          <div>
            <dt>Test</dt>
            <dd>
              <code>{c.test ?? test}</code>
            </dd>
          </div>
        ) : null}
        {c.runs ? (
          <div>
            <dt>LLM runs</dt>
            <dd className="num">
              {c.runs.k} of {c.runs.n} attempts got this outcome
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

type Open = { row: number; col: ConfigId | 'story' } | null;

export function Ledger({ table, caption }: { table: X1Table; caption: string }) {
  const [open, setOpen] = useState<Open>(null);
  const toggle = (row: number, col: ConfigId | 'story') =>
    setOpen((o) => (o && o.row === row && o.col === col ? null : { row, col }));

  return (
    <div className={s.wrap}>
      {/* Desktop and tablet: a real table */}
      <table className={s.table}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={s.cardCol}>
              Attack card
            </th>
            {CONFIGS.map((c) => (
              <th key={c.id} scope="col">
                <span className={s.cfgId}>{c.id}</span>
                <span className={s.cfgLabel}>{c.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <Fragment key={r.cardId}>
              <tr className={open?.row === i ? s.rowOpen : undefined}>
                <th scope="row" className={s.cardCol}>
                  <button
                    type="button"
                    className={s.rowBtn}
                    aria-expanded={open?.row === i && open.col === 'story'}
                    onClick={() => toggle(i, 'story')}
                  >
                    <span className={s.cardTitle}>{r.title}</span>
                    <span className={s.guard}>{GUARD_LABEL[r.guard]}</span>
                  </button>
                </th>
                {CONFIGS.map((c) => {
                  const cell = r.cells[c.id];
                  const isOpen = open?.row === i && open.col === c.id;
                  return (
                    <td key={c.id}>
                      <button
                        type="button"
                        className={s.cellBtn}
                        aria-expanded={isOpen}
                        aria-label={`${r.title}, ${c.id} ${c.label}: ${cellText(cell)}. Show receipt`}
                        onClick={() => toggle(i, c.id)}
                      >
                        <CellView c={cell} />
                      </button>
                    </td>
                  );
                })}
              </tr>
              {open?.row === i ? (
                <tr className={s.detailRow}>
                  <td colSpan={5}>
                    {open.col === 'story' ? (
                      <div className={s.story}>
                        <div>
                          <h4>Attack</h4>
                          <p>{r.attack ?? 'No description published for this card yet.'}</p>
                        </div>
                        <div>
                          <h4>Guard</h4>
                          <p>{r.defense ?? GUARD_LABEL[r.guard]}</p>
                        </div>
                        <div>
                          <h4>Proof</h4>
                          <p>{r.test ? <code>{r.test}</code> : 'No test name published yet.'}</p>
                        </div>
                      </div>
                    ) : (
                      <Receipt c={r.cells[open.col]} config={open.col} test={r.test} />
                    )}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
          {table.metric2 ? (
            <tr className={s.metricRow}>
              <th scope="row" className={s.cardCol}>
                <span className={s.cardTitle}>Legit new seller</span>
                <span className={s.guard}>Paid without asking the owner?</span>
              </th>
              {CONFIGS.map((c) => (
                <td key={c.id}>
                  <span className={s.cellStatic}>
                    <Metric2View c={table.metric2![c.id]} />
                  </span>
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>

      {/* Phones: one block per attack card */}
      <ul className={s.stack} aria-label={caption}>
        {table.rows.map((r) => (
          <li key={r.cardId} className={s.stackItem}>
            <div className={s.stackHead}>
              <span className={s.cardTitle}>{r.title}</span>
              <span className={s.guard}>{GUARD_LABEL[r.guard]}</span>
            </div>
            <dl className={s.stackGrid}>
              {CONFIGS.map((c) => (
                <div key={c.id}>
                  <dt>
                    {c.id} · {c.short}
                  </dt>
                  <dd>
                    <CellView c={r.cells[c.id]} />
                    {r.cells[c.id].txHash ? <Hex value={r.cells[c.id].txHash!} kind="tx" /> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
        {table.metric2 ? (
          <li className={s.stackItem}>
            <div className={s.stackHead}>
              <span className={s.cardTitle}>Legit new seller</span>
              <span className={s.guard}>Paid without asking the owner?</span>
            </div>
            <dl className={s.stackGrid}>
              {CONFIGS.map((c) => (
                <div key={c.id}>
                  <dt>
                    {c.id} · {c.short}
                  </dt>
                  <dd>
                    <Metric2View c={table.metric2![c.id]} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/** Sum of value lost beyond policy in one configuration, per asset symbol. */
export function lossSummary(table: X1Table, config: ConfigId) {
  const pending = table.rows.filter((r) => r.cells[config].outcome === 'pending').length;
  const totals = new Map<string, { value: bigint; decimals: number }>();
  for (const r of table.rows) {
    const c = r.cells[config];
    if (c.outcome === 'lost' && c.amount !== undefined && c.asset) {
      const t = totals.get(c.asset.symbol) ?? { value: 0n, decimals: c.asset.decimals };
      t.value += c.amount;
      totals.set(c.asset.symbol, t);
    }
  }
  const lostCards = table.rows.filter((r) => r.cells[config].outcome === 'lost').length;
  return { pending, totals, lostCards, total: table.rows.length };
}
