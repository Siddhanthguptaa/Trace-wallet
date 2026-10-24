/**
 * X6 run driver (EXPERIMENTS X6). Runs scenarios H1-H9 and workloads L1-L4 over the given seeds and
 * detector modes, writing one JSONL record per run; `tools/x6_aggregate.py` turns the stream into
 * `results/x6_detection.{csv,json}`.
 *
 * Protocol (pre-registered): dev seeds 1-3 fix the detector thresholds and are never reported; the
 * scored seeds are 42-61 (20 per scenario and workload). Every scored run is written, none dropped.
 * One run = one fresh anvil chain, so runs never share state and a seed reproduces a run exactly.
 *
 *   tsx hijack/run.ts --smoke
 *   tsx hijack/run.ts --seeds 42-61 --mode combined --out ../results/x6_runs_combined.jsonl
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildRun } from './harness.ts';
import { READY_SCENARIOS, SCENARIOS } from './scenarios/index.ts';
import { READY_WORKLOADS, WORKLOADS } from './workloads/index.ts';
import { DETECTOR_MODES, type DetectorMode, type RunRecord } from './types.ts';
import { harnessEnv, OUT_DIR, RESULTS_DIR } from '../src/env.ts';

export const SCORED_SEEDS = Array.from({ length: 20 }, (_, i) => 42 + i); // 42..61
export const DEV_SEEDS = [1, 2, 3];

export interface X6Options {
  seeds?: number[];
  modes?: DetectorMode[];
  only?: string[];
  smoke?: boolean;
  jsonlFile?: string;
  attestorUrl?: string;
}

const blank = (kind: RunRecord['kind'], id: string, seed: number, mode: DetectorMode, notes: string): RunRecord => ({
  kind, id, seed, mode, config: 'X6', ops: 0, frozen: false, opsToFreeze: null, lossBeforeFreezeBaseUnits: '0', lossTotalBaseUnits: '0', lossUnprovenBaseUnits: '0', falseFreeze: false, notes,
});

export function parseSeeds(spec: string): number[] {
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, k) => Number(range[1]) + k);
  return spec.split(',').map(Number).filter((n) => !Number.isNaN(n));
}

export async function runX6(o: X6Options = {}): Promise<{ records: RunRecord[]; jsonlFile: string }> {
  const env = harnessEnv();
  const seeds = o.seeds ?? (o.smoke ? [1] : SCORED_SEEDS);
  const modes = o.modes ?? (o.smoke ? ['combined'] : DETECTOR_MODES);
  const keep = (id: string) => !o.only || o.only.includes(id);
  const scenarios = (o.smoke ? READY_SCENARIOS : SCENARIOS).filter((s) => keep(s.id));
  const workloads = (o.smoke ? READY_WORKLOADS : WORKLOADS).filter((w) => keep(w.id));
  const jsonlFile = o.jsonlFile ?? (o.smoke ? join(OUT_DIR, 'x6_runs_smoke.jsonl') : join(RESULTS_DIR, 'x6_runs.jsonl'));
  mkdirSync(dirname(jsonlFile), { recursive: true });
  writeFileSync(jsonlFile, '');
  const records: RunRecord[] = [];
  const add = (r: RunRecord) => {
    records.push(r);
    appendFileSync(jsonlFile, `${JSON.stringify(r)}\n`);
  };

  for (const mode of modes) {
    for (const seed of seeds) {
      for (const [kind, list] of [['hijack', scenarios], ['legit', workloads]] as const) {
        for (const item of list) {
          if (!item.ready) {
            add(blank(kind, item.id, seed, mode, 'pending (module not integrated)'));
            continue;
          }
          const { ctx, stop } = await buildRun(seed, { env, attestorUrl: o.attestorUrl, mode });
          try {
            add(await item.run(ctx));
          } catch (e) {
            add(blank(kind, item.id, seed, mode, `error: ${(e as Error).message.split('\n')[0]}`));
          } finally {
            stop();
          }
        }
      }
    }
  }
  return { records, jsonlFile };
}

if (process.argv[1]?.endsWith('run.ts') && process.argv[1]?.includes('hijack')) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const smoke = process.argv.includes('--smoke');
  runX6({
    smoke,
    seeds: arg('--seeds') ? parseSeeds(arg('--seeds')!) : undefined,
    modes: arg('--mode') ? (arg('--mode')!.split(',') as DetectorMode[]) : undefined,
    only: arg('--only')?.split(','),
    jsonlFile: arg('--out'),
  })
    .then((r) => console.log(`x6: ${r.records.length} runs -> ${r.jsonlFile}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
