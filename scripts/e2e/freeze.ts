/**
 * Freeze end-to-end on the REAL AgentAccount with the real watcher service in-process:
 *   tripwire   a hijacked agent key sprays fresh unproven payees: T2 trips on the 6th, the key is
 *              frozen ON-CHAIN, the 6th payment is undone (nothing reaches the 6th payee)
 *   refused    while frozen, the key's next in-policy op is refused in validation (FROZEN)
 *   watcher    a second key floods approval requests: the watcher's approval-rate detector alarms and
 *              sends freeze(key) through the escalate-only watcher role
 *   escalate   the watcher cannot unfreeze, a stranger cannot freeze
 *   unfreeze   the OWNER unfreezes the first key and its in-policy op executes again; the second key
 *              stays frozen until its own unfreeze
 *   pnpm exec tsx scripts/e2e/freeze.ts  ->  results/m10_freeze_e2e.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, encodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainSource, FreezeSender, WatcherService, chainFor, publicClientFor, viemReader, viemWriter } from '../../services/watcher/src/index.ts';
import { DEV, addr, chainNow, startAnvil } from '../lib/anvil.ts';
import { BUILD_ROOT, Deployer, createAccount, deployStack, loadArtifact } from '../lib/stack.ts';
import { RULE_OP, TRANSFER, policyInput } from '../lib/policy.ts';
import { signAgentOp, submitOps } from '../lib/ops.ts';

interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}

async function main(): Promise<void> {
  const anvil = await startAnvil();
  const checks: Check[] = [];
  const add = (name: string, expected: string, observed: string) => checks.push({ name, expected, observed, pass: expected === observed });
  const metrics: Record<string, string | number | boolean> = {};
  try {
    const owner = addr('owner');
    const agent = addr('agent');
    const agent2 = addr('agent2');
    const d = new Deployer(anvil, DEV.owner);
    const stack = await deployStack(d);
    const A = stack.abi.account;
    const usdc = await d.deploy(loadArtifact('MockUSDC3009', 'MockUSDC3009.sol'));
    const usdcAbi = loadArtifact('MockUSDC3009', 'MockUSDC3009.sol').abi;
    const shop = addr('verifier');
    const account = await createAccount(d, stack, owner, 0n);
    const now0 = await chainNow(anvil.rpcUrl);
    await d.send(usdc, usdcAbi, 'mint', [account, 100_000_000n]);
    await d.send(account, A, 'addDeposit', [], DEV.owner, 10n ** 18n);
    await d.send(account, A, 'setGlobalCap', [usdc, 10_000_000n, 10_000_000n]);
    await d.send(account, A, 'setRecipient', [shop, true]);
    for (const k of [agent, agent2]) {
      await d.send(account, A, 'setPolicy', [
        k,
        policyInput({
          validAfter: now0 - 1,
          validUntil: now0 + 30 * 86400,
          assets: [{ asset: usdc, perTxCap: 10_000_000n, burst: 10_000_000n, ratePerDay: 10_000_000n }],
          calls: [{ target: usdc, selector: TRANSFER, rules: [{ argIndex: 0, op: RULE_OP.PAYEE }] }],
        }),
      ]);
    }
    await d.send(account, A, 'setWatcher', [addr('watcher')]);

    const client = publicClientFor(anvil.chainId, anvil.rpcUrl);
    const reader = viemReader(client);
    const writer = viemWriter(client, chainFor(anvil.chainId, anvil.rpcUrl), anvil.rpcUrl, DEV.watcher);
    const source = new ChainSource({ client, accounts: [account], entryPoint: stack.entryPoint });
    const svc = new WatcherService({ accounts: [account], freezer: new FreezeSender({ writer, reader, watcher: addr('watcher') }), reader, source });
    await svc.tick();

    const pay = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
    const run = async (key: typeof DEV.agent, to: Address, amount: bigint) => {
      const s = await signAgentOp(d, stack, anvil.chainId, { account, agentKey: key, target: usdc, data: pay(to, amount) });
      const r = await submitOps(d, stack, [s.op], addr('relayer'), DEV.relayer);
      await svc.tick();
      return r;
    };
    const isFrozen = (k: Address) => d.read<boolean>(account, A, 'isFrozen', [k]);
    const bal = (a: Address) => d.read<bigint>(usdc, usdcAbi, 'balanceOf', [a]);

    // control: an in-policy payment to the listed shop executes
    const c0 = await run(DEV.agent, shop, 1_000_000n);
    add('control: in-policy payment to the listed shop executes', 'validated/success', `${c0.validated ? 'validated' : 'rejected'}/${c0.success ? 'success' : 'reverted'}`);

    // tripwire: spray six fresh unproven payees
    const payees = Array.from({ length: 6 }, (_, i) => privateKeyToAccount(`0x${(0xa0 + i).toString(16).padStart(64, '0')}`).address);
    let frozenAt = 0;
    for (let i = 0; i < payees.length; i++) {
      const r = await run(DEV.agent, payees[i]!, 100_000n);
      if (r.has('AgentFrozen')) {
        frozenAt = i + 1;
        break;
      }
    }
    add('T2: the 6th distinct unproven payee freezes the key on-chain', '6', String(frozenAt));
    add('the freezing (6th) payment was undone: that payee holds nothing', '0', String(await bal(payees[5]!)));
    add('isFrozen(agent) is true', 'true', String(await isFrozen(agent)));
    let sprayLoss = 0n;
    for (const p of payees) sprayLoss += await bal(p);
    metrics.sprayLossBaseUnits = sprayLoss.toString();
    add('spray loss <= the exploration cap (1 USDC)', 'true', String(sprayLoss <= 1_000_000n));

    // refused while frozen
    const rf = await run(DEV.agent, shop, 1_000_000n);
    add('a frozen key is refused in validation', 'rejected', rf.validated ? 'validated' : 'rejected');
    metrics.frozenRefusal = rf.reason ?? '';

    // watcher path: approval spam on agent2
    add('agent2 starts unfrozen', 'false', String(await isFrozen(agent2)));
    const t = await chainNow(anvil.rpcUrl);
    let alarmedAt = 0;
    for (let i = 0; i < 12; i++) {
      const raised = await svc.approvalRequest(account, agent2, t + i);
      if (raised.length && !alarmedAt) alarmedAt = i + 1;
    }
    add('watcher: the 7th approval request in an hour alarms (approval_rate)', '7', String(alarmedAt));
    add('watcher: the alarm sent a freeze tx; isFrozen(agent2) is true', 'true', String(await isFrozen(agent2)));
    metrics.watcherAlarms = svc.alarms.map((a) => a.alarm.detector).join(',');

    // escalate-only
    const watcherUnfreeze = await d.send(account, A, 'unfreeze', [agent2], DEV.watcher).then(() => 'unfroze', () => 'refused');
    add('the watcher cannot unfreeze', 'refused', watcherUnfreeze);
    const strangerFreeze = await d.send(account, A, 'freeze', [agent], DEV.attacker).then(() => 'froze', () => 'refused');
    add('a stranger cannot freeze', 'refused', strangerFreeze);

    // owner unfreeze: the agent works again, agent2 stays frozen
    await d.send(account, A, 'unfreeze', [agent], DEV.owner);
    add('owner unfreeze clears agent', 'false', String(await isFrozen(agent)));
    const again = await run(DEV.agent, shop, 1_000_000n);
    add('after the owner unfreezes, the agent key works again', 'validated/success', `${again.validated ? 'validated' : `rejected:${again.reason}`}/${again.success ? 'success' : 'reverted'}`);
    add('agent2 stays frozen until its own unfreeze', 'true', String(await isFrozen(agent2)));

    const allOk = checks.every((c) => c.pass);
    const out = { realAccount: true, chainId: anvil.chainId, ok: allOk, passed: checks.filter((c) => c.pass).length, total: checks.length, account, metrics, checks, generatedAt: new Date().toISOString() };
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', 'm10_freeze_e2e.json'), `${JSON.stringify(out, null, 2)}\n`);
    for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
    console.log(`freeze e2e (real account + watcher service): ${out.passed}/${out.total} ${allOk ? 'ok' : 'FAILED'} -> results/m10_freeze_e2e.json`);
    if (!allOk) process.exitCode = 1;
  } finally {
    anvil.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
