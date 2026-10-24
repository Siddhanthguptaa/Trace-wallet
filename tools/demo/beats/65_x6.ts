/**
 * Beat 65 (X6): hijack detection. Reads results/x6_detection.json (written by tools/x6_run.ts +
 * tools/x6_aggregate.py): detection rate, false-freeze rate, containment and the loss assert (the
 * attacker never gains more than the daily limit, in every mode including "no detector").
 */
import type { BeatContext, BeatResult } from '../../lib/common.ts';
import { readResult } from '../lib.ts';

export default async function beat(ctx: BeatContext): Promise<BeatResult> {
  const d = readResult(ctx, 'x6_detection.json');
  if (!d?.byMode) return { ok: false, summary: 'missing results/x6_detection.json (run tools/x6_run.ts --seeds 42-61)' };
  let ok = true;
  for (const [mode, s] of Object.entries(d.byMode as Record<string, any>)) {
    const o = s.overall;
    const pct = (x: { hit: number; runs: number; rate: number | null }) => `${x.hit}/${x.runs}${x.rate === null ? '' : ` = ${(x.rate * 100).toFixed(1)}%`}`;
    ctx.log(`${mode.padEnd(9)} detection ${pct(o.detection)} | containment ${pct(o.containment)} | false freezes ${pct(o.falseFreeze)} | max attacker gain ${o.maxAttackerGainBaseUnits} <= ${o.globalCap}: ${o.lossAssertHeld}`);
    ok &&= o.lossAssertHeld === true;
  }
  const p = d.byMode[d.primaryMode ?? 'combined']?.overall;
  if (!p) return { ok: false, summary: 'x6_detection.json has no primary mode' };
  return {
    ok: ok && p.hijackRuns > 0,
    summary: `X6 (${d.primaryMode}): detection ${p.detection.hit}/${p.detection.runs}, false freezes ${p.falseFreeze.hit}/${p.falseFreeze.runs}, max gain ${p.maxAttackerGainBaseUnits} <= ${p.globalCap} in ${p.lossAssertRuns} hijack runs`,
    details: { file: 'results/x6_detection.json' },
  };
}
