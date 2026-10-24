import {
  useEffect,
  useId,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ElementType,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import s from './ui.module.css';
import { Icon } from './Icon';
import { explorerAddress, explorerTx } from '@/config';
import { formatUnits, relativeTime, shortHex } from '@/domain/units';
import { TRACKS, type Track } from '@/domain/tracks';
import { describeReason } from '@/domain/reasons';
import { ApiError } from '@/api/http';
import type { Bucket } from '@/api/schemas';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- Glass ---------- */
export function Glass({
  as: As = 'div',
  level = 1,
  pad = false,
  className,
  children,
  ...rest
}: { as?: ElementType; level?: 1 | 2; pad?: boolean; className?: string; children?: ReactNode } & Record<string, unknown>) {
  return (
    <As className={cx(level === 1 ? s.panel : s.sheet, pad && s.pad, className)} {...rest}>
      {children}
    </As>
  );
}

/* ---------- Buttons ---------- */
type Variant = 'primary' | 'decide' | 'secondary' | 'ghost';
type BtnOpts = { variant?: Variant; size?: 'md' | 'small'; block?: boolean };
const btnClass = ({ variant = 'secondary', size = 'md', block }: BtnOpts, extra?: string) =>
  cx(s.btn, s[variant], size === 'small' && s.small, block && s.block, extra);

export function Button({ variant, size, block, className, ...rest }: BtnOpts & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={btnClass({ variant, size, block }, className)} {...rest} />;
}
export function ButtonLink({ variant, size, block, className, ...rest }: BtnOpts & LinkProps) {
  return <Link className={btnClass({ variant, size, block }, className)} {...rest} />;
}
export function ButtonA({
  variant,
  size,
  block,
  className,
  ...rest
}: BtnOpts & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={btnClass({ variant, size, block }, className)} {...rest} />;
}

/** Hold for 1.2 s to confirm. For irreversible owner actions such as revoking the agent. */
export function HoldButton({
  onConfirm,
  children,
  disabled,
  block,
}: {
  onConfirm: () => void;
  children: ReactNode;
  disabled?: boolean;
  block?: boolean;
}) {
  const [holding, setHolding] = useState(false);
  const t = useRef<number | null>(null);
  const start = () => {
    if (disabled) return;
    setHolding(true);
    t.current = window.setTimeout(() => {
      setHolding(false);
      onConfirm();
    }, 1200);
  };
  const stop = () => {
    setHolding(false);
    if (t.current) window.clearTimeout(t.current);
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      disabled={disabled}
      className={cx(btnClass({ variant: 'secondary', block }), s.hold, holding && s.holding)}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') stop();
      }}
      aria-describedby={undefined}
    >
      <span className={s.holdFill} aria-hidden="true" />
      {children}
    </button>
  );
}

