import type { SVGProps } from 'react';

/** Authored icon set: 24px grid, 1.6 stroke, round joins. Icons carry state, never decoration. */
const PATHS = {
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  cross: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
    </>
  ),
  external: (
    <>
      <path d="M13.5 5.5H18.5V10.5" />
      <path d="M18.5 5.5l-8 8" />
      <path d="M16.5 13.5v4a1.5 1.5 0 01-1.5 1.5H7A1.5 1.5 0 015.5 17.5V9.5A1.5 1.5 0 017 8h4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="10.5" height="10.5" rx="2" />
      <path d="M15.5 8.5V6.5A1.5 1.5 0 0014 5H6.5A1.5 1.5 0 005 6.5V14a1.5 1.5 0 001.5 1.5h2" />
    </>
  ),
  arrowRight: <path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" />,
  alert: (
    <>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4.2M12 16.9v.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8v4.3l2.8 1.7" />
    </>
  ),
  key: (
    <>
      <circle cx="8.5" cy="12" r="3.5" />
      <path d="M12 12h8M17 12v3M20 12v2.2" />
    </>
  ),
  refresh: (
    <>
      <path d="M18.5 9A7 7 0 006.3 7.6L5 9" />
      <path d="M5 5v4h4" />
      <path d="M5.5 15a7 7 0 0012.2 1.4L19 15" />
      <path d="M19 19v-4h-4" />
    </>
  ),
  chevronDown: <path d="M7 10l5 5 5-5" />,
  door: (
    <>
      <path d="M7 20V5.5A1.5 1.5 0 018.5 4h7A1.5 1.5 0 0117 5.5V20" />
      <path d="M4.5 20h15" />
      <path d="M14 12.5v.1" />
    </>
  ),
  minus: <path d="M6 12h12" />,
  play: <path d="M8 5.5v13l10-6.5z" />,
  pause: (
    <>
      <path d="M9 6v12" />
      <path d="M15 6v12" />
    </>
  ),
  bounded: (
    <>
      <path d="M5 18h14" />
      <path d="M7 14l5-7 5 7" />
    </>
  ),
  wallet: (
    <>
      <rect x="4" y="6.5" width="16" height="12" rx="2" />
      <path d="M16 12.5h.1M4 9.5h16" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, title, ...rest }: { name: IconName; size?: number; title?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
