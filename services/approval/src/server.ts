/** Start: `pnpm --filter @hypnexis/approval start` (env: src/config.ts, docs/api.md 16.6). */
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { buildService } from './build.ts';
import { loadApprovalConfig } from './config.ts';

try {
  const cfg = loadApprovalConfig();
  const svc = buildService(cfg, (m) => console.log(`[approval] ${m}`));
  serve({ fetch: createApp(svc).fetch, port: cfg.port, hostname: '127.0.0.1' }, (info) => {
    console.log(`[approval] chainId=${cfg.chainId} simulation=${cfg.simulationMode} relay=${cfg.bundlerUrl ? 'bundler' : cfg.relayerKey ? 'direct' : 'none'} listening on http://127.0.0.1:${info.port}`);
  });
} catch (e) {
  console.error(`[approval] failed to start: ${(e as Error).message}`);
  process.exit(1);
}
