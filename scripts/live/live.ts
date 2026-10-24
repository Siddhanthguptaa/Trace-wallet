/**
 * Hypnexis LIVE demo CLI: the owner is YOUR MetaMask, the attacker holds the leaked agent key, on a
 * real public testnet (Base Sepolia) with real Circle test USDC, the real EntryPoint v0.8 and the real
 * attestor / approval / watcher services. No mocks on this path. (The anvil pre-flight is rehearse.ts.)
 *
 *   pnpm exec tsx scripts/live/live.ts <command> [options]
 *
 *   init --owner 0x…           write .env.live (throwaway testnet keys + your PUBLIC owner address)
 *   deploy                     deploy the stack (libraries linked) and compute the account address
 *   fund-keys [--guardians]    send gas money to the watcher / attestor (/ guardian) keys
 *   services up|down|status    the real attestor, approval service and watcher as processes
 *   doctor                     preflight checklist (green / red)
 *   status [--json]            one-screen state: balances, limits, freeze, attacker, services
 *   leak                       print the agent private key on screen (the demo moment; throwaway key)
 *   attack unproven|forged|spray|sidedoor|approvemax|all     live attacks with the leaked key
 *   legit [--amount 1]         the agent pays the trusted merchant (in policy)
 *   pay --to 0x… --amount N [--attested]   the agent pays; --attested asks the real attestor first
 *   request --to 0x… --amount N [--note …]  agent files an out-of-policy approval request
 *   vouch --payee 0x…          verifier-signed outcomes (non-interactive way to make a payee PROVEN)
 *   recovery propose|approve|status   play the guardians
 *   watcher                    start only the real watcher service
 *   console [--port N] [--frontend dir]   owner-console backend (serves YOUR frontend + the API)
 *
 * Global: --allow-mainnet (otherwise any mainnet is refused).
 */
