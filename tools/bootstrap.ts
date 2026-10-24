/**
 * Second half of `pnpm run bootstrap` (after `pnpm install`): make sure the pinned Foundry deps are in
 * contracts/lib (vendored with --no-git, no submodules), then `forge build`.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CONTRACTS, foundryBin, loadEnv } from './lib/common.ts';

const DEPS: [dir: string, spec: string][] = [
  ['forge-std', 'foundry-rs/forge-std@v1.17.0'],
  ['openzeppelin-contracts', 'OpenZeppelin/openzeppelin-contracts@v5.1.0'],
  ['account-abstraction', 'eth-infinitism/account-abstraction@v0.8.0'],
];

loadEnv();
const forge = foundryBin('forge');
for (const [dir, spec] of DEPS) {
  if (existsSync(join(CONTRACTS, 'lib', dir))) continue;
  console.log(`[bootstrap] forge install --no-git ${spec}`);
  const r = spawnSync(forge, ['install', '--no-git', spec], { cwd: CONTRACTS, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('[bootstrap] forge build');
const b = spawnSync(forge, ['build'], { cwd: CONTRACTS, stdio: 'inherit' });
process.exit(b.status ?? 1);
