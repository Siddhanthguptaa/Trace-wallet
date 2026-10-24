/**
 * X6 runner entry point (EXPERIMENTS X6). Runs scenarios H1-H9 and workloads L1-L4 over the given
 * seeds, one child process per detector mode (combined, tripwires, watcher, none) in parallel, each
 * writing results/x6_runs_<mode>.jsonl, then rebuilds results/x6_detection.{csv,json}.
 *
 *   tsx tools/x6_run.ts --dev                       dev seeds 1-3 (threshold fixing; never reported)
 *   tsx tools/x6_run.ts --seeds 42-61               the scored run
 *   tsx tools/x6_run.ts --seeds 42-61 --modes combined --only H1,H9
 *
 * Dev runs write results/dev/ so they can never be mistaken for scored results.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/common.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const dev = process.argv.includes('--dev');
const seeds = dev ? '1-3' : (arg('--seeds') ?? '42-61');
const modes = (arg('--modes') ?? 'combined,tripwires,watcher,none').split(',');
const only = arg('--only');
const outDir = join(ROOT, 'results', dev ? 'dev' : '');
mkdirSync(outDir, { recursive: true });

function runMode(mode: string): Promise<number> {
  const out = join(outDir, `x6_runs_${mode}.jsonl`);
  const args = ['exec', 'tsx', 'hijack/run.ts', '--seeds', seeds, '--mode', mode, '--out', out, ...(only ? ['--only', only] : [])];
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(pnpm, args, { cwd: join(ROOT, 'agent'), stdio: 'inherit', shell: process.platform === 'win32' });
  return new Promise((res) => child.on('exit', (code) => res(code ?? 1)));
}

const codes = await Promise.all(modes.map(runMode));
if (codes.some((c) => c !== 0)) {
  console.error(`x6_run: a mode failed (${modes.map((m, i) => `${m}=${codes[i]}`).join(' ')})`);
  process.exit(1);
}
const py = process.platform === 'win32' ? 'python' : 'python3';
const files = modes.map((m) => join(outDir, `x6_runs_${m}.jsonl`));
if (dev) {
  console.log(`x6_run: dev seeds written to ${outDir}; aggregate with: python tools/x6_aggregate.py ${files.join(' ')}`);
} else {
  const r = spawnSync(py, [join(ROOT, 'tools', 'x6_aggregate.py'), ...files], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
