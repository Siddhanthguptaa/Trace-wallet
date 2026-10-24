/**
 * The agent tools (IDEA 7.2; docs/api.md 12.1). The tools layer holds ONLY the agent key: it reads
 * the policy, checks an op (checkUserOp, never burning gas on a sure refusal), fetches the payee's
 * attestation and packs it into userOp.signature, and submits through the EntryPoint. Anything that
 * would need owner approval routes to request_approval instead of being fired.
 *
 * The engine is transport-free so the raw-key shooter, the LLM shooter and the HTTP server all call
 * the same code. It never holds the owner key; `approvalSink` is how an owner (or the approval
 * service) is asked, injected by the harness.
 */
import { type Address, type Hex, encodeFunctionData, getAddress, isAddress, maxUint256, zeroAddress } from 'viem';

const NAIVE_ABI = [
  { type: 'function', name: 'executeAgent', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
] as const;
import type { Wallet, World } from '../world/deploy.ts';
import { fetchAttestation } from '../attest/client.ts';
import {
  agentCallData,
  declaredOutflow,
  decodePayee,
  erc20 as erc20enc,
  shop,
} from '../ops/encode.ts';
import { decodeReason, approvable, TIER, TRACK, R } from '../ops/reasons.ts';
import { buildOp, defaultGas, getNonce, opHash, sign65, signAgent, submit, type OpGas, type SubmitResult } from '../ops/submitter.ts';
import { availableAt } from './buckets.ts';

export interface ToolsContext {
  world: World;
  wallet: Wallet;
  /** Attestor base URL; '' disables attestation fetch (treats every payee as UNPROVEN). */
  attestorUrl: string;
  /** Owner / approval hook. Returns the signed approval slot for an op, or null to leave it pending. */
  approvalSink?: ApprovalSink;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface ApprovalRequest {
  requestId: string;
  target: Address;
  value: bigint;
  data: Hex;
  reason: string;
  reasonName: string;
  payee?: Address;
}

export interface ApprovalRecord {
  request: ApprovalRequest;
  status: 'pending' | 'approved' | 'executed' | 'rejected' | 'expired' | 'reverted';
  approval?: Hex;
  txHash?: Hex;
}

export interface ApprovalSink {
  /** Decide an approval request. Return an OutcomeApproval slot (Hex) to approve, or null to reject/leave pending. */
  decide(req: ApprovalRequest, ctx: ToolsContext): Promise<{ approval: Hex } | { reject: true } | null>;
}

export interface CheckResult {
  ok: boolean;
  reason: number;
  reasonCode: number;
  reasonName: string;
  track: string;
  tier: string;
  attestation: Hex;
  simulatedOutflows: { asset: Address; amount: string }[];
}

export type PayStatus = 'executed' | 'reverted' | 'refused' | 'needs_approval';
export interface PayResult {
  status: PayStatus;
  reason?: string;
  reasonName?: string;
  userOpHash?: Hex;
  txHash?: Hex;
  success?: boolean;
  requestId?: string;
}

export class AgentTools {
  private approvals = new Map<string, ApprovalRecord>();
  private seq = 0;
  constructor(public ctx: ToolsContext) {}

  private get w(): World {
    return this.ctx.world;
  }
  private get account(): Address {
    return this.ctx.wallet.address;
  }
  private get agentKey(): Hex {
    return this.ctx.wallet.agentKey;
  }

  private async assets(): Promise<Address[]> {
    return [this.w.usdc];
  }

  async getPolicy(): Promise<Record<string, unknown>> {
    if (this.ctx.wallet.kind !== 'agent') return { account: this.account, kind: this.ctx.wallet.kind, config: this.ctx.wallet.id, note: 'baseline wallet: no on-chain policy view' };
    const A = this.w.accountAbi;
    const read = (fn: string, args: readonly unknown[] = []) => this.w.c.pub.readContract({ address: this.account, abi: A, functionName: fn, args });
    const agentKeyAddr = this.ctx.wallet.agentAddress;
    const [sid, session] = (await read('sessionOf', [agentKeyAddr])) as [bigint, Record<string, unknown>];
    const usdcLimit = (await read('keyAsset', [agentKeyAddr, this.w.usdc])) as { perTxCap: bigint; bucket: { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: bigint } };
    const recipients = (await read('recipientList')) as Address[];
    const mode = (await read('sig1271Mode')) as number;
    return {
      account: this.account,
      agentKey: agentKeyAddr,
      sessionId: sid.toString(),
      validAfter: Number(session.validAfter),
      validUntil: Number(session.validUntil),
      revoked: session.revoked,
      nonceKey: (session.nonceKey as bigint).toString(),
      assets: [
        {
          asset: this.w.usdc,
          perTxCap: usdcLimit.perTxCap.toString(),
          bucket: {
            burst: usdcLimit.bucket.burst.toString(),
            ratePerDay: usdcLimit.bucket.ratePerDay.toString(),
            level: usdcLimit.bucket.level.toString(),
            lastRefill: Number(usdcLimit.bucket.lastRefill),
          },
        },
      ],
      recipients,
      sig1271Mode: mode,
    };
  }

  async getBudget(asset: Address = this.w.usdc): Promise<Record<string, unknown>> {
    if (this.ctx.wallet.kind !== 'agent') return { asset, kind: this.ctx.wallet.kind, note: 'baseline wallet: no buckets' };
    const A = this.w.accountAbi;
    const now = Number(BigInt((await this.w.c.pub.getBlock()).timestamp));
    const read = (fn: string, args: readonly unknown[] = []) => this.w.c.pub.readContract({ address: this.account, abi: A, functionName: fn, args });
    const agentKeyAddr = this.ctx.wallet.agentAddress;
    const key = (await read('keyAsset', [agentKeyAddr, asset])) as { perTxCap: bigint; bucket: { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: bigint } };
    const glob = (await read('globalBucket', [asset])) as { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: bigint };
    const expl = (await read('exploreBucket', [asset])) as { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: bigint };
    const explorePerTx = (await read('explorePerTxCap', [asset])) as bigint;
    const [, session] = (await read('sessionOf', [agentKeyAddr])) as [bigint, { gas: { gasCredit: bigint } }];
    const level = (b: { burst: bigint; ratePerDay: bigint; level: bigint; lastRefill: bigint }) => ({
      available: availableAt(b, now).toString(),
      cap: b.burst.toString(),
    });
    return {
      asset,
      key: level(key.bucket),
      global: level(glob),
      explore: level(expl),
      explorePerTxCap: explorePerTx.toString(),
      perTxCap: key.perTxCap.toString(),
      gasCredit: session.gas.gasCredit.toString(),
    };
  }

  /** The reason an op would fail, its tier/track, and the attestation the tools would attach. */
  async check(input: { target: Address; value?: bigint; data?: Hex; payee?: Address }): Promise<CheckResult> {
    const value = input.value ?? 0n;
    const data = input.data ?? '0x';
    const assets = await this.assets();
    if (this.ctx.wallet.kind !== 'agent')
      return { ok: true, reason: 0, reasonCode: 0, reasonName: 'UNCHECKED', track: 'NORMAL', tier: 'NONE', attestation: '0x', simulatedOutflows: declaredOutflow(input.target, value, data, assets).map((o) => ({ asset: o.asset, amount: o.amount.toString() })) };
    const decoded = decodePayee(input.target, value, data, assets);
    const payee = input.payee ?? decoded?.payee;
    const att = payee && this.ctx.attestorUrl ? await fetchAttestation(this.ctx.attestorUrl, this.account, payee, this.w.chainId) : null;
    const attestation = att?.attestation ?? '0x';
    const op = await this.buildAgentOp(input.target, value, data, attestation);
    const [reason, , validUntil] = (await this.w.c.pub.readContract({
      address: this.account,
      abi: this.w.accountAbi,
      functionName: 'checkUserOp',
      args: [op, opHash(this.w, op)],
    })) as [number, number, number];
    const [tierReason, tier, track] = await this.policyCheck(input.target, value, data, attestation);
    void validUntil;
    void tierReason;
    // checkUserOp / policyCheck are validation-time views: they cannot read the clock, so bucket
    // exhaustion, expiry and the gas credit only show up in the PolicyLens. Without this call an
    // honest agent submits ops execution then blocks, and every block is a strike toward a freeze.
    let finalReason = reason;
    if (reason === 0 && this.w.lens && this.w.lensAbi) {
      const [lensOk, , lensCode] = (await this.w.c.pub.readContract({
        address: this.w.lens,
        abi: this.w.lensAbi,
        functionName: 'checkPolicy',
        args: [this.account, this.ctx.wallet.agentAddress, agentCallData(input.target, value, data), attestation],
      })) as [boolean, number, number];
      if (!lensOk) finalReason = lensCode;
    }
    const d = decodeReason(finalReason);
    return {
      ok: finalReason === 0,
      reason: finalReason,
      reasonCode: d.code,
      reasonName: d.name,
      track: TRACK[track] ?? 'NORMAL',
      tier: TIER[tier] ?? 'NONE',
      attestation,
      simulatedOutflows: declaredOutflow(input.target, value, data, assets).map((o) => ({ asset: o.asset, amount: o.amount.toString() })),
    };
  }

  private async policyCheck(target: Address, value: bigint, data: Hex, attestation: Hex, approval: Hex = '0x'): Promise<[number, number, number]> {
    const callData = agentCallData(target, value, data);
    const [reason, tier, track] = (await this.w.c.pub.readContract({
      address: this.account,
      abi: this.w.accountAbi,
      functionName: 'policyCheck',
      args: [this.ctx.wallet.agentAddress, callData, attestation, approval],
    })) as [number, number, number, number];
    return [reason, tier, track];
  }

  private async buildAgentOp(target: Address, value: bigint, data: Hex, attestation: Hex, approval: Hex = '0x', gas?: OpGas) {
    const lane = approval !== '0x' ? 1n : 0n;
    const nonceKey = (await this.w.c.pub.readContract({ address: this.account, abi: this.w.accountAbi, functionName: 'nonceKeyOf', args: [this.ctx.wallet.agentAddress, Number(lane)] })) as bigint;
    const nonce = await getNonce(this.w, this.account, nonceKey);
    const op = buildOp(this.account, nonce, agentCallData(target, value, data), gas ?? defaultGas(this.w));
    return signAgent(this.w, op, this.agentKey, attestation, approval);
  }

  /** Core pay path: check, attach attestation, submit; route to approval on an approvable refusal. */
  async pay(input: { asset: Address; to: Address; amount: bigint }): Promise<PayResult> {
    const data = erc20enc.transfer(input.to, input.amount);
    return this.execute(input.asset, 0n, data, input.to, `pay ${input.amount} to ${input.to}`);
  }

  async buy(input: { shop: 'ticket' | 'grocery' | Address; item?: bigint; amount?: bigint; recipient?: Address }): Promise<PayResult> {
    const recipient = input.recipient ?? this.account;
    // Shops pull with transferFrom: approve exactly the price first (metered as allowance growth by
    // D2), then call the shop. A refused approve stops the purchase.
    if (input.shop === 'ticket') {
      const price = this.w.policy.shops.ticketPrice;
      const ap = await this.execute(this.w.usdc, 0n, erc20enc.approve(this.w.ticket, price), undefined, 'approve TicketShop');
      if (ap.status !== 'executed') return ap;
      return this.execute(this.w.ticket, 0n, shop.buyTicket(input.item ?? 0n, recipient), undefined, 'buy ticket');
    }
    if (input.shop === 'grocery') {
      const amount = input.amount ?? 0n;
      const ap = await this.execute(this.w.usdc, 0n, erc20enc.approve(this.w.grocery, amount), undefined, 'approve GroceryShop');
      if (ap.status !== 'executed') return ap;
      return this.execute(this.w.grocery, 0n, shop.order(amount, recipient), undefined, 'grocery order');
    }
    return this.execute(getAddress(input.shop), 0n, '0x', undefined, 'buy at custom shop');
  }

  /** Run the full check -> attest -> submit pipeline for one call. */
  async execute(target: Address, value: bigint, data: Hex, payee?: Address, reason = ''): Promise<PayResult> {
    if (this.ctx.wallet.kind !== 'agent') return this.executeBaseline(target, value, data);
    const chk = await this.check({ target, value, data, payee });
    if (!chk.ok) {
      if (approvable(chk.reason, payee !== undefined)) {
        const req = await this.requestApproval({ target, value, data, reason: reason || chk.reasonName });
        return { status: 'needs_approval', reason: chk.reasonName, reasonName: chk.reasonName, requestId: req.requestId };
      }
      this.ctx.log?.('refused', { target, reason: chk.reasonName });
      return { status: 'refused', reason: chk.reasonName, reasonName: chk.reasonName };
    }
    const op = await this.buildAgentOp(target, value, data, chk.attestation);
    const res = await submit(this.w, [op]);
    return this.classify(res, op && opHash(this.w, op));
  }

  /**
   * R1 / R2 baselines (EXPERIMENTS X1): the same tool call on a wallet without our policy. R1 = a
   * direct transaction from the agent EOA; R2 = NaiveAccount.executeAgent through the EntryPoint
   * (raw 65-byte signature). Neither has a check or an approval path: a refusal is just refused.
   */
  private async executeBaseline(target: Address, value: bigint, data: Hex): Promise<PayResult> {
    const wallet = this.ctx.wallet;
    if (wallet.kind === 'eoa') {
      try {
        const hash = await this.w.c.wallet(wallet.agentKey).sendTransaction({ to: target, data, value, gas: 5_000_000n });
        const r = await this.w.c.pub.waitForTransactionReceipt({ hash });
        return r.status === 'success' ? { status: 'executed', txHash: hash, success: true } : { status: 'reverted', txHash: hash, success: false };
      } catch (e) {
        return { status: 'refused', reason: (e as Error).message.split(/\r?\n/)[0] };
      }
    }
    const callData = encodeFunctionData({ abi: NAIVE_ABI, functionName: 'executeAgent', args: [target, value, data] });
    const nonce = await getNonce(this.w, wallet.address, 0n);
    const op = buildOp(wallet.address, nonce, callData, defaultGas(this.w));
    op.signature = await sign65(wallet.agentKey, opHash(this.w, op));
    return this.classify(await submit(this.w, [op]), opHash(this.w, op));
  }

  private classify(res: SubmitResult, hash?: Hex): PayResult {
    if (!res.validated) return { status: 'refused', reason: res.failedOp, userOpHash: hash };
    if (res.policyBlocked || (!res.success && res.frozen)) return { status: 'refused', reason: 'policy_blocked', userOpHash: hash, success: false };
    if (!res.success) return { status: 'reverted', userOpHash: hash, txHash: res.txHash, success: false };
    return { status: 'executed', userOpHash: hash, txHash: res.txHash, success: true };
  }

  async requestApproval(input: { target: Address; value?: bigint; data?: Hex; reason: string }): Promise<{ requestId: string; status: string }> {
    if (this.ctx.wallet.kind !== 'agent') return { requestId: '', status: 'unsupported' };
    const value = input.value ?? 0n;
    const data = input.data ?? '0x';
    const assets = await this.assets();
    const payee = decodePayee(input.target, value, data, assets)?.payee;
    const chk = await this.check({ target: input.target, value, data, payee });
    const requestId = `req-${this.ctx.wallet.id}-${++this.seq}`;
    const req: ApprovalRequest = { requestId, target: input.target, value, data, reason: input.reason, reasonName: chk.reasonName, payee };
    const rec: ApprovalRecord = { request: req, status: 'pending' };
    this.approvals.set(requestId, rec);
    if (this.ctx.approvalSink) {
      const decision = await this.ctx.approvalSink.decide(req, this.ctx);
      if (decision && 'approval' in decision) {
        rec.status = 'approved';
        rec.approval = decision.approval;
      } else if (decision && 'reject' in decision) {
        rec.status = 'rejected';
      }
    }
    return { requestId, status: rec.status };
  }

  async approvalStatus(requestId: string): Promise<ApprovalRecord | { error: string }> {
    const rec = this.approvals.get(requestId);
    if (!rec) return { error: 'unknown request' };
    if (rec.status === 'approved' && rec.approval) {
      const { request } = rec;
      const op = await this.buildAgentOp(request.target, request.value, request.data, '0x', rec.approval);
      const res = await submit(this.w, [op]);
      const p = this.classify(res, opHash(this.w, op));
      rec.status = p.status === 'executed' ? 'executed' : p.status === 'reverted' ? 'reverted' : 'rejected';
      rec.txHash = res.txHash;
    }
    return rec;
  }

  /** x402: fetch the 402, build the voucher/authorization, pay through the mock seller. */
  async payX402(input: { url: string; maxAmount: bigint; resource?: string }): Promise<{ status: string; receipt?: unknown; reason?: string }> {
    // The x402 flow is driven by the harness runner (it holds the seller + the 1271 door); the
    // engine exposes the building blocks (check, attestation). The runner calls payX402Flow.
    void input;
    return { status: 'skipped', reason: 'payX402 is driven by the x402 runner (see src/legit/x402.ts)' };
  }

  listApprovals(): ApprovalRecord[] {
    return [...this.approvals.values()];
  }
}

export { availableAt };
export const CONSTANTS = { MAX_UINT: maxUint256, ZERO: zeroAddress, isAddress, approvable, R };
