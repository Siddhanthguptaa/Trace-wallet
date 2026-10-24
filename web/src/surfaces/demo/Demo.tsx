import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import s from './demo.module.css';
import { SiteHeader } from '@/components/Chrome';
import {
  Amount,
  Button,
  DataAge,
  ErrorState,
  Glass,
  Hex,
  Kbd,
  Loading,
  ReasonCode,
  Segmented,
  TextField,
  TrackBadge,
  BucketGauge,
  EmptyState,
} from '@/components/ui';
import { Scenarios } from './Scenarios';
import { Door, type DoorPhase } from '@/components/Door';
import { Icon } from '@/components/Icon';
import { useBounty, useBudget, useCards, useConfigs, usePolicy, useTokenBalance } from '@/api/queries';
import { agentTools, runner } from '@/api/clients';
import type { Asset, Card, PayResult, RunEvent, WalletConfig } from '@/api/schemas';
import { CONFIGS, toTrack, type ConfigId } from '@/domain/tracks';
import { parseUnits } from '@/domain/units';
import { isAddress } from 'viem';

type Attempt = Extract<RunEvent, { type: 'attempt' }>;
type Tab = 'live' | 'scenarios' | 'try';

function useProjector() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.dataset.projector;
    root.dataset.projector = on ? 'on' : 'off';
    return () => {
      if (prev) root.dataset.projector = prev;
      else delete root.dataset.projector;
    };
  }, [on]);
  return [on, setOn] as const;
}

