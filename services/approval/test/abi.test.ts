/**
 * Drift check: every function / event in the hand-written approval ABI exists with the same
 * signature in the forge artifacts of the real account (AgentAccount + AgentAccountAdmin merged at the
 * account address). Uses FORGE_OUT, else the newest contracts/out* dir whose AgentAccount has the
 * APPC ApprovalModule fill. Skipped if no artifact exists.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Abi } from 'viem';
import { approvalAccountAbi, entryPointHandleOpsAbi } from '../../../packages/shared/src/approval/index.ts';
import { BUILD_ROOT } from '../scripts/lib/devchain.ts';

function artifactDir(): string | null {
  const cdir = join(BUILD_ROOT, 'contracts');
  const cands = (process.env.FORGE_OUT ? [process.env.FORGE_OUT] : readdirSync(cdir).filter((d) => d.startsWith('out')).map((d) => join(cdir, d)))
    .map((d) => ({ d, f: join(d, 'AgentAccount.sol', 'AgentAccount.json') }))
    .filter((x) => existsSync(x.f) && existsSync(join(x.d, 'AgentAccountAdmin.sol', 'AgentAccountAdmin.json')))
    .filter((x) => process.env.FORGE_OUT || readFileSync(x.f, 'utf8').includes('ApprovedExecuted'))
    .sort((a, b) => statSync(b.f).mtimeMs - statSync(a.f).mtimeMs);
  return cands[0]?.d ?? null;
}

type P = { type: string; indexed?: boolean; components?: readonly P[] };
const ty = (p: P): string => (p.type.startsWith('tuple') ? `(${(p.components ?? []).map(ty).join(',')})${p.type.slice(5)}` : p.type);
/** canonical form: kind name(inputs[ indexed]) returns (outputs) mutability */
function sig(x: Abi[number]): string {
  const i = x as unknown as { type: string; name?: string; inputs?: P[]; outputs?: P[]; stateMutability?: string };
  const ins = (i.inputs ?? []).map((p) => `${ty(p)}${p.indexed ? ' indexed' : ''}`).join(',');
  const outs = i.type === 'function' ? ` returns (${(i.outputs ?? []).map(ty).join(',')}) ${i.stateMutability}` : '';
  return `${i.type} ${i.name}(${ins})${outs}`;
}
const formatAbiItem = sig;

const dir = artifactDir();
const load = (rel: string) => (JSON.parse(readFileSync(join(dir!, rel), 'utf8')) as { abi: Abi }).abi;

describe.skipIf(!dir)('approval ABI subset == forge artifacts', () => {
  it(`account functions and events exist with identical signatures (${dir})`, () => {
    const real = [...load('AgentAccount.sol/AgentAccount.json'), ...load('AgentAccountAdmin.sol/AgentAccountAdmin.json')];
    const sigs = new Set(real.filter((x) => x.type === 'function' || x.type === 'event').map((x) => formatAbiItem(x)));
    const missing = approvalAccountAbi
      .filter((x) => x.type === 'function' || x.type === 'event')
      .map((x) => formatAbiItem(x))
      .filter((s) => !sigs.has(s));
    expect(missing).toEqual([]);
  });

  it('EntryPoint handleOps / getNonce / events match the v0.8 artifact', () => {
    const p = join(dir!, 'EntryPoint.sol', 'EntryPoint.json');
    if (!existsSync(p)) return;
    const real = load('EntryPoint.sol/EntryPoint.json');
    const sigs = new Set(real.filter((x) => x.type !== 'constructor' && x.type !== 'fallback' && x.type !== 'receive').map((x) => formatAbiItem(x)));
    const mine = entryPointHandleOpsAbi.filter((x) => x.type === 'function' || x.type === 'event' || x.type === 'error').map((x) => formatAbiItem(x));
    expect(mine.filter((s) => !sigs.has(s))).toEqual([]);
  });
});
