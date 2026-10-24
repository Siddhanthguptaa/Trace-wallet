/**
 * Recovery success path (EXPERIMENTS X6 / problem statement "recover with 3 of 5 guardians after a
 * 48-hour delay, with an owner veto"). H7 shows takeover attempts failing; this shows the honest
 * flow working on the integrated account, end to end on a fresh anvil chain, and writes
 * results/x6_recovery.json. Three cases:
 *
 *   A  owner key lost: 3 of 5 guardians recover. Early execution fails; after 48 h anyone executes;
 *      the owner changes, every agent key is revoked, the attestation epoch moves, funds do not move,
 *      the old owner is locked out, the new owner can install a fresh agent key.
 *   B  owner alive and disagrees: guardians reach quorum, the owner vetoes inside the window; the
 *      owner is unchanged and the proposal cannot be executed later.
 *   C  misuse: 2 of 5 never executes (even a week later); a guardian cannot approve twice; an
 *      executed proposal cannot be replayed; the leaked agent key cannot propose.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { erc20Abi, type Address, type Hex } from 'viem';
import { deployBase, deployWallet, send, type World, type Wallet } from '../src/world/deploy.ts';
import { devchain } from '../src/chain/anvil.ts';
import { harnessEnv, RESULTS_DIR } from '../src/env.ts';

const DELAY = 48 * 3600;

interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}

async function fresh(): Promise<{ w: World; wallet: Wallet }> {
  const w = await deployBase({ env: harnessEnv() });
  const wallet = await deployWallet(w, 'X6');
  return { w, wallet };
}

function helpers(w: World, wallet: Wallet) {
  const acct = wallet.address;
  const tx = async (pk: Hex, fn: string, args: unknown[] = []): Promise<boolean> => {
    try {
      await send(w, pk, acct, w.accountAbi, fn, args);
      return true;
    } catch {
      return false;
    }
  };
  const read = <T>(fn: string, args: unknown[] = []) => w.c.pub.readContract({ address: acct, abi: w.accountAbi, functionName: fn, args }) as Promise<T>;
  const usdc = () => w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [acct] }) as Promise<bigint>;
  const revoked = async (key: Address) => (await read<[bigint, { revoked: boolean }]>('sessionOf', [key]))[1].revoked;
  return { acct, tx, read, usdc, revoked };
}

export async function runRecoveryFlow(): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const add = (name: string, expected: unknown, observed: unknown) => checks.push({ name, expected: String(expected), observed: String(observed), pass: String(expected) === String(observed) });
  const warp = (w: World, s: number) => devchain.warp(w.c.rpcUrl, s);

  // ------------------------------------------------------------------ A: honest recovery
  {
    const { w, wallet } = await fresh();
    const h = helpers(w, wallet);
    const g = [w.keys.guardian0, w.keys.guardian1, w.keys.guardian2, w.keys.guardian3, w.keys.guardian4];
    const newOwner = w.addrOf.agent3;
    const bal0 = await h.usdc();
    const epoch0 = await h.read<bigint>('attestEpoch');
    try {
      add('A.guardians configured 5 / threshold 3', '5/3', await h.read<[Address[], number]>('guardians').then(([a, t]) => `${a.length}/${t}`));
      add('A.guardian proposes', true, await h.tx(g[0]!, 'proposeRecovery', [newOwner]));
      add('A.second approval', true, await h.tx(g[1]!, 'approveRecovery', [1n]));
      add('A.execute with 2 of 5 fails', false, await h.tx(w.keys.attacker, 'executeRecovery'));
      add('A.third approval', true, await h.tx(g[2]!, 'approveRecovery', [1n]));
      add('A.execute with quorum but inside the 48 h delay fails', false, await h.tx(w.keys.attacker, 'executeRecovery'));
      await warp(w, DELAY - 3600);
      add('A.execute 1 h before the delay ends fails', false, await h.tx(w.keys.attacker, 'executeRecovery'));
      await warp(w, 2 * 3600);
      add('A.execute after 48 h succeeds (anyone may call)', true, await h.tx(w.keys.attacker, 'executeRecovery'));
      add('A.owner is the new owner', newOwner.toLowerCase(), (await h.read<Address>('owner')).toLowerCase());
      add('A.agent key revoked by recovery', true, await h.revoked(wallet.agentAddress));
      add('A.attestation epoch bumped', true, (await h.read<bigint>('attestEpoch')) > epoch0);
      add('A.funds did not move', bal0.toString(), (await h.usdc()).toString());
      add('A.old owner is locked out (setGlobalCap reverts)', false, await h.tx(w.keys.owner, 'setGlobalCap', [w.usdc, 1n, 1n]));
      add('A.new owner can act (setGlobalCap)', true, await h.tx(w.keys.agent3, 'setGlobalCap', [w.usdc, 5_000_000n, 5_000_000n]));
      add('A.replay: executing the same proposal again fails', false, await h.tx(w.keys.attacker, 'executeRecovery'));
    } finally {
      w.anvil.stop();
    }
  }

  // ------------------------------------------------------------------ B: owner veto
  {
    const { w, wallet } = await fresh();
    const h = helpers(w, wallet);
    const g = [w.keys.guardian0, w.keys.guardian1, w.keys.guardian2];
    try {
      const owner0 = (await h.read<Address>('owner')).toLowerCase();
      await h.tx(g[0]!, 'proposeRecovery', [w.addrOf.attacker]);
      await h.tx(g[1]!, 'approveRecovery', [1n]);
      await h.tx(g[2]!, 'approveRecovery', [1n]);
      await warp(w, Math.floor(DELAY / 2));
      add('B.owner vetoes inside the window', true, await h.tx(w.keys.owner, 'vetoRecovery'));
      await warp(w, DELAY);
      add('B.execute after the delay fails (vetoed)', false, await h.tx(w.keys.attacker, 'executeRecovery'));
      add('B.owner unchanged', owner0, (await h.read<Address>('owner')).toLowerCase());
      add('B.agent key untouched', false, await h.revoked(wallet.agentAddress));
      add('B.non-owner cannot veto', false, await h.tx(w.keys.attacker, 'vetoRecovery'));
    } finally {
      w.anvil.stop();
    }
  }

  // ------------------------------------------------------------------ C: misuse
  {
    const { w, wallet } = await fresh();
    const h = helpers(w, wallet);
    try {
      const owner0 = (await h.read<Address>('owner')).toLowerCase();
      add('C.leaked agent key cannot propose', false, await h.tx(wallet.agentKey, 'proposeRecovery', [w.addrOf.attacker]));
      add('C.non-guardian cannot propose', false, await h.tx(w.keys.attacker, 'proposeRecovery', [w.addrOf.attacker]));
      await h.tx(w.keys.guardian0, 'proposeRecovery', [w.addrOf.agent3]);
      add('C.same guardian cannot approve twice', false, await h.tx(w.keys.guardian0, 'approveRecovery', [1n]));
      await h.tx(w.keys.guardian1, 'approveRecovery', [1n]);
      await warp(w, 7 * 24 * 3600);
      add('C.2 of 5 never executes, even a week later', false, await h.tx(w.keys.attacker, 'executeRecovery'));
      add('C.owner unchanged', owner0, (await h.read<Address>('owner')).toLowerCase());
    } finally {
      w.anvil.stop();
    }
  }

  return { checks, ok: checks.every((c) => c.pass) };
}

if (process.argv[1]?.endsWith('recoveryFlow.ts')) {
  runRecoveryFlow()
    .then((r) => {
      const out = join(RESULTS_DIR, 'x6_recovery.json');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify({ meta: { delaySeconds: DELAY, guardians: 5, threshold: 3, generatedAt: new Date().toISOString() }, ok: r.ok, passed: r.checks.filter((c) => c.pass).length, total: r.checks.length, checks: r.checks }, null, 2)}\n`);
      for (const c of r.checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
      console.log(`x6 recovery flow: ${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks ${r.ok ? 'ok' : 'FAILED'} -> ${out}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