export default function Demo() {
  const [projector, setProjector] = useProjector();
  const [tab, setTab] = useState<Tab>('live');
  const [shooter, setShooter] = useState<'raw' | 'llm'>('raw');
  const [helpOpen, setHelpOpen] = useState(false);
  const cards = useCards();
  const configs = useConfigs();
  const bounty = useBounty();
  const demoPolicy = usePolicy(bounty.data?.wallet);
  const demoAsset = demoPolicy.data?.assets[0]?.asset;

  const [active, setActive] = useState<Card | null>(null);
  const [running, setRunning] = useState(false);
  const [latest, setLatest] = useState<Partial<Record<ConfigId, Attempt>>>({});
  const [feed, setFeed] = useState<RunEvent[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const closeRef = useRef<() => void>(() => {});

  const fire = useCallback(
    async (card: Card) => {
      if (running) return;
      closeRef.current();
      setActive(card);
      setRunning(true);
      setRunError(null);
      setLatest({});
      setTab('live');
      try {
        const { runId } = await runner.fire(card.id, shooter);
        closeRef.current = runner.stream(
          runId,
          (e) => {
            setFeed((f) => [e, ...f].slice(0, 60));
            if (e.type === 'attempt') {
              setLatest((l) => ({ ...l, [e.config]: e }));
              if (e.outcome !== 'pending') setAnnounce(`${e.config}: ${e.outcome}${e.reasonCode ? `, ${e.reasonCode}` : ''}`);
            }
            if (e.type === 'done') setRunning(false);
          },
          (err) => {
            setRunError(err.message);
            setRunning(false);
          },
        );
      } catch (e) {
        setRunError((e as Error).message);
        setRunning(false);
      }
    },
    [running, shooter],
  );

  useEffect(() => () => closeRef.current(), []);

  // Presenter shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const list = cards.data ?? [];
      if (/^[0-9]$/.test(e.key)) {
        const i = e.key === '0' ? 9 : Number(e.key) - 1;
        const c = list[i];
        if (c) fire(c);
      } else if (e.key === ' ' && list.length) {
        e.preventDefault();
        const i = active ? list.findIndex((c) => c.id === active.id) : -1;
        const next = list[(i + 1) % list.length];
        if (next) fire(next);
      } else if (e.key === 'p' || e.key === 'P') setProjector((v) => !v);
      else if (e.key === 's' || e.key === 'S') setTab('scenarios');
      else if (e.key === 'l' || e.key === 'L') setTab('live');
      else if (e.key === '?') setHelpOpen((v) => !v);
      else if (e.key === 'Escape') setHelpOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards.data, active, fire, setProjector]);

  return (
    <div className={s.page}>
      <SiteHeader
        right={
          <div className={s.headerTools}>
            <Segmented
              label="Display"
              value={projector ? 'proj' : 'std'}
              onChange={(v) => setProjector(v === 'proj')}
              options={[
                { value: 'proj', label: 'Projector' },
                { value: 'std', label: 'Standard' },
              ]}
            />
            <Button size="small" variant="ghost" onClick={() => setHelpOpen((v) => !v)} aria-expanded={helpOpen}>
              <Kbd>?</Kbd> Shortcuts
            </Button>
          </div>
        }
      />
      <div className="visually-hidden" aria-live="assertive">
        {announce}
      </div>

      <BountyBand bounty={bounty} asset={demoAsset} policyAssets={demoPolicy.data?.assets} />

      {helpOpen ? <Shortcuts onClose={() => setHelpOpen(false)} /> : null}

      <div className={s.stage}>
        <aside className={s.deck} aria-label="Attack deck">
          <div className={s.deckHead}>
            <h2>Attack deck</h2>
            <Segmented
              label="Shooter"
              value={shooter}
              onChange={setShooter}
              options={[
                { value: 'raw', label: 'Raw key' },
                { value: 'llm', label: 'Hypnotized LLM' },
              ]}
            />
          </div>
          {cards.isPending ? (
            <Loading lines={6} label="Loading cards" />
          ) : cards.isError ? (
            <ErrorState error={cards.error} title="Can't load the attack deck" onRetry={() => cards.refetch()} />
          ) : cards.data.length === 0 ? (
            <EmptyState title="No attack cards published" />
          ) : (
            <ol className={s.cards}>
              {cards.data.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={s.card}
                    aria-current={active?.id === c.id ? 'true' : undefined}
                    disabled={running}
                    onClick={() => fire(c)}
                  >
                    <span className={s.cardKey}>{i < 10 ? <Kbd>{i === 9 ? 0 : i + 1}</Kbd> : null}</span>
                    <span className={s.cardBody}>
                      <span className={s.cardTitle}>{c.title}</span>
                      <span className={s.cardSummary}>{c.summary}</span>
                    </span>
                    <span className={s.cardGuard}>{c.guard === 'core' ? 'Core' : c.guard}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>

        <section className={s.center} aria-label="Wallets">
          <div className={s.centerHead}>
            <div role="tablist" aria-label="View" className={s.tabs}>
              {(
                [
                  ['live', 'Live'],
                  ['scenarios', 'Scenarios'],
                  ['try', 'Try it yourself'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={s.tab} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            {active && tab === 'live' ? (
              <p className={s.nowFiring}>
                {running ? 'Firing' : 'Fired'} <strong>{active.title}</strong> with the {shooter === 'raw' ? 'raw key' : 'hypnotized LLM'}
              </p>
            ) : null}
          </div>

          {runError ? (
            <Glass className={s.inlineError}>
              <ErrorState error={new Error(runError)} title="The run stopped" />
            </Glass>
          ) : null}

          {tab === 'live' ? (
            configs.isPending ? (
              <Glass>
                <Loading lines={5} />
              </Glass>
            ) : configs.isError ? (
              <Glass>
                <ErrorState error={configs.error} title="Can't load the four wallets" onRetry={() => configs.refetch()} />
              </Glass>
            ) : (
              <div className={s.columns}>
                {CONFIGS.map((meta) => {
                  const cfg = configs.data.find((c) => c.id === meta.id);
                  return (
                    <WalletColumn
                      key={meta.id}
                      id={meta.id}
                      label={meta.label}
                      cfg={cfg}
                      asset={demoAsset}
                      attempt={latest[meta.id]}
                      running={running}
                      cardTitle={active?.title}
                    />
                  );
                })}
              </div>
            )
          ) : tab === 'scenarios' ? (
            <Scenarios />
          ) : (
            <TryIt wallet={bounty.data?.wallet} asset={demoAsset} />
          )}
        </section>
      </div>

      <Ticker feed={feed} />
    </div>
  );
}

/* ---------- Bounty band ---------- */
function BountyBand({
  bounty,
  asset,
  policyAssets,
}: {
  bounty: ReturnType<typeof useBounty>;
  asset?: Asset;
  policyAssets?: { asset: Asset; globalCap: bigint; exploreCap: bigint }[];
}) {
  const caps = policyAssets?.[0];
  const budget = useBudget(bounty.data?.wallet);
  const global = budget.data?.buckets.find((b) => b.scope === 'global' && asset && b.asset.toLowerCase() === asset.address.toLowerCase());
  return (
    <Glass as="section" className={s.band} aria-label="The bounty">
      <div className={s.bandKey}>
        <span className={s.bandLabel}>
          <Icon name="key" size={16} /> The agent's private key. Take it.
        </span>
        {bounty.data ? (
          <Hex value={bounty.data.agentPrivateKey} kind="key" full className={s.bigKey} />
        ) : bounty.isError ? (
          <span className={s.bandMuted}>The runner did not publish the key ({bounty.error.message}).</span>
        ) : (
          <span className={s.bandMuted}>Loading…</span>
        )}
        {bounty.data ? (
          <span className={s.bandMuted}>
            Agent <Hex value={bounty.data.agentAddress} /> · Wallet <Hex value={bounty.data.wallet} />
          </span>
        ) : null}
      </div>
      <div className={s.bandBound}>
        <span className={s.bandLabel}>Most anyone can take with it in 24 hours</span>
        {caps ? (
          <>
            <span className={s.boundNum}>
              <Amount value={caps.globalCap} decimals={caps.asset.decimals} symbol={caps.asset.symbol} />
            </span>
            <span className={s.bandSub}>
              of which at most <Amount value={caps.exploreCap} decimals={caps.asset.decimals} symbol={caps.asset.symbol} /> to
              strangers
            </span>
          </>
        ) : (
          <span className={s.bandMuted}>Waiting for the wallet's policy…</span>
        )}
      </div>
      <div className={s.bandLeft}>
        <span className={s.bandLabel}>Left right now</span>
        {global && asset ? (
          <>
            <span className={s.leftNum}>
              <Amount value={global.level} decimals={asset.decimals} symbol={asset.symbol} />
            </span>
            {budget.dataUpdatedAt ? <DataAge updatedAt={budget.dataUpdatedAt} /> : null}
          </>
        ) : (
          <span className={s.bandMuted}>{budget.isError ? 'Budget unavailable' : '…'}</span>
        )}
      </div>
    </Glass>
  );
}

/* ---------- Wallet column ---------- */
function WalletColumn({
  id,
  label,
  cfg,
  asset,
  attempt,
  running,
  cardTitle,
}: {
  id: ConfigId;
  label: string;
  cfg?: WalletConfig;
  asset?: Asset;
  attempt?: Attempt;
  running: boolean;
  cardTitle?: string;
}) {
  const wallet = cfg?.wallet as Address | undefined;
  const balance = useTokenBalance(asset?.address, wallet);
  const budget = useBudget(id === 'R1' ? undefined : wallet);

  let phase: DoorPhase = 'idle';
  if (attempt) {
    if (attempt.outcome === 'pending') phase = 'travel';
    else if (attempt.outcome === 'refused') phase = 'stop';
    else phase = 'pass';
  } else if (running) phase = 'travel';

  const verdict = attempt ? <Verdict a={attempt} /> : null;
  const buckets = budget.data?.buckets.filter((b) => !asset || b.asset.toLowerCase() === asset.address.toLowerCase()) ?? [];

  return (
    <Glass className={s.column} data-outcome={attempt?.outcome ?? 'none'}>
      <header className={s.colHead}>
        <span className={s.colId}>{id}</span>
        <span className={s.colLabel}>{label}</span>
      </header>
      <div className={s.colBalance}>
        <span className={s.bandLabel}>Balance</span>
        <span className={s.balanceNum}>
          {balance.data !== undefined && asset ? (
            <Amount value={balance.data} decimals={asset.decimals} symbol={asset.symbol} />
          ) : wallet ? (
            '…'
          ) : (
            '—'
          )}
        </span>
        {wallet ? <Hex value={wallet} /> : <span className={s.bandMuted}>Not deployed</span>}
      </div>
      <Door
        phase={phase}
        token={cardTitle ?? 'Idle'}
        verdict={verdict}
        label={attempt ? `${id}: ${attempt.outcome}` : `${id}: idle`}
      />
      <div className={s.colResult}>{attempt ? <AttemptDetail a={attempt} /> : <span className={s.bandMuted}>No attempt yet</span>}</div>
      {id === 'R1' ? (
        <p className={s.colNote}>A raw key has no budget. Whoever holds it can move everything.</p>
      ) : buckets.length && asset ? (
        <div className={s.colGauges}>
          {buckets.map((b) => (
            <BucketGauge key={b.scope + (b.agentKey ?? '')} bucket={b} decimals={asset.decimals} symbol={asset.symbol} />
          ))}
        </div>
      ) : budget.isError ? (
        <p className={s.colNote}>Budget unavailable.</p>
      ) : null}
    </Glass>
  );
}

function Verdict({ a }: { a: Attempt }) {
  if (a.outcome === 'refused') return <span className={s.vStop}>{a.reasonCode ?? 'Refused'}</span>;
  if (a.outcome === 'lost') return <span className={s.vLost}>Lost</span>;
  if (a.outcome === 'bounded') return <span className={s.vBound}>Within bound</span>;
  if (a.outcome === 'paid') return <span className={s.vPaid}>Paid</span>;
  return null;
}

function AttemptDetail({ a }: { a: Attempt }) {
  return (
    <div className={s.attempt}>
      {a.amount !== undefined && a.asset ? (
        <span className={a.outcome === 'lost' ? s.lostAmt : s.amt}>
          <Amount value={a.amount} decimals={a.asset.decimals} symbol={a.asset.symbol} sign={a.outcome === 'refused' ? undefined : 'out'} />
        </span>
      ) : null}
      {a.reasonCode ? <ReasonCode code={a.reasonCode} /> : null}
      {a.k !== undefined && a.n !== undefined ? (
        <span className={s.bandMuted}>
          {a.k} of {a.n} LLM attempts
        </span>
      ) : null}
      {a.txHash ? <Hex value={a.txHash} kind="tx" /> : null}
    </div>
  );
}

/* ---------- Try it yourself ---------- */
function TryIt({ wallet, asset }: { wallet?: Address; asset?: Asset }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PayResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<DoorPhase>('idle');

  const toErr = to && !isAddress(to) ? 'Not a valid address' : null;
  const value = asset ? parseUnits(amount, asset.decimals) : null;
  const amtErr = amount && value === null ? `Use a plain number with at most ${asset?.decimals ?? 6} decimals` : null;
  const ready = Boolean(wallet && asset && isAddress(to) && value && value > 0n);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !wallet || !asset || !value) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    setPhase('travel');
    try {
      const r = await agentTools.pay({ wallet, to, asset: asset.address, amount: value });
      setResult(r);
      setPhase(r.status === 'executed' ? 'pass' : 'stop');
    } catch (e2) {
      setErr((e2 as Error).message);
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Glass pad className={s.try}>
      <div className={s.tryIntro}>
        <h2>Pay any address with the leaked key</h2>
        <p>
          This sends a real payment request through the agent tools, signed with the key shown above. The wallet decides. Your
          own address is a fresh, unproven payee.
        </p>
      </div>
      <form className={s.tryForm} onSubmit={submit}>
        <TextField label="Pay to" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} error={toErr} mono />
        <TextField
          label={`Amount${asset ? ` (${asset.symbol})` : ''}`}
          placeholder="5.00"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={amtErr}
        />
        <Button type="submit" variant="decide" disabled={!ready || busy}>
          {busy ? 'Sending…' : 'Send payment'}
        </Button>
      </form>
      <Door
        phase={phase}
        token={value && asset ? `pay ${amount} ${asset.symbol}` : 'Your payment'}
        verdict={
          result ? (
            result.status === 'executed' ? (
              <span className={s.vPaid}>Executed</span>
            ) : (
              <span className={s.vStop}>{result.reasonCode ?? result.status}</span>
            )
          ) : null
        }
        label="Your payment"
      />
      <div role="status" aria-live="polite" className={s.tryResult}>
        {err ? <ErrorState error={new Error(err)} title="The request failed" /> : null}
        {result ? (
          <div className={s.attempt}>
            <span className={s.tryVerdict}>
              {result.status === 'executed'
                ? 'The wallet paid it. It was within the bound.'
                : result.status === 'approval_requested'
                  ? 'Outside the policy. The agent had to ask the owner instead.'
                  : result.status === 'reverted'
                    ? 'It reverted on-chain. Nothing moved.'
                    : 'Refused before it reached the chain.'}
            </span>
            {result.track ? <TrackBadge track={toTrack(result.track)} /> : null}
            {result.reasonCode ? <ReasonCode code={result.reasonCode} /> : null}
            {result.outflow !== undefined && asset ? (
              <span>
                Outflow <Amount value={result.outflow} decimals={asset.decimals} symbol={asset.symbol} />
              </span>
            ) : null}
            {result.txHash ? <Hex value={result.txHash} kind="tx" /> : null}
          </div>
        ) : null}
      </div>
    </Glass>
  );
}

/* ---------- Ticker ---------- */
function Ticker({ feed }: { feed: RunEvent[] }) {
  const items = useMemo(() => feed.filter((e) => e.type !== 'done'), [feed]);
  return (
    <section className={s.ticker} aria-label="Event log">
      <h2 className="visually-hidden">Event log</h2>
      {items.length === 0 ? (
        <p className={s.bandMuted}>Fire a card to see every operation, revert and transaction here.</p>
      ) : (
        <ol className={s.tickerList}>
          {items.map((e, i) => (
            <li key={i} className={s.tick}>
              <time className={s.tickTime}>{new Date(e.at * 1000).toLocaleTimeString('en-GB')}</time>
              {e.type === 'attempt' ? (
                <>
                  <span className={s.tickCfg}>{e.config}</span>
                  <span className={s[`o_${e.outcome}`]}>{e.outcome}</span>
                  {e.reasonCode ? <code className={s.tickCode}>{e.reasonCode}</code> : null}
                  {e.amount !== undefined && e.asset ? <Amount value={e.amount} decimals={e.asset.decimals} symbol={e.asset.symbol} /> : null}
                  {e.txHash ? <Hex value={e.txHash} kind="tx" /> : null}
                </>
              ) : e.type === 'log' ? (
                <span className={s.tickLog}>{e.message}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Glass level={2} pad className={s.help} role="dialog" aria-label="Keyboard shortcuts">
      <div className={s.helpHead}>
        <h2>Presenter shortcuts</h2>
        <Button size="small" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <dl className={s.helpList}>
        <div>
          <dt>
            <Kbd>1</Kbd>–<Kbd>9</Kbd>, <Kbd>0</Kbd>
          </dt>
          <dd>Fire card 1 to 10</dd>
        </div>
        <div>
          <dt>
            <Kbd>Space</Kbd>
          </dt>
          <dd>Fire the next card</dd>
        </div>
        <div>
          <dt>
            <Kbd>L</Kbd> / <Kbd>S</Kbd>
          </dt>
          <dd>Live view / scenarios</dd>
        </div>
        <div>
          <dt>
            <Kbd>←</Kbd> <Kbd>→</Kbd> · <Kbd>T</Kbd>
          </dt>
          <dd>In scenarios: previous or next, TRACE on or off</dd>
        </div>
        <div>
          <dt>
            <Kbd>P</Kbd>
          </dt>
          <dd>Projector mode on or off</dd>
        </div>
        <div>
          <dt>
            <Kbd>?</Kbd>
          </dt>
          <dd>Show or hide this panel</dd>
        </div>
      </dl>
    </Glass>
  );
}
