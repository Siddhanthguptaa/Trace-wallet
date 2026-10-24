/**
 * REHEARSAL (pre-flight test, NOT the demo): runs the whole live toolkit on a local anvil chain so you
 * find setup problems before you stand in front of an audience. It is the only place where a stand-in
 * token (MockUSDC3009) and an anvil-impersonated owner exist: on Base Sepolia the token is Circle's real
 * test USDC and the owner is your MetaMask. Everything else is the real code path:
 *
 *   live.ts init -> deploy (stack + R1..R4) -> fund --send -> owner transactions (the same calldata the
 *   frontend sends, replayed by the impersonated owner) -> the REAL attestor / approval / watcher services
 *   as processes (+ the gateway if services/gateway is present) -> doctor -> live attacks with the leaked
 *   key against R4 -> owner unfreezes -> results/live_rehearsal.json
 *
 *   pnpm exec tsx scripts/live/rehearse.ts
 *
 * It uses a temp .env.live / state dir (LIVE_ENV_FILE, LIVE_STATE_DIR), so it never touches yours.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address, type Hex, formatUnits, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
};

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), 'hyp-live-rehearsal-'));
  process.env.LIVE_ENV_FILE = join(tmp, '.env.live');
  process.env.LIVE_STATE_DIR = join(tmp, 'state');
  process.env.LIVE_WEB_ENV_FILE = join(tmp, 'web.env');
  process.env.STACK_ARTIFACTS ??= 'out';

  // imports AFTER the env is set: envfile.ts reads these at load time
  const { startAnvil, rpc } = await import('../lib/anvil.ts');
  const { loadArtifact } = await import('../lib/stack.ts');
  const { init, deploy, fund } = await import('./lib/setup.ts');
  const { ROOT, readLive, updateEnv } = await import('./lib/envfile.ts');
  const { makeDeployer, publicClient, usdcAbi, stackOf } = await import('./lib/chainio.ts');
  const { ownerPack } = await import('./lib/ownerPack.ts');
  const { servicesUp, servicesDown, servicesStatus, SERVICE_NAMES } = await import('./lib/services.ts');
  const { doctor } = await import('./lib/doctor.ts');
  const A = await import('./lib/agent.ts');
  const log = (m: string) => console.log(m);

  const anvil = await startAnvil(31337);
  let names: string[] = [];
  try {
    // ---- the ONLY stand-ins: a token with the EIP-3009 surface, and an owner we can impersonate
    const ownerAddr = privateKeyToAccount(generatePrivateKey()).address; // an address; we hold no key for it
    await rpc(anvil.rpcUrl, 'anvil_setBalance', [ownerAddr, '0x3635C9ADC5DEA00000']);
    await rpc(anvil.rpcUrl, 'anvil_impersonateAccount', [ownerAddr]);
    const ownerSend = async (to: string, data: Hex, value = 0n): Promise<void> => {
      const hash = await rpc<Hex>(anvil.rpcUrl, 'eth_sendTransaction', [{ from: ownerAddr, to, data, value: `0x${value.toString(16)}`, gas: '0x1c9c380' }]);
      for (let i = 0; i < 60; i++) {
        const r = await rpc<{ status: string } | null>(anvil.rpcUrl, 'eth_getTransactionReceipt', [hash]);
        if (r) {
          if (r.status !== '0x1') throw new Error(`owner tx reverted: ${hash}`);
          return;
        }
        await new Promise((r2) => setTimeout(r2, 100));
      }
      throw new Error(`owner tx not mined: ${hash}`);
    };

    // ---- init
    const ports = { g: await freePort(), a: await freePort(), t: await freePort(), w: await freePort() };
    // deploy the stand-in token with a throwaway key (the ONLY mock in this file)
    const tokenKey = generatePrivateKey();
    await rpc(anvil.rpcUrl, 'anvil_setBalance', [privateKeyToAccount(tokenKey).address, '0x56BC75E2D63100000']);
    const { Deployer } = await import('../lib/stack.ts');
    const td = new Deployer({ rpcUrl: anvil.rpcUrl, chainId: 31337 }, tokenKey);
    const tokenArt = loadArtifact('MockUSDC3009', 'MockUSDC3009.sol');
    const token = await td.deploy(tokenArt, []);
    check('stand-in token deployed (rehearsal only; Base Sepolia uses Circle test USDC)', true, token);

    await init({ owner: ownerAddr, chain: 'anvil', rpc: anvil.rpcUrl, usdc: token, force: true, allowMainnet: false, log });
    updateEnv({
      GATEWAY_PORT: String(ports.g), APPROVAL_PORT: String(ports.a), ATTESTOR_PORT: String(ports.t), WATCHER_PORT: String(ports.w),
      GATEWAY_URL: `http://localhost:${ports.g}`, APPROVAL_URL: `http://127.0.0.1:${ports.a}`, ATTESTOR_URL: `http://127.0.0.1:${ports.t}`, WATCHER_URL: `http://127.0.0.1:${ports.w}`,
      WATCHER_POLL_MS: '1000', APPROVAL_SIMULATION_MODE: 'declared',
    });
    let L = readLive();
    check('init wrote .env.live without any owner key', !/OWNER_KEY|OWNER_PRIVATE/.test(JSON.stringify(L.raw)), `owner ${L.owner}`);
    await rpc(anvil.rpcUrl, 'anvil_setBalance', [L.addr.deployer, '0x56BC75E2D63100000']);

    // ---- deploy: stack + four wallets
    await deploy(L, { redeploy: true, allowMainnet: false, log });
    L = readLive();
    const pub = publicClient(L);
    const code = async (a: string) => ((await pub.getCode({ address: a as Address })) ?? '0x') !== '0x';
    check('stack deployed (factory, implementation, lens)', (await code(L.factory)) && (await code(L.implementation)) && (await code(L.lens)), L.factory);
    for (const n of ['R2', 'R3', 'R4'] as const) check(`${n} deployed`, await code(L.wallets[n]), L.wallets[n]);
    check('R1 is the agent EOA', L.wallets.R1 === L.addr.agent, L.wallets.R1);
    check('ACCOUNT is R4', L.account === L.wallets.R4);

    // ---- fund: faucet-style USDC to the deployer and to the owner; fund --send pays R1-R3; the owner pays R4
    const mint = (to: Address, amt: bigint) => td.send(token, tokenArt.abi, 'mint', [to, amt]);
    await mint(L.addr.deployer, parseUnits('10', 6));
    await mint(ownerAddr, parseUnits('10', 6));
    await fund(L, { send: true, includeR4: false, allowMainnet: false, log });
    const { encodeFunctionData } = await import('viem');
    await ownerSend(L.usdc, encodeFunctionData({ abi: usdcAbi, functionName: 'transfer', args: [L.wallets.R4 as Address, L.fundUsdc] }));
    const usdcOf = (a: string) => pub.readContract({ address: L.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [a as Address] }) as Promise<bigint>;
    for (const n of ['R1', 'R2', 'R3', 'R4'] as const) check(`${n} holds ${formatUnits(L.fundUsdc, 6)} USDC`, (await usdcOf(L.wallets[n])) === L.fundUsdc, formatUnits(await usdcOf(L.wallets[n]), 6));

    // ---- the owner's setup: the same transactions the frontend / owner-pack send
    const now = Number((await pub.getBlock()).timestamp);
    for (const p of ownerPack(L, now)) {
      for (const s of p.steps) await ownerSend(s.to, s.data, s.value);
      check(`${p.wallet}: ${p.steps.length} owner transactions applied`, true);
    }

    // ---- the real services (+ gateway)
    await servicesUp(L, SERVICE_NAMES, log);
    const st = await servicesStatus(L, () => undefined);
    names = Object.entries(st).filter(([, up]) => up).map(([n]) => n);
    for (const n of ['attestor', 'approval', 'watcher'] as const) check(`${n} service is up (real process)`, !!st[n]);
    check('gateway', true, st.gateway ? 'up' : 'services/gateway not started (skipped)');
    const notes: string[] = ((globalThis as { __notes?: string[] }).__notes ??= []);
    if (st.gateway) {
      const g = L.urls.gateway;
      const res = await fetch(`${g}/v1/cards`).then((r) => ({ ok: r.ok, status: r.status })).catch(() => ({ ok: false, status: 0 }));
      if (res.status === 503) notes.push('gateway /v1/cards answered 503: the attack runner (services/runner) is not wired yet; not part of this rehearsal');
      else check('gateway answers the runner API (/v1/cards)', res.ok, `HTTP ${res.status}`);
      const pol = await fetch(`${g}/tools/get_policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => ({ ok: r.ok, status: r.status })).catch(() => ({ ok: false, status: 0 }));
      check('gateway answers the agent-tools API (/tools/get_policy)', pol.ok, `HTTP ${pol.status}`);
    }
    const docLines: string[] = [];
    const doc = await doctor((m) => docLines.push(m), { allowMainnet: false });
    for (const l of docLines.filter((m) => /FAIL|fix:/.test(m))) console.log(`    doctor> ${l.trim()}`);
    check('doctor: no red with services up', doc);

    // ---- live attacks with the leaked key against R4, owner unfreezes in between
    const x = await A.makeCtx(L, () => undefined);
    const daily = L.policy.burst + L.policy.rate;
    const results: Record<string, unknown>[] = [];
    const run = async (name: string, f: () => Promise<{ attack: string; gain: bigint; frozenAtOp: number | null; withinLimit: boolean }>) => {
      const r = await f();
      results.push({ attack: name, gainBaseUnits: r.gain.toString(), frozenAtOp: r.frozenAtOp, withinLimit: r.withinLimit });
      check(`attack ${name}: gain ${formatUnits(r.gain, 6)} USDC within the daily limit ${formatUnits(daily, 6)}`, r.withinLimit);
      return r;
    };
    await run('sidedoor', () => A.attackSideDoor(x));
    await run('approvemax', () => A.attackApproveMax(x));
    await run('unproven', () => A.attackUnproven(x));
    const frozen = (await pub.readContract({ address: L.account as Address, abi: stackOf(L).abi.account, functionName: 'isFrozen', args: [L.addr.agent] })) as boolean;
    check('the key was frozen by the tripwires / watcher after the unproven drain', frozen);
    if (frozen) {
      await ownerSend(L.account as string, encodeFunctionData({ abi: stackOf(L).abi.account, functionName: 'unfreeze', args: [L.addr.agent] }));
      check('only the owner can unfreeze; the key is live again', !((await pub.readContract({ address: L.account as Address, abi: stackOf(L).abi.account, functionName: 'isFrozen', args: [L.addr.agent] })) as boolean));
    }
    await run('forged', () => A.attackForged(x));
    const total = results.reduce((a, r) => a + BigInt(r.gainBaseUnits as string), 0n);
    check('all attacks together stay below the wallet balance', total < L.fundUsdc, `${formatUnits(total, 6)} of ${formatUnits(L.fundUsdc, 6)} USDC`);

    const ok = checks.every((c) => c.pass);
    mkdirSync(join(ROOT, 'results'), { recursive: true });
    const out = join(ROOT, 'results', 'live_rehearsal.json');
    writeFileSync(out, `${JSON.stringify({ ok, rehearsal: true, note: 'anvil pre-flight with a stand-in token and an impersonated owner; the demo itself runs on Base Sepolia with Circle test USDC and your MetaMask', seconds: Math.round((Date.now() - t0) / 1000), services: names, attacks: results, notes: (globalThis as { __notes?: string[] }).__notes ?? [], checks }, null, 2)}\n`);
    console.log(`\n${ok ? 'REHEARSAL OK' : 'REHEARSAL FAILED'}: ${checks.filter((c) => c.pass).length}/${checks.length} checks -> ${out}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await servicesDown(['gateway', 'watcher', 'approval', 'attestor'], () => undefined).catch(() => undefined);
    anvil.stop();
  }
}

main().catch((e) => {
  console.error(`\nREHEARSAL ERROR: ${(e as Error).message}`);
  process.exit(1);
});

