/**
 * `live.ts services up|down|status`: the REAL attestor (services/attestor, real TRACE scoring and signer),
 * the REAL approval service (services/approval, eth_call simulation, relay) and the REAL watcher
 * (services/watcher, CUSUM + revert streak + approval rate -> freeze) as detached processes, configured
 * from `.env.live`. Logs: scripts/live/.state/logs/<name>.log, pids: scripts/live/.state/pids.json.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJson, sleep } from './chainio.ts';
import { ENV_LIVE, LOG_DIR, ROOT, STATE_DIR, type Live } from './envfile.ts';

export type ServiceName = 'attestor' | 'approval' | 'watcher' | 'gateway';
/** the gateway starts last: it fronts the other three for the frontend (and hosts the attack runner) */
export const SERVICE_NAMES: ServiceName[] = ['attestor', 'approval', 'watcher', 'gateway'];
const PIDS = join(STATE_DIR, 'pids.json');

interface Def {
  cwd: string;
  entry: string;
  /** gateway only: started with `pnpm --filter @hypnexis/gateway start` once services/gateway exists */
  pnpm?: string[];
  port: (L: Live) => number;
  url: (L: Live) => string;
  env: (L: Live) => Record<string, string>;
}

function watcherConfig(): string {
  const th = JSON.parse(readFileSync(join(ROOT, 'agent', 'hijack', 'thresholds.json'), 'utf8')) as { watcher: unknown };
  return JSON.stringify(th.watcher);
}

const DEFS: Record<ServiceName, Def> = {
  attestor: {
    cwd: 'services/attestor',
    entry: 'src/server.ts',
    port: (L) => L.ports.attestor,
    url: (L) => L.urls.attestor,
    env: (L) => ({
      ATTESTOR_PRIVATE_KEY: L.attestorKey,
      AGENT_ADDRESSES: L.addr.agent,
      VERIFIER_ADDRESSES: L.addr.verifier,
      CHAIN_ID: String(L.chainId),
      RPC_URL: L.rpcUrl,
      ATTESTOR_PORT: String(L.ports.attestor),
      ATTESTOR_DB: join(STATE_DIR, 'attestor.sqlite'),
      ATTESTOR_MODE: 'trace',
      WALLETS: [L.wallets.R3, L.wallets.R4].filter(Boolean).join(','),
    }),
  },
  approval: {
    cwd: 'services/approval',
    entry: 'src/server.ts',
    port: (L) => L.ports.approval,
    url: (L) => L.urls.approval,
    env: (L) => ({
      CHAIN_ID: String(L.chainId),
      RPC_URL: L.rpcUrl,
      ENTRYPOINT: L.entryPoint,
      RELAYER_PRIVATE_KEY: L.deployerKey,
      APPROVAL_PORT: String(L.ports.approval),
      APPROVAL_DB: join(STATE_DIR, 'approval.sqlite'),
      APPROVAL_TTL_SECONDS: '1800',
      SIMULATION_MODE: process.env.APPROVAL_SIMULATION_MODE ?? 'eth_call',
    }),
  },
  watcher: {
    cwd: 'services/watcher',
    entry: 'src/main.ts',
    port: (L) => L.ports.watcher,
    url: (L) => L.urls.watcher,
    env: (L) => ({
      WATCHER_PRIVATE_KEY: L.watcherKey,
      RPC_URL: L.rpcUrl,
      CHAIN_ID: String(L.chainId),
      WATCHER_ACCOUNTS: [L.wallets.R3, L.wallets.R4].filter(Boolean).join(','),
      ENTRYPOINT: L.entryPoint,
      AGENT_ADDRESSES: L.addr.agent,
      WATCHER_PORT: String(L.ports.watcher),
      POLL_MS: String(L.watcherPollMs),
      WATCHER_CONFIG: watcherConfig(),
    }),
  },
  gateway: {
    cwd: '.',
    entry: '',
    pnpm: ['--filter', '@hypnexis/gateway', 'start'],
    port: (L) => L.ports.gateway,
    url: (L) => L.urls.gateway,
    // the gateway reads the whole live environment (wallets, keys of the throwaway roles, service URLs)
    env: (L) => ({ ...L.raw, LIVE_ENV_FILE: ENV_LIVE, GATEWAY_PORT: String(L.ports.gateway), APPROVAL_URL: L.urls.approval, ATTESTOR_URL: L.urls.attestor, WATCHER_URL: L.urls.watcher }),
  },
};

