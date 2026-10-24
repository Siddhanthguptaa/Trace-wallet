/**
 * Chain access for the watcher: read the account's events and send `freeze(agentKey)` from the watcher key.
 *
 * Account ABI names follow docs/api.md (CORE) sections 2.3 and 7.2 and FreezeAdmin (FRZ, M10):
 * freeze(address) (owner or watcher; escalate-only), isFrozen(address), watcher(), globalBucket(asset).
 * The watcher ABI deliberately has no unfreeze: the role is escalate-only on-chain and in code.
 */
import {
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { WatcherEvent } from './detectors.ts';

export const ACCOUNT_EVENTS_ABI = parseAbi([
  'event Decision(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, address payee, uint8 tier, uint8 track, (address asset, uint256 amount)[] outflows)',
  'event PolicyBlocked(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, bytes reason)',
  'event AgentFrozen(address indexed agentKey, address indexed by, bytes32 userOpHash)',
  'event AgentUnfrozen(address indexed agentKey)',
]);

export const ACCOUNT_ABI = parseAbi([
  'function freeze(address agentKey)',
  'function isFrozen(address agentKey) view returns (bool)',
  'function watcher() view returns (address)',
  'function globalBucket(address asset) view returns ((uint128 burst, uint128 ratePerDay, uint128 level, uint48 lastRefill))',
]);

export const USER_OPERATION_EVENT = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);
export const ENTRYPOINT_EVENTS_ABI = [USER_OPERATION_EVENT] as const;

/** Track.APPROVAL in lib/PolicyTypes.sol: owner-approved ops are not agent spend anomalies. */
export const TRACK_APPROVAL = 2;

/**
 * The agent key of an agent op from its EntryPoint nonce: nonce = key(192) << 64 | seq, and an agent
 * session's nonce key is uint160(agentKey) << 32 | salt << 8 | lane (AgentAccountAdmin._newNonceKey).
 * Owner ops use nonce key 0, so they map to null.
 */
export function agentKeyFromNonce(nonce: bigint): Address | null {
  const a = (nonce >> 96n) & ((1n << 160n) - 1n);
  return a === 0n ? null : getAddress(`0x${a.toString(16).padStart(40, '0')}`);
}

export interface DecodedEvent {
  account: Address;
  event: WatcherEvent;
}

/**
 * Turn raw logs (account events + EntryPoint UserOperationEvent) into watcher events.
 * Outcome rule (docs/api.md 3.2): Decision = ok, PolicyBlocked = failure (the EntryPoint still says
 * success = true), UserOperationEvent success = false = failure (a reverting target; no Decision).
 * Decision outflows become spend events, except on Track.APPROVAL (owner-signed outflow).
 */
export function decodeLogs(
  logs: Log[],
  accounts: Address[],
  entryPoint: Address | null,
  tsOf: (blockNumber: bigint) => number,
): DecodedEvent[] {
  const accSet = new Set(accounts.map((a) => a.toLowerCase()));
  const out: DecodedEvent[] = [];
  for (const log of logs) {
    const emitter = log.address.toLowerCase();
    const ts = tsOf(log.blockNumber ?? 0n);
    if (accSet.has(emitter)) {
      let d;
      try {
        d = decodeEventLog({ abi: ACCOUNT_EVENTS_ABI, data: log.data, topics: log.topics });
      } catch {
        continue; // another account event
      }
      const account = getAddress(log.address);
      if (d.eventName === 'Decision') {
        const { agentKey, track, outflows } = d.args;
        out.push({ account, event: { kind: 'outcome', agentKey, ok: true, ts } });
        if (track !== TRACK_APPROVAL) {
          for (const o of outflows) {
            if (o.amount > 0n) out.push({ account, event: { kind: 'spend', agentKey, asset: o.asset, amount: o.amount, ts } });
          }
        }
      } else if (d.eventName === 'PolicyBlocked') {
        out.push({ account, event: { kind: 'outcome', agentKey: d.args.agentKey, ok: false, ts, why: `blocked ${d.args.reason.slice(0, 10)}` } });
      } else if (d.eventName === 'AgentFrozen') {
        out.push({ account, event: { kind: 'frozen', agentKey: d.args.agentKey, ts, by: d.args.by } });
      } else if (d.eventName === 'AgentUnfrozen') {
        out.push({ account, event: { kind: 'unfrozen', agentKey: d.args.agentKey, ts } });
      }
    } else if (entryPoint && emitter === entryPoint.toLowerCase()) {
      let d;
      try {
        d = decodeEventLog({ abi: ENTRYPOINT_EVENTS_ABI, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (d.eventName !== 'UserOperationEvent' || d.args.success) continue;
      if (!accSet.has(d.args.sender.toLowerCase())) continue;
      const agentKey = agentKeyFromNonce(d.args.nonce);
      if (!agentKey) continue; // owner op
      out.push({ account: getAddress(d.args.sender), event: { kind: 'outcome', agentKey, ok: false, ts, why: 'reverted' } });
    }
  }
  return out;
}

export interface AccountReader {
  isFrozen(account: Address, agentKey: Address): Promise<boolean>;
  watcher(account: Address): Promise<Address>;
  /** burst + ratePerDay of the asset's global bucket (0 = no cap). */
  globalCap(account: Address, asset: Address): Promise<bigint>;
}

export interface FreezeWriter {
  /** sends freeze(agentKey) on `account` from the watcher key and waits for a successful receipt. */
  freeze(account: Address, agentKey: Address): Promise<Hex>;
}

export function chainFor(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function viemReader(client: PublicClient): AccountReader {
  return {
    isFrozen: (account, agentKey) =>
      client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: 'isFrozen', args: [agentKey] }),
    watcher: (account) => client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: 'watcher' }),
    globalCap: async (account, asset) => {
      const b = await client.readContract({ address: account, abi: ACCOUNT_ABI, functionName: 'globalBucket', args: [asset] });
      return b.burst + b.ratePerDay;
    },
  };
}

