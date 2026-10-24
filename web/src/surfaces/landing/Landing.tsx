import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  animate,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
  type Variants,
} from 'framer-motion';
import s from './landing.module.css';
import { SiteHeader, PAPER_URL } from '@/components/Chrome';
import { Amount, ButtonA, ButtonLink, BucketGauge, ErrorState, Loading } from '@/components/ui';
import { Ledger, lossSummary } from '@/components/Ledger';
import { Door } from '@/components/Door';
import { Icon } from '@/components/Icon';
import { useBounty, useBudget, usePolicy, useResults } from '@/api/queries';
import { publicClient } from '@/chain/client';
import { formatUnits } from '@/domain/units';
import type { Policy, X1Table } from '@/api/schemas';
import { createStage, type Mode, type Stage } from './stage';

type Guard = X1Table['rows'][number]['guard'];
type Caps = Policy['assets'][number] | undefined;

/** Page order. Index i drives camera shot i in stage.ts. */
const MODES: Mode[] = ['hero', 'open', 'rise', 'sidedoor', 'measure', 'tracks', 'bound', 'trace', 'ledger'];
/** Which recorded attack cards the story has covered by each section, for the instrument strip. */
const SEEN: Guard[][] = [[], [], ['core'], ['core', 'D1'], ['core', 'D1', 'D2'], ['core', 'D1', 'D2', 'D3']];

const EASE = [0.22, 0.61, 0.36, 1] as const;
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const item: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
};
const group = (stagger = 0.08, delay = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: stagger, delayChildren: delay } },
});

export default function Landing() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);
  const [noStage, setNoStage] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [active, setActive] = useState(0);
  const reduced = useMemo(reducedMotion, []);
  const [introDone, setIntroDone] = useState(reduced);
  const p = useMotionValue(0);

  const results = useResults();
  const bounty = useBounty();
  const policy = usePolicy(bounty.data?.wallet);
  const caps = policy.data?.assets[0];

  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.3 });

  // Build the stage once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stage = createStage(canvas, { reduced });
    if (!stage) {
      setNoStage(true);
      setSceneReady(true);
      return;
    }
    stageRef.current = stage;
    setSceneReady(true);
    const onResize = () => stage.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      stage.dispose();
      stageRef.current = null;
    };
  }, [reduced]);

  // Scroll position -> fractional section index p (p = i at the centre of section i). No React render per frame.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const mid = window.innerHeight * 0.5;
      const els = sectionRefs.current;
      let next = 0;
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.top <= mid && r.bottom > mid) {
          next = i + (mid - r.top) / r.height - 0.5;
          break;
        }
        if (r.top > mid) {
          next = Math.max(0, i - 0.5);
          break;
        }
        next = i + 0.5;
      }
      next = Math.max(0, Math.min(MODES.length - 1, next));
      p.set(next);
      setActive(Math.round(next));
      stageRef.current?.setScroll(next);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [p]);

  useEffect(() => {
    stageRef.current?.setMode(MODES[active] ?? 'hero');
  }, [active]);

  const setSection = (i: number) => (el: HTMLElement | null) => {
    sectionRefs.current[i] = el;
  };
  const goTo = (i: number) => sectionRefs.current[i]?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });

  const chapters = buildChapters(caps, bounty.data?.wallet);

  return (
    <div className={s.page} data-stage={noStage ? 'off' : 'on'} data-danger={MODES[active] === 'open'}>
      <canvas ref={canvasRef} className={s.canvas} aria-hidden="true" />
      <div className={s.progress} aria-hidden="true">
        <motion.i style={{ scaleX: progress }} />
      </div>
      <SiteHeader overlay />

      <Intro
        reduced={reduced}
        onLeave={() => setIntroDone(true)}
        steps={[
          { label: 'Building the studio', done: sceneReady },
          { label: 'Reading the demo wallet', done: !bounty.isPending && !(bounty.data && policy.isPending) },
          { label: 'Loading the recorded attacks', done: !results.isPending },
        ]}
      />

      <ChapterMarks chapters={chapters} p={p} />
      <Rail chapters={chapters} active={active} onGo={goTo} />
      <Instruments caps={caps} table={results.data} active={active} />

      <main className={s.film}>
        <Hero sectionRef={setSection(0)} ready={introDone} onNext={() => goTo(1)} />

        {chapters.map((c, i) => (
          <ChapterSection key={c.id} c={c} index={i} total={chapters.length} sectionRef={setSection(i + 1)} />
        ))}

        <section ref={setSection(MODES.length - 1)} className={s.epilogue} aria-labelledby="ledger-title">
          <Epilogue table={results.data} pending={results.isPending} error={results.error} retry={() => results.refetch()} />
        </section>
      </main>

      <footer className={s.footer}>
        <motion.div
          className={s.footerInner}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.4 }}
          variants={group(0.08)}
        >
          <motion.div variants={item}>
            <p className={s.footerMark}>
              trace<em>-wallet</em>
            </p>
            <p className={s.footerLine}>Spending limits bound how much. TRACE bounds who.</p>
          </motion.div>
          <motion.nav variants={item} className={s.footerLinks} aria-label="Footer">
            <Link to="/demo">Live demo</Link>
            <Link to="/console">Owner console</Link>
            <a href={PAPER_URL} target="_blank" rel="noreferrer">
              TRACE paper
            </a>
          </motion.nav>
          <motion.p variants={item} className={s.footerFine}>
            Hypnexis W3-02 Agent Wallet. Figures marked live are read from the demo wallet and the attack runner.
          </motion.p>
        </motion.div>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------- hero */