import { type Address, type Hex, getAddress, isAddress, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { outcomeTypedData } from '../../packages/shared/src/attestor/typedData.ts';
import { accountAbi } from '../lib/stack.ts';
import { agentPay, attackApproveMax, attackForged, attackSideDoor, attackSpray, attackUnproven, bold, dim, fileApprovalRequest, green, makeCtx, red, runAll, yellow } from './lib/agent.ts';
import { fetchJson, makeDeployer, publicClient, sleep } from './lib/chainio.ts';
import { txUrl } from './lib/chains.ts';
import { doctor } from './lib/doctor.ts';
import { guardMainnet, readLive } from './lib/envfile.ts';
import { SERVICE_NAMES, type ServiceName, servicesDown, servicesStatus, servicesUp } from './lib/services.ts';
import { deploy, fundKeys, init } from './lib/setup.ts';
import { getStatus, render } from './lib/status.ts';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (n: string) => argv.includes(n);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const log = (m: string) => console.log(m);

async function main(): Promise<void> {
  const allow = flag('--allow-mainnet');
  switch (cmd) {
    case 'init':
      return init({ owner: opt('--owner'), chain: opt('--chain') ?? 'base-sepolia', rpc: opt('--rpc'), merchant: opt('--merchant'), salt: opt('--salt'), usdc: opt('--usdc'), force: flag('--force'), allowMainnet: allow, log });
    case 'deploy': {
      const L = readLive();
      return deploy(L, { redeploy: flag('--redeploy'), allowMainnet: allow, log });
    }
    case 'fund-keys': {
      const L = readLive();
      return fundKeys(L, { eth: opt('--eth'), guardians: flag('--guardians'), allowMainnet: allow, log });
    }
    case 'services': {
      const L = readLive();
      guardMainnet(L, allow);
      const sub = rest[0];
      const names = (rest.slice(1).filter((x) => !x.startsWith('--')) as ServiceName[]).filter((n) => SERVICE_NAMES.includes(n));
      if (sub === 'up') {
        log('starting the real services (attestor, approval, watcher) from .env.live…');
        await servicesUp(L, names.length ? names : SERVICE_NAMES, log);
        log(green('services up.'));
        return;
      }
      if (sub === 'down') return servicesDown(names.length ? names : SERVICE_NAMES, log);
      if (sub === 'status' || !sub) {
        const s = await servicesStatus(L, log);
        if (!Object.values(s).every(Boolean)) process.exitCode = 1;
        return;
      }
      throw new Error('usage: services up|down|status [attestor|approval|watcher]');
    }
    case 'watcher': {
      const L = readLive();
      guardMainnet(L, allow);
      await servicesUp(L, ['watcher'], log);
      return;
    }
    case 'doctor': {
      const ok = await doctor(log, { allowMainnet: allow });
      if (!ok) process.exitCode = 1;
      return;
    }
    case 'status': {
      const L = readLive();
      guardMainnet(L, allow);
      const s = await getStatus(L);
      log(flag('--json') ? JSON.stringify(s, null, 2) : render(s, L));
      return;
    }
    case 'leak': {
      const L = readLive();
      log('');
      log(red(bold('  !!!  THE AGENT KEY HAS LEAKED  !!!')));
      log(`  agent address : ${L.addr.agent}`);
      log(`  private key   : ${L.agentKey}`);
      log(dim('  (a THROWAWAY testnet key generated by `live.ts init`; it can only do what the owner’s policy allows)'));
      log('');
      return;
    }
    case 'attack': {
      const L = readLive();
      guardMainnet(L, allow);
      const x = await makeCtx(L, log);
      const name = rest[0];
      const table: Record<string, () => Promise<unknown>> = {
        unproven: () => attackUnproven(x),
        forged: () => attackForged(x),
        spray: () => attackSpray(x),
        sidedoor: () => attackSideDoor(x),
        approvemax: () => attackApproveMax(x),
        all: async () => {
          const r = await runAll(x);
          log('');
          log(bold('SUMMARY'));
          for (const a of r) log(`  ${a.attack.padEnd(22)} gained ${(Number(a.gain) / 1e6).toFixed(2)} USDC  ${a.frozenAtOp ? `frozen at op ${a.frozenAtOp}` : ''}  ${a.withinLimit ? green('within the daily limit') : red('OVER THE LIMIT')}`);
          if (r.some((a) => !a.withinLimit)) process.exitCode = 1;
        },
      };
      if (!name || !table[name]) throw new Error(`usage: attack ${Object.keys(table).join('|')}`);
      const result = (await table[name]!()) as { withinLimit?: boolean } | undefined;
      if (result && result.withinLimit === false) process.exitCode = 1;
      return;
    }
    case 'legit': {
      const L = readLive();
      guardMainnet(L, allow);
      const x = await makeCtx(L, log);
      log(bold(`the agent pays the trusted merchant ${L.merchant} (in policy)`));
      await agentPay(x, L.merchant, parseUnits(opt('--amount') ?? '1', L.usdcDecimals), false);
      return;
    }
    case 'pay': {
      const L = readLive();
      guardMainnet(L, allow);
      const to = opt('--to');
      if (!to || !isAddress(to)) throw new Error('--to 0x… is required');
      const x = await makeCtx(L, log);
      await agentPay(x, getAddress(to), parseUnits(opt('--amount') ?? '1', L.usdcDecimals), flag('--attested'));
      return;
    }
    case 'request': {
      const L = readLive();
      guardMainnet(L, allow);
      const to = opt('--to');
      if (!to || !isAddress(to)) throw new Error('--to 0x… is required');
      const x = await makeCtx(L, log);
      const r = await fileApprovalRequest(x, getAddress(to), parseUnits(opt('--amount') ?? '3', L.usdcDecimals), opt('--note') ?? 'please approve this payment (agent text, untrusted)');
      log(r.status < 300 ? green(`filed approval request ${r.id}: the owner sees it in the console (approvals panel)`) : red(`approval service answered HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`));
      if (r.status >= 300) process.exitCode = 1;
      return;
    }
    case 'vouch': {
      const L = readLive();
      guardMainnet(L, allow);
      const payee = opt('--payee');
      if (!payee || !isAddress(payee)) throw new Error('--payee 0x… is required');
      if (!L.account) throw new Error('ACCOUNT empty: deploy first');
      const verifier = privateKeyToAccount(L.verifierKey);
      const n = Number(opt('--count') ?? '3');
      for (let i = 0; i < n; i++) {
        const { keccak256, toBytes } = await import('viem');
        const ref = keccak256(toBytes(`verifier-vouch:${payee}:${i}:${Date.now()}`)) as Hex;
        const msg = { wallet: L.account as Address, payee: getAddress(payee), success: true, ref, asset: L.usdc, amount: 1_000_000n };
        const signature = await verifier.signTypedData(outcomeTypedData(L.chainId, msg));
        const r = await fetchJson(`${L.urls.attestor}/v1/outcomes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'verifier', outcome: { ...msg, amount: '1000000' }, signature }) }, 20_000);
        log(`  outcome ${i + 1}/${n}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
      }
      return;
    }
    case 'recovery': {
      const L = readLive();
      guardMainnet(L, allow);
      const d = makeDeployer(L);
      const abi = accountAbi();
      const sub = rest[0];
      const pub = publicClient(L);
      if (sub === 'status') {
        const p = (await pub.readContract({ address: L.account as Address, abi, functionName: 'pendingRecovery' })) as [bigint, Address, number, bigint, boolean];
        log(p[1] === '0x0000000000000000000000000000000000000000' ? 'no recovery pending' : `recovery #${p[0]} -> ${p[1]}, proposed at ${new Date(Number(p[2]) * 1000).toISOString()}, approvals bitmap ${p[3]}, vetoed ${p[4]}`);
        return;
      }
      const idx = Number(opt('--guardian') ?? '1') - 1;
      const key = L.guardianKeys[idx];
      if (!key) throw new Error(`no guardian ${idx + 1} (1-${L.guardianKeys.length})`);
      if (sub === 'propose') {
        const newOwner = opt('--new-owner');
        if (!newOwner || !isAddress(newOwner)) throw new Error('--new-owner 0x… is required');
        const h = await d.send(L.account as Address, abi, 'proposeRecovery', [getAddress(newOwner)], key as Hex);
        log(`guardian ${idx + 1} proposed ${newOwner}: ${txUrl(L.explorer, h)}\nthe owner can veto in the console until it executes (48 h delay, 3 of 5 approvals)`);
        return;
      }
      if (sub === 'approve') {
        const id = BigInt(opt('--id') ?? '1');
        const h = await d.send(L.account as Address, abi, 'approveRecovery', [id], key as Hex);
        log(`guardian ${idx + 1} approved #${id}: ${txUrl(L.explorer, h)}`);
        return;
      }
      throw new Error('usage: recovery propose --new-owner 0x… [--guardian N] | approve [--id N --guardian N] | status');
    }
    case 'console': {
      const L = readLive();
      guardMainnet(L, allow);
      const { startConsole } = await import('./console/server.ts');
      const c = await startConsole({ port: opt('--port') ? Number(opt('--port')) : undefined, frontend: opt('--frontend'), log });
      const st = await servicesStatus(L, () => undefined);
      if (!Object.values(st).every(Boolean)) log(yellow('  note: some services are down. Run: pnpm exec tsx scripts/live/live.ts services up'));
      void c;
      await new Promise(() => undefined); // run until Ctrl+C
      return;
    }
    default:
      log(readHelp());
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

function readHelp(): string {
  return `Hypnexis live demo (real testnet, real services, your MetaMask as owner)

  init --owner 0x…  |  deploy  |  fund-keys [--guardians]  |  services up|down|status  |  doctor
  status [--json]   |  leak    |  attack unproven|forged|spray|sidedoor|approvemax|all
  legit [--amount N] | pay --to 0x… --amount N [--attested] | request --to 0x… --amount N
  vouch --payee 0x…  |  recovery propose|approve|status  |  watcher  |  console

Run \`doctor\` first. Full walkthrough: docs/live_demo_metamask.md`;
}

main().catch((e) => {
  console.error(red(`\nERROR: ${(e as Error).message}`));
  process.exit(1);
});

void sleep;
