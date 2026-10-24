/**
 * `live.ts init | deploy | fund-keys`. init writes `.env.live` (throwaway testnet keys + the owner's
 * PUBLIC address); deploy puts the real stack on the chain from the forge artifacts with the libraries
 * linked; fund-keys sends gas money from the deployer to the service keys. The owner key is never
 * generated, read or stored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, formatEther, getAddress, isAddress, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { artifactsDir, createAccount, deployStack, loadArtifact } from '../../lib/stack.ts';
import { CHAINS, ENTRYPOINT_V08, chainByKey, txUrl } from './chains.ts';
import { makeDeployer, publicClient, sleep, usdcAbi } from './chainio.ts';
import { ENV_EXAMPLE, ENV_LIVE, ROOT, type Live, guardMainnet, readLive, renderEnv, updateEnv } from './envfile.ts';

export interface InitOptions {
  owner?: string;
  chain: string;
  rpc?: string;
  merchant?: string;
  salt?: string;
  force: boolean;
  allowMainnet: boolean;
  usdc?: string;
  log: (m: string) => void;
}

async function rpcChainId(rpc: string): Promise<number> {
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(8000) });
  return Number(BigInt(((await res.json()) as { result: string }).result));
}

export async function init(o: InitOptions): Promise<void> {
  const info = chainByKey(o.chain);
  if (info.mainnet && !o.allowMainnet) throw new Error(`${info.name} is a MAINNET: refused. Pass --allow-mainnet (the contracts are UNAUDITED; keep at most ~1 USDC in the account).`);
  if (o.owner && !isAddress(o.owner)) throw new Error('--owner must be your MetaMask ACCOUNT ADDRESS (0x…, 42 characters), never a private key or a seed phrase');
  if (o.owner && /^0x[0-9a-fA-F]{64}$/.test(o.owner)) throw new Error('that looks like a PRIVATE KEY. Stop: the owner key must stay in MetaMask. Pass the public address.');
  const log = o.log;

  if (existsSync(ENV_LIVE) && !o.force) {
    const L = readLive();
    if (o.owner) {
      updateEnv({ OWNER_ADDRESS: getAddress(o.owner) });
      log(`.env.live already exists: OWNER_ADDRESS updated to ${getAddress(o.owner)} (keys kept; pass --force to regenerate everything)`);
    } else log('.env.live already exists (keys kept). Pass --force to regenerate everything, or --owner 0x… to change the owner.');
    printFunding(readLive(), log);
    void L;
    return;
  }
  if (!o.owner) throw new Error('--owner 0x<your MetaMask address> is required for the first init');

  const rpc = o.rpc ?? info.rpc;
  const chainId = await rpcChainId(rpc).catch((e) => {
    throw new Error(`cannot reach ${rpc}: ${(e as Error).message}`);
  });
  if (chainId !== info.chainId) throw new Error(`${rpc} reports chain ${chainId}, expected ${info.chainId} (${info.name})`);

  const key = () => generatePrivateKey();
  const guardianKeys = Array.from({ length: 5 }, key);
  const merchant = o.merchant ? getAddress(o.merchant) : privateKeyToAccount(key()).address; // key discarded: a plain receiving address
  const usdc = o.usdc ? getAddress(o.usdc) : info.usdc;
  if (!usdc) throw new Error(`no USDC address known for ${info.key}: pass --usdc 0x…`);
  const values: Record<string, string> = {
    CHAIN: info.key,
    CHAIN_ID: String(info.chainId),
    RPC_URL: rpc,
    EXPLORER_URL: info.explorer,
    ENTRYPOINT: ENTRYPOINT_V08,
    USDC: usdc,
    OWNER_ADDRESS: getAddress(o.owner),
    DEPLOYER_KEY: key(),
    AGENT_KEY: key(),
    ATTESTOR_KEY: key(),
    WATCHER_KEY: key(),
    ATTACKER_KEY: key(),
    VERIFIER_KEY: key(),
    GUARDIAN_ADDRESSES: guardianKeys.map((k) => privateKeyToAccount(k).address).join(','),
    GUARDIAN_KEYS: guardianKeys.join(','),
    MERCHANT_ADDRESS: merchant,
    SALT: o.salt ?? '1',
  };
  writeFileSync(ENV_LIVE, renderEnv(readFileSync(ENV_EXAMPLE, 'utf8'), values));
  log(`wrote ${ENV_LIVE} (git-ignored; throwaway TESTNET keys; your owner key is NOT in it)`);

  const L = readLive();
  const pub = publicClient(L);
  const ep = await pub.getCode({ address: L.entryPoint });
  log(`EntryPoint v0.8 at ${L.entryPoint}: ${ep && ep !== '0x' ? 'present (real, canonical)' : 'ABSENT on this chain: `deploy` will deploy the official eth-infinitism EntryPoint v0.8 artifact'}`);
  const uc = await pub.getCode({ address: L.usdc });
  if (!uc || uc === '0x') log(`WARNING: no contract at USDC ${L.usdc} on this chain`);
  else {
    const auth = await pub.readContract({ address: L.usdc, abi: usdcAbi, functionName: 'authorizationState', args: [L.addr.deployer, `0x${'00'.repeat(32)}`] }).then(() => 'supports EIP-3009 (authorizationState answers)', () => 'does NOT answer authorizationState: the side-door attack cannot run');
    log(`USDC at ${L.usdc}: contract present, ${auth}`);
  }
  printFunding(L, log);
}

export function printFunding(L: Live, log: (m: string) => void): void {
  const info = CHAINS[L.chainKey]!;
  log('');
  log('NEXT: fund the deployer/relayer with a little test ETH (it pays for deploying and for every UserOp):');
  log(`  deployer / relayer   ${L.addr.deployer}   ~0.02 ETH`);
  for (const f of info.faucets.filter((x) => /ETH/.test(x.what))) log(`    ${f.what}: ${f.url}`);
  log(`  then run:  pnpm exec tsx scripts/live/live.ts deploy`);
  log('');
  log(`  owner (MetaMask)     ${L.owner}   needs ~0.01 test ETH for its own transactions`);
  log(`  agent account        ${L.account || '(known after deploy)'}   will hold the test USDC${info.faucets.some((f) => /USDC/.test(f.what)) ? `  (${info.faucets.find((f) => /USDC/.test(f.what))!.url})` : ''}`);
}

// ---------------------------------------------------------------- deploy

export interface DeployOptions {
  redeploy: boolean;
  allowMainnet: boolean;
  log: (m: string) => void;
}

export async function deploy(L: Live, o: DeployOptions): Promise<void> {
  guardMainnet(L, o.allowMainnet);
  const log = o.log;
  if (!L.owner) throw new Error('OWNER_ADDRESS is empty in .env.live: run `live.ts init --owner 0x…`');
  const pub = publicClient(L);
  const bal = await pub.getBalance({ address: L.addr.deployer });
  log(`deployer ${L.addr.deployer} holds ${formatEther(bal)} ETH`);
  if (L.factory && !o.redeploy) {
    log(`already deployed: factory ${L.factory} (pass --redeploy to deploy a new stack)`);
    await finish(L, log);
    return;
  }
  if (bal < parseEther('0.004') && L.chainId !== 31337) throw new Error(`the deployer needs ~0.01-0.02 ETH to deploy (it has ${formatEther(bal)}): fund ${L.addr.deployer}`);
  log(`artifacts: ${artifactsDir()}`);
  const d = makeDeployer(L);
  let entryPoint: Address | undefined;
  const code = await pub.getCode({ address: L.entryPoint });
  if (code && code !== '0x') entryPoint = L.entryPoint;
  else {
    log('EntryPoint v0.8 absent: deploying the official EntryPoint v0.8 artifact (eth-infinitism)');
    entryPoint = await d.deploy(loadArtifact('EntryPoint'));
    updateEnv({ ENTRYPOINT: entryPoint });
    log(`  EntryPoint deployed at ${entryPoint}`);
  }
  log('deploying libraries, AgentAccountAdmin, AgentAccount implementation, factory, PolicyLens (this takes a few minutes on a public RPC)...');
  const stack = await deployStack(d, { entryPoint, paymaster: false });
  const deployment = {
    chainId: L.chainId,
    chain: L.chainKey,
    deployer: L.addr.deployer,
    entryPoint: stack.entryPoint,
    entryPointDeployedByUs: !(code && code !== '0x'),
    libraries: stack.libs,
    admin: stack.admin,
    implementation: stack.implementation,
    factory: stack.factory,
    lens: stack.lens,
    artifacts: artifactsDir().replace(ROOT, '.').split('\\').join('/'),
    deployedAt: new Date().toISOString(),
  };
  mkdirSync(join(ROOT, 'deployments'), { recursive: true });
  writeFileSync(join(ROOT, 'deployments', `${L.chainId}.json`), `${JSON.stringify(deployment, null, 2)}\n`);
  updateEnv({ FACTORY: stack.factory, IMPLEMENTATION: stack.implementation, ADMIN: stack.admin, LENS: stack.lens });
  for (const [n, a] of Object.entries({ factory: stack.factory, implementation: stack.implementation, admin: stack.admin, lens: stack.lens, ...Object.fromEntries(Object.entries(stack.libs)) })) {
    log(`  ${n.padEnd(15)} ${a}${L.explorer ? `  ${L.explorer}/address/${a}` : ''}`);
  }
  log(`wrote deployments/${L.chainId}.json and the addresses into .env.live`);
  await finish(readLive(), log);
}

async function finish(L: Live, log: (m: string) => void): Promise<void> {
  const d = makeDeployer(L);
  const stack = (await import('./chainio.ts')).stackOf(L);
  const account = getAddress(await d.read<Address>(L.factory as Address, stack.abi.factory, 'getAddress', [L.owner as Address, L.salt]));
  if (account !== L.account) updateEnv({ ACCOUNT: account });
  log(`agent account (created by the OWNER in the console, step 1): ${account}${L.explorer ? `  ${L.explorer}/address/${account}` : ''}`);
  log('');
  log('NEXT:  pnpm exec tsx scripts/live/live.ts fund-keys     (gas money for the watcher and attestor keys)');
  log('       pnpm exec tsx scripts/live/live.ts console        (open the owner console and run steps 1-11 in MetaMask)');
  void createAccount;
}

// ---------------------------------------------------------------- fund-keys

export async function fundKeys(L: Live, o: { eth?: string; guardians: boolean; allowMainnet: boolean; log: (m: string) => void }): Promise<void> {
  guardMainnet(L, o.allowMainnet);
  const d = makeDeployer(L);
  const pub = publicClient(L);
  const targets: { name: string; to: Address; eth: bigint }[] = [
    { name: 'watcher (freeze txs)', to: L.addr.watcher, eth: parseEther(o.eth ?? '0.001') },
    { name: 'attestor (flag txs)', to: L.addr.attestor, eth: parseEther(o.eth ?? '0.001') },
  ];
  if (o.guardians) for (const [i, g] of L.guardianAddresses.entries()) targets.push({ name: `guardian ${i + 1}`, to: g, eth: parseEther('0.0005') });
  const w = (await import('./chainio.ts')).walletClient(L, L.deployerKey);
  for (const t of targets) {
    const have = await pub.getBalance({ address: t.to });
    if (have >= t.eth / 2n) {
      o.log(`  ${t.name}: already holds ${formatEther(have)} ETH`);
      continue;
    }
    const hash = await w.sendTransaction({ to: t.to, value: t.eth });
    await pub.waitForTransactionReceipt({ hash });
    o.log(`  ${t.name}: sent ${formatEther(t.eth)} ETH to ${t.to}  ${txUrl(L.explorer, hash)}`);
    await sleep(300);
  }
  void d;
}
