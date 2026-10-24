/**
 * `live.ts doctor`: preflight for the whole demo as a green / red checklist. Every line says what was
 * checked, what was found, and (when it fails) the exact command that fixes it. Exit code 1 if any red.
 */
import { type Address, formatEther, formatUnits, parseEther } from 'viem';
import { accountAbi } from '../../lib/stack.ts';
import { green, red, yellow, bold, dim } from './agent.ts';
import { fetchJson, publicClient, usdcAbi } from './chainio.ts';
import { MAINNET_IDS } from './chains.ts';
import { ENV_LIVE, type Live, readLive } from './envfile.ts';
import { healthOf, SERVICE_NAMES } from './services.ts';
import { existsSync } from 'node:fs';

type Level = 'ok' | 'fail' | 'warn';
interface Check {
  level: Level;
  label: string;
  detail: string;
  fix?: string;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export async function doctor(log: (m: string) => void = console.log, opts: { allowMainnet?: boolean } = {}): Promise<boolean> {
  const checks: Check[] = [];
  const add = (level: Level, label: string, detail: string, fix?: string) => checks.push({ level, label, detail, fix });

  let L: Live;
  if (!existsSync(ENV_LIVE)) {
    add('fail', '.env.live', 'not found', 'pnpm exec tsx scripts/live/live.ts init --owner 0x<your MetaMask address>');
    return print(checks, log);
  }
  try {
    L = readLive();
    add('ok', '.env.live', `chain ${L.chainKey} (${L.chainId}), ${L.chainName}`);
  } catch (e) {
    add('fail', '.env.live', (e as Error).message, 'regenerate with: live.ts init --force --owner 0x…');
    return print(checks, log);
  }
  if (MAINNET_IDS.has(L.chainId)) add(opts.allowMainnet ? 'warn' : 'fail', 'network is a testnet', `${L.chainKey} is a MAINNET: unaudited contracts, keep at most ~1 USDC`, opts.allowMainnet ? undefined : 'use base-sepolia, or pass --allow-mainnet knowingly');
  else add('ok', 'network is a testnet', L.chainName);

  const pub = publicClient(L);

  // RPC + chain id
  let chainOk = false;
  try {
    const id = await pub.getChainId();
    chainOk = id === L.chainId;
    add(chainOk ? 'ok' : 'fail', 'RPC reachable, chain id right', `${L.rpcUrl} answers chain ${id}${chainOk ? '' : `, expected ${L.chainId}`}`, chainOk ? undefined : 'fix RPC_URL in .env.live');
  } catch (e) {
    add('fail', 'RPC reachable', (e as Error).message.split('\n')[0]!, 'set a working RPC_URL (an Alchemy / Infura Base Sepolia URL if the public one rate-limits)');
  }
  if (!chainOk) return print(checks, log);

  // EntryPoint v0.8
  const ep = await pub.getCode({ address: L.entryPoint });
  add(ep && ep !== '0x' ? 'ok' : 'fail', 'EntryPoint v0.8 code present', `${L.entryPoint}${ep && ep !== '0x' ? '' : ': no code'}`, 'live.ts deploy deploys the official EntryPoint v0.8 if it is absent');

  // USDC + EIP-3009
  const uc = await pub.getCode({ address: L.usdc });
  if (!uc || uc === '0x') add('fail', 'USDC contract present', `${L.usdc}: no code`, 'fix USDC in .env.live');
  else {
    const ok = await pub.readContract({ address: L.usdc, abi: usdcAbi, functionName: 'authorizationState', args: [L.addr.deployer, `0x${'00'.repeat(32)}`] }).then(() => true, () => false);
    add(ok ? 'ok' : 'fail', 'USDC supports EIP-3009', ok ? `${L.usdc} answers authorizationState (the side-door attack is real)` : `${L.usdc} has no authorizationState`, 'use Circle test USDC (FiatTokenV2_2)');
  }

  // state override support (approval service simulation)
  try {
    const r = await fetchJson<{ result?: string; error?: unknown }>(L.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x00000000000000000000000000000000000dEaD1', data: '0x' }, 'latest', { '0x00000000000000000000000000000000000dEaD1': { code: '0x60016000526001601ff3' } }] }) }, 8000);
    const ok = r.ok && !!r.body.result && r.body.result !== '0x';
    add(ok ? 'ok' : 'warn', 'RPC supports eth_call state overrides', ok ? 'the approval service can simulate outflows' : 'not supported', 'set APPROVAL_SIMULATION_MODE=declared before `services up` (amount-based approvals)');
  } catch {
    add('warn', 'RPC supports eth_call state overrides', 'could not test', 'set APPROVAL_SIMULATION_MODE=declared if approvals fail to file');
  }

  // owner
  if (!L.owner) add('fail', 'owner address set', 'OWNER_ADDRESS is empty', 'live.ts init --owner 0x<MetaMask address>');
  else {
    const same = Object.entries(L.addr).find(([, a]) => a.toLowerCase() === L.owner.toLowerCase());
    add(same ? 'fail' : 'ok', 'owner address set (public MetaMask address only)', same ? `OWNER_ADDRESS equals the throwaway ${same[0]} key: the owner must be your MetaMask account` : L.owner, same ? 'live.ts init --owner <your MetaMask address>' : undefined);
    const ownerEth = await pub.getBalance({ address: L.owner });
    add(ownerEth >= parseEther('0.00003') ? 'ok' : 'warn', 'owner has test ETH for its transactions', `${formatEther(ownerEth)} ETH`, `send ~0.01 Base Sepolia ETH to ${L.owner}`);
  }

  // deployer
  const dep = await pub.getBalance({ address: L.addr.deployer });
  const deployed = !!L.factory;
  const need = deployed ? parseEther('0.00005') : parseEther('0.0006');
  add(dep >= need ? 'ok' : deployed ? 'warn' : 'fail', 'deployer / relayer has ETH', `${formatEther(dep)} ETH at ${L.addr.deployer}`, `send ~0.02 ETH to ${L.addr.deployer}`);

  // deployment
  const code = async (a: string) => (a ? ((await pub.getCode({ address: a as Address })) ?? '0x') !== '0x' : false);
  const dOk = (await code(L.factory)) && (await code(L.implementation)) && (await code(L.lens));
  add(dOk ? 'ok' : 'fail', 'stack deployed (factory, implementation, lens)', dOk ? `factory ${L.factory}` : 'not deployed', 'pnpm exec tsx scripts/live/live.ts deploy');

  // the four demo wallets
  const usdcOf = (x: string) => pub.readContract({ address: L.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [x as Address] }) as Promise<bigint>;
  const depositOf = async (x: string) => (await pub.readContract({ address: L.entryPoint, abi: (await import('../../lib/stack.ts')).loadArtifact('EntryPoint').abi, functionName: 'balanceOf', args: [x as Address] })) as bigint;
  const daily = L.policy.burst + L.policy.rate;
  const funded = (label: string, bal: bigint) =>
    add(bal >= L.fundUsdc ? 'ok' : bal > 0n ? 'warn' : 'fail', `${label} holds real test USDC`, `${formatUnits(bal, L.usdcDecimals)} USDC (target ${formatUnits(L.fundUsdc, L.usdcDecimals)})`, label.startsWith('R4') ? 'R4: send it from MetaMask in the frontend (Setup step 4); others: live.ts fund --send' : 'pnpm exec tsx scripts/live/live.ts fund --send');
  if (!dOk) add('warn', 'wallets R1-R4', 'skipped: stack not deployed');
  else {
    for (const n of ['R1', 'R2', 'R3', 'R4'] as const) {
      const a = L.wallets[n];
      if (!a || !(await code(a)) && n !== 'R1') {
        add('fail', `${n} wallet deployed`, a ? `${a} has no code` : 'address not recorded', 'pnpm exec tsx scripts/live/live.ts deploy');
        continue;
      }
      add('ok', `${n} wallet deployed`, a);
      funded(`${n}`, await usdcOf(a));
      if (n === 'R1') continue;
      const dpt = await depositOf(a);
      add(dpt >= parseEther('0.00004') ? 'ok' : 'warn', `${n} has an EntryPoint gas deposit`, `${formatEther(dpt)} ETH`, 'live.ts deploy tops it up');
      if (n === 'R2') continue;
      // R3 / R4: the owner's configuration (done in the frontend / owner-pack)
      const abi = accountAbi();
      const rd = <T>(fn: string, args: unknown[] = []) => pub.readContract({ address: a, abi, functionName: fn, args } as never) as Promise<T>;
      const owner = await rd<Address>('owner');
      add(owner.toLowerCase() === L.owner.toLowerCase() ? 'ok' : 'fail', `${n} owner is your MetaMask address`, owner, 'OWNER_ADDRESS differs from the on-chain owner');
      const g = await rd<{ burst: bigint; ratePerDay: bigint; lastRefill: number }>('globalBucket', [L.usdc]);
      add(g.lastRefill !== 0 ? 'ok' : 'warn', `${n} daily limit configured`, g.lastRefill !== 0 ? `${formatUnits(g.burst + g.ratePerDay, L.usdcDecimals)} USDC / 24 h (target ${formatUnits(daily, L.usdcDecimals)})` : 'not set (owner step)', 'frontend Policy, or: live.ts owner-pack');
      const [sid, sess] = await rd<[bigint, { revoked: boolean; validUntil: number }]>('sessionOf', [L.addr.agent]);
      const now = Number((await pub.getBlock()).timestamp);
      add(sid !== 0n && !sess.revoked && Number(sess.validUntil) > now ? 'ok' : 'warn', `${n} agent session key live`, sid === 0n ? 'no session (owner step)' : sess.revoked ? 'revoked' : Number(sess.validUntil) > now ? `valid until ${new Date(Number(sess.validUntil) * 1000).toISOString()}` : 'expired', 'frontend Setup/Keys, or: live.ts owner-pack');
      const att = await rd<Address>('attestor');
      if (n === 'R4') add(att.toLowerCase() === L.addr.attestor.toLowerCase() ? 'ok' : 'warn', 'R4 trusts the real attestor', att === ZERO ? 'none set (owner step)' : att, 'frontend Setup step 3');
      else add(att === ZERO ? 'ok' : 'warn', 'R3 has no attestor (that is the point of R3)', att === ZERO ? 'none' : att);
      const w = await rd<Address>('watcher');
      add(w.toLowerCase() === L.addr.watcher.toLowerCase() ? 'ok' : 'warn', `${n} lets the watcher freeze`, w === ZERO ? 'none set (owner step)' : w, 'live.ts owner-pack (setWatcher)');
    }
  }

  // service keys
  for (const [n, a] of [['watcher', L.addr.watcher], ['attestor', L.addr.attestor]] as const) {
    const b = await pub.getBalance({ address: a });
    add(b >= parseEther('0.00002') ? 'ok' : 'warn', `${n} key has ETH for its transactions`, `${formatEther(b)} ETH at ${a}`, 'live.ts fund-keys');
  }

  // services
  for (const n of SERVICE_NAMES) {
    const h = await healthOf(n, L);
    add(h.up ? 'ok' : 'warn', `${n} service healthy${n === 'gateway' ? ` (the frontend talks only to this: ${L.urls.gateway})` : ''}`, h.up ? h.detail.slice(0, 100) : `down (${h.detail})`, 'pnpm exec tsx scripts/live/live.ts services up');
  }

  return print(checks, log);
}

function print(checks: Check[], log: (m: string) => void): boolean {
  log(bold('\nHypnexis live demo: doctor\n'));
  for (const c of checks) {
    const mark = c.level === 'ok' ? green('  OK  ') : c.level === 'warn' ? yellow(' WARN ') : red(' FAIL ');
    log(`${mark} ${c.label}${c.detail ? dim(`  ${c.detail}`) : ''}`);
    if (c.level !== 'ok' && c.fix) log(`        ${dim('fix:')} ${c.fix}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  log('');
  log(fails ? red(bold(`${fails} red, ${warns} amber: fix the red items first.`)) : warns ? yellow(bold(`all required checks pass; ${warns} amber item(s) to finish before the demo.`)) : green(bold('ALL GREEN: ready to demo.')));
  return fails === 0;
}
