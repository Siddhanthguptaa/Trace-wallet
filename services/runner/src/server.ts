/** Standalone runner: `pnpm --filter @hypnexis/runner start` (port RUNNER_PORT, default 8790). */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createRunnerApp } from './app.ts';
import { loadRunnerOptions } from './config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const opts = loadRunnerOptions(process.env, root);
const port = Number(process.env.RUNNER_PORT ?? 8790);
serve({ fetch: createRunnerApp(opts).fetch, port, hostname: '127.0.0.1' });
console.log(`[runner] chain ${opts.chainId}, wallets ${Object.keys(opts.wallets).join(',')}, listening on http://127.0.0.1:${port}`);
