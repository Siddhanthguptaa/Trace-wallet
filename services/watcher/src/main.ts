/** Entry point: `pnpm --filter @hypnexis/watcher start` (env: see config.ts). */
import { ChainSource, chainFor, publicClientFor, viemReader, viemWriter } from './chain.ts';
import { loadEnv } from './config.ts';
import { FreezeSender } from './freezer.ts';
import { makeServer } from './server.ts';
import { WatcherService } from './service.ts';

const env = loadEnv();
const log = (m: string) => console.log(`[watcher] ${m}`);
const client = env.rpcUrl ? publicClientFor(env.chainId, env.rpcUrl) : null;
const reader = client ? viemReader(client) : null;
const writer =
  client && env.rpcUrl && env.watcherKey ? viemWriter(client, chainFor(env.chainId, env.rpcUrl), env.rpcUrl, env.watcherKey) : null;
const source =
  client && env.accounts.length
    ? new ChainSource({ client, accounts: env.accounts, entryPoint: env.entryPoint, fromBlock: env.fromBlock ?? undefined })
    : null;
const freezer = new FreezeSender({ writer, reader, watcher: env.watcher ?? '0x0000000000000000000000000000000000000000', log });
const svc = new WatcherService({ accounts: env.accounts, freezer, reader, source, config: env.config, caps: env.caps, log });

if (!writer) log('no RPC_URL or WATCHER_PRIVATE_KEY: alarms are reported but no freeze tx is sent');
makeServer(svc, { watcher: env.watcher, chainId: env.chainId }).listen(env.port, () => log(`listening on :${env.port}`));

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await svc.tick();
  } catch (e) {
    log(`poll error: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    busy = false;
  }
}, env.pollMs);
