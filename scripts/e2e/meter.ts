/**
 * Effect metering end-to-end (D2) on the REAL AgentAccount: the leaked agent key fires straight at
 * the EntryPoint (no tools pre-check). The meter measures balance and allowance deltas around the one
 * call, debits per-tx / key / global buckets, and a breach is undone inside the execution sandbox.
 *   greedy         an allowed shop whose buy() pulls 10x through an owner-granted allowance: blocked, 0 moves
 *   once           approve-then-pull counts each unit once (allowance growth charged at approve)
 *   midnight       12 payments before and 12 after UTC midnight: window outflow <= the daily limit
 *   multi-key      3 session keys x 12 payments: the global bucket is shared, total <= the daily limit
 * The freeze tripwires are switched off here (setFreezeParam) so ONLY the meter and buckets bound the
 * agent; with them on, T1 freezes the key earlier (scripts/e2e/freeze.ts).
 *   pnpm exec tsx scripts/e2e/meter.ts  ->  results/m2_meter_e2e.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Hex, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEV, addr, chainNow, warp } from '../lib/anvil.ts';
import { BUILD_ROOT } from '../lib/stack.ts';
import { signAgentOp, submitOps } from '../lib/ops.ts';
import { CAP, checker, erc20, makeWorld, shopCalls, type World } from '../lib/world.ts';

const executeAbi = [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: 'dest', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'func', type: 'bytes' }], outputs: [] }] as const;
const DAILY_LIMIT = CAP + CAP; // burst + ratePerDay = 20 USDC per 24 h

async function main(): Promise<void> {
  const { checks, add } = checker();
  const metrics: Record<string, string | number | boolean> = {};
  const attacker = addr('attacker');

  const fire = async (w: World, key: Hex, target: `0x${string}`, data: Hex) => {
    const s = await signAgentOp(w.d, w.stack, w.chainId, { account: w.account, agentKey: key, target, data });
    const r = await submitOps(w.d, w.stack, [s.op], addr('relayer'), DEV.relayer);
    return !r.validated ? 'rejected' : r.has('PolicyBlocked') ? 'blocked' : r.success ? 'executed' : 'reverted';
  };

  // ---------------------------------------------------------------- greedy merchant + counted once
  {
    const w = await makeWorld({ greedy: true, noTripwires: true });
    try {
      const shop = w.api;
      // standing allowance the OWNER granted the shop (not paid for by the agent)
      await w.d.send(w.account, w.A, 'execute', [w.usdc, 0n, erc20.approve(w.greedy, 20_000_000n)], DEV.owner);
      const t0 = await w.usdcBalance(attacker);
      add('greedy merchant: buy() pulls 10x (20 USDC) through the owner-granted allowance: blocked', 'blocked', await fire(w, DEV.agent, w.greedy, shopCalls.greedyBuy()));
      add('greedy merchant: nothing reached the merchant treasury', '0', String((await w.usdcBalance(attacker)) - t0));
      void encodeFunctionData;
      void executeAbi;

      const w2 = await makeWorld({ noTripwires: true });
      try {
        const shop2 = w2.api;
        add('once: approve(grocery, 5 USDC) executes', 'executed', await fire(w2, DEV.agent, w2.usdc, erc20.approve(w2.grocery, 5_000_000n)));
        add('once: the shop pulls 5 USDC through that allowance (order) and executes', 'executed', await fire(w2, DEV.agent, w2.grocery, shopCalls.order(5_000_000n, w2.account)));
        add('once: a further 5 USDC payment still fits (the unit was counted once, 10 USDC total)', 'executed', await fire(w2, DEV.agent, w2.usdc, erc20.transfer(shop2, 5_000_000n)));
        add('once: one more unit is blocked (bucket empty)', 'blocked', await fire(w2, DEV.agent, w2.usdc, erc20.transfer(shop2, 1_000_000n)));
      } finally {
        w2.stop();
      }
      void shop;
    } finally {
      w.stop();
    }
  }

  // ---------------------------------------------------------------- midnight double spend
  {
    const w = await makeWorld({ noTripwires: true });
    try {
      const shop = w.api;
      const start = await chainNow(w.anvil.rpcUrl);
      const midnight = (Math.floor(start / 86400) + 1) * 86400;
      let wait = midnight - 60 - start;
      if (wait < 0) wait += 86400;
      await warp(w.anvil.rpcUrl, wait);
      const moved0 = await w.usdcBalance(shop);
      let before = 0;
      for (let i = 0; i < 12; i++) if ((await fire(w, DEV.agent, w.usdc, erc20.transfer(shop, 2_000_000n))) === 'executed') before++;
      await warp(w.anvil.rpcUrl, 120);
      let after = 0;
      for (let i = 0; i < 12; i++) if ((await fire(w, DEV.agent, w.usdc, erc20.transfer(shop, 2_000_000n))) === 'executed') after++;
      const moved = (await w.usdcBalance(shop)) - moved0;
      metrics.midnightExecutedBefore = before;
      metrics.midnightExecutedAfter = after;
      metrics.midnightWindowOutflow = moved.toString();
      add('midnight: window outflow across UTC midnight <= the daily limit (burst + 24 h refill)', 'true', String(moved <= DAILY_LIMIT));
      add('midnight: a calendar-day cap would have allowed 2x; here the second side moved at most one payment', 'true', String(after <= 1));
      add('midnight: the first side spent the burst (5 x 2 USDC)', '5', String(before));
    } finally {
      w.stop();
    }
  }

  // ---------------------------------------------------------------- multi-key cap
  {
    const w = await makeWorld({ extraAgents: [DEV.agent2, DEV.agent3], noTripwires: true });
    try {
      const shop = w.api;
      await warp(w.anvil.rpcUrl, 86_460);
      const moved0 = await w.usdcBalance(shop);
      const executed: number[] = [];
      for (const key of [DEV.agent, DEV.agent2, DEV.agent3]) {
        let n = 0;
        for (let i = 0; i < 12; i++) if ((await fire(w, key, w.usdc, erc20.transfer(shop, 2_000_000n))) === 'executed') n++;
        executed.push(n);
      }
      const moved = (await w.usdcBalance(shop)) - moved0;
      metrics.multiKeyExecuted = executed.join('/');
      metrics.multiKeyOutflow = moved.toString();
      add('multi-key: 3 keys x 12 payments move <= the daily limit in total (shared global bucket)', 'true', String(moved <= DAILY_LIMIT));
      add('multi-key: the 2nd and 3rd key got nothing more once the global bucket was spent', 'true', String(executed[1]! + executed[2]! <= 1));
      void privateKeyToAccount;
    } finally {
      w.stop();
    }
  }

  const ok = checks.every((c) => c.pass);
  const out = { realAccount: true, ok, dailyLimit: DAILY_LIMIT.toString(), passed: checks.filter((c) => c.pass).length, total: checks.length, metrics, checks, generatedAt: new Date().toISOString() };
  mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
  writeFileSync(join(BUILD_ROOT, 'results', 'm2_meter_e2e.json'), `${JSON.stringify(out, null, 2)}\n`);
  for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
  console.log(`meter e2e (real account): ${out.passed}/${out.total} ${ok ? 'ok' : 'FAILED'} -> results/m2_meter_e2e.json`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