function Hero({ sectionRef, ready, onNext }: { sectionRef: (el: HTMLElement | null) => void; ready: boolean; onNext: () => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [0, -160]);
  const opacity = useTransform(scrollYProgress, [0, 0.65], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [1, 0.95]);
  const word = 'Trace'.split('');

  return (
    <section
      ref={(el) => {
        ref.current = el;
        sectionRef(el);
      }}
      className={s.hero}
      aria-labelledby="hero-title"
    >
      <motion.div className={s.heroInner} style={{ y, opacity, scale }}>
        <motion.div initial="hidden" animate={ready ? 'show' : 'hidden'} variants={group(0.09, 0.05)}>
          <motion.p variants={item} className={s.kicker}>
            ERC-4337 · Agent wallet · <b>Hypnexis W3-02</b>
          </motion.p>
          <h1 id="hero-title" className={s.heroTitle} aria-label="trace-wallet">
            <motion.span className={s.heroWord} variants={group(0.055)} aria-hidden="true">
              {word.map((ch, i) => (
                <motion.span
                  key={i}
                  className={s.letter}
                  variants={{
                    hidden: { y: '108%' },
                    show: { y: '0%', transition: { duration: 0.9, ease: EASE } },
                  }}
                >
                  {ch}
                </motion.span>
              ))}
            </motion.span>
            <motion.em
              className={s.heroItalic}
              aria-hidden="true"
              variants={{
                hidden: { opacity: 0, x: -14 },
                show: { opacity: 1, x: 0, transition: { duration: 0.9, delay: 0.35, ease: EASE } },
              }}
            >
              wallet
            </motion.em>
          </h1>
          <motion.p variants={item} className={s.heroLine}>
            Hypnotize the agent; the wallet stays awake.
          </motion.p>
          <motion.p variants={item} className={s.heroSub}>
            An agent wallet whose limits hold when the AI is hijacked or its key leaks. Scroll to watch the same attacks meet
            the door.
          </motion.p>
          <motion.div variants={item} className={s.heroActions}>
            <ButtonLink to="/demo" variant="decide" className={s.cta}>
              Try to beat it <Icon name="arrowRight" size={17} />
            </ButtonLink>
            <button type="button" className={s.scrollCue} onClick={onNext}>
              Scroll to begin
              <i aria-hidden="true">
                <motion.b animate={{ x: ['-100%', '220%'] }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }} />
              </i>
            </button>
          </motion.div>
          <motion.p variants={item} className={s.credit}>
            Built on TRACE · CIKM '26 · Base Sepolia
          </motion.p>
        </motion.div>
      </motion.div>
    </section>
  );
}

/* ---------------------------------------------------------------- chapters */

type Stat = { label: string; value: ReactNode; unit?: string; sub: string; tone?: 'loss' | 'bound' | 'held' };
type Chapter = {
  id: string;
  numeral: string;
  floating: string;
  danger?: boolean;
  label: ReactNode;
  title: ReactNode;
  stats: Stat[];
  figure?: ReactNode;
  body: ReactNode;
  meta: ReactNode;
};

