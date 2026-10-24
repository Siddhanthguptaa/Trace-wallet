export type Track = 'proven' | 'unproven' | 'flagged';

export const TRACKS: Record<Track, { label: string; sentence: string }> = {
  proven: { label: 'Proven', sentence: 'Owner-listed or attested by TRACE. Normal caps apply.' },
  unproven: { label: 'Unproven', sentence: 'Shares the small exploration budget for new payees.' },
  flagged: { label: 'Flagged', sentence: 'Needs an owner approval for every payment.' },
};

/** Fail closed: anything we cannot read is unproven, never proven. */
export function toTrack(v: unknown): Track {
  if (v === 'proven' || v === 'PROVEN') return 'proven';
  if (v === 'flagged' || v === 'FLAGGED') return 'flagged';
  return 'unproven';
}

export type ConfigId = 'R1' | 'R2' | 'R3' | 'R4';
export const CONFIGS: { id: ConfigId; label: string; short: string }[] = [
  { id: 'R1', label: 'Raw key', short: 'Raw key' },
  { id: 'R2', label: 'Static allowlist', short: 'Allowlist' },
  { id: 'R3', label: 'Ours, without D3', short: 'Ours − D3' },
  { id: 'R4', label: 'Ours, with D3', short: 'Ours + D3' },
];
