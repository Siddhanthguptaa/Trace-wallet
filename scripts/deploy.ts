/**
 * Deploy the Hypnexis agent-wallet stack with viem (no forge needed at deploy time, only the built
 * artifacts in contracts/out): the four external libraries are deployed first and linked into the
 * AgentAccount implementation bytecode, then AgentAccountAdmin, the implementation, the factory,
 * PolicyLens and optionally AgentPaymaster. Writes deployments/<chainId>.json.
 *
 *   RPC_URL=... DEPLOYER_KEY=0x... [ENTRYPOINT=0x...] [PAYMASTER_OWNER=0x...] pnpm exec tsx scripts/deploy.ts
 *   pnpm exec tsx scripts/deploy.ts --anvil     self-contained: starts anvil, deploys with a dev key,
 *                                               smoke-tests createAccount + a policy read, writes
 *                                               results/deploy_ts_anvil.json (nothing in deployments/)
 *
 * Mainnets (Base 8453, Ethereum 1, OP 10, Arbitrum 42161, Polygon 137) are refused unless
 * --allow-mainnet is passed: a mainnet deployment is the user's decision, never a script default.
 * The EntryPoint is the canonical v0.8 (0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108) when ENTRYPOINT is
 * unset and the chain already has code there; otherwise a fresh one is deployed (local chains only).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, createPublicClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEV, addr, startAnvil } from './lib/anvil.ts';
import { BUILD_ROOT, Deployer, artifactsDir, chainOf, createAccount, deployStack } from './lib/stack.ts';

const CANONICAL_EP: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const MAINNETS = new Set([1, 10, 137, 8453, 42161]);

export interface DeployResult {
  chainId: number;
  deployer: Address;
  entryPoint: Address;
  entryPointDeployed: boolean;
  libraries: Record<string, Address>;
  admin: Address;
  implementation: Address;
  factory: Address;
  lens: Address;
  paymaster: Address | null;
  artifacts: string;
  deployedAt: string;
}

export async function deployAll(o: { rpcUrl: string; chainId: number; key: Hex; entryPoint?: Address; paymasterOwner?: Address }): Promise<DeployResult> {
  const d = new Deployer({ rpcUrl: o.rpcUrl, chainId: o.chainId }, o.key);
  const pub = createPublicClient({ chain: chainOf({ rpcUrl: o.rpcUrl, chainId: o.chainId }), transport: http(o.rpcUrl) });
  let entryPoint = o.entryPoint;
  if (!entryPoint) {
    const code = await pub.getCode({ address: CANONICAL_EP });
    if (code && code !== '0x') entryPoint = CANONICAL_EP;
  }
  const stack = await deployStack(d, {
    entryPoint,
    paymaster: o.paymasterOwner
      ? { owner: o.paymasterOwner, caps: { maxFeePerGas: 2_000_000_000n, callGasLimit: 500_000, verificationGasLimit: 300_000, preVerificationGas: 100_000, paymasterVerificationGasLimit: 100_000, paymasterPostOpGasLimit: 100_000 } }
      : false,
  });
  return {
    chainId: o.chainId,
    deployer: privateKeyToAccount(o.key).address,
    entryPoint: stack.entryPoint,
    entryPointDeployed: !entryPoint,
    libraries: stack.libs,
    admin: stack.admin,
    implementation: stack.implementation,
    factory: stack.factory,
    lens: stack.lens,
    paymaster: stack.paymaster,
    artifacts: artifactsDir().replace(BUILD_ROOT, '.').split('\\').join('/'),
    deployedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--anvil')) {
    const anvil = await startAnvil();
    try {
      const r = await deployAll({ rpcUrl: anvil.rpcUrl, chainId: anvil.chainId, key: DEV.owner, paymasterOwner: addr('owner') });
      // smoke: a clone from the factory is wired to the implementation's libraries and answers the policy views
      const d = new Deployer(anvil, DEV.owner);
      const { loadArtifact, accountAbi } = await import('./lib/stack.ts');
      const stack = { factory: r.factory, abi: { factory: loadArtifact('AgentAccountFactory').abi, account: accountAbi() } } as never as Parameters<typeof createAccount>[1];
      const acct = await createAccount(d, stack, addr('owner'), 7n);
      const owner = await d.read<Address>(acct, accountAbi(), 'owner');
      const lensOk = await d.read<unknown>(r.lens, loadArtifact('PolicyLens').abi, 'checkPolicy', [acct, addr('agent'), '0x', '0x']).then(() => true, () => false);
      const out = { ...r, smoke: { account: acct, ownerIsDeployerKey: getAddress(owner) === addr('owner'), lensAnswers: lensOk, librariesLinked: Object.keys(r.libraries).sort() } };
      mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
      writeFileSync(join(BUILD_ROOT, 'results', 'deploy_ts_anvil.json'), `${JSON.stringify(out, null, 2)}\n`);
      const ok = out.smoke.ownerIsDeployerKey && out.smoke.lensAnswers && out.smoke.librariesLinked.join() === 'ApprovalLib,FreezeTripwires,MeterLib,OneDoorLib';
      console.log(`deploy --anvil: ${ok ? 'ok' : 'FAILED'}: factory ${r.factory}, libraries ${out.smoke.librariesLinked.join(', ')} -> results/deploy_ts_anvil.json`);
      if (!ok) process.exitCode = 1;
    } finally {
      anvil.stop();
    }
    return;
  }
  const rpcUrl = process.env.RPC_URL;
  const key = process.env.DEPLOYER_KEY as Hex | undefined;
  if (!rpcUrl || !key) throw new Error('set RPC_URL and DEPLOYER_KEY (or use --anvil)');
  const chainId = Number((await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })).json() as { result: string }).result);
  if (MAINNETS.has(chainId) && !argv.includes('--allow-mainnet')) throw new Error(`chain ${chainId} is a mainnet: pass --allow-mainnet to deploy there (your decision, funds at risk)`);
  const r = await deployAll({ rpcUrl, chainId, key, entryPoint: process.env.ENTRYPOINT as Address | undefined, paymasterOwner: process.env.PAYMASTER_OWNER as Address | undefined });
  mkdirSync(join(BUILD_ROOT, 'deployments'), { recursive: true });
  const file = join(BUILD_ROOT, 'deployments', `${chainId}.json`);
  writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  console.log(`deployed on chain ${chainId}: factory ${r.factory} -> deployments/${chainId}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