type Pids = Partial<Record<ServiceName, number>>;
const readPids = (): Pids => (existsSync(PIDS) ? (JSON.parse(readFileSync(PIDS, 'utf8')) as Pids) : {});
const writePids = (p: Pids) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PIDS, `${JSON.stringify(p, null, 2)}\n`);
};
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function healthOf(name: ServiceName, L: Live): Promise<{ up: boolean; detail: string }> {
  try {
    const r = await fetchJson<Record<string, unknown>>(`${DEFS[name].url(L)}/health`, undefined, 2500);
    return { up: r.ok, detail: r.ok ? JSON.stringify(r.body) : `http ${r.status}` };
  } catch (e) {
    return { up: false, detail: (e as Error).message.split('\n')[0]! };
  }
}

export async function servicesUp(L: Live, only: ServiceName[] = SERVICE_NAMES, log: (m: string) => void = console.log): Promise<void> {
  if (!L.account) throw new Error('ACCOUNT is empty in .env.live: run `live.ts deploy` first (the services watch that account)');
  mkdirSync(LOG_DIR, { recursive: true });
  const pids = readPids();
  for (const name of only) {
    const def = DEFS[name];
    if (name === 'gateway' && !existsSync(join(ROOT, 'services', 'gateway', 'package.json'))) {
      log('  gateway: services/gateway does not exist yet (the frontend needs it on :' + def.port(L) + '); skipping');
      continue;
    }
    if ((await healthOf(name, L)).up) {
      log(`  ${name}: already up at ${def.url(L)}`);
      continue;
    }
    const out = openSync(join(LOG_DIR, `${name}.log`), 'a');
    const child = def.pnpm
      ? spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', def.pnpm, { cwd: join(ROOT, def.cwd), env: { ...process.env, ...def.env(L) }, detached: true, stdio: ['ignore', out, out], windowsHide: true, shell: process.platform === 'win32' })
      : spawn(process.execPath, ['--import', 'tsx', def.entry], { cwd: join(ROOT, def.cwd), env: { ...process.env, ...def.env(L) }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    closeSync(out);
    pids[name] = child.pid;
    writePids(pids);
    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline) {
      if (!alive(child.pid)) break;
      if ((await healthOf(name, L)).up) {
        up = true;
        break;
      }
      await sleep(500);
    }
    if (!up) throw new Error(`${name} did not become healthy; see ${join(LOG_DIR, `${name}.log`)}`);
    log(`  ${name}: up (pid ${child.pid}) at ${def.url(L)}   log ${join('scripts', 'live', '.state', 'logs', `${name}.log`)}`);
  }
}

export async function servicesDown(only: ServiceName[] = SERVICE_NAMES, log: (m: string) => void = console.log): Promise<void> {
  const pids = readPids();
  for (const name of only) {
    const pid = pids[name];
    if (alive(pid)) {
      try {
        if (process.platform === 'win32') (await import('node:child_process')).spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(pid!);
        log(`  ${name}: stopped (pid ${pid})`);
      } catch (e) {
        log(`  ${name}: could not stop pid ${pid}: ${(e as Error).message}`);
      }
    } else log(`  ${name}: not running`);
    delete pids[name];
  }
  writePids(pids);
}

export async function servicesStatus(L: Live, log: (m: string) => void = console.log): Promise<Record<ServiceName, boolean>> {
  const pids = readPids();
  const res = {} as Record<ServiceName, boolean>;
  for (const name of SERVICE_NAMES) {
    const h = await healthOf(name, L);
    res[name] = h.up;
    log(`  ${name.padEnd(9)} ${h.up ? 'UP  ' : 'DOWN'} ${DEFS[name].url(L)}  pid ${pids[name] ?? '-'}${alive(pids[name]) ? '' : ' (not ours / not running)'}  ${h.up ? h.detail.slice(0, 120) : h.detail}`);
  }
  return res;
}
