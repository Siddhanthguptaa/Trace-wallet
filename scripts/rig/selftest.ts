/**
 * Rig self-test on a local anvil: fund sends test ETH, reset revokes + unfreezes the listed agent key
 * and bumps the attestation epoch, new-key prints a fresh key, and the rig REFUSES a chain id that is
 * not a testnet (an anvil started with chain id 8453).
 *   pnpm exec tsx scripts/rig/selftest.ts  ->  results/rig_selftest.json
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { DEV, addr, startAnvil } from '../lib/anvil.ts';
import { BUILD_ROOT } from '../lib/stack.ts';
import { checker, makeWorld } from '../lib/world.ts';

const rig = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(BUILD_ROOT, 'scripts', 'rig', 'rig.ts'), ...args], { cwd: BUILD_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });

async function main(): Promise<void> {
  const { checks, add } = checker();
  const w = await makeWorld();
  try {
    const agent = addr('agent');
    const nk = rig(['new-key'], {});
    add('new-key prints a fresh address and key', 'true', String(/"address": "0x[0-9a-fA-F]{40}"/.test(nk.stdout) && /"privateKey": "0x[0-9a-f]{64}"/.test(nk.stdout)));
    const to = privateKeyToAccount(generatePrivateKey()).address as Address;
    const f = rig(['fund', '--to', to, '--eth', '0.05'], { RPC_URL: w.anvil.rpcUrl, FUNDER_KEY: DEV.relayer });
    add('fund sends test ETH', '50000000000000000', String(await w.d.pub.getBalance({ address: to })));
    void f;
    await w.own('freeze', [agent]);
    const epoch0 = await w.read<bigint>('attestEpoch');
    const r = rig(['reset', '--account', w.account, '--agents', agent], { RPC_URL: w.anvil.rpcUrl, OWNER_KEY: DEV.owner });
    add('reset revokes the agent session', 'true', String((await w.read<[bigint, { revoked: boolean }]>('sessionOf', [agent]))[1].revoked));
    add('reset clears the freeze', 'false', String(await w.read<boolean>('isFrozen', [agent])));
    add('reset bumps the attestation epoch', 'true', String((await w.read<bigint>('attestEpoch')) > epoch0));
    void r;
    const main = await startAnvil(8453);
    try {
      const refused = rig(['fund', '--to', to], { RPC_URL: main.rpcUrl, FUNDER_KEY: DEV.relayer });
      add('the rig refuses a mainnet chain id', 'refused', /not a testnet/.test(refused.stderr) ? 'refused' : `ran: ${refused.stdout}${refused.stderr}`.slice(0, 120));
    } finally {
      main.stop();
    }
    const ok = checks.every((c) => c.pass);
    const out = { ok, passed: checks.filter((c) => c.pass).length, total: checks.length, checks, generatedAt: new Date().toISOString() };
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', 'rig_selftest.json'), `${JSON.stringify(out, null, 2)}\n`);
    for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
    console.log(`rig selftest: ${out.passed}/${out.total} ${ok ? 'ok' : 'FAILED'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    w.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