function ChapterSection({
  c,
  index,
  total,
  sectionRef,
}: {
  c: Chapter;
  index: number;
  total: number;
  sectionRef: (el: HTMLElement | null) => void;
}) {
  const sec = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const inView = useInView(panel, { once: true, amount: 0.2 });
  const { scrollYProgress } = useScroll({ target: sec, offset: ['start end', 'end start'] });
  // Scrubbed with the scroll: the pane rises in, holds, then drifts out as the next chapter arrives.
  const opacity = useTransform(scrollYProgress, [0.08, 0.24, 0.8, 0.94], [0, 1, 1, 0]);
  const y = useTransform(scrollYProgress, [0.08, 0.24, 0.8, 0.94], [70, 0, 0, -50]);
  const top = useStickyCentre(panel);

  return (
    <section
      ref={(el) => {
        sec.current = el;
        sectionRef(el);
      }}
      className={s.chapter}
      data-danger={c.danger ? 'true' : undefined}
      aria-labelledby={`${c.id}-title`}
    >
      <motion.article
        ref={panel}
        className={s.panel}
        style={{ opacity, y, ['--top' as string]: `${top}px` }}
        initial="hidden"
        animate={inView ? 'show' : 'hidden'}
        variants={group(0.07, 0.1)}
      >
        <motion.div variants={item} className={s.panelTop}>
          <p className={s.panelLabel}>{c.label}</p>
          <span className={s.panelIndex}>
            {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
          </span>
        </motion.div>
        <motion.h2 variants={item} id={`${c.id}-title`} className={s.panelTitle}>
          {c.title}
        </motion.h2>
        <motion.dl variants={item} className={s.stats}>
          {c.stats.map((st) => (
            <div key={st.label} className={s.stat}>
              <dt>{st.label}</dt>
              <dd data-tone={st.tone}>
                <CountUp value={st.value} run={inView} />
                {st.unit ? <small>{st.unit}</small> : null}
              </dd>
              <span data-tone={st.tone}>{st.sub}</span>
            </div>
          ))}
        </motion.dl>
        {c.figure ? (
          <motion.div variants={item} className={s.figure}>
            {c.figure}
          </motion.div>
        ) : null}
        <motion.div variants={item} className={s.body}>
          {c.body}
        </motion.div>
        <motion.p variants={item} className={s.meta}>
          {c.meta}
        </motion.p>
      </motion.article>
    </section>
  );
}

/** Centres a sticky pane vertically when it fits; when it is taller than the screen, it sticks by its bottom edge instead. */
function useStickyCentre(ref: React.RefObject<HTMLElement | null>) {
  const [top, setTop] = useState(84);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const h = el.offsetHeight;
      const vh = window.innerHeight;
      setTop(h + 104 <= vh ? Math.max(84, Math.round((vh - h) / 2 + 18)) : Math.round(vh - h - 20));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [ref]);
  return top;
}

/** Counts a plain number up from zero the first time it is shown. Anything that is not a plain number renders as is. */
function CountUp({ value, run }: { value: ReactNode; run: boolean }) {
  const reduce = useReducedMotion();
  const parsed = typeof value === 'string' ? /^([^\d]*)([\d,]+(?:\.(\d+))?)(.*)$/.exec(value) : null;
  const target = parsed ? Number(parsed[2]!.replace(/,/g, '')) : NaN;
  const decimals = parsed?.[3]?.length ?? 0;
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    if (!run || !parsed || Number.isNaN(target) || reduce) return;
    const ctl = animate(0, target, { duration: 1.3, ease: EASE, onUpdate: (v) => setShown(v) });
    return () => ctl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, target, reduce]);

  if (!parsed || Number.isNaN(target) || shown === null || reduce) return <>{value}</>;
  const text = shown.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (
    <>
      {parsed[1]}
      {text}
      {parsed[4]}
    </>
  );
}

function capValue(caps: Caps, key: 'globalCap' | 'exploreCap' | 'explorePerTxCap', fallback: string): { value: ReactNode; unit?: string } {
  if (!caps) return { value: fallback };
  return { value: formatUnits(caps[key], caps.asset.decimals), unit: caps.asset.symbol };
}

