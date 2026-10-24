/**
 * Beat 00 (M0): the X2 ERC-1271 side door. Runs the local twin (MockUSDC3009) and, when BASE_RPC
 * answers, the Base fork test on real USDC; then prints both accounts' balances. If the RPC is down
 * the beat falls back to the local twin and says so (IDEA section 11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rpcReachable, runForge, type BeatContext, type BeatResult } from '../../lib/common.ts';

interface Side {
  contract: string;
  balanceBefore: number;
  balanceAfter: number;
  lostBaseUnits: number;
  isValidSignature: string;
}
interface X2 {
  chainMode: string;
  forkBlock: number;
  authValue: number;
  naive: Side;
  oneDoor: Side;
  userOps: number;
}

const usdc = (v: number) => (v / 1e6).toFixed(6);

function check(d: X2): boolean {
  return (
    d.naive.lostBaseUnits === d.authValue &&
    d.oneDoor.lostBaseUnits === 0 &&
    d.oneDoor.isValidSignature === '0xffffffff' &&
    d.userOps === 0
  );
}

function show(ctx: BeatContext, d: X2): void {
  const where = d.chainMode === 'fork' ? `Base fork @${d.forkBlock}, real USDC` : 'local, MockUSDC3009';
  ctx.log(`X2 side door (${where}): leaked agent key signs transferWithAuthorization(100 USDC -> attacker)`);
  for (const s of [d.naive, d.oneDoor]) {
    ctx.log(
      `  ${s.contract.padEnd(13)} balance ${usdc(s.balanceBefore)} -> ${usdc(s.balanceAfter)} USDC, ` +
        `lost ${usdc(s.lostBaseUnits)}, isValidSignature=${s.isValidSignature}`,
    );
  }
  ctx.log(`  UserOps executed: ${d.userOps}`);
}

export default async function run(ctx: BeatContext): Promise<BeatResult> {
  const read = (f: string) => JSON.parse(readFileSync(join(ctx.root, 'results', f), 'utf8')) as X2;

  const local = runForge(['test', '--match-path', 'test/spike/X2SideDoorLocal.t.sol']);
  if (local.status !== 0) return { ok: false, summary: 'local X2 test failed' };
  const dl = read('x2_spike_local.json');
  show(ctx, dl);

  const rpc = await rpcReachable(ctx.config.BASE_RPC);
  let forkNote = 'fork skipped: BASE_RPC unreachable, using local twin';
  let df: X2 | undefined;
  if (rpc.ok) {
    const fork = runForge(['test', '--match-path', 'test/fork/X2SideDoor.t.sol']);
    if (fork.status !== 0) return { ok: false, summary: 'fork X2 test failed' };
    df = read('x2_spike.json');
    show(ctx, df);
    forkNote = `fork @${df.forkBlock}`;
  } else {
    ctx.log(`${forkNote} (${rpc.error})`);
  }

  const ok = check(dl) && (df === undefined || check(df));
  const d = df ?? dl;
  return {
    ok,
    summary:
      `${forkNote}: naive lost ${usdc(d.naive.lostBaseUnits)} USDC with ${d.userOps} UserOps; ` +
      `one door lost ${usdc(d.oneDoor.lostBaseUnits)} (${d.oneDoor.isValidSignature})`,
    details: { local: dl, fork: df ?? null, forkSkipped: df === undefined },
  };
}
