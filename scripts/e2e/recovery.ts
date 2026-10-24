/**
 * Guardian recovery end-to-end on the REAL AgentAccount (problem statement: "recover with 3 of 5
 * guardians after a 48-hour delay, with an owner veto"). Fresh anvil per case.
 *   A  owner key lost: 3 of 5 recover. 2 of 5 and the 48 h delay both bind; after the delay anyone
 *      executes; owner changes, agent keys revoked, attestation epoch bumped, funds untouched, old owner
 *      locked out, new owner acts, the executed proposal cannot be replayed.
 *   B  guardians collude but the owner is alive: veto inside the window; nothing can be executed later.
 *   C  misuse: the leaked agent key / a non-guardian cannot propose; a guardian cannot approve twice;
 *      2 of 5 never executes (a week later).
 *   pnpm exec tsx scripts/e2e/recovery.ts  ->  results/m11_recovery_e2e.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, encodeFunctionData, erc20Abi } from 'viem';
import { DEV, addr, chainNow, startAnvil, warp, type Role } from '../lib/anvil.ts';
import { BUILD_ROOT, Deployer, createAccount, deployStack, loadArtifact } from '../lib/stack.ts';
import { RULE_OP, TRANSFER, policyInput } from '../lib/policy.ts';
import { signAgentOp, submitOps } from '../lib/ops.ts';

const DELAY = 48 * 3600;

interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, expected: unknown, observed: unknown) => checks.push({ name, expected: String(expected), observed: String(observed), pass: String(expected) === String(observed) });
  const guardRoles: Role[] = ['guardian0', 'guardian1', 'guardian2', 'guardian3', 'guardian4'];

  async function world() {
    const anvil = await startAnvil();
    const d = new Deployer(anvil, DEV.owner);
    const stack = await deployStack(d);
    const A = stack.abi.account;
    const usdcArt = loadArtifact('MockUSDC3009', 'MockUSDC3009.sol');
    const usdc = await d.deploy(usdcArt);
    const usdcAbi = usdcArt.abi;
    const account = await createAccount(d, stack, addr('owner'), 0n);
    const now = await chainNow(anvil.rpcUrl);
    await d.send(usdc, usdcAbi, 'mint', [account, 50_000_000n]);
    await d.send(account, A, 'addDeposit', [], DEV.owner, 10n ** 18n);
    await d.send(account, A, 'setGlobalCap', [usdc, 10_000_000n, 10_000_000n]);
    await d.send(account, A, 'setRecipient', [addr('verifier'), true]);
    await d.send(account, A, 'setPolicy', [
      addr('agent'),
      policyInput({
        validAfter: now - 1,
        validUntil: now + 30 * 86400,
        assets: [{ asset: usdc, perTxCap: 10_000_000n, burst: 10_000_000n, ratePerDay: 10_000_000n }],
        calls: [{ target: usdc, selector: TRANSFER, rules: [{ argIndex: 0, op: RULE_OP.PAYEE }] }],
      }),
    ]);
    await d.send(account, A, 'setGuardians', [guardRoles.map((r) => addr(r)), 3]);
    const tx = (key: Hex, fn: string, args: unknown[] = []) => d.send(account, A, fn, args, key).then(() => true, () => false);
    const read = <T>(fn: string, args: unknown[] = []) => d.read<T>(account, A, fn, args);
    return { anvil, d, stack, A, usdc, usdcAbi, account, tx, read };
  }

  // ------------------------------------------------------------------ A: honest recovery
  {
    const w = await world();
    const newOwner = addr('agent3');
    try {
      const bal = () => w.d.read<bigint>(w.usdc, w.usdcAbi, 'balanceOf', [w.account]);
      const bal0 = await bal();
      const epoch0 = await w.read<bigint>('attestEpoch');
      const [gs, thr] = await w.read<[Address[], number]>('guardians');
      add('A. 5 guardians, threshold 3', '5/3', `${gs.length}/${thr}`);
      add('A. guardian proposes the new owner', true, await w.tx(DEV.guardian0, 'proposeRecovery', [newOwner]));
      add('A. second guardian approves', true, await w.tx(DEV.guardian1, 'approveRecovery', [1n]));
      add('A. execute with 2 of 5 fails', false, await w.tx(DEV.attacker, 'executeRecovery'));
      add('A. third guardian approves', true, await w.tx(DEV.guardian2, 'approveRecovery', [1n]));
      add('A. execute with quorum but inside the 48 h delay fails', false, await w.tx(DEV.attacker, 'executeRecovery'));
      await warp(w.anvil.rpcUrl, DELAY - 3600);
      add('A. execute 1 h before the delay ends fails', false, await w.tx(DEV.attacker, 'executeRecovery'));
      await warp(w.anvil.rpcUrl, 2 * 3600);
      add('A. execute after 48 h succeeds (anyone may call)', true, await w.tx(DEV.attacker, 'executeRecovery'));
      add('A. the owner is now the recovered owner', newOwner.toLowerCase(), String(await w.read<Address>('owner')).toLowerCase());
      const [, session] = await w.read<[bigint, { revoked: boolean }]>('sessionOf', [addr('agent')]);
      add('A. every agent session was revoked by recovery', true, session.revoked);
      add('A. attestation epoch bumped (old attestations die)', true, (await w.read<bigint>('attestEpoch')) > epoch0);
      add('A. recovery moved no funds', bal0, await bal());
      const s = await signAgentOp(w.d, w.stack, w.anvil.chainId, {
        account: w.account,
        agentKey: DEV.agent,
        target: w.usdc,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [addr('verifier'), 1_000_000n] }),
      });
      add('A. the old agent key is refused after recovery', 'rejected', (await submitOps(w.d, w.stack, [s.op], addr('relayer'), DEV.relayer)).validated ? 'validated' : 'rejected');
      add('A. the old owner is locked out', false, await w.tx(DEV.owner, 'setGlobalCap', [w.usdc, 1n, 1n]));
      add('A. the new owner can act', true, await w.tx(DEV.agent3, 'setGlobalCap', [w.usdc, 5_000_000n, 5_000_000n]));
      add('A. executing the same proposal again fails (no replay)', false, await w.tx(DEV.attacker, 'executeRecovery'));
    } finally {
      w.anvil.stop();
    }
  }

  // ------------------------------------------------------------------ B: owner veto
  {
    const w = await world();
    try {
      const owner0 = String(await w.read<Address>('owner')).toLowerCase();
      await w.tx(DEV.guardian0, 'proposeRecovery', [addr('attacker')]);
      await w.tx(DEV.guardian1, 'approveRecovery', [1n]);
      await w.tx(DEV.guardian2, 'approveRecovery', [1n]);
      await warp(w.anvil.rpcUrl, Math.floor(DELAY / 2));
      add('B. a non-owner cannot veto', false, await w.tx(DEV.attacker, 'vetoRecovery'));
      add('B. the owner vetoes inside the 48 h window', true, await w.tx(DEV.owner, 'vetoRecovery'));
      await warp(w.anvil.rpcUrl, DELAY);
      add('B. execute after the delay fails (vetoed)', false, await w.tx(DEV.attacker, 'executeRecovery'));
      add('B. the owner is unchanged', owner0, String(await w.read<Address>('owner')).toLowerCase());
      const [, session] = await w.read<[bigint, { revoked: boolean }]>('sessionOf', [addr('agent')]);
      add('B. the agent session is untouched', false, session.revoked);
    } finally {
      w.anvil.stop();
    }
  }

  // ------------------------------------------------------------------ C: misuse
  {
    const w = await world();
    try {
      const owner0 = String(await w.read<Address>('owner')).toLowerCase();
      add('C. the leaked agent key cannot propose', false, await w.tx(DEV.agent, 'proposeRecovery', [addr('attacker')]));
      add('C. a non-guardian cannot propose', false, await w.tx(DEV.attacker, 'proposeRecovery', [addr('attacker')]));
      await w.tx(DEV.guardian0, 'proposeRecovery', [addr('agent3')]);
      add('C. the proposer cannot approve twice', false, await w.tx(DEV.guardian0, 'approveRecovery', [1n]));
      await w.tx(DEV.guardian1, 'approveRecovery', [1n]);
      await warp(w.anvil.rpcUrl, 7 * 24 * 3600);
      add('C. 2 of 5 never executes, even a week later', false, await w.tx(DEV.attacker, 'executeRecovery'));
      add('C. the owner is unchanged', owner0, String(await w.read<Address>('owner')).toLowerCase());
    } finally {
      w.anvil.stop();
    }
  }

  const ok = checks.every((c) => c.pass);
  const out = { realAccount: true, ok, delaySeconds: DELAY, guardians: 5, threshold: 3, passed: checks.filter((c) => c.pass).length, total: checks.length, checks, generatedAt: new Date().toISOString() };
  mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
  writeFileSync(join(BUILD_ROOT, 'results', 'm11_recovery_e2e.json'), `${JSON.stringify(out, null, 2)}\n`);
  for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
  console.log(`recovery e2e (real account): ${out.passed}/${out.total} ${ok ? 'ok' : 'FAILED'} -> results/m11_recovery_e2e.json`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