function buildChapters(caps: Caps, wallet: `0x${string}` | undefined): Chapter[] {
  const live = caps ? 'Live from the demo wallet' : undefined;
  return [
    {
      id: 'prologue',
      numeral: '',
      floating: 'The only lock',
      danger: true,
      label: (
        <>
          Prologue · <b data-tone="loss">Where it already happened</b>
        </>
      ),
      title: (
        <>
          When the model is the only <i>lock</i>
        </>
      ),
      stats: [
        { label: 'Freysa · Nov 2024', value: '13.19', unit: 'ETH', sub: 'after 482 attempts', tone: 'loss' },
        { label: 'aixbt · Mar 2025', value: '55.5', unit: 'ETH', sub: 'the AI was never fooled', tone: 'loss' },
      ],
      figure: <Door phase="pass" token="send everything" verdict={<span className={s.vLoss}>no wallet check</span>} label="A transfer with no check" />,
      body: (
        <>
          <p>
            An AI agent guarding a prize pool was talked into sending all of it: <b>13.19 ETH</b>, about $47,000. Four months
            later an attacker got into another bot's dashboard and moved <b>55.5 ETH</b>, about $106,200.
          </p>
          <p>In both cases nothing stood between the agent and the money except the agent's own judgment.</p>
        </>
      ),
      meta: (
        <>
          Sources:{' '}
          <a href="https://the-decoder.com/hacker-wins-47000-by-tricking-ai-chatbot-with-smart-prompting/" target="_blank" rel="noreferrer">
            The Decoder
          </a>{' '}
          ·{' '}
          <a href="https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth" target="_blank" rel="noreferrer">
            Cointelegraph
          </a>
        </>
      ),
    },
    {
      id: 'assume',
      numeral: 'I',
      floating: 'Assume the worst',
      label: 'Chapter I · The assumption',
      title: (
        <>
          Assume the agent is already <i>hijacked</i>
        </>
      ),
      stats: [
        { label: 'Published defenses tested', value: '12', sub: 'prompt-injection guards' },
        { label: 'Bypassed by adaptive attacks', value: '>90', unit: '%', sub: 'for most of them', tone: 'loss' },
      ],
      body: (
        <>
          <p>
            Filtering prompts and hardening the model help, but adaptive attacks get past 12 published defenses, most more than
            90% of the time. And a key can simply leak.
          </p>
          <p>
            So the wallet assumes nothing about the agent. <b>The contract is the lock</b>: every rule in this story holds even
            when an attacker fully controls the agent.
          </p>
        </>
      ),
      meta: 'ERC-4337 account · rules enforced on-chain',
    },
    {
      id: 'd1',
      numeral: 'II',
      floating: 'One door',
      label: (
        <>
          Chapter II · <b data-tone="bound">D1</b> · One door
        </>
      ),
      title: (
        <>
          Every dollar leaves by <i>one door</i>
        </>
      ),
      stats: [
        { label: 'Agent signatures accepted', value: '0', sub: 'ERC-1271 returns 0xffffffff', tone: 'held' },
        { label: 'Ways for money to leave', value: '1', sub: 'the checked path', tone: 'held' },
      ],
      figure: <Door phase="stop" token="EIP-3009 signature" verdict={<span className={s.vHeld}>1271 → 0xffffffff</span>} label="An EIP-3009 signature, stopped" />,
      body: (
        <>
          <p>
            x402 payments and USDC's transferWithAuthorization move money with only a signature, skipping every check the
            wallet runs. Permit2 does the same for allowances.
          </p>
          <p>
            The wallet refuses to treat the agent's signature as its own. <b>Signatures are owner-only</b>, so every dollar the
            agent moves goes through the validated, metered path.
          </p>
        </>
      ),
      meta: 'EIP-3009 · Permit2 · ERC-1271',
    },
    {
      id: 'd2',
      numeral: 'III',
      floating: 'Measured, not described',
      label: (
        <>
          Chapter III · <b data-tone="bound">D2</b> · Measured limits
        </>
      ),
      title: (
        <>
          Count what <i>actually</i> left
        </>
      ),
      stats: [
        { label: 'The allowed shop pulled', value: '50', unit: 'USDC', sub: 'for a 10 USDC item', tone: 'loss' },
        { label: 'Cap for the call', value: '10', unit: 'USDC', sub: 'so the whole call reverted', tone: 'held' },
      ],
      figure: <Door phase="stop" token="buy() pulls 50 USDC" verdict={<span className={s.vHeld}>measured 50 &gt; cap 10</span>} label="An overcharge, reverted" />,
      body: (
        <>
          <p>
            Checking a call's arguments is not enough: an allowed shop can still pull more than the price. The wallet records
            balances, allowances and NFTs before each call and <b>checks them after</b>. Any outflow over the cap reverts.
          </p>
          <p>
            When the agent needs more, it asks the owner. The request is built from the decoded call and a simulation, and the
            owner signs <b>the exact payee and maximum</b>, never the agent's description.
          </p>
        </>
      ),
      meta: 'Balance deltas · allowances · NFTs · EIP-712 approvals',
    },
    {
      id: 'd3',
      numeral: 'IV',
      floating: 'Two tracks',
      label: (
        <>
          Chapter IV · <b data-tone="bound">D3</b> · Two tracks
        </>
      ),
      title: (
        <>
          Strangers share <i>one small</i> budget
        </>
      ),
      stats: [
        { label: 'Per 24 h to unproven payees', ...capValue(caps, 'exploreCap', '5%'), sub: caps ? 'shared by all of them' : 'of the account cap, by default', tone: 'bound' },
        { label: 'Per payment to a stranger', ...capValue(caps, 'explorePerTxCap', '1%'), sub: caps ? live! : 'of the account cap, by default', tone: 'bound' },
      ],
      figure: <Door phase="pass" token="pay new shop 0.15" verdict={<span className={s.vBound}>unproven · within budget</span>} label="A new payee, paid within budget" />,
      body: (
        <>
          <p>
            An allowlist is safe but starves honest newcomers; paying anyone lets a hijacked agent invent payees. The wallet
            keeps both: <b>proven payees</b> use normal limits, <b>unproven ones share a small exploration budget</b>.
          </p>
          <p>Fifty fake addresses at once still stop at a known amount, and a real new seller still gets paid. TRACE can flag a payee; only the owner can clear it.</p>
        </>
      ),
      meta: 'Proven track · exploration track · flags',
    },
    {
      id: 'bound',
      numeral: 'V',
      floating: 'The bound',
      label: 'Chapter V · The bound',
      title: (
        <>
          Bounded loss, never <i>zero</i> loss
        </>
      ),
      stats: [
        { label: 'Most a hijacked agent can move, 24 h', ...capValue(caps, 'globalCap', 'The cap'), sub: live ?? 'set per account by the owner', tone: 'bound' },
        { label: 'Of which, to strangers', ...capValue(caps, 'exploreCap', '5%'), sub: live ?? 'of it, by default', tone: 'bound' },
      ],
      figure: wallet ? <LiveBucket wallet={wallet} /> : undefined,
      body: (
        <>
          <p>
            If an agent can spend on its own, it can be fooled into spending badly. Overpaying a shop the owner allowed looks
            like a normal purchase on-chain, and no contract can tell it apart. What a contract can do is <b>cap it, exactly</b>.
          </p>
          <p>Limits refill continuously over 24 hours, so there is no midnight reset to time an attack around.</p>
        </>
      ),
      meta: 'Continuous refill · per key · per account',
    },
    {
      id: 'trace',
      numeral: 'VI',
      floating: 'TRACE',
      label: (
        <>
          Chapter VI · <b data-tone="bound">TRACE</b> · CIKM '26
        </>
      ),
      title: (
        <>
          Who to pay is our own <i>research</i>
        </>
      ),
      stats: [
        { label: 'Honest providers served, of 700', value: '125', sub: 'with exploration, vs 66 proven-only', tone: 'held' },
        { label: 'Fraud when buyers see only their own history', value: '6.4', unit: 'sats', sub: 'exploring, vs 32.0 greedy', tone: 'held' },
      ],
      figure: (
        <div className={s.compares}>
          <Compare
            label="Jobs sent to fake identities, Sybil attack"
            rows={[
              ['EigenTrust', 81.7],
              ['Reputation only', 29.0],
            ]}
            max={100}
            unit="%"
            lowerIsBetter
          />
        </div>
      ),
      body: (
        <>
          <p>We wrote TRACE, a trust-routing paper at CIKM '26, on the question D3 has to answer: who should an agent pay when sellers are new and some are fake?</p>
          <p>
            Paying only proven sellers starves newcomers, and spreading trust through a graph fails against fake identities. So
            <b> fraud defense and discovery need separate tracks with independent budgets</b>. Figures are from simulated agents.
          </p>
        </>
      ),
      meta: (
        <a href={PAPER_URL} target="_blank" rel="noreferrer">
          TRACE: Graph-Aware Anomaly Detection for Trust Routing
        </a>
      ),
    },
  ];
}

