import type { ReactNode } from 'react';
import s from './door.module.css';

export type DoorPhase = 'idle' | 'travel' | 'pass' | 'stop';

/**
 * The one motion of this product: a request travels to the threshold and either
 * passes through or stops there while the threshold lights up.
 */
export function Door({
  phase,
  token,
  verdict,
  label,
}: {
  phase: DoorPhase;
  token: ReactNode;
  verdict?: ReactNode;
  label?: string;
}) {
  return (
    <div className={s.lane} data-phase={phase} aria-label={label} role="img">
      <span className={s.threshold} aria-hidden="true" />
      <span className={s.token}>{token}</span>
      {verdict ? <span className={s.verdict}>{verdict}</span> : null}
    </div>
  );
}
