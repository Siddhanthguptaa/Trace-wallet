import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import s from './scenarios.module.css';
import { Amount, Button, EmptyState, ErrorState, Glass, Hex, Kbd, Loading, Segmented } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { Ledger } from '@/components/Ledger';
import { PAPER_URL } from '@/components/Chrome';
import { useResults } from '@/api/queries';
import type { Asset, Cell, Metric2Cell, X1Table } from '@/api/schemas';
import { describeReason } from '@/domain/reasons';
import { formatUnits } from '@/domain/units';
import type { ConfigId } from '@/domain/tracks';

/* Every recorded scenario, replayed by a click. All outcomes come from the runner's results; nothing here is invented. */

type Row = X1Table['rows'][number];
type Kind = 'lost' | 'refused' | 'bounded' | 'na' | 'pending' | 'paid' | 'blocked' | 'ping';
type Tone = 'loss' | 'held' | 'bound' | 'starved' | 'muted';
type Out = {
  kind: Kind;
  amount?: bigint;
  asset?: Asset;
  reason?: string;
  tx?: string;
  runs?: { k: number; n: number };
  paid?: number;
  total?: number;
};
type Scenario = {
  id: string;
  title: string;
  guard: Row['guard'];
  story: string;
  defense?: string;
  test?: string;
  legit: boolean;
  outs: Record<ConfigId, Out>;
};

const GUARD: Record<Row['guard'], string> = { core: 'Core policy', D1: 'D1 · one door', D2: 'D2 · measured limits', D3: 'D3 · TRACE tracks' };
const DOOR = 0.56; // where the wallet's check sits along each lane

const fromCell = (c: Cell): Out => ({ kind: c.outcome, amount: c.amount, asset: c.asset, reason: c.reasonCode, tx: c.txHash, runs: c.runs });
const fromM2 = (c: Metric2Cell): Out => ({ kind: c.outcome, paid: c.paid, total: c.total });

function toScenarios(t: X1Table): Scenario[] {
  const list: Scenario[] = t.rows.map((r) => ({
    id: r.cardId,
    title: r.title,
    guard: r.guard,
    story: r.attack ?? '',
    defense: r.defense,
    test: r.test,
    legit: false,
    outs: { R1: fromCell(r.cells.R1), R2: fromCell(r.cells.R2), R3: fromCell(r.cells.R3), R4: fromCell(r.cells.R4) },
  }));
  if (t.metric2) {
    const m = t.metric2;
    list.push({
      id: 'legit-seller',
      title: 'Honest new seller',
      guard: 'D3',
      story: 'A real seller the wallet has never paid asks for small payments. Does it get paid without the owner stepping in?',
      legit: true,
      outs: { R1: fromM2(m.R1), R2: fromM2(m.R2), R3: fromM2(m.R3), R4: fromM2(m.R4) },
    });
  }
  return list;
}

function tone(o: Out, legit: boolean): Tone {
  if (legit) return o.kind === 'paid' ? 'held' : o.kind === 'blocked' ? 'starved' : o.kind === 'ping' ? 'bound' : 'muted';
  return o.kind === 'lost' ? 'loss' : o.kind === 'refused' ? 'held' : o.kind === 'bounded' ? 'bound' : 'muted';
}

const money = (o: Out) => (o.amount !== undefined && o.asset ? `${formatUnits(o.amount, o.asset.decimals)} ${o.asset.symbol}` : null);

function describe(o: Out): string {
  switch (o.kind) {
    case 'lost':
      return money(o) ? `lost ${money(o)}` : 'lost the asset';
    case 'refused':
      return `refused (${describeReason(o.reason).label.toLowerCase()})`;
    case 'bounded':
      return money(o) ? `capped at ${money(o)}` : 'capped at the bound';
    case 'paid':
      return o.total !== undefined ? `paid ${o.paid ?? 0} of ${o.total}` : 'paid';
    case 'blocked':
      return o.total !== undefined ? `paid ${o.paid ?? 0} of ${o.total}` : 'blocked';
    case 'ping':
      return 'needed the owner';
    case 'na':
      return 'not applicable';
    default:
      return 'not run yet';
  }
}

const same = (a: Out, b: Out) => a.kind === b.kind && a.amount === b.amount && a.paid === b.paid;

/* ---------------------------------------------------------------- component */

