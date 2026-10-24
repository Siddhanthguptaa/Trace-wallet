import { decodeEventLog, type Address, type Hex, type Log } from 'viem';
import { config } from '@/config';
import { accountAbi, entryPointAbi } from './abi';
import { publicClient } from './client';

export type ActivityKind =
  | 'op'
  | 'op-reverted'
  | 'spent'
  | 'approved'
  | 'flagged'
  | 'flag-cleared'
  | 'revoked'
  | 'policy'
  | 'voucher-registered'
  | 'voucher-used'
  | 'voucher-reclaimed'
  | 'epoch';

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  blockNumber: bigint;
  txHash: Hex;
  timestamp?: number;
  payee?: Address;
  asset?: Address;
  amount?: bigint;
  track?: number;
  agentKey?: Address;
  detail?: string;
};

const CHUNK = 9_000n;
const WINDOW = 45_000n; // about 25 hours of Base blocks at 2 s

/** Reads the wallet's own events plus its EntryPoint events for roughly the last day. */
export async function fetchActivity(wallet: Address): Promise<ActivityItem[]> {
  const latest = await publicClient.getBlockNumber();
  const from = latest > WINDOW ? latest - WINDOW : 0n;
  const ranges: [bigint, bigint][] = [];
  for (let start = from; start <= latest; start += CHUNK + 1n) {
    const end = start + CHUNK > latest ? latest : start + CHUNK;
    ranges.push([start, end]);
  }
  const logs: Log[] = [];
  for (const [fromBlock, toBlock] of ranges) {
    const [own, ops, reverts] = await Promise.all([
      publicClient.getLogs({ address: wallet, fromBlock, toBlock }),
      publicClient.getLogs({ address: config.entryPointAddress, fromBlock, toBlock, event: entryPointAbi[0], args: { sender: wallet } }),
      publicClient.getLogs({ address: config.entryPointAddress, fromBlock, toBlock, event: entryPointAbi[1], args: { sender: wallet } }),
    ]);
    logs.push(...own, ...ops, ...reverts);
  }

  const items: ActivityItem[] = [];
  for (const log of logs) {
    const base = {
      id: `${log.transactionHash}-${log.logIndex}`,
      blockNumber: log.blockNumber ?? 0n,
      txHash: (log.transactionHash ?? '0x') as Hex,
    };
    const item = decode(log, base);
    if (item) items.push(item);
  }
  items.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
  const top = items.slice(0, 80);

  const blocks = [...new Set(top.map((i) => i.blockNumber))].slice(0, 40);
  const stamps = new Map<bigint, number>();
  await Promise.all(
    blocks.map(async (n) => {
      const b = await publicClient.getBlock({ blockNumber: n });
      stamps.set(n, Number(b.timestamp));
    }),
  );
  return top.map((i) => ({ ...i, timestamp: stamps.get(i.blockNumber) }));
}

function decode(log: Log, base: Pick<ActivityItem, 'id' | 'blockNumber' | 'txHash'>): ActivityItem | null {
  for (const abi of [accountAbi, entryPointAbi] as const) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      const a = ev.args as Record<string, unknown>;
      switch (ev.eventName) {
        case 'UserOperationEvent':
          return { ...base, kind: a.success ? 'op' : 'op-reverted' };
        case 'UserOperationRevertReason':
          return { ...base, kind: 'op-reverted', detail: String(a.revertReason ?? '') };
        case 'Spent':
          return {
            ...base,
            kind: 'spent',
            agentKey: a.agentKey as Address,
            payee: a.payee as Address,
            asset: a.asset as Address,
            amount: a.amount as bigint,
            track: Number(a.track),
          };
        case 'ApprovedExecuted':
          return { ...base, kind: 'approved', payee: a.payee as Address, amount: a.outflow as bigint };
        case 'PayeeFlagged':
          return { ...base, kind: 'flagged', payee: a.payee as Address };
        case 'FlagCleared':
          return { ...base, kind: 'flag-cleared', payee: a.payee as Address };
        case 'KeyRevoked':
          return { ...base, kind: 'revoked', agentKey: a.agentKey as Address };
        case 'PolicyChanged':
          return { ...base, kind: 'policy' };
        case 'VoucherRegistered':
          return { ...base, kind: 'voucher-registered', payee: a.payTo as Address, amount: a.maxValue as bigint };
        case 'VoucherUsed':
          return { ...base, kind: 'voucher-used' };
        case 'VoucherReclaimed':
          return { ...base, kind: 'voucher-reclaimed' };
        case 'EpochBumped':
          return { ...base, kind: 'epoch', detail: String(a.epoch) };
      }
    } catch {
      /* not this ABI */
    }
  }
  return null;
}
