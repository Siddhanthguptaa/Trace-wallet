/**
 * Chain access: read the wallet's owner / attestor / epoch / flags, send `flag(payee)`, and verify
 * x402 settlement receipts. Interfaces so tests and the scripted mode can stub them.
 *
 * Account ABI names follow docs/api.md section 2.3 (CORE): owner(), attestor(), attestEpoch(),
 * isFlagged(address), flag(address) (attestor or owner; escalate-only, I10).
 */
import {
  type Address,
  type Chain,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ACCOUNT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function attestor() view returns (address)',
  'function attestEpoch() view returns (uint64)',
  'function isFlagged(address a) view returns (bool)',
  'function flag(address payee)',
]);

export const ERC20_TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export interface AccountReader {
  owner(wallet: Address): Promise<Address>;
  attestor(wallet: Address): Promise<Address>;
  attestEpoch(wallet: Address): Promise<bigint>;
  isFlagged(wallet: Address, payee: Address): Promise<boolean>;
}

export interface FlagWriter {
  /** sends flag(payee) on `wallet` from the attestor key and waits for the receipt. */
  flag(wallet: Address, payee: Address): Promise<Hex>;
}

export interface ReceiptCheck {
  wallet: Address;
  payee: Address;
  asset: Address;
  amount: bigint;
  txHash: Hex;
}

export interface ReceiptVerifier {
  /** ok iff the tx succeeded and the asset emitted Transfer(wallet -> payee, value >= amount). */
  verify(c: ReceiptCheck): Promise<{ ok: true; ts: number } | { ok: false; reason: string }>;
}

export function chainFor(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function viemChainAccess(opts: { rpcUrl: string; chainId: number; attestorKey?: Hex; pollingIntervalMs?: number }): {
  reader: AccountReader;
  writer: FlagWriter | null;
  receipts: ReceiptVerifier;
} {
  const chain = chainFor(opts.chainId, opts.rpcUrl);
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl), pollingInterval: opts.pollingIntervalMs ?? 250 });
  const read = <T>(wallet: Address, functionName: 'owner' | 'attestor' | 'attestEpoch', args: [] = []) =>
    pub.readContract({ address: wallet, abi: ACCOUNT_ABI, functionName, args }) as Promise<T>;

  const reader: AccountReader = {
    owner: (w) => read<Address>(w, 'owner'),
    attestor: (w) => read<Address>(w, 'attestor'),
    attestEpoch: (w) => read<bigint>(w, 'attestEpoch'),
    isFlagged: (w, p) => pub.readContract({ address: w, abi: ACCOUNT_ABI, functionName: 'isFlagged', args: [p] }) as Promise<boolean>,
  };

  let writer: FlagWriter | null = null;
  if (opts.attestorKey) {
    const account = privateKeyToAccount(opts.attestorKey);
    const wc = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
    writer = {
      async flag(wallet, payee) {
        const hash = await wc.writeContract({ address: wallet, abi: ACCOUNT_ABI, functionName: 'flag', args: [payee], account, chain });
        const r = await pub.waitForTransactionReceipt({ hash });
        if (r.status !== 'success') throw new Error(`flag(${payee}) reverted on ${wallet}`);
        return hash;
      },
    };
  }

  const receipts: ReceiptVerifier = {
    async verify(c) {
      let r;
      try {
        r = await pub.getTransactionReceipt({ hash: c.txHash });
      } catch {
        return { ok: false, reason: 'tx_not_found' };
      }
      if (r.status !== 'success') return { ok: false, reason: 'tx_reverted' };
      const paid = r.logs.some((log) => {
        if (log.address.toLowerCase() !== c.asset.toLowerCase()) return false;
        try {
          const ev = decodeEventLog({ abi: ERC20_TRANSFER_ABI, data: log.data, topics: log.topics });
          return (
            ev.args.from.toLowerCase() === c.wallet.toLowerCase() &&
            ev.args.to.toLowerCase() === c.payee.toLowerCase() &&
            ev.args.value >= c.amount
          );
        } catch {
          return false;
        }
      });
      if (!paid) return { ok: false, reason: 'no_matching_transfer' };
      const block = await pub.getBlock({ blockNumber: r.blockNumber });
      return { ok: true, ts: Number(block.timestamp) };
    },
  };
  return { reader, writer, receipts };
}

/** Static reader for scripted mode and tests: fixed owners and epochs, flags tracked in memory. */
export function staticReader(opts: { owners?: Record<string, Address>; attestor?: Address; epoch?: bigint } = {}): AccountReader & FlagWriter & {
  flaggedPairs: Set<string>;
} {
  const flaggedPairs = new Set<string>();
  const key = (w: Address, p: Address) => `${w.toLowerCase()}:${p.toLowerCase()}`;
  const owners = Object.fromEntries(Object.entries(opts.owners ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    flaggedPairs,
    async owner(w) {
      const o = owners[w.toLowerCase()];
      if (!o) throw new Error(`unknown wallet ${w}`);
      return o;
    },
    async attestor() {
      if (!opts.attestor) throw new Error('no attestor configured');
      return opts.attestor;
    },
    async attestEpoch() {
      return opts.epoch ?? 1n;
    },
    async isFlagged(w, p) {
      return flaggedPairs.has(key(w, p));
    },
    async flag(w, p) {
      flaggedPairs.add(key(w, p));
      return `0x${'00'.repeat(31)}01` as Hex;
    },
  };
}
