/**
 * Start the attestor: `pnpm --filter @hypnexis/attestor start` (env: see src/config.ts).
 * Exits non-zero if the attestor key equals an agent key [A20].
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { buildAttestor } from './build.ts';
import { loadAttestorConfig } from './config.ts';
import { KeySeparationError } from './signer.ts';

try {
  const cfg = loadAttestorConfig();
  const attestor = buildAttestor(cfg, (m) => console.log(`[attestor] ${m}`));
  serve({ fetch: createApp(attestor).fetch, port: cfg.port, hostname: '127.0.0.1' }, (info) => {
    console.log(`[attestor] ${attestor.signer.address} mode=${cfg.mode} chainId=${cfg.chainId} listening on http://127.0.0.1:${info.port}`);
  });
} catch (e) {
  if (e instanceof KeySeparationError) console.error(`[attestor] refusing to start: ${e.message}`);
  else console.error(`[attestor] failed to start: ${(e as Error).message}`);
  process.exit(1);
}