export function viemWriter(client: PublicClient, chain: Chain, rpcUrl: string, watcherKey: Hex): FreezeWriter {
  const account = privateKeyToAccount(watcherKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  return {
    async freeze(target, agentKey) {
      const { request } = await client.simulateContract({
        account,
        address: target,
        abi: ACCOUNT_ABI,
        functionName: 'freeze',
        args: [agentKey],
      });
      const hash = await wallet.writeContract(request);
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`freeze tx ${hash} reverted`);
      return hash;
    },
  };
}

export function publicClientFor(chainId: number, rpcUrl: string, pollingInterval = 1000): PublicClient {
  return createPublicClient({ chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl), pollingInterval });
}

/**
 * Polls account events and the EntryPoint's failed UserOperationEvents from `fromBlock` on.
 * Each poll covers (last polled block, latest], in chunks of `maxRange` blocks.
 */
export class ChainSource {
  private next: bigint | null;
  private readonly client: PublicClient;
  private readonly accounts: Address[];
  private readonly entryPoint: Address | null;
  private readonly maxRange: bigint;
  private readonly blockTs = new Map<bigint, number>();

  constructor(opts: {
    client: PublicClient;
    accounts: Address[];
    entryPoint?: Address | null;
    fromBlock?: bigint;
    maxRange?: bigint;
  }) {
    this.client = opts.client;
    this.accounts = opts.accounts;
    this.entryPoint = opts.entryPoint ?? null;
    this.next = opts.fromBlock ?? null;
    this.maxRange = opts.maxRange ?? 2000n;
  }

  async poll(): Promise<DecodedEvent[]> {
    const latest = await this.client.getBlockNumber();
    let next: bigint = this.next ?? latest; // default: start at the head
    const out: DecodedEvent[] = [];
    while (next <= latest) {
      const from: bigint = next;
      const to: bigint = from + this.maxRange - 1n < latest ? from + this.maxRange - 1n : latest;
      const logs: Log[] = [];
      logs.push(...((await this.client.getLogs({ address: this.accounts, fromBlock: from, toBlock: to })) as Log[]));
      if (this.entryPoint) {
        logs.push(
          ...((await this.client.getLogs({
            address: this.entryPoint,
            event: USER_OPERATION_EVENT,
            args: { sender: this.accounts },
            fromBlock: from,
            toBlock: to,
          })) as unknown as Log[]),
        );
      }
      logs.sort((a, b) =>
        a.blockNumber === b.blockNumber ? (a.logIndex ?? 0) - (b.logIndex ?? 0) : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)),
      );
      for (const bn of new Set(logs.map((l) => l.blockNumber ?? 0n))) {
        if (!this.blockTs.has(bn)) {
          const b = await this.client.getBlock({ blockNumber: bn });
          this.blockTs.set(bn, Number(b.timestamp));
        }
      }
      out.push(...decodeLogs(logs, this.accounts, this.entryPoint, (bn) => this.blockTs.get(bn) ?? 0));
      next = to + 1n;
    }
    this.next = next;
    return out;
  }
}