/* ---------- Hex (address / hash) ---------- */
export function Hex({
  value,
  kind = 'address',
  full = false,
  link = true,
  className,
}: {
  value: string;
  kind?: 'address' | 'tx' | 'key';
  full?: boolean;
  link?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = full ? value : shortHex(value);
  const href = link ? (kind === 'tx' ? explorerTx(value) : kind === 'address' ? explorerAddress(value) : undefined) : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };
  const label = kind === 'tx' ? 'transaction' : kind === 'key' ? 'key' : 'address';
  return (
    <span className={cx(s.hex, className)} title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${label} ${value} in the block explorer`}>
          <span className={s.hexText}>{text}</span>
        </a>
      ) : (
        <span className={s.hexText}>{text}</span>
      )}
      <button type="button" className={cx(s.iconBtn, copied && s.copied)} onClick={copy} aria-label={`Copy ${label}`}>
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
      {href ? (
        <a className={s.iconBtn} href={href} target="_blank" rel="noreferrer" aria-hidden="true" tabIndex={-1}>
          <Icon name="external" size={15} />
        </a>
      ) : null}
      <span className="visually-hidden" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}

/* ---------- Amount ---------- */
export function Amount({
  value,
  decimals,
  symbol,
  sign,
  className,
  maxFraction = 2,
}: {
  value: bigint;
  decimals: number;
  symbol?: string;
  sign?: 'out' | 'in';
  className?: string;
  maxFraction?: number;
}) {
  const v = sign === 'out' ? -value : value;
  const prefix = sign === 'in' && value > 0n ? '+' : '';
  return (
    <span className={cx(s.amount, className)}>
      {prefix}
      {formatUnits(v, decimals, maxFraction)}
      {symbol ? <span className={s.amountUnit}>{symbol}</span> : null}
    </span>
  );
}

/* ---------- Badges ---------- */
export function TrackBadge({ track, detail }: { track: Track; detail?: string }) {
  const cls = track === 'proven' ? s.badgeProven : track === 'flagged' ? s.badgeFlagged : s.badgeUnproven;
  const icon = track === 'proven' ? 'check' : track === 'flagged' ? 'alert' : 'bounded';
  return (
    <span className={cx(s.badge, cls)} title={TRACKS[track].sentence}>
      <Icon name={icon} size={14} />
      {TRACKS[track].label}
      {detail ? <span style={{ color: 'var(--text-3)' }}>· {detail}</span> : null}
    </span>
  );
}
export function Badge({ children, icon }: { children: ReactNode; icon?: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <span className={cx(s.badge, s.badgeNeutral)}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}

export function ReasonCode({ code, compact = false }: { code: string | null | undefined; compact?: boolean }) {
  const r = describeReason(code);
  return (
    <span className={s.reason}>
      <span className={s.reasonCode}>{r.code}</span>
      {compact ? null : <span className={s.reasonSentence}>{r.sentence}</span>}
    </span>
  );
}

/* ---------- Bucket gauge ---------- */
const SCOPE_LABEL: Record<Bucket['scope'], string> = {
  key: "Agent key's budget",
  global: 'Account daily cap',
  explore: 'Exploration budget',
};
export function BucketGauge({ bucket, decimals, symbol }: { bucket: Bucket; decimals: number; symbol: string }) {
  const pct = bucket.cap > 0n ? Number((bucket.level * 10_000n) / bucket.cap) / 100 : 0;
  const low = pct < 15;
  const full = bucket.level >= bucket.cap;
  return (
    <div className={s.gauge}>
      <div className={s.gaugeHead}>
        <span className={s.gaugeTitle}>{SCOPE_LABEL[bucket.scope]}</span>
        <span>
          <Amount value={bucket.level} decimals={decimals} /> of{' '}
          <Amount value={bucket.cap} decimals={decimals} symbol={symbol} /> left
        </span>
      </div>
      <div
        className={s.track}
        role="meter"
        aria-label={`${SCOPE_LABEL[bucket.scope]} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className={cx(s.fill, bucket.scope === 'explore' && s.fillExplore, low && s.fillLow)}
          style={{ transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})` }}
        />
      </div>
      <div className={s.gaugeFoot}>
        <span>
          Refills <Amount value={bucket.refillPerDay} decimals={decimals} /> {symbol} per 24 h
        </span>
        <span>{full ? 'Full' : `Full ${relativeTime(bucket.fullAt)}`}</span>
      </div>
    </div>
  );
}

/* ---------- States ---------- */
export function Loading({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className={s.skeleton} role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={s.skLine} style={{ width: `${92 - i * 17}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const e = error instanceof ApiError ? error : null;
  const message = e?.message ?? (error as Error)?.message ?? 'Something went wrong.';
  const hint =
    e?.kind === 'not-configured'
      ? 'Add the service URL to web/.env.local (see .env.example), then reload.'
      : e?.kind === 'schema'
        ? 'The service answered, but not in the shape this screen expects. Nothing from it is shown.'
        : e?.kind === 'network' || e?.kind === 'timeout'
          ? 'Check that the service is running and reachable from this browser.'
          : undefined;
  return (
    <div className={s.state} role="alert">
      <span className={s.stateTitle}>
        <Icon name="alert" size={18} />
        {title ?? message}
      </span>
      {title ? <span>{message}</span> : null}
      {hint ? <span>{hint}</span> : null}
      {e?.detail ? <span className={s.stateDetail}>{e.detail}</span> : null}
      {onRetry ? (
        <Button size="small" onClick={onRetry}>
          <Icon name="refresh" size={15} /> Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.state}>
      <span className={s.stateTitle}>{title}</span>
      {children ? <span>{children}</span> : null}
      {action}
    </div>
  );
}

/** Shows how old the data on screen is; marks it stale after 30 s. */
export function DataAge({ updatedAt }: { updatedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!updatedAt) return null;
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  const stale = sec > 30;
  return (
    <span className={cx(s.age, stale && s.stale)}>
      <span className={s.ageDot} aria-hidden="true" />
      {stale ? `Stale · updated ${sec} s ago` : sec < 2 ? 'Live' : `Updated ${sec} s ago`}
    </span>
  );
}

/* ---------- Fields ---------- */
export function TextField({
  label,
  hint,
  error,
  mono,
  ...rest
}: { label: string; hint?: string; error?: string | null; mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={cx(s.input, mono && s.inputMono)}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-d` : undefined}
        spellCheck={false}
        autoComplete="off"
        {...rest}
      />
      {error ? (
        <span id={`${id}-d`} className={s.error}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-d`} className={s.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className={s.seg} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Progress ---------- */
export function TxProgress({
  steps,
  current,
  failed,
}: {
  steps: string[];
  current: number;
  failed?: boolean;
}) {
  return (
    <ol className={s.progress} aria-label="Progress">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? (failed ? 'fail' : 'now') : 'todo';
        return (
          <li
            key={label}
            className={cx(s.step, state === 'done' && s.stepDone, state === 'now' && s.stepNow, state === 'fail' && s.stepFail)}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className={s.stepBar} />
            {label}
          </li>
        );
      })}
    </ol>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}
