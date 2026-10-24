/**
 * `live.ts doctor`: preflight for the whole demo as a green / red checklist. Every line says what was
 * checked, what was found, and (when it fails) the exact command that fixes it. Exit code 1 if any red.
 */
import { createServer } from 'node:net';
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

async function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}

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
    add(ownerEth >= parseEther('0.002') ? 'ok' : 'warn', 'owner has test ETH for its transactions', `${formatEther(ownerEth)} ETH`, `send ~0.01 Base Sepolia ETH to ${L.owner}`);
  }

  // deployer
  const dep = await pub.getBalance({ address: L.addr.deployer });
  const deployed = !!L.factory;
  const need = deployed ? parseEther('0.001') : parseEther('0.01');
  add(dep >= need ? 'ok' : deployed ? 'warn' : 'fail', 'deployer / relayer has ETH', `${formatEther(dep)} ETH at ${L.addr.deployer}`, `send ~0.02 ETH to ${L.addr.deployer}`);

  // deployment
  const code = async (a: string) => (a ? ((await pub.getCode({ address: a as Address })) ?? '0x') !== '0x' : false);
  const dOk = (await code(L.factory)) && (await code(L.implementation)) && (await code(L.lens));
  add(dOk ? 'ok' : 'fail', 'stack deployed (factory, implementation, lens)', dOk ? `factory ${L.factory}` : 'not deployed', 'pnpm exec tsx scripts/live/live.ts deploy');

  // account
  if (dOk && L.account) {
    const acctCode = await code(L.account);
    if (!acctCode) add('warn', 'agent account created by the owner', `${L.account} has no code yet`, 'console step 1 “Create my agent account” (MetaMask)');
    else {
      const abi = accountAbi();
      const rd = <T>(fn: string, args: unknown[] = []) => pub.readContract({ address: L.account as Address, abi, functionName: fn, args } as never) as Promise<T>;
      const owner = await rd<Address>('owner');
      add(owner.toLowerCase() === L.owner.toLowerCase() ? 'ok' : 'fail', 'account owner is your MetaMask address', owner, 'OWNER_ADDRESS differs from the on-chain owner');
      const g = await rd<{ burst: bigint; ratePerDay: bigint; lastRefill: number }>('globalBucket', [L.usdc]);
      add(g.lastRefill !== 0 ? 'ok' : 'warn', 'daily limit configured', g.lastRefill !== 0 ? `${formatUnits(g.burst + g.ratePerDay, L.usdcDecimals)} USDC / 24 h` : 'not set', 'console step 2');
      const [sid, s] = await rd<[bigint, { revoked: boolean; validUntil: number }]>('sessionOf', [L.addr.agent]);
      const now = Number((await pub.getBlock()).timestamp);
      add(sid !== 0n && !s.revoked && Number(s.validUntil) > now ? 'ok' : 'warn', 'agent session key live', sid === 0n ? 'no session' : s.revoked ? 'revoked' : Number(s.validUntil) > now ? `valid until ${new Date(Number(s.validUntil) * 1000).toISOString()}` : 'expired', 'console step 5');
      const att = await rd<Address>('attestor');
      add(att.toLowerCase() === L.addr.attestor.toLowerCase() ? 'ok' : 'warn', 'account trusts the attestor', att === ZERO ? 'none set' : att, 'console step 6');
      const w = await rd<Address>('watcher');
      add(w.toLowerCase() === L.addr.watcher.toLowerCase() ? 'ok' : 'warn', 'account lets the watcher freeze', w === ZERO ? 'none set' : w, 'console step 7');
      const [gs] = await rd<[Address[], number]>('guardians');
      add(gs.length === 5 ? 'ok' : 'warn', 'five guardians (3 of 5)', `${gs.length} set`, 'console step 8');
      const usdcBal = (await pub.readContract({ address: L.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [L.account] })) as bigint;
      const daily = g.burst + g.ratePerDay;
      add(usdcBal >= daily ? 'ok' : usdcBal > 0n ? 'warn' : 'fail', 'account holds test USDC', `${formatUnits(usdcBal, L.usdcDecimals)} USDC${usdcBal > 0n && usdcBal < daily ? ` (less than the ${formatUnits(daily, L.usdcDecimals)} daily limit: the balance, not the limit, would bound the loss)` : ''}`, `get 10 USDC at https://faucet.circle.com (Base Sepolia) sent to ${L.account}, or console step 11`);
      const dpt = (await pub.readContract({ address: L.entryPoint, abi: (await import('../../lib/stack.ts')).loadArtifact('EntryPoint').abi, functionName: 'balanceOf', args: [L.account] })) as bigint;
      add(dpt >= parseEther('0.001') ? 'ok' : 'warn', 'account has an EntryPoint gas deposit', `${formatEther(dpt)} ETH`, 'console step 10');
    }
  }

  // service keys
  for (const [n, a] of [['watcher', L.addr.watcher], ['attestor', L.addr.attestor]] as const) {
    const b = await pub.getBalance({ address: a });
    add(b >= parseEther('0.0003') ? 'ok' : 'warn', `${n} key has ETH for its transactions`, `${formatEther(b)} ETH at ${a}`, 'live.ts fund-keys');
  }

  // services
  for (const n of SERVICE_NAMES) {
    const h = await healthOf(n, L);
    add(h.up ? 'ok' : 'warn', `${n} service healthy`, h.up ? h.detail.slice(0, 100) : `down (${h.detail})`, 'live.ts services up');
  }

  // console port
  const ports = await portFree(L.ports.console);
  add(ports ? 'ok' : 'warn', `console port ${L.ports.console}`, ports ? 'free' : 'in use (the console may already be running)');

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
