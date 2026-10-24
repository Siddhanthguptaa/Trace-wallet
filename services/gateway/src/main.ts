/** `pnpm --filter @hypnexis/gateway start`: serve the frontend's four base URLs on one port (default 8800). */
import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { createGatewayApp } from './app.ts';

const cfg = loadConfig();
const app = createGatewayApp({ cfg });
serve({ fetch: app.fetch, port: cfg.port }, (i) => {
  console.log(`[gateway] http://localhost:${i.port}  chain ${cfg.chainId}  wallet ${cfg.wallet}`);
  console.log(`[gateway] approval ${cfg.approvalUrl}  attestor ${cfg.attestorUrl}  rpc ${cfg.rpcUrl}`);
  console.log(`[gateway] frontend env: VITE_APPROVAL_URL=VITE_ATTESTOR_URL=VITE_AGENT_TOOLS_URL=VITE_RUNNER_URL=http://localhost:${i.port}`);
});
