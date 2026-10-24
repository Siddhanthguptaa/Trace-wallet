/** Amounts are bigint base units end to end. Format only at render. */

export function formatUnits(value: bigint, decimals: number, maxFraction = 2): string {
  const neg = value < 0n;
  let v = neg ? -value : value;
  let d = decimals;
  if (decimals > maxFraction) {
    // Round half up to maxFraction digits.
    const scale = 10n ** BigInt(decimals - maxFraction);
    v = (v + scale / 2n) / scale;
    d = maxFraction;
  }
  const base = 10n ** BigInt(d);
  const whole = v / base;
  const frac = d > 0 ? (v % base).toString().padStart(d, '0') : '';
  return (neg ? '−' : '') + group(whole.toString()) + (frac ? '.' + frac : '');
}

function group(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Parse a human amount ("12.5") to base units. Returns null when not representable. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;
  const [w = '0', f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return BigInt((w || '0') + f.padEnd(decimals, '0'));
}

export function shortHex(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function relativeTime(unixSeconds: number, nowMs = Date.now()): string {
  const diff = unixSeconds * 1000 - nowMs;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
  ];
  for (const [u, ms] of units) {
    if (abs >= ms || u === 'second') return rtf.format(Math.round(diff / ms), u);
  }
  return '';
}

export function dateTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}
