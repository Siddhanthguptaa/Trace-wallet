/**
 * A `World` for the agent tools (agent/src/tools/engine.ts) on a REAL chain: the real EntryPoint, the
 * real USDC and the real deployed account, artifacts (ABIs) from contracts/out. Nothing here deploys or
 * mocks anything. Only the agent key (and the relayer key that pays gas) are present; any other role
 * (owner, attacker...) throws if touched, so a bug can never fall back to a fake key.
 */
import { type Address, type Chain, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import type { Abi, Hex } from 'viem';
import { loadArtifact } from '../../../agent/src/chain/artifacts.ts';
import { loadDemoPolicy } from '../../../agent/src/world/policy.ts';
import type { Wallet, World } from '../../../agent/src/world/deploy.ts';
import type { GatewayConfig } from './config.ts';

export interface Live {
  maxFeeWei?: bigint;
  world: World;
  wallet: Wallet;
  accountAbi: Abi;
  lensAbi: Abi | null;
  pub: ReturnType<typeof createPublicClient>;
}

export function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  return defineChain({ id: chainId, name: `Chain ${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
}

function guarded<T extends object>(known: T, what: string): T {
  return new Proxy(known, {
    get(t, p) {
      if (typeof p === 'string' && !(p in t)) throw new Error(`gateway has no ${what} for role "${p}" (only the agent and relayer are configured)`);
      return (t as Record<string | symbol, unknown>)[p];
    },
  });
}

export function buildLive(cfg: GatewayConfig): Live {
  const chain = chainFor(cfg.chainId, cfg.rpcUrl);
  const transport = http(cfg.rpcUrl, { retryCount: 3, retryDelay: 400 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 1000 });
  const walletClients = new Map<string, ReturnType<typeof createWalletClient>>();
  const c = {
    rpcUrl: cfg.rpcUrl,
    chain,
    pub,
    wallet: (pk: Hex) => {
      let w = walletClients.get(pk);
      if (!w) {
        w = createWalletClient({ account: privateKeyToAccount(pk), chain, transport });
        walletClients.set(pk, w);
      }
      return w;
    },
  };
  const ep = loadArtifact(cfg.forgeOut, 'EntryPoint', 'EntryPoint.sol');
  const acct = loadArtifact(cfg.forgeOut, 'AgentAccount', 'AgentAccount.sol');
  const admin = loadArtifact(cfg.forgeOut, 'AgentAccountAdmin', 'AgentAccountAdmin.sol');
  const seen = new Set<string>();
  const accountAbi = [...acct.abi, ...admin.abi].filter((i) => {
    if (i.type === 'constructor' || i.type === 'fallback' || i.type === 'receive') return false;
    const k = JSON.stringify([i.type, 'name' in i ? i.name : '', 'inputs' in i ? i.inputs : []]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }) as Abi;
  let lensAbi: Abi | null = null;
  if (cfg.lens) {
    try {
      lensAbi = loadArtifact(cfg.forgeOut, 'PolicyLens', 'PolicyLens.sol').abi;
    } catch {
      lensAbi = null;
    }
  }
  const agentAddress = privateKeyToAccount(cfg.agentKey).address;
  const relayerAddress = privateKeyToAccount(cfg.relayerKey).address;
  const zero = '0x0000000000000000000000000000000000000000' as Address;
  const policy = loadDemoPolicy();
  const world = {
    env: {} as World['env'],
    anvil: { rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, proc: null, stop: () => {} },
    c,
    chainId: cfg.chainId,
    arts: { EntryPoint: ep } as unknown as World['arts'],
    keys: guarded({ agent: cfg.agentKey, relayer: cfg.relayerKey }, 'key') as World['keys'],
    addrOf: guarded({ agent: agentAddress, relayer: relayerAddress }, 'address') as World['addrOf'],
    policy,
    labels: {},
    accountAbi,
    ep: cfg.entryPoint,
    factory: zero,
    usdc: cfg.usdc,
    ticket: zero,
    grocery: zero,
    api: zero,
    paymasterArt: null,
    lens: cfg.lens ?? null,
    lensAbi,
    libs: {},
  } as unknown as World;
  const wallet = {
    id: 'LIVE',
    config: { id: 'R4', kind: 'agent' } as unknown as Wallet['config'],
    kind: 'agent',
    address: cfg.wallet,
    agentKey: cfg.agentKey,
    agentAddress,
    extraAgentKeys: [],
    deployedAt: 0,
  } as Wallet;
  return { world, wallet, accountAbi, lensAbi, pub: pub as unknown as Live['pub'], maxFeeWei: cfg.maxFeeWei };
}

/** Live fee: clears the current gas price (x3 headroom) but never exceeds the session's own maxFeePerGas cap. */
export async function refreshGas(live: Live): Promise<void> {
  try {
    const gp = await live.pub.getGasPrice();
    const [, session] = (await live.pub.readContract({
      address: live.wallet.address,
      abi: live.accountAbi,
      functionName: 'sessionOf',
      args: [live.wallet.agentAddress],
    })) as [bigint, { gas: { maxFeePerGas: bigint } }];
    const cap = session.gas.maxFeePerGas;
    let fee = gp * 3n > 10_000_000n ? gp * 3n : 10_000_000n;
    if (cap > 0n && fee > cap) fee = cap;
    if (live.maxFeeWei && fee > live.maxFeeWei) fee = live.maxFeeWei;
    live.world.policy.opGas.maxFeePerGas = fee;
    live.world.policy.opGas.maxPriorityFeePerGas = fee;
  } catch {
    /* keep the defaults */
  }
}
