/**
 * pnpm run test:all  ->  forge tests without test/fork/* (summary in results/forge_summary.json),
 * then `pnpm -r test`. Node script, safe under cmd.exe. Exit 1 if either part fails.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, pythonBin, RESULTS, ROOT, runForge, runPnpm } from './lib/common.ts';

loadEnv();
mkdirSync(RESULTS, { recursive: true });

console.log('[test:all] forge test --no-match-path "test/fork/*" --json');
const forge = runForge(['test', '--no-match-path', 'test/fork/*', '--json']);
const forgeJson = join(RESULTS, 'forge_all.json');
writeFileSync(forgeJson, forge.stdout);
const summary = spawnSync(pythonBin(), ['tools/forge_summary.py', 'results/forge_all.json'], {
  cwd: ROOT,
  stdio: 'inherit',
});
const forgeOk = forge.status === 0 && summary.status === 0;

console.log('[test:all] pnpm -r test');
const js = runPnpm(['-r', 'test']);
const jsOk = js.status === 0;

console.log(`[test:all] forge ${forgeOk ? 'ok' : 'FAIL'}, js ${jsOk ? 'ok' : 'FAIL'}`);
process.exit(forgeOk && jsOk ? 0 : 1);
