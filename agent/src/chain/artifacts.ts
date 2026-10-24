/**
 * Forge artifacts for the harness. The harness builds into its own output dir
 * (FASTPLAN rule 5: `FOUNDRY_OUT=out-harn`), so it never races another lane's `out/`.
 * External libraries (if a module lane moves code into a linked library) are deployed and linked
 * generically from `linkReferences`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Abi, Hex } from 'viem';
import { CONTRACTS_DIR } from '../env.ts';

export interface LinkRef {
  start: number;
  length: number;
}
export interface Artifact {
  name: string;
  file: string;
  abi: Abi;
  bytecode: Hex;
  linkReferences: Record<string, Record<string, LinkRef[]>>;
}

/** The contracts the harness deploys: name -> source file (relative to the forge out dir). */
export const ARTIFACTS = {
  EntryPoint: 'EntryPoint.sol',
  AgentAccount: 'AgentAccount.sol',
  AgentAccountAdmin: 'AgentAccountAdmin.sol',
  AgentAccountFactory: 'AgentAccountFactory.sol',
  NaiveAccount: 'NaiveAccount.sol',
  MockUSDC3009: 'MockUSDC3009.sol',
  TicketNFT: 'TicketNFT.sol',
  GroceryMerchant: 'GroceryMerchant.sol',
  ApiSeller: 'ApiSeller.sol',
  GreedyMerchant: 'GreedyMerchant.sol',
} as const;
export type ArtifactName = keyof typeof ARTIFACTS;
/** Optional artifacts from W2 lanes (loaded when present). */
export const OPTIONAL_ARTIFACTS = {
  AgentPaymaster: 'AgentPaymaster.sol',
  PolicyLens: 'PolicyLens.sol',
} as const;

export function foundryExe(name: 'forge' | 'anvil' | 'cast'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const fromEnv = process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, exe) : undefined;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  const home = join(homedir(), '.foundry', 'bin', exe);
  if (existsSync(home)) return home;
  throw new Error(`${name} not found: install Foundry or set FOUNDRY_BIN`);
}

export function outDir(forgeOut: string): string {
  return join(CONTRACTS_DIR, forgeOut);
}

/** `forge build` into the harness out dir (skips when every artifact exists, unless `force`). */
export function ensureBuilt(forgeOut: string, force = false): void {
  const missing = Object.entries(ARTIFACTS).some(([n, f]) => !existsSync(join(outDir(forgeOut), f, `${n}.json`)));
  if (!force && !missing) return;
  const lane = forgeOut.replace(/^out-?/, '') || 'harn';
  const r = spawnSync(foundryExe('forge'), ['build'], {
    cwd: CONTRACTS_DIR,
    env: { ...process.env, FOUNDRY_OUT: forgeOut, FOUNDRY_CACHE_PATH: `cache-${lane}` },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`forge build failed (${forgeOut}):\n${(r.stderr || r.stdout).slice(-4000)}`);
}

export function loadArtifact(forgeOut: string, name: string, file: string): Artifact {
  const p = join(outDir(forgeOut), file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`artifact missing: ${p} (run forge build with FOUNDRY_OUT=${forgeOut})`);
  const j = JSON.parse(readFileSync(p, 'utf8')) as {
    abi: Abi;
    bytecode: { object: string; linkReferences?: Artifact['linkReferences'] };
  };
  const obj = j.bytecode.object.startsWith('0x') ? j.bytecode.object : `0x${j.bytecode.object}`;
  return { name, file, abi: j.abi, bytecode: obj as Hex, linkReferences: j.bytecode.linkReferences ?? {} };
}

export function tryLoadArtifact(forgeOut: string, name: string, file: string): Artifact | null {
  try {
    return loadArtifact(forgeOut, name, file);
  } catch {
    return null;
  }
}

export type Artifacts = Record<ArtifactName, Artifact>;
export function loadAll(forgeOut: string): Artifacts {
  const out = {} as Artifacts;
  for (const [n, f] of Object.entries(ARTIFACTS)) out[n as ArtifactName] = loadArtifact(forgeOut, n, f);
  return out;
}

/** Replace every link placeholder of `art` with the deployed library addresses (by library name). */
export function linkBytecode(art: Artifact, libs: Record<string, `0x${string}`>): Hex {
  let code = art.bytecode.slice(2);
  for (const [, byName] of Object.entries(art.linkReferences)) {
    for (const [lib, refs] of Object.entries(byName)) {
      const addr = libs[lib];
      if (!addr) throw new Error(`${art.name}: library ${lib} not deployed`);
      for (const r of refs) {
        const at = r.start * 2;
        code = code.slice(0, at) + addr.slice(2).toLowerCase() + code.slice(at + r.length * 2);
      }
    }
  }
  return `0x${code}` as Hex;
}

/** Library names `art` needs, with the source file each lives in. */
export function libraryDeps(art: Artifact): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const [path, byName] of Object.entries(art.linkReferences)) {
    const file = path.split('/').pop() ?? path;
    for (const name of Object.keys(byName)) out.push({ file, name });
  }
  return out;
}

/** Merged account ABI: core + admin (the admin runs through the account's fallback). */
export function mergedAbi(...abis: Abi[]): Abi {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const abi of abis)
    for (const item of abi) {
      const key = JSON.stringify([item.type, 'name' in item ? item.name : '', 'inputs' in item ? item.inputs : []]);
      if (item.type === 'constructor' || item.type === 'fallback' || item.type === 'receive') continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  return out as Abi;
}
