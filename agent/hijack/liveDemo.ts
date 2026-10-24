/**
 * Live hijack demo (beat 59). A fresh anvil chain, a funded wallet, and the agent's private key handed
 * to an attacker (a throwaway local dev key: nothing real is exposed). The attacker then submits ops
 * straight to the bundler, no tools, and a running counter shows what reaches the attacker against the
 * daily limit:
 *
 *   Phase 1  all defences on. Attack A: drain through an unproven payee. Owner unfreezes.
 *            Attack B: the attestor key leaked too, so the attacker payee reads as PROVEN: drain as fast
 *            as possible.
 *   Phase 2  every detector OFF (caps only). Attack B again. The loss is still bounded by the caps.
 *
 * Writes results/demo_hijack_live.json; ok only if the attacker's gain never exceeds the daily limit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRun, step } from './harness.ts';
import { forgeAttestation } from './scenarios/index.ts';
import { erc20 as erc20enc } from '../src/ops/encode.ts';
import { send } from '../src/world/deploy.ts';
import { RESULTS_DIR } from '../src/env.ts';
import type { DetectorMode } from './types.ts';

const fmt = (x: bigint | string) => (Number(BigInt(x)) / 1e6).toFixed(2);
const lines: string[] = [];
const say = (m: string) => {
  lines.push(m);
  console.log(m);
};

interface Phase {
  name: string;
  mode: DetectorMode;
  gainBaseUnits: string;
  frozenAtOp: number | null;
  ops: number;
}

async function attack(label: string, mode: DetectorMode, kind: 'unproven' | 'forged', seed: number, reuse?: Awaited<ReturnType<typeof buildRun>>) {
  const run = reuse ?? (await buildRun(seed, { mode }));
  const { ctx } = run;
  const w = ctx.world;
  const att = kind === 'forged' ? await forgeAttestation(ctx, w.addrOf.attacker) : undefined;
  const cap = w.policy.explorePerTxCap;
  const n = kind === 'unproven' ? 30 : 14;
  let frozenAt: number | null = null;
  let last = '0';
  say(`  ${label}`);
  for (let i = 1; i <= n; i++) {
    const amount = kind === 'unproven' ? cap : BigInt(2 + Math.floor(ctx.rng() * 9)) * 1_000_000n;
    const op = await step(ctx, `${label}#${i}`, w.usdc, 0n, erc20enc.transfer(w.addrOf.attacker, amount), att ? { attestation: att } : {});
    const gained = BigInt(op.cumulativeLossBaseUnits);
    const moved = gained !== BigInt(last);
    say(`    op ${String(i).padStart(2)}: tries ${fmt(amount)} USDC -> ${moved ? 'PAID' : 'refused / undone'}; attacker holds ${fmt(gained)} USDC${op.frozenAfter && frozenAt === null ? '   <-- KEY FROZEN' : ''}`);
    last = op.cumulativeLossBaseUnits;
    if (op.frozenAfter && frozenAt === null) {
      frozenAt = i;
      if (mode !== 'none') break;
    }
  }
  return { run, gain: BigInt(last), frozenAt, ops: n };
}

async function main() {
  const phases: Phase[] = [];
  const dailyLimit = 20_000_000n;
  let ok = true;

  say('PHASE 1: all defences on. The agent key is LEAKED to an attacker.');
  const run1 = await buildRun(7, { mode: 'combined' });
  const w = run1.world;
  say(`  leaked agent key (throwaway dev key): ${run1.ctx.wallet.agentKey}`);
  say(`  wallet balance: 100.00 USDC, daily limit: ${fmt(dailyLimit)} USDC, exploration budget for unknown payees: 1.00 USDC`);
  try {
    const a = await attack('Attack A: drain through an unproven payee', 'combined', 'unproven', 7, run1);
    say(`  -> attacker gained ${fmt(a.gain)} USDC (exploration budget 1.00), key frozen at op ${a.frozenAt ?? 'never'}`);
    phases.push({ name: 'A unproven drain', mode: 'combined', gainBaseUnits: a.gain.toString(), frozenAtOp: a.frozenAt, ops: a.ops });
    ok &&= a.gain <= 1_000_000n && a.frozenAt !== null;

    await send(w, w.keys.owner, run1.ctx.wallet.address, w.accountAbi, 'unfreeze', [run1.ctx.wallet.agentAddress]);
    say('  owner reviews and unfreezes the key (only the owner can; the watcher can only freeze)');

    const before = a.gain;
    const b = await attack('Attack B: the attestor key leaked too, attacker payee forged PROVEN, drain as fast as possible', 'combined', 'forged', 8, run1);
    const gainB = b.gain - before;
    say(`  -> attacker gained ${fmt(gainB)} USDC more (total ${fmt(b.gain)} USDC), daily limit ${fmt(dailyLimit)} USDC, key frozen at op ${b.frozenAt ?? 'never'}`);
    phases.push({ name: 'B forged-PROVEN drain', mode: 'combined', gainBaseUnits: gainB.toString(), frozenAtOp: b.frozenAt, ops: b.ops });
    ok &&= b.gain <= dailyLimit;
  } finally {
    run1.stop();
  }

  say('PHASE 2: every detector OFF, only the caps. Attack B again.');
  const run2 = await buildRun(9, { mode: 'none' });
  try {
    const b2 = await attack('Attack B with no detector', 'none', 'forged', 9, run2);
    say(`  -> attacker gained ${fmt(b2.gain)} USDC of the wallet's 100.00 USDC. The caps alone hold it under the ${fmt(dailyLimit)} USDC daily limit.`);
    phases.push({ name: 'B forged-PROVEN drain, no detector', mode: 'none', gainBaseUnits: b2.gain.toString(), frozenAtOp: b2.frozenAt, ops: b2.ops });
    ok &&= b2.gain <= dailyLimit && b2.gain < 100_000_000n;
  } finally {
    run2.stop();
  }

  say(ok ? 'RESULT: loss stayed inside the stated bounds in every phase.' : 'RESULT: A BOUND WAS EXCEEDED.');
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, 'demo_hijack_live.json'), `${JSON.stringify({ ok, dailyLimitBaseUnits: dailyLimit.toString(), explorationCapBaseUnits: '1000000', phases, lines }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
