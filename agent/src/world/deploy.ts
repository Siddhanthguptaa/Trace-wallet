/**
 * Local world for the harness: EntryPoint v0.8, the account factory (admin -> implementation ->
 * factory, docs/api.md 2.1), the demo shops, then one wallet per config (R1-R4, X6) on demand.
 * Mirrors contracts/test/unit/M1_Fixture.sol (same policy, funding and deploy order).
 */
import {
  type Abi,
  type Address,
  type Hex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  maxUint256,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  type Artifact,
  type Artifacts,
  ensureBuilt,
  libraryDeps,
  linkBytecode,
  loadAll,
  loadArtifact,
  mergedAbi,
  tryLoadArtifact,
  OPTIONAL_ARTIFACTS,
} from '../chain/artifacts.ts';
import { type Anvil, type Clients, clients, devchain, startAnvil } from '../chain/anvil.ts';
import { type Keys, allKeys, harnessEnv, type HarnessEnv } from '../env.ts';
import {
  type DemoPolicy,
  type Labels,
  type RuleInput,
  type WalletConfig,
  SIG1271,
  labelAddress,
  loadDemoPolicy,
  loadFreezeThresholds,
  loadFixture,
  loadWalletConfig,
  policyInput,
  r2Config,
} from './policy.ts';

export interface World {
  env: HarnessEnv;
  anvil: Anvil;
  c: Clients;
  chainId: number;
  arts: Artifacts;
  keys: Keys;
  addrOf: Record<keyof Keys, Address>;
  policy: DemoPolicy;
  labels: Labels;
  accountAbi: Abi;
  ep: Address;
  factory: Address;
  usdc: Address;
  ticket: Address;
  grocery: Address;
  api: Address;
  paymasterArt: Artifact | null;
  /** PolicyLens (docs/api.md checkPolicy): the time- and bucket-aware pre-check the tools call. */
  lens: Address | null;
  lensAbi: Abi | null;
  libs: Record<string, Address>;
}

export async function send(
  w: Pick<World, 'c'>,
  pk: Hex,
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  value = 0n,
): Promise<Hex> {
  const wallet = w.c.wallet(pk);
  const data = encodeFunctionData({ abi, functionName, args });
  const hash = await wallet.sendTransaction({ to, data, value, gas: 15_000_000n });
  const r = await w.c.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
  return hash;
}

