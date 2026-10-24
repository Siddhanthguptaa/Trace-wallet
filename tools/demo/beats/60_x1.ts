/**
 * Beat 60 (X1): the attack-suite results table. Reads results/x1_table.json (written by the X1 lane)
 * and prints, per wallet configuration, how many cards moved funds beyond policy. R3 and R4 must have
 * 0 beyond policy on every card, and the static-allowlist baseline R2 must lose on at least one;
 * fails clearly if the table is absent.
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { readResult } from '../lib.ts';

interface Cell {
  card: string;
  config: string;
  lostBaseUnits: string;
  beyondPolicyBaseUnits: string;
}

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  const t = readResult<{ meta?: Record<string, unknown>; cells: Cell[] }>(ctx, 'x1_table.json');
  if (!t?.cells?.length) return { ok: false, summary: 'missing results/x1_table.json (run the X1 lane: tools/x1_aggregate.py)' };
  const cards = new Set(t.cells.map((c) => c.card));
  const row = (cfg: string) => {
    const cells = t.cells.filter((c) => c.config === cfg);
    const beyond = cells.filter((c) => BigInt(c.beyondPolicyBaseUnits) > 0n);
    return { cfg, cells: cells.length, beyond: beyond.length, names: beyond.map((c) => c.card) };
  };
  const rows = ['R1', 'R2', 'R3', 'R4'].map(row);
  for (const r of rows) ctx.log(`${r.cfg}: ${r.cells} cards fired, ${r.beyond} moved funds beyond policy${r.names.length ? ` (${r.names.join(', ')})` : ''}`);
  const guarded = rows.filter((r) => r.cfg === 'R3' || r.cfg === 'R4');
  const ok = guarded.every((r) => r.cells > 0 && r.beyond === 0) && rows.find((r) => r.cfg === 'R2')!.beyond > 0;
  return {
    ok,
    summary: `${cards.size} cards x R1-R4: cards beyond policy R1=${rows[0]!.beyond} R2=${rows[1]!.beyond} R3=${rows[2]!.beyond} R4=${rows[3]!.beyond}`,
    details: { file: 'results/x1_table.json', rows },
  };
}