function LiveBucket({ wallet }: { wallet: `0x${string}` }) {
  const budget = useBudget(wallet);
  const policy = usePolicy(wallet);
  const asset = policy.data?.assets[0]?.asset;
  const b = budget.data?.buckets.find((x) => x.scope === 'global' && asset && x.asset.toLowerCase() === asset.address.toLowerCase());
  if (!b || !asset) return null;
  return <BucketGauge bucket={b} decimals={asset.decimals} symbol={asset.symbol} />;
}

function Compare({
  label,
  rows,
  max,
  unit,
  lowerIsBetter,
}: {
  label: string;
  rows: [string, number][];
  max: number;
  unit?: string;
  lowerIsBetter?: boolean;
}) {
  const best = lowerIsBetter ? Math.min(...rows.map((r) => r[1])) : Math.max(...rows.map((r) => r[1]));
  return (
    <figure className={s.compare}>
      <figcaption>{label}</figcaption>
      {rows.map(([l, v], i) => (
        <div key={l} className={s.bar}>
          <span className={s.barLabel}>{l}</span>
          <span className={s.barTrack}>
            <motion.span
              className={v === best ? s.barBest : s.barFill}
              style={{ width: `${(v / max) * 100}%`, originX: 0 }}
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1, delay: 0.2 + i * 0.12, ease: EASE }}
            />
          </span>
          <span className={s.barVal}>
            {v}
            {unit}
          </span>
        </div>
      ))}
    </figure>
  );
}