async function deployRaw(w: Pick<World, 'c' | 'env' | 'libs'>, pk: Hex, art: Artifact, args: readonly unknown[]): Promise<Address> {
  for (const dep of libraryDeps(art)) {
    if (w.libs[dep.name]) continue;
    const libArt = loadArtifact(w.env.forgeOut, dep.name, dep.file);
    w.libs[dep.name] = await deployRaw(w, pk, libArt, []);
  }
  const bytecode = Object.keys(art.linkReferences).length ? linkBytecode(art, w.libs) : art.bytecode;
  const wallet = w.c.wallet(pk);
  const hash = await wallet.deployContract({ abi: art.abi, bytecode, args, gas: 29_000_000n });
  const r = await w.c.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${art.name} failed`);
  return getAddress(r.contractAddress);
}

export async function deploy(w: World, art: Artifact, args: readonly unknown[] = [], pk: Hex = w.keys.owner): Promise<Address> {
  return deployRaw(w, pk, art, args);
}

export interface WorldOptions {
  env?: HarnessEnv;
  build?: boolean;
  anvil?: Anvil;
}

/** Start anvil (unless given), build artifacts if missing, deploy EntryPoint, factory and shops. */
export async function deployBase(o: WorldOptions = {}): Promise<World> {
  const env = o.env ?? harnessEnv();
  if (o.build !== false) ensureBuilt(env.forgeOut);
  const arts = loadAll(env.forgeOut);
  const anvil = o.anvil ?? (await startAnvil({ genesisTs: env.genesisTs }));
  const c = clients(anvil.rpcUrl, anvil.chainId);
  const keys = allKeys();
  const addrOf = Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, privateKeyToAccount(k).address])) as World['addrOf'];
  const policy = loadDemoPolicy();
  const partial = { env, c, libs: {} as Record<string, Address> };
  const ownerPk = keys.owner;
  const ep = await deployRaw(partial, ownerPk, arts.EntryPoint, []);
  const adminLogic = await deployRaw(partial, ownerPk, arts.AgentAccountAdmin, [ep]);
  const impl = await deployRaw(partial, ownerPk, arts.AgentAccount, [ep, adminLogic]);
  const factory = await deployRaw(partial, ownerPk, arts.AgentAccountFactory, [impl]);
  const usdc = await deployRaw(partial, ownerPk, arts.MockUSDC3009, []);
  const ticket = await deployRaw(partial, ownerPk, arts.TicketNFT, [usdc, policy.shops.ticketPrice, labelAddress('hypnexis.treasury.TicketShop')]);
  const grocery = await deployRaw(partial, ownerPk, arts.GroceryMerchant, [usdc, labelAddress('hypnexis.treasury.GroceryShop')]);
  const api = await deployRaw(partial, ownerPk, arts.ApiSeller, [usdc, policy.shops.apiPrice, labelAddress('hypnexis.owner.ApiSeller')]);
  const lensArt = tryLoadArtifact(env.forgeOut, 'PolicyLens', OPTIONAL_ARTIFACTS.PolicyLens);
  const lens = lensArt ? await deployRaw(partial, ownerPk, lensArt, []) : null;
  const legit = loadFixture<{ payees: Record<string, { address: Address }> }>('legit_stream.json');
  const deck = loadFixture<{ attackerLabels: Record<string, string> }>('deck_params.json');
  const labels: Labels = {
    USDC: usdc,
    TicketShop: ticket,
    GroceryShop: grocery,
    ApiSeller: api,
    EntryPoint: ep,
    attacker: addrOf.attacker,
    ColludingShop: labelAddress(deck.attackerLabels.ColludingShop!),
    ProvenPayee: labelAddress(deck.attackerLabels.ProvenPayee!),
  };
  for (const [name, p] of Object.entries(legit.payees)) labels[name] = getAddress(p.address);
  return {
    env,
    anvil,
    c,
    chainId: anvil.chainId,
    arts,
    keys,
    addrOf,
    policy,
    labels,
    accountAbi: mergedAbi(arts.AgentAccount.abi, arts.AgentAccountAdmin.abi),
    ep,
    factory,
    usdc,
    ticket,
    grocery,
    api,
    paymasterArt: tryLoadArtifact(env.forgeOut, 'AgentPaymaster', OPTIONAL_ARTIFACTS.AgentPaymaster),
    lens,
    lensAbi: lensArt?.abi ?? null,
    libs: partial.libs,
  };
}

export type WalletKind = 'eoa' | 'naive' | 'agent';

export interface Wallet {
  id: string;
  config: WalletConfig;
  kind: WalletKind;
  /** Where the funds sit (EOA for R1, the contract wallet otherwise). */
  address: Address;
  agentKey: Hex;
  agentAddress: Address;
  extraAgentKeys: Hex[];
  deployedAt: number;
}

export interface WalletSetup {
  /** Extra (target, selector) entries: AgentAccount rule entries (R3/R4) and R2 allowlist pairs. */
  extraRules?: RuleInput[];
  extraRecipients?: Address[];
  extraSpenders?: Address[];
  /** More session keys with the same demo policy (R3/R4 only). */
  extraAgentKeys?: Hex[];
  /** Standing allowances set by the owner before the agent runs. */
  ownerApprovals?: { spender: Address; amount: bigint }[];
  salt?: bigint;
  /** Override the 1271 mode (default: the config's). */
  sig1271Mode?: keyof typeof SIG1271;
}

export async function deployWallet(w: World, configId: string, s: WalletSetup = {}): Promise<Wallet> {
  const config = loadWalletConfig(configId);
  const p = w.policy;
  const now = await devchain.now(w.c.rpcUrl);
  const agentAddress = w.addrOf.agent;
  const base = { id: config.id, config, kind: config.kind, agentKey: w.keys.agent, agentAddress, extraAgentKeys: s.extraAgentKeys ?? [], deployedAt: now };
  const owner = w.keys.owner;
  const mint = (to: Address, amt: bigint) => send(w, owner, w.usdc, w.arts.MockUSDC3009.abi, 'mint', [to, amt]);
  if (config.kind === 'eoa') {
    await devchain.setBalance(w.c.rpcUrl, agentAddress, p.funding.eth);
    await mint(agentAddress, p.funding.usdc);
    for (const a of s.ownerApprovals ?? []) await send(w, w.keys.agent, w.usdc, erc20Abi, 'approve', [a.spender, a.amount]);
    return { ...base, address: agentAddress };
  }
  if (config.kind === 'naive') {
    const naive = await deploy(w, w.arts.NaiveAccount, [w.addrOf.owner, agentAddress]);
    const cfg = r2Config(p, w.labels, (s.extraRules ?? []).map((r) => ({ target: r.target, selector: r.selector })), s.extraRecipients ?? []);
    await send(w, owner, naive, w.arts.NaiveAccount.abi, 'configure', [w.ep, cfg]);
    await mint(naive, p.funding.usdc);
    await devchain.setBalance(w.c.rpcUrl, naive, p.funding.eth);
    await send(w, owner, naive, w.arts.NaiveAccount.abi, 'addDeposit', [], p.funding.deposit);
    for (const a of s.ownerApprovals ?? [])
      await send(w, owner, naive, w.arts.NaiveAccount.abi, 'execute', [w.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.spender, a.amount] })]);
    return { ...base, address: naive };
  }
  // AgentAccount (R3 / R4 / X6)
  // Distinct default salts so several configs can live on one chain (CREATE2 binds owner + salt).
  const salt = s.salt ?? ({ R3: 3n, R4: 4n, X6: 6n } as Record<string, bigint>)[config.id] ?? 0n;
  await send(w, owner, w.factory, w.arts.AgentAccountFactory.abi, 'createAccount', [w.addrOf.owner, salt]);
  const acct = (await w.c.pub.readContract({ address: w.factory, abi: w.arts.AgentAccountFactory.abi, functionName: 'getAddress', args: [w.addrOf.owner, salt] })) as Address;
  const A = w.accountAbi;
  const o = (fn: string, args: readonly unknown[], value = 0n) => send(w, owner, acct, A, fn, args, value);
  await o('setGlobalCap', [w.usdc, p.globalCap.burst, p.globalCap.ratePerDay]);
  for (const r of [...p.recipients.map((x) => w.labels[x]!), ...(s.extraRecipients ?? [])]) await o('setRecipient', [r, true]);
  await o('setTrackedSpenders', [[...p.trackedSpenders.map((x) => w.labels[x]!), ...(s.extraSpenders ?? [])]]);
  await o('setTrackedNFTs', [p.trackedNFTs.map((x) => w.labels[x]!)]);
  if (config.exploration === false) {
    await o('setExploreCap', [w.usdc, 0n, 0n]);
    await o('setExplorePerTxCap', [w.usdc, 0n]);
  } else {
    await o('setExploreCap', [w.usdc, p.exploreCap.burst, p.exploreCap.ratePerDay]);
    await o('setExplorePerTxCap', [w.usdc, p.explorePerTxCap]);
  }
  if (config.attestor) await o('setAttestor', [w.addrOf.attestor]);
  const mode = s.sig1271Mode ?? config.sig1271Mode ?? p.sig1271Mode;
  if (SIG1271[mode] !== 0) await o('setSig1271Mode', [SIG1271[mode]]);
  const pol = policyInput(p, w.labels, now, s.extraRules ?? []);
  await o('setPolicy', [agentAddress, pol]);
  for (const k of s.extraAgentKeys ?? []) await o('setPolicy', [privateKeyToAccount(k).address, pol]);
  // Freeze tripwire thresholds pinned on dev seeds (hijack/thresholds.json): the same for every AgentAccount config.
  const ft = loadFreezeThresholds().onchain;
  for (const [name, value] of [['velocityBps', ft.velocityBps], ['sprayMax', ft.sprayMax], ['strikeMax', ft.strikeMax]] as const) {
    await o('setFreezeParam', [keccak256(toBytes(`hypnexis.freeze.${name}`)), BigInt(value)]);
  }
  if (config.watcher) await o('setWatcher', [w.addrOf.watcher]);
  if (config.guardians) {
    const g = [w.addrOf.guardian0, w.addrOf.guardian1, w.addrOf.guardian2, w.addrOf.guardian3, w.addrOf.guardian4].slice(0, config.guardians.count);
    await o('setGuardians', [g, config.guardians.threshold]);
  }
  await mint(acct, p.funding.usdc);
  await devchain.setBalance(w.c.rpcUrl, acct, p.funding.eth);
  await o('addDeposit', [], p.funding.deposit);
  for (const a of s.ownerApprovals ?? [])
    await o('execute', [w.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.spender, a.amount] })]);
  return { ...base, address: acct };
}

export const MAX_UINT = maxUint256;

export async function usdcBalance(w: World, who: Address): Promise<bigint> {
  return w.c.pub.readContract({ address: w.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}
