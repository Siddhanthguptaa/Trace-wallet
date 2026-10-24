/**
 * On anvil, against the real AgentAccount bytecode (forge artifacts, FreezeTripwires linked):
 *  - the freeze sender lands freeze(agentKey) through the watcher role, is idempotent, and has no
 *    unfreeze path; a stranger's freeze and the watcher's unfreeze revert on-chain;
 *  - the chain source decodes the AgentFrozen / AgentUnfrozen events;
 *  - WatcherService end to end: approval-request spam -> alarm -> freeze tx -> isFrozen.
 * Artifacts: $WATCHER_ARTIFACTS, else contracts/out-frz, else contracts/out (run forge build first).
 * anvil runs with --disable-code-size-limit: EIP-170 is checked by `forge build --sizes`, not here.
 * Skips (with a note) if anvil or the artifacts are missing.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Abi, type Address, type Hex, createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainSource, chainFor, viemReader, viemWriter } from '../src/chain.ts';
import { FreezeSender } from '../src/freezer.ts';
import { WatcherService } from '../src/service.ts';

const BUILD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// anvil's public dev keys (test only)
const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  watcher: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  stranger: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
} as const satisfies Record<string, Hex>;
const AGENT = getAddress('0x00000000000000000000000000000000000a6e47');
const AGENT2 = getAddress('0x00000000000000000000000000000000000a6e48');
const EP = getAddress('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');

function findAnvil(): string | null {
  if (spawnSync('anvil', ['--version']).status === 0) return 'anvil';
  for (const p of [join(homedir(), '.foundry', 'bin', 'anvil.exe'), join(homedir(), '.foundry', 'bin', 'anvil')]) {
    if (existsSync(p)) return p;
  }
  return null;
}

interface Art {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>> };
}

function artifactsDir(): string | null {
  const cands = [process.env.WATCHER_ARTIFACTS, join(BUILD_ROOT, 'contracts', 'out-int'), join(BUILD_ROOT, 'contracts', 'out'), join(BUILD_ROOT, 'contracts', 'out-frz')];
  for (const d of cands) {
    if (!d) continue;
    const acct = join(d, 'AgentAccount.sol', 'AgentAccount.json');
    if (!existsSync(acct) || !existsSync(join(d, 'FreezeModule.sol', 'FreezeTripwires.json'))) continue;
    const a = JSON.parse(readFileSync(acct, 'utf8')) as Art;
    if (JSON.stringify(a.bytecode.linkReferences).includes('FreezeTripwires')) return d;
  }
  return null;
}

const load = (dir: string, file: string, name: string) => JSON.parse(readFileSync(join(dir, file, `${name}.json`), 'utf8')) as Art;

function link(bytecode: Hex, refs: Art['bytecode']['linkReferences'], libs: Record<string, Address>): Hex {
  let hex = bytecode.slice(2);
  for (const file of Object.values(refs)) {
    for (const [name, sites] of Object.entries(file)) {
      const addr = libs[name];
      if (!addr) throw new Error(`no address for library ${name}`);
      for (const { start, length } of sites) {
        hex = hex.slice(0, start * 2) + addr.slice(2).toLowerCase() + hex.slice((start + length) * 2);
      }
    }
  }
  return `0x${hex}`;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

const anvil = findAnvil();
const dir = artifactsDir();
if (!anvil || !dir) console.log(`# anvil e2e skipped: ${!anvil ? 'anvil not found' : 'no linked forge artifacts (run forge build)'}`);

describe('anvil: watcher role against the real AgentAccount', { skip: !anvil || !dir, timeout: 120_000 }, () => {
  let proc: ChildProcess;
  let rpc: string;
  let account: Address;
  let adminAbi: Abi;
  const chain = () => chainFor(31337, rpc);
  const pub = () => createPublicClient({ chain: chain(), transport: http(rpc), pollingInterval: 50 });
  const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: chain(), transport: http(rpc) });
  const watcherAddr = privateKeyToAccount(KEYS.watcher).address;

  const libAddrs: Record<string, Address> = {};
  /** Deploy every external library `art` links against (FreezeTripwires and any other lane's). */
  async function deployLibs(art: Art): Promise<Record<string, Address>> {
    for (const [file, libs] of Object.entries(art.bytecode.linkReferences)) {
      for (const name of Object.keys(libs)) {
        if (libAddrs[name]) continue;
        const libArt = load(dir!, file.split('/').pop()!, name);
        libAddrs[name] = await deploy(libArt, []);
      }
    }
    return libAddrs;
  }

  async function deploy(art: Art, args: unknown[]): Promise<Address> {
    const libs = await deployLibs(art);
    const hash = await wallet(KEYS.owner).deployContract({
      abi: art.abi,
      bytecode: link(art.bytecode.object, art.bytecode.linkReferences, libs),
      args,
    } as never);
    const r = await pub().waitForTransactionReceipt({ hash });
    assert.equal(r.status, 'success');
    return r.contractAddress as Address;
  }

  async function send(k: Hex, address: Address, functionName: string, args: unknown[]) {
    const hash = await wallet(k).writeContract({ address, abi: adminAbi, functionName, args } as never);
    return pub().waitForTransactionReceipt({ hash });
  }

  const isFrozen = (key: Address) =>
    pub().readContract({ address: account, abi: adminAbi, functionName: 'isFrozen', args: [key] }) as Promise<boolean>;

  before(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    proc = spawn(anvil!, ['--port', String(port), '--chain-id', '31337', '--disable-code-size-limit', '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await pub().getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // The factory refuses an implementation whose EntryPoint has no code: etch a fresh v0.8
    // EntryPoint at the canonical address on this plain (non-fork) anvil.
    const epCode = await pub().getCode({ address: EP });
    if (!epCode || epCode === '0x') {
      const tmp = await deploy(load(dir!, 'EntryPoint.sol', 'EntryPoint'), []);
      const runtime = await pub().getCode({ address: tmp });
      await pub().request({ method: 'anvil_setCode', params: [EP, runtime as Hex] } as never);
    }
    const adminArt = load(dir!, 'AgentAccountAdmin.sol', 'AgentAccountAdmin');
    adminAbi = adminArt.abi;
    const adminLogic = await deploy(adminArt, [EP]);
    const impl = await deploy(load(dir!, 'AgentAccount.sol', 'AgentAccount'), [EP, adminLogic]);
    assert.ok(libAddrs.FreezeTripwires, 'AgentAccount links FreezeTripwires');
    const factoryArt = load(dir!, 'AgentAccountFactory.sol', 'AgentAccountFactory');
    const factory = await deploy(factoryArt, [impl]);
    const owner = privateKeyToAccount(KEYS.owner).address;
    const h = await wallet(KEYS.owner).writeContract({ address: factory, abi: factoryArt.abi, functionName: 'createAccount', args: [owner, 0n] } as never);
    await pub().waitForTransactionReceipt({ hash: h });
    account = (await pub().readContract({ address: factory, abi: factoryArt.abi, functionName: 'getAddress', args: [owner, 0n] })) as Address;
    assert.equal((await send(KEYS.owner, account, 'setWatcher', [watcherAddr])).status, 'success');
  });

  after(() => {
    proc?.kill();
  });

  it('freeze lands through the watcher role, idempotently; the source sees AgentFrozen', async () => {
    const client = pub();
    const source = new ChainSource({ client, accounts: [account], entryPoint: EP, fromBlock: 0n });
    const freezer = new FreezeSender({ writer: viemWriter(client, chain(), rpc, KEYS.watcher), reader: viemReader(client), watcher: watcherAddr });
    assert.equal(await isFrozen(AGENT), false);
    const r = await freezer.ensureFrozen(account, AGENT, 'test');
    assert.equal(r.status, 'sent');
    assert.equal(await isFrozen(AGENT), true);
    assert.equal((await freezer.ensureFrozen(account, AGENT, 'again')).status, 'already');
    // A real poller keeps polling: accumulate (polls are incremental) until the event shows up. A single
    // immediate poll was flaky under machine load (anvil log visibility vs the receipt).
    const evs: Awaited<ReturnType<typeof source.poll>>[number]['event'][] = [];
    for (let i = 0; i < 25 && !evs.some((e) => e.kind === 'frozen'); i++) {
      if (i) await new Promise((r) => setTimeout(r, 200));
      evs.push(...(await source.poll()).map((d) => d.event));
    }
    const fr = evs.find((e) => e.kind === 'frozen');
    assert.ok(fr && fr.kind === 'frozen' && fr.agentKey === AGENT && fr.by === watcherAddr, `events seen: ${JSON.stringify(evs)}; head ${await pub().getBlockNumber({ cacheTime: 0 })}`);
  });

  it('escalate-only on-chain: stranger cannot freeze, watcher cannot unfreeze; the owner can', async () => {
    const client = pub();
    const stranger = new FreezeSender({ writer: viemWriter(client, chain(), rpc, KEYS.stranger), reader: null, watcher: watcherAddr });
    const r = await stranger.ensureFrozen(account, AGENT2, 'x');
    assert.equal(r.status, 'error', 'freeze from a non-watcher reverts (NotOwner)');
    assert.equal(await isFrozen(AGENT2), false);
    await assert.rejects(send(KEYS.watcher, account, 'unfreeze', [AGENT]));
    assert.equal(await isFrozen(AGENT), true);
    const source = new ChainSource({ client, accounts: [account], entryPoint: EP });
    await source.poll(); // move to the head
    assert.equal((await send(KEYS.owner, account, 'unfreeze', [AGENT])).status, 'success');
    assert.equal(await isFrozen(AGENT), false);
    const evs = (await source.poll()).map((d) => d.event);
    assert.ok(evs.some((e) => e.kind === 'unfrozen' && e.agentKey === AGENT));
  });

  it('WatcherService: approval spam -> alarm -> freeze tx on the real account', async () => {
    const client = pub();
    const reader = viemReader(client);
    const freezer = new FreezeSender({ writer: viemWriter(client, chain(), rpc, KEYS.watcher), reader, watcher: watcherAddr });
    const source = new ChainSource({ client, accounts: [account], entryPoint: EP });
    const svc = new WatcherService({ accounts: [account], freezer, reader, source });
    await svc.tick();
    const t0 = 1_800_000_000;
    for (let i = 0; i < 6; i++) assert.equal((await svc.approvalRequest(account, AGENT2, t0 + i)).length, 0);
    const raised = await svc.approvalRequest(account, AGENT2, t0 + 6);
    assert.equal(raised[0]?.alarm.detector, 'approval_rate');
    assert.equal(raised[0]?.freeze?.status, 'sent');
    assert.equal(await isFrozen(AGENT2), true);
    await svc.tick(); // the AgentFrozen log comes back from the chain
    assert.equal(svc.watcherOf(account).isFrozen(AGENT2), true);
  });
});