/* ---------------------------------------------------------------- overlays */

function Intro({ steps, reduced, onLeave }: { steps: { label: string; done: boolean }[]; reduced: boolean; onLeave: () => void }) {
  const [minDone, setMinDone] = useState(false);
  const [maxDone, setMaxDone] = useState(false);
  const [gone, setGone] = useState(reduced);
  const done = steps.filter((x) => x.done).length;
  const leaving = (done === steps.length && minDone) || maxDone;
  useEffect(() => {
    const a = window.setTimeout(() => setMinDone(true), 900);
    const b = window.setTimeout(() => setMaxDone(true), 2800);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, []);
  useEffect(() => {
    if (!leaving) return;
    onLeave();
    const t = window.setTimeout(() => setGone(true), 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);
  if (gone) return null;
  const current = steps.find((x) => !x.done)?.label ?? 'Ready';
  return (
    <div className={s.intro} data-leaving={leaving} aria-hidden="true">
      <motion.div
        className={s.introInner}
        initial={{ opacity: 0, y: 12 }}
        animate={leaving ? { opacity: 0, y: -16 } : { opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE }}
      >
        <span className={s.introMark} />
        <p className={s.introWord}>Trace</p>
        <p className={s.introItalic}>wallet</p>
        <span className={s.introLine}>
          <i style={{ transform: `scaleX(${done / steps.length})` }} />
        </span>
        <p className={s.introStatus}>
          {current} · {Math.round((done / steps.length) * 100)}%
        </p>
      </motion.div>
    </div>
  );
}

function ChapterMarks({ chapters, p }: { chapters: Chapter[]; p: MotionValue<number> }) {
  return (
    <div className={s.marks} aria-hidden="true">
      {chapters.map((c, i) => (
        <Mark key={c.id} c={c} at={i + 1} p={p} />
      ))}
    </div>
  );
}

/** A chapter's floating numeral and title. Depth comes from the two moving at different speeds and blurring as they leave. */
function Mark({ c, at, p }: { c: Chapter; at: number; p: MotionValue<number> }) {
  const d = useTransform(p, (v) => Math.abs(v - at));
  const opacity = useTransform(d, [0, 0.42], [1, 0]);
  const blur = useTransform(d, [0, 0.42], ['blur(0px)', 'blur(10px)']);
  const numY = useTransform(p, (v) => (v - at) * -36);
  const titleY = useTransform(p, (v) => (v - at) * -110);
  const numScale = useTransform(d, [0, 0.5], [1, 1.12]);
  return (
    <motion.div className={s.mark} style={{ opacity, filter: blur }}>
      {c.numeral ? (
        <motion.span className={s.markNumeral} style={{ y: numY, scale: numScale }}>
          {c.numeral}
        </motion.span>
      ) : null}
      <motion.span className={s.markTitle} style={{ y: titleY }} data-danger={c.danger ? 'true' : undefined}>
        {c.floating}
      </motion.span>
    </motion.div>
  );
}

function Rail({ chapters, active, onGo }: { chapters: Chapter[]; active: number; onGo: (i: number) => void }) {
  const items = [{ id: 'top', numeral: '·', floating: 'Top' }, ...chapters, { id: 'ledger', numeral: 'L', floating: 'The ledger' }];
  return (
    <nav className={s.rail} aria-label="Chapters" data-hidden={active >= items.length - 1}>
      <ol>
        {items.map((c, i) => (
          <li key={c.id}>
            <button type="button" aria-current={active === i ? 'step' : undefined} onClick={() => onGo(i)} aria-label={c.floating}>
              <span className={s.railNum}>{c.numeral || '0'}</span>
              <span className={s.railName}>{c.floating}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A value that slides in whenever it changes. */
function Tick({ k, children, tone, className }: { k: string; children: ReactNode; tone?: string; className?: string }) {
  return (
    <b data-tone={tone} className={className}>
      <motion.span
        key={k}
        className={s.tick}
        initial={{ y: '60%', opacity: 0 }}
        animate={{ y: '0%', opacity: 1 }}
        transition={{ duration: 0.45, ease: EASE }}
      >
        {children}
      </motion.span>
    </b>
  );
}

function Instruments({ caps, table, active }: { caps: Caps; table?: X1Table; active: number }) {
  const block = useQuery({
    queryKey: ['blockNumber'],
    queryFn: () => publicClient.getBlockNumber(),
    refetchInterval: 4000,
    retry: false,
  });
  const seen = active >= SEEN.length ? null : SEEN[active]!;
  // Only cards that have actually run count as fired.
  const rows = (table ? (seen ? table.rows.filter((r) => seen.includes(r.guard)) : table.rows) : []).filter((r) => r.cells.R4.outcome !== 'pending');
  const stopped = rows.filter((r) => r.cells.R4.outcome === 'refused').length;
  const moved = new Map<string, { v: bigint; d: number }>();
  for (const r of rows) {
    const c = r.cells.R4;
    if (c.outcome === 'lost' && c.amount !== undefined && c.asset) {
      const m = moved.get(c.asset.symbol) ?? { v: 0n, d: c.asset.decimals };
      m.v += c.amount;
      moved.set(c.asset.symbol, m);
    }
  }
  const movedText = !table ? '—' : moved.size === 0 ? '0.00' : [...moved.values()].map((m) => formatUnits(m.v, m.d)).join(' + ');

  return (
    <aside className={s.hud} aria-label="Instruments" data-hidden={active >= MODES.length - 1}>
      <div className={s.cell}>
        <span>Max loss · 24 h</span>
        <b data-tone="bound">{caps ? <Amount value={caps.globalCap} decimals={caps.asset.decimals} symbol={caps.asset.symbol} /> : '—'}</b>
      </div>
      <div className={s.cell}>
        <span>To strangers</span>
        <b data-tone="bound">{caps ? <Amount value={caps.exploreCap} decimals={caps.asset.decimals} symbol={caps.asset.symbol} /> : '—'}</b>
      </div>
      <div className={s.cell} data-wide="false">
        <span>Cards fired</span>
        <Tick k={`f${rows.length}`}>
          {table ? rows.length : '—'}
          {table ? <small>/{table.rows.length}</small> : null}
        </Tick>
      </div>
      <div className={s.cell} data-wide="false">
        <span>Stopped by R4</span>
        <Tick k={`s${stopped}`} tone="held">
          {table ? stopped : '—'}
        </Tick>
      </div>
      <div className={s.cell}>
        <span>Beyond policy</span>
        <Tick k={`m${movedText}`} tone={moved.size ? 'loss' : 'held'}>
          {movedText}
        </Tick>
      </div>
      <div className={s.cell} data-wide="false">
        <span>Block</span>
        <b className={s.block}>{block.data !== undefined ? `#${block.data.toString()}` : '—'}</b>
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- epilogue */

function Epilogue({ table, pending, error, retry }: { table?: X1Table; pending: boolean; error: unknown; retry: () => void }) {
  const r4 = table ? lossSummary(table, 'R4') : null;
  const r1 = table ? lossSummary(table, 'R1') : null;
  const r2 = table ? lossSummary(table, 'R2') : null;
  const sum = (t: ReturnType<typeof lossSummary> | null) =>
    !t ? '—' : t.totals.size === 0 ? '0.00' : [...t.totals.entries()].map(([sym, v]) => `${formatUnits(v.value, v.decimals)} ${sym}`).join(' + ');
  const legit = table?.metric2?.R4;
  const words = ['What', 'the', 'attacks'];

  return (
    <div className={s.epiInner}>
      <motion.div initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.5 }} variants={group(0.06)}>
        <motion.p variants={item} className={s.panelLabel}>
          Epilogue · <b data-tone="bound">The ledger</b>
        </motion.p>
        <h2 id="ledger-title" className={s.epiTitle}>
          {words.map((w) => (
            <Fragment key={w}>
              <span className={s.mask}>
                <motion.span className={s.maskIn} variants={{ hidden: { y: '105%' }, show: { y: '0%', transition: { duration: 0.85, ease: EASE } } }}>
                  {w}
                </motion.span>
              </span>{' '}
            </Fragment>
          ))}
          <span className={s.mask}>
            <motion.i className={s.maskIn} variants={{ hidden: { y: '105%' }, show: { y: '0%', transition: { duration: 0.85, ease: EASE } } }}>
              cost
            </motion.i>
          </span>
        </h2>
        <motion.p variants={item} className={s.epiLede}>
          Every card in this story, fired at four wallets: a raw key, a static allowlist, ours without D3, and ours with it. Open
          any row for the attack, or any cell for its transaction.
        </motion.p>
      </motion.div>

      <motion.dl className={s.tiles} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.3 }} variants={group(0.08)}>
        <motion.div variants={item}>
          <dt>Cards fired</dt>
          <dd>{table ? table.rows.length - (r4?.pending ?? 0) : '—'}</dd>
          <small>{r4?.pending ? `${r4.pending} awaiting a run` : 'recorded runs'}</small>
        </motion.div>
        <motion.div variants={item}>
          <dt>Raw key lost</dt>
          <dd data-tone="loss">{sum(r1)}</dd>
          <small>R1, on {r1?.lostCards ?? '—'} cards</small>
        </motion.div>
        <motion.div variants={item}>
          <dt>Allowlist lost</dt>
          <dd data-tone="loss">{sum(r2)}</dd>
          <small>R2, on {r2?.lostCards ?? '—'} cards</small>
        </motion.div>
        <motion.div variants={item}>
          <dt>Ours, beyond policy</dt>
          <dd data-tone="bound">{sum(r4)}</dd>
          <small>R4, with D3</small>
        </motion.div>
        <motion.div variants={item}>
          <dt>Honest new seller paid</dt>
          <dd data-tone="held">{legit && legit.paid !== undefined && legit.total !== undefined ? `${legit.paid}/${legit.total}` : '—'}</dd>
          <small>by R4, without asking the owner</small>
        </motion.div>
      </motion.dl>

      <motion.div
        className={s.ledgerPanel}
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.15 }}
        transition={{ duration: 0.8, ease: EASE }}
      >
        {pending ? (
          <Loading lines={7} label="Loading results" />
        ) : error ? (
          <ErrorState error={error} title="The recorded results are unavailable right now" onRetry={retry} />
        ) : table ? (
          <Ledger table={table} caption="Attack cards fired at four wallet configurations" />
        ) : null}
      </motion.div>

      <motion.div className={s.close} initial="hidden" whileInView="show" viewport={{ once: true, amount: 0.5 }} variants={group(0.1)}>
        <motion.h3 variants={item} className={s.closeTitle}>
          The agent's key is public during the demo. Try to take <i>more than the bound</i>.
        </motion.h3>
        <motion.div variants={item} className={s.closeActions}>
          <ButtonLink to="/demo" variant="decide" className={s.cta}>
            Open the live demo <Icon name="arrowRight" size={17} />
          </ButtonLink>
          <ButtonLink to="/console" variant="secondary" className={s.cta}>
            Owner console
          </ButtonLink>
          <ButtonA href={PAPER_URL} target="_blank" rel="noreferrer" variant="ghost" className={s.cta}>
            Read the paper
          </ButtonA>
        </motion.div>
      </motion.div>
    </div>
  );
}