export function Scenarios() {
  const results = useResults();
  const scenarios = useMemo(() => (results.data ? toScenarios(results.data) : []), [results.data]);
  const [idx, setIdx] = useState(0);
  const [trace, setTrace] = useState(true);
  const [play, setPlay] = useState(false);
  const [replay, setReplay] = useState(0);
  const [ledger, setLedger] = useState(false);

  const n = scenarios.length;
  const cur = scenarios[Math.min(idx, Math.max(0, n - 1))];

  const pick = useCallback((i: number) => {
    setPlay(false);
    setIdx(i);
    setReplay((r) => r + 1);
  }, []);

  // Play every scenario in turn, each with TRACE off then on.
  useEffect(() => {
    if (!play || n === 0) return;
    const t = window.setTimeout(() => {
      if (!trace) setTrace(true);
      else {
        setTrace(false);
        setIdx((i) => (i + 1) % n);
        setReplay((r) => r + 1);
      }
    }, 3200);
    return () => window.clearTimeout(t);
  }, [play, trace, idx, n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey || n === 0) return;
      if (e.key === 'ArrowRight') pick((idx + 1) % n);
      else if (e.key === 'ArrowLeft') pick((idx - 1 + n) % n);
      else if (e.key === 't' || e.key === 'T') setTrace((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, n, pick]);

  if (results.isPending)
    return (
      <Glass className={s.wrap}>
        <Loading lines={8} label="Loading the recorded scenarios" />
      </Glass>
    );
  if (results.isError)
    return (
      <Glass className={s.wrap}>
        <ErrorState error={results.error} title="The recorded scenarios are unavailable" onRetry={() => results.refetch()} />
      </Glass>
    );
  if (!cur) return <EmptyState title="No scenarios recorded yet">Run the attack cards once and they appear here.</EmptyState>;

  const ours: ConfigId = trace ? 'R4' : 'R3';
  const lanes: { id: ConfigId; name: string; sub: string; door: string }[] = [
    { id: 'R1', name: 'Raw key', sub: 'R1 · no wallet logic', door: 'no check' },
    { id: 'R2', name: 'Static allowlist', sub: 'R2 · fixed payee list', door: 'allowlist' },
    { id: ours, name: 'trace-wallet', sub: trace ? 'R4 · TRACE on' : 'R3 · TRACE off', door: 'policy' },
  ];

  return (
    <div className={s.wrap}>
      {/* Picker */}
      <Glass className={s.pickerPanel}>
        <div className={s.pickerHead}>
          <h2 className={s.h}>
            {n} scenarios <span>· recorded on four wallets</span>
          </h2>
          <div className={s.pickerTools}>
            <Button size="small" variant={play ? 'primary' : 'secondary'} onClick={() => setPlay((v) => !v)} aria-pressed={play}>
              <Icon name={play ? 'pause' : 'play'} size={14} /> {play ? 'Stop' : 'Play all'}
            </Button>
            <span className={s.hint}>
              <Kbd>←</Kbd>
              <Kbd>→</Kbd> scenario · <Kbd>T</Kbd> TRACE
            </span>
          </div>
        </div>
        <ol className={s.picker}>
          {scenarios.map((sc, i) => (
            <li key={sc.id}>
              <button type="button" className={s.pick} aria-current={i === idx ? 'true' : undefined} onClick={() => pick(i)}>
                <span className={s.pickGuard}>{sc.legit ? 'Honest flow' : GUARD[sc.guard]}</span>
                <span className={s.pickTitle}>{sc.title}</span>
                <span className={s.dots} aria-hidden="true">
                  {(['R1', 'R2', 'R3', 'R4'] as const).map((c) => (
                    <i key={c} data-tone={tone(sc.outs[c], sc.legit)} />
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </Glass>

      {/* Stage */}
      <Glass className={s.stage} aria-live="polite">
        <div className={s.stageHead}>
          <div className={s.stageText}>
            <p className={s.kicker}>
              {sc_label(cur)} · scenario {Math.min(idx, n - 1) + 1} of {n}
            </p>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={cur.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
              >
                <h3 className={s.title}>{cur.title}</h3>
                {cur.story ? <p className={s.story}>{cur.story}</p> : null}
              </motion.div>
            </AnimatePresence>
          </div>
          <div className={s.traceSwitch}>
            <span className={s.traceLabel}>TRACE</span>
            <Segmented
              label="TRACE"
              value={trace ? 'on' : 'off'}
              onChange={(v) => {
                setPlay(false);
                setTrace(v === 'on');
              }}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ]}
            />
            <button type="button" className={s.replay} onClick={() => setReplay((r) => r + 1)}>
              <Icon name="refresh" size={14} /> Replay
            </button>
          </div>
        </div>

        <div className={s.lanes}>
          {lanes.map((l, i) => (
            <Lane
              key={`${cur.id}-${l.id}-${replay}`}
              name={l.name}
              sub={l.sub}
              door={l.door}
              out={cur.outs[l.id]}
              legit={cur.legit}
              delay={i * 0.14}
              ours={l.name === 'trace-wallet'}
              noDoor={l.id === 'R1'}
            />
          ))}
        </div>

        <Delta key={`${cur.id}-${trace}`} sc={cur} trace={trace} />
      </Glass>

      {/* Impact across all scenarios */}
      <Impact scenarios={scenarios} active={idx} trace={trace} onPick={pick} />

      <div className={s.ledgerToggle}>
        <Button size="small" variant="ghost" onClick={() => setLedger((v) => !v)} aria-expanded={ledger}>
          {ledger ? 'Hide' : 'Show'} the full ledger with transactions
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {ledger && results.data ? (
          <motion.div
            key="ledger"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.3 }}
          >
            <Glass className={s.ledger}>
              <Ledger table={results.data} caption="Every scenario across all four wallets" />
            </Glass>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function sc_label(sc: Scenario) {
  return sc.legit ? 'Honest flow' : GUARD[sc.guard];
}

/* ---------------------------------------------------------------- one lane */

function Lane({
  name,
  sub,
  door,
  out,
  legit,
  delay,
  ours,
  noDoor,
}: {
  name: string;
  sub: string;
  door: string;
  out: Out;
  legit: boolean;
  delay: number;
  ours: boolean;
  noDoor: boolean;
}) {
  const t = tone(out, legit);
  const stops = out.kind === 'refused' || out.kind === 'blocked' || out.kind === 'ping';
  const passes = out.kind === 'lost' || out.kind === 'paid' || out.kind === 'bounded';
  const travel = 1.05;
  const pct = `${DOOR * 100}%`;

  const chip = stops
    ? { x: ['0%', pct, `${DOOR * 100 - 5}%`, `${DOOR * 100 - 2}%`], transition: { duration: travel, times: [0, 0.6, 0.8, 1], delay, ease: 'easeOut' as const } }
    : passes
      ? {
          x: ['0%', pct, '100%'],
          transition: { duration: travel, times: [0, 0.55, 1], delay, ease: 'easeInOut' as const },
        }
      : out.kind === 'pending'
        ? { opacity: [0.35, 1, 0.35], transition: { duration: 1.6, repeat: Infinity, delay } }
        : { opacity: 0.25 };

  return (
    <div className={s.lane} data-tone={t} data-ours={ours || undefined}>
      <div className={s.laneName}>
        <b>{name}</b>
        <span>{sub}</span>
      </div>

      <div className={s.track} aria-hidden="true">
        <span className={s.line} />
        <span className={s.from}>agent</span>
        <span className={s.to}>{legit ? 'seller' : 'attacker'}</span>
        <div className={s.box}>
          <span className={s.door} data-none={noDoor || undefined} style={{ left: pct }}>
            <motion.i
              initial={{ opacity: 0 }}
              animate={stops ? { opacity: [0, 0, 1, 0.45] } : { opacity: 0 }}
              transition={{ duration: travel, times: [0, 0.55, 0.65, 1], delay }}
            />
            <em>{door}</em>
          </span>
          <motion.span className={s.runner} initial={{ x: '0%' }} animate={chip}>
            <motion.span
              className={s.chip}
              initial={{ scale: 1 }}
              animate={{ scale: out.kind === 'bounded' ? [1, 1, 0.55] : 1 }}
              transition={{ duration: travel, times: [0, 0.55, 1], delay }}
            >
              <motion.i
                initial={{ opacity: 0 }}
                animate={{ opacity: out.kind === 'na' || out.kind === 'pending' ? 0 : [0, 0, 1] }}
                transition={{ duration: travel, times: [0, 0.56, 0.7], delay }}
              />
            </motion.span>
          </motion.span>
        </div>
      </div>

      <motion.div
        className={s.result}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: delay + (out.kind === 'pending' || out.kind === 'na' ? 0.1 : travel * 0.85) }}
      >
        <Verdict out={out} />
      </motion.div>
    </div>
  );
}

function Verdict({ out }: { out: Out }) {
  const amount =
    out.amount !== undefined && out.asset ? (
      <Amount value={out.amount} decimals={out.asset.decimals} symbol={out.asset.symbol} sign={out.kind === 'lost' ? 'out' : undefined} />
    ) : null;
  let head: React.ReactNode;
  let note: React.ReactNode = null;
  switch (out.kind) {
    case 'lost':
      head = amount ?? 'Asset lost';
      note = 'Left the wallet.';
      break;
    case 'refused': {
      const r = describeReason(out.reason);
      head = 'Refused';
      note = r.label;
      break;
    }
    case 'bounded':
      head = amount ? <>≤ {amount}</> : 'Bounded';
      note = 'Capped by the exploration budget.';
      break;
    case 'paid':
      head = out.total !== undefined ? `Paid ${out.paid ?? 0}/${out.total}` : 'Paid';
      note = 'No owner needed.';
      break;
    case 'blocked':
      head = out.total !== undefined ? `Paid ${out.paid ?? 0}/${out.total}` : 'Blocked';
      note = 'The honest seller was turned away.';
      break;
    case 'ping':
      head = 'Owner ping';
      note = 'Every payment needed the owner.';
      break;
    case 'na':
      head = 'n/a';
      note = 'This wallet has no such path.';
      break;
    default:
      head = 'Not run yet';
      note = 'Awaiting a recorded run.';
  }
  return (
    <>
      <b className={s.head}>{head}</b>
      <span className={s.note}>{note}</span>
      <span className={s.meta}>
        {out.runs ? <span>{`${out.runs.k}/${out.runs.n} LLM runs`}</span> : null}
        {out.tx ? <Hex value={out.tx} kind="tx" /> : null}
      </span>
    </>
  );
}

/* ---------------------------------------------------------------- what TRACE changed here */

function Delta({ sc, trace }: { sc: Scenario; trace: boolean }) {
  const off = sc.outs.R3;
  const on = sc.outs.R4;
  const pending = off.kind === 'pending' || on.kind === 'pending';
  const changed = !pending && !same(off, on);
  return (
    <motion.div
      className={s.delta}
      data-changed={changed || undefined}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.9 }}
    >
      <span className={s.deltaTag}>{changed ? 'TRACE changes this' : pending ? 'Not comparable yet' : 'Same either way'}</span>
      <p>
        {pending ? (
          <>One of the two trace-wallet runs has not been recorded yet.</>
        ) : changed ? (
          <>
            Without TRACE, trace-wallet <b>{describe(off)}</b>. With TRACE, it <b>{describe(on)}</b>.{' '}
            {trace ? 'Switch TRACE off to see the difference.' : 'Switch TRACE on to see the difference.'}
          </>
        ) : (
          <>
            trace-wallet {describe(on)} with or without TRACE. {sc.legit ? '' : `${GUARD[sc.guard]} handles this one.`}
          </>
        )}
      </p>
    </motion.div>
  );
}

/* ---------------------------------------------------------------- impact across all scenarios */

function Impact({ scenarios, active, trace, onPick }: { scenarios: Scenario[]; active: number; trace: boolean; onPick: (i: number) => void }) {
  const attacks = scenarios.filter((x) => !x.legit);
  const legit = scenarios.find((x) => x.legit);
  const comparable = attacks.filter((x) => x.outs.R3.kind !== 'pending' && x.outs.R4.kind !== 'pending');
  const changed = comparable.filter((x) => !same(x.outs.R3, x.outs.R4)).length;

  const lostSum = (c: ConfigId) => {
    const m = new Map<string, { v: bigint; d: number }>();
    for (const x of attacks) {
      const o = x.outs[c];
      if (o.kind === 'lost' && o.amount !== undefined && o.asset) {
        const e = m.get(o.asset.symbol) ?? { v: 0n, d: o.asset.decimals };
        e.v += o.amount;
        m.set(o.asset.symbol, e);
      }
    }
    return m.size ? [...m.entries()].map(([sym, e]) => `${formatUnits(e.v, e.d)} ${sym}`).join(' + ') : `0.00`;
  };
  const lostCount = (c: ConfigId) => attacks.filter((x) => x.outs[c].kind === 'lost').length;

  const rows: { id: ConfigId; name: string }[] = [
    { id: 'R1', name: 'Raw key' },
    { id: 'R2', name: 'Static allowlist' },
    { id: 'R3', name: 'trace-wallet, TRACE off' },
    { id: 'R4', name: 'trace-wallet, TRACE on' },
  ];
  const current: ConfigId = trace ? 'R4' : 'R3';
  const seller = (c: ConfigId) => {
    const o = legit?.outs[c];
    return o && o.total !== undefined ? `${o.paid ?? 0}/${o.total}` : '—';
  };

  return (
    <Glass className={s.impact}>
      <div className={s.impactHead}>
        <h2 className={s.h}>
          What TRACE changes <span>· across every recorded scenario</span>
        </h2>
      </div>

      <div className={s.figures}>
        <Figure label="Scenarios TRACE changes" value={`${changed}`} unit={`of ${comparable.length}`} tone="bound" />
        <Figure label="Lost beyond policy" value={lostSum('R3')} arrow={lostSum('R4')} note="TRACE off → on" tone="loss" />
        <Figure label="Honest new seller paid" value={seller('R3')} arrow={seller('R4')} note="TRACE off → on, no owner" tone="held" />
      </div>

      <div className={s.board} role="table" aria-label="Outcome of every scenario per wallet">
        <div className={s.boardRow} role="row" data-head>
          <span role="columnheader">Wallet</span>
          <span role="columnheader">Each square is one scenario. Click one to replay it.</span>
          <span role="columnheader">Lost</span>
        </div>
        {rows.map((r) => (
          <div key={r.id} className={s.boardRow} role="row" data-current={r.id === current || undefined}>
            <span role="rowheader" className={s.boardName}>
              <b>{r.id}</b> {r.name}
            </span>
            <span role="cell" className={s.squares}>
              {scenarios.map((sc, i) => (
                <motion.button
                  key={sc.id}
                  type="button"
                  className={s.square}
                  data-tone={tone(sc.outs[r.id], sc.legit)}
                  data-active={i === active || undefined}
                  aria-label={`${sc.title}, ${r.name}: ${describe(sc.outs[r.id])}`}
                  title={`${sc.title}: ${describe(sc.outs[r.id])}`}
                  onClick={() => onPick(i)}
                  initial={{ opacity: 0, scale: 0.6 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true, margin: '-40px' }}
                  transition={{ duration: 0.3, delay: i * 0.035 }}
                />
              ))}
            </span>
            <span role="cell" className={s.boardLost} data-zero={lostCount(r.id) === 0 || undefined}>
              {lostCount(r.id)} <small>of {attacks.length}</small>
            </span>
          </div>
        ))}
        <div className={s.legend} aria-hidden="true">
          <span data-tone="loss">Lost</span>
          <span data-tone="bound">Capped</span>
          <span data-tone="held">Refused attack, or honest seller paid</span>
          <span data-tone="starved">Honest seller turned away</span>
          <span data-tone="muted">n/a or not run</span>
        </div>
      </div>

      <aside className={s.research}>
        <p className={s.kicker}>In an open market · from the TRACE paper (simulated agents, not these runs)</p>
        <div className={s.researchGrid}>
          <div>
            <b>
              66 <Icon name="arrowRight" size={14} /> 125
            </b>
            <span>honest providers served, of 700, once newcomers get an exploration track</span>
          </div>
          <div>
            <b>
              32.0 <Icon name="arrowRight" size={14} /> 6.4
            </b>
            <span>sats lost to fraud when each buyer sees only its own history, greedy vs exploring</span>
          </div>
        </div>
        <a href={PAPER_URL} target="_blank" rel="noreferrer" className={s.paper}>
          Read the paper
        </a>
      </aside>
    </Glass>
  );
}

function Figure({ label, value, arrow, unit, note, tone: t }: { label: string; value: string; arrow?: string; unit?: string; note?: string; tone: Tone }) {
  return (
    <div className={s.figure} data-tone={t}>
      <span className={s.figLabel}>{label}</span>
      <span className={s.figValue}>
        {arrow !== undefined ? (
          <>
            <del className={s.was}>{value}</del>
            <Icon name="arrowRight" size={18} />
            <b>{arrow}</b>
          </>
        ) : (
          <>
            <b>{value}</b>
            {unit ? <small>{unit}</small> : null}
          </>
        )}
      </span>
      {note ? <span className={s.figNote}>{note}</span> : null}
    </div>
  );
}
