/** get_policy / get_budget: read the REAL account on chain and shape it for the frontend (wire.ts). */
import { type Address, type Hex, erc20Abi, getAddress, parseAbiItem, zeroAddress } from 'viem';
import { availableAt } from '../../../agent/src/tools/buckets.ts';
import type { GatewayConfig } from './config.ts';
import type { Live } from './world.ts';

type Bucket = { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: bigint };
const OPS = ['EQ_SELF', 'IN_RECIPIENTS', 'PAYEE', 'LTE', 'EQ'] as const;
const KNOWN_SIGS: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x00000000': '(plain value send)',
};
const SCAN_BACK = 60_000n;
const CHUNK = 9_000n;

export class Reader {
  private keys = new Set<Address>();
  private scanned: bigint | null = null;

  constructor(
    readonly live: Live,
    readonly cfg: GatewayConfig,
  ) {
    this.keys.add(live.wallet.agentAddress);
  }

  read<T = unknown>(fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.live.pub.readContract({ address: this.cfg.wallet, abi: this.live.accountAbi, functionName: fn, args }) as Promise<T>;
  }

  async assetInfo(a: Address): Promise<{ address: Address; symbol: string; decimals: number }> {
    if (a.toLowerCase() === this.cfg.usdc.toLowerCase()) return { address: a, symbol: this.cfg.usdcSymbol, decimals: this.cfg.usdcDecimals };
    try {
      const [symbol, decimals] = await Promise.all([
        this.live.pub.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
        this.live.pub.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      return { address: a, symbol: String(symbol), decimals: Number(decimals) };
    } catch {
      return { address: a, symbol: 'TOKEN', decimals: 18 };
    }
  }

  /** Every agent key the account ever set a policy for: the configured one plus PolicySet logs (bounded scan). */
  async agentKeys(): Promise<Address[]> {
    const head = await this.live.pub.getBlockNumber();
    const from = this.scanned ?? this.cfg.fromBlock ?? (head > SCAN_BACK ? head - SCAN_BACK : 0n);
    const ev = parseAbiItem('event PolicySet(address indexed agentKey, uint64 indexed sessionId, uint32 gen, uint192 nonceKey, uint48 validAfter, uint48 validUntil)');
    try {
      for (let s = from; s <= head; s += CHUNK) {
        const to = s + CHUNK - 1n > head ? head : s + CHUNK - 1n;
        const logs = await this.live.pub.getLogs({ address: this.cfg.wallet, event: ev, fromBlock: s, toBlock: to });
        for (const l of logs) if (l.args.agentKey) this.keys.add(getAddress(l.args.agentKey));
      }
      this.scanned = head + 1n;
    } catch {
      /* a rate-limited RPC keeps the keys already known */
    }
    return [...this.keys];
  }

  async flaggedPayees(): Promise<Address[]> {
    const head = await this.live.pub.getBlockNumber();
    const from = this.cfg.fromBlock ?? (head > SCAN_BACK ? head - SCAN_BACK : 0n);
    const ev = parseAbiItem('event Flagged(address indexed payee, address indexed by)');
    const seen = new Set<Address>();
    try {
      for (let s = from; s <= head; s += CHUNK) {
        const logs = await this.live.pub.getLogs({ address: this.cfg.wallet, event: ev, fromBlock: s, toBlock: s + CHUNK - 1n > head ? head : s + CHUNK - 1n });
        for (const l of logs) if (l.args.payee) seen.add(getAddress(l.args.payee));
      }
    } catch {
      /* ignore */
    }
    const flagged: Address[] = [];
    for (const p of seen) if (await this.read<boolean>('isFlagged', [p])) flagged.push(p);
    return flagged;
  }

  async sessionKey(key: Address) {
    const [, s] = await this.read<
      [bigint, { validAfter: number; validUntil: number; revoked: boolean; nonceKey: bigint; gas: { maxCallGas: number; maxVerificationGas: number; maxPreVerificationGas: number; maxFeePerGas: bigint; gasCredit: bigint } }]
    >('sessionOf', [key]);
    const assets = await this.read<Address[]>('keyAssets', [key]);
    const assetRows = [];
    for (const asset of assets) {
      const ka = await this.read<{ perTxCap: bigint; bucket: Bucket }>('keyAsset', [key, asset]);
      assetRows.push({ asset, perTxCap: ka.perTxCap.toString(), cap: (ka.bucket.burst + ka.bucket.ratePerDay).toString() });
    }
    const refs = await this.read<{ target: Address; selector: Hex }[]>('rulesOf', [key]);
    const rules = [];
    for (const r of refs) {
      const [, args] = await this.read<[boolean, { argIndex: number; op: number; bound: bigint }[]]>('ruleOf', [key, r.target, r.selector]);
      rules.push({
        target: r.target,
        targetLabel: r.target.toLowerCase() === this.cfg.usdc.toLowerCase() ? this.cfg.usdcSymbol : r.target === zeroAddress ? 'any target' : undefined,
        selector: r.selector,
        signature: KNOWN_SIGS[r.selector.toLowerCase()],
        args: args.map((a) => ({ index: a.argIndex, op: OPS[a.op] ?? 'EQ', value: a.bound.toString() })),
      });
    }
    return {
      agentKey: key,
      label: key === this.live.wallet.agentAddress ? 'agent session key' : undefined,
      validAfter: Number(s.validAfter),
      validUntil: Number(s.validUntil),
      revoked: s.revoked,
      nonceKey: s.nonceKey.toString(),
      assets: assetRows,
      rules,
      gas: {
        maxCallGas: String(s.gas.maxCallGas),
        maxVerificationGas: String(s.gas.maxVerificationGas),
        maxPreVerificationGas: String(s.gas.maxPreVerificationGas),
        maxFeePerGas: s.gas.maxFeePerGas.toString(),
        gasCredit: s.gas.gasCredit.toString(),
      },
    };
  }

  async getPolicy() {
    const [owner, mode, attestor, epoch, tracked, recipients, spenders, nfts, keys, flagged] = await Promise.all([
      this.read<Address>('owner'),
      this.read<number>('sig1271Mode'),
      this.read<Address>('attestor'),
      this.read<bigint>('attestEpoch'),
      this.read<Address[]>('trackedAssets'),
      this.read<Address[]>('recipientList'),
      this.read<Address[]>('trackedSpenders'),
      this.read<Address[]>('trackedNFTs'),
      this.agentKeys(),
      this.flaggedPayees(),
    ]);
    const assets = [];
    for (const a of tracked.filter((x) => x !== zeroAddress)) {
      const [info, g, e, tx] = await Promise.all([
        this.assetInfo(a),
        this.read<Bucket>('globalBucket', [a]),
        this.read<Bucket>('exploreBucket', [a]),
        this.read<bigint>('explorePerTxCap', [a]),
      ]);
      assets.push({ asset: info, globalCap: (g.burst + g.ratePerDay).toString(), exploreCap: (e.burst + e.ratePerDay).toString(), explorePerTxCap: tx.toString() });
    }
    const sessions = [];
    for (const k of keys) {
      const [sid] = await this.read<[bigint]>('sessionOf', [k]);
      if (sid !== 0n) sessions.push(await this.sessionKey(k));
    }
    return {
      wallet: this.cfg.wallet,
      owner,
      chainId: this.cfg.chainId,
      sig1271Mode: mode === 1 ? 'OWNER_PLUS_X402_VOUCHER' : 'OWNER_ONLY',
      attestor: attestor === zeroAddress ? null : attestor,
      attestEpoch: Number(epoch),
      assets,
      recipients,
      flagged,
      trackedSpenders: spenders.map((address) => ({ address })),
      trackedNFTs: nfts.map((address) => ({ address })),
      keys: sessions,
    };
  }

  async getBudget() {
    const now = Number((await this.live.pub.getBlock()).timestamp);
    const tracked = (await this.read<Address[]>('trackedAssets')).filter((x) => x !== zeroAddress);
    const keys = await this.agentKeys();
    const buckets: Record<string, unknown>[] = [];
    const row = (scope: 'key' | 'global' | 'explore', asset: Address, b: Bucket, agentKey?: Address) => {
      const level = availableAt(b, now);
      const fullAt = level >= b.burst || b.ratePerDay === 0n ? now : now + Number(((b.burst - level) * 86_400n) / b.ratePerDay);
      buckets.push({ scope, ...(agentKey ? { agentKey } : {}), asset, level: level.toString(), cap: b.burst.toString(), refillPerDay: b.ratePerDay.toString(), fullAt });
    };
    for (const asset of tracked) {
      row('global', asset, await this.read<Bucket>('globalBucket', [asset]));
      row('explore', asset, await this.read<Bucket>('exploreBucket', [asset]));
      for (const k of keys) {
        const [sid] = await this.read<[bigint]>('sessionOf', [k]);
        if (sid === 0n) continue;
        const ka = await this.read<{ enabled: boolean; bucket: Bucket }>('keyAsset', [k, asset]);
        if (ka.enabled) row('key', asset, ka.bucket, k);
      }
    }
    return { at: now, buckets };
  }
}
