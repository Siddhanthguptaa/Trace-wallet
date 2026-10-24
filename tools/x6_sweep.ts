/**
 * X6 threshold fixing on DEV SEEDS 1-3 only (EXPERIMENTS X6 protocol). One sensitivity knob moves the
 * on-chain velocity tripwire (T1) and the off-chain spend CUSUM together:
 *
 *   S0 default (4000 bps, h 0.3)  S1 (5000, 0.4)  S2 (6000, 0.5)  S3 (7000, 0.6)  S4 (8000, 0.8)  S5 (9000, 1.0)
 *
 * Each setting runs the legit workloads L1-L4 plus the two velocity-sensitive attacks (H2 slow drain,
 * H9 forged-PROVEN burst drain) on seeds 1-3 in the combined mode. SELECTION RULE (written before any
 * sweep result was read): choose the most sensitive setting (lowest index) with ZERO false freezes
 * across the 12 dev legit runs. The whole sweep is written to results/dev/x6_threshold_sweep.json
 * either way, so the detection-vs-false-freeze trade-off is visible. `--apply` pins the choice into
 * agent/hijack/thresholds.json (fixedOnDevSeeds: true); the scored seeds 42-61 never feed this.
 *
 *   tsx tools/x6_sweep.ts [--apply]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/common.ts';

const SETTINGS = [
  { id: 'S0', velocityBps: 4000, h: 0.3 },
  { id: 'S1', velocityBps: 5000, h: 0.4 },
  { id: 'S2', velocityBps: 6000, h: 0.5 },
  { id: 'S3', velocityBps: 7000, h: 0.6 },
  { id: 'S4', velocityBps: 8000, h: 0.8 },
  { id: 'S5', velocityBps: 9000, h: 1.0 },
];
const ONLY = 'L1,L2,L3,L4,H2,H9';
const dir = join(ROOT, 'results', 'dev', 'sweep');
mkdirSync(dir, { recursive: true });
const base = JSON.parse(readFileSync(join(ROOT, 'agent', 'hijack', 'thresholds.json'), 'utf8'));

type Rec = { kind: string; id: string; seed: number; frozen: boolean; falseFreeze: boolean; opsToFreeze: number | null; lossBeforeFreezeBaseUnits: string; lossTotalBaseUnits: string; freezeTrigger?: string; metrics?: Record<string, string> };

function runSetting(s: (typeof SETTINGS)[number]): Promise<Rec[]> {
  const th = { ...base, onchain: { ...base.onchain, velocityBps: s.velocityBps }, watcher: { ...base.watcher, spend: { ...base.watcher.spend, h: s.h } } };
  const thFile = join(dir, `${s.id}.thresholds.json`);
  const out = join(dir, `${s.id}.jsonl`);
  writeFileSync(thFile, JSON.stringify(th, null, 2));
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(pnpm, ['exec', 'tsx', 'hijack/run.ts', '--seeds', '1-3', '--mode', 'combined', '--only', ONLY, '--out', out], {
    cwd: join(ROOT, 'agent'),
    env: { ...process.env, X6_THRESHOLDS: thFile },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return new Promise((res, rej) =>
    child.on('exit', (code) =>
      code === 0 ? res(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec)) : rej(new Error(`${s.id} exited ${code}`)),
    ),
  );
}

// small pool: 3 settings at a time
const results: Record<string, Rec[]> = {};
const queue = [...SETTINGS];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) results[s.id] = await runSetting(s);
  }),
);

const rows = SETTINGS.map((s) => {
  const recs = results[s.id]!;
  const legit = recs.filter((r) => r.kind === 'legit');
  const hij = (id: string) => recs.filter((r) => r.id === id);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    ...s,
    falseFreezes: legit.filter((r) => r.falseFreeze).length,
    legitRuns: legit.length,
    falseFreezeByWorkload: Object.fromEntries(['L1', 'L2', 'L3', 'L4'].map((w) => [w, legit.filter((r) => r.id === w && r.falseFreeze).length])),
    peakLegitHourSpend: Math.max(0, ...legit.map((r) => Number(r.metrics?.peakHourSpendBaseUnits ?? 0))),
    H9: { detected: hij('H9').filter((r) => r.frozen).length, runs: hij('H9').length, meanLossBeforeFreeze: mean(hij('H9').filter((r) => r.frozen).map((r) => Number(r.lossBeforeFreezeBaseUnits))), maxLoss: Math.max(0, ...hij('H9').map((r) => Number(r.lossTotalBaseUnits))) },
    H2: { detected: hij('H2').filter((r) => r.frozen).length, runs: hij('H2').length, meanLossBeforeFreeze: mean(hij('H2').filter((r) => r.frozen).map((r) => Number(r.lossBeforeFreezeBaseUnits))), maxLoss: Math.max(0, ...hij('H2').map((r) => Number(r.lossTotalBaseUnits))) },
  };
});
const chosen = rows.find((r) => r.falseFreezes === 0) ?? null;
const report = {
  rule: 'most sensitive setting (lowest index) with 0 false freezes across the dev legit runs L1-L4 x seeds 1-3',
  seeds: [1, 2, 3],
  note: 'DEV seeds only; never reported as results. Shows the detection vs false-freeze trade-off.',
  rows,
  chosen: chosen ? chosen.id : null,
};
writeFileSync(join(ROOT, 'results', 'dev', 'x6_threshold_sweep.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const r of rows) console.log(`${r.id} bps=${r.velocityBps} h=${r.h}  falseFreeze ${r.falseFreezes}/${r.legitRuns} ${JSON.stringify(r.falseFreezeByWorkload)}  peakLegitHour=${r.peakLegitHourSpend}  H9 ${r.H9.detected}/${r.H9.runs} lossBefore=${r.H9.meanLossBeforeFreeze}  H2 ${r.H2.detected}/${r.H2.runs} lossBefore=${r.H2.meanLossBeforeFreeze}`);
console.log(`chosen: ${report.chosen}`);
if (process.argv.includes('--apply')) {
  if (!chosen) throw new Error('no setting has 0 false freezes; not applying (extend the sweep or accept the trade-off explicitly)');
  const pinned = { ...base, version: 1, fixedOnDevSeeds: true, sweepChoice: chosen.id, onchain: { ...base.onchain, velocityBps: chosen.velocityBps }, watcher: { ...base.watcher, spend: { ...base.watcher.spend, h: chosen.h } } };
  writeFileSync(join(ROOT, 'agent', 'hijack', 'thresholds.json'), `${JSON.stringify(pinned, null, 2)}\n`);
  console.log(`pinned ${chosen.id} into agent/hijack/thresholds.json`);
}
