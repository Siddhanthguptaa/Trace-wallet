/**
 * Approval service core (IDEA 7.3, BUILD M5, docs/api.md section 16).
 *
 * Flow: the agent files a lane-1 UserOp it signed (attributable: its ECDSA over userOpHash), the
 * service checks it against the account (session, nonce lane, rules via policyCheck), rate-limits
 * per session key, simulates the outflow (eth_call + state override), and stores an OutcomeApproval
 * draft. The owner fetches the EIP-712 typed data and posts a signature; the service checks it
 * recovers the on-chain owner(), builds the final signature envelope, preflights checkUserOp and
 * relays through a Submitter. Status follows the on-chain result: executed, reverted (target
 * reverted or PolicyBlocked: nothing moved), rejected (never included), expired.
 */
import { randomBytes } from 'node:crypto';
import {
  type Address,
  type Hex,
  type Log,
  decodeErrorResult,
  decodeEventLog,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  recoverAddress,
  recoverMessageAddress,
  size,
} from 'viem';
import { z } from 'zod';
import { type PackedUserOperation, getUserOpHashV08, packUserOp } from '@hypnexis/shared';
import {
  ANY_TARGET,
  type AgentCall,
  LANE,
  MAX_UINT48,
  OP_KIND,
  type OutcomeApproval,
  REASON,
  ROLE,
  type Submitter,
  ZERO_SELECTOR,
  agentOfNonce,
  approvalAccountAbi,
  approvalFromJson,
  approvalToJson,
  approvalTypedDataV4Json,
  decodeAgentOp,
  decodeSignatureEnvelope,
  encodeApprovalSlot,
  encodeSignatureEnvelope,
  laneOfNonce,
  nonceKeyOfNonce,
  outcomeApprovalDigest,
  payeeFromRules,
  payeeHeuristic,
  reasonName,
  recoverApprovalSigner,
} from '../../../packages/shared/src/approval/index.ts';
import { type ApprovalChain, ChainUnavailableError } from './chain.ts';
import type { ApprovalConfig } from './config.ts';
import {
  type Simulation,
  type SimRequest,
  declaredSimulation,
  outflowsFromRaw,
  simulationToJson,
  unionAddrs,
} from './simulate.ts';
import type { RequestRow, RequestStatus, Store } from './store.ts';

export class ApiError extends Error {
  constructor(
    readonly http: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const ZERO_SIG65: Hex = `0x${'00'.repeat(65)}`;

/** EIP-191 text the owner signs to reject a request. */
export function rejectMessage(id: string): string {
  return `Hypnexis approval service: reject request ${id}`;
}

const bigish = z.union([z.string().regex(/^(0x[0-9a-fA-F]+|[0-9]+)$/), z.number().int().nonnegative(), z.bigint()]).transform((v) => BigInt(v));
const hex = z.string().refine((s) => isHex(s, { strict: true }), 'expected 0x hex');
const hex32 = hex.refine((s) => s.length === 66, 'expected bytes32');
const addr = z.string().refine((s) => isAddress(s, { strict: false }), 'expected an address').transform((s) => getAddress(s));

const PackedSchema = z.object({
  sender: addr,
  nonce: bigish,
  initCode: hex.default('0x'),
  callData: hex,
  accountGasLimits: hex32,
  preVerificationGas: bigish,
  gasFees: hex32,
  paymasterAndData: hex.default('0x'),
  signature: hex,
});

const UnpackedSchema = z.object({
  sender: addr,
  nonce: bigish,
  factory: addr.optional(),
  factoryData: hex.optional(),
  callData: hex,
  callGasLimit: bigish,
  verificationGasLimit: bigish,
  preVerificationGas: bigish,
  maxFeePerGas: bigish,
  maxPriorityFeePerGas: bigish,
  paymaster: addr.optional(),
  paymasterVerificationGasLimit: bigish.optional(),
  paymasterPostOpGasLimit: bigish.optional(),
  paymasterData: hex.optional(),
  signature: hex,
});

const CreateSchema = z.object({
  account: addr,
  chainId: z.coerce.number().int().positive(),
  userOp: z.record(z.unknown()),
  note: z.string().optional(),
});

export function parseUserOp(raw: Record<string, unknown>): PackedUserOperation {
  if ('accountGasLimits' in raw) {
    const p = PackedSchema.parse(raw);
    return { ...p, initCode: p.initCode as Hex, callData: p.callData as Hex, accountGasLimits: p.accountGasLimits as Hex, gasFees: p.gasFees as Hex, paymasterAndData: p.paymasterAndData as Hex, signature: p.signature as Hex };
  }
  const u = UnpackedSchema.parse(raw);
  return packUserOp({ ...u, factoryData: u.factoryData as Hex | undefined, callData: u.callData as Hex, paymasterData: u.paymasterData as Hex | undefined, signature: u.signature as Hex });
}

export function userOpToJson(op: PackedUserOperation): Record<string, string> {
  return {
    sender: op.sender,
    nonce: op.nonce.toString(),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: op.preVerificationGas.toString(),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

const BLOCK_ERRORS = parseAbi([
  'error PolicyViolation(uint16 reason)',
  'error TripwireTripped(uint8 stage)',
  'error BucketExceeded(uint256 amount, uint256 available)',
  'error OutflowAboveApproval(address asset, uint256 amount, uint256 maxAmount)',
  'error Error(string)',
]);

/** Human form of a PolicyBlocked reason / revert blob. */
export function describeRevert(data: Hex): string {
  if (!data || data === '0x') return 'empty';
  try {
    const d = decodeErrorResult({ abi: BLOCK_ERRORS, data });
    if (d.errorName === 'PolicyViolation') return `PolicyViolation(${reasonName(Number(d.args[0]))})`;
    return `${d.errorName}(${(d.args ?? []).map((a) => String(a)).join(',')})`;
  } catch {
    return `error ${data.slice(0, 10)}`;
  }
}

interface ParsedEffects {
  blocked: boolean;
  blockReason?: string;
  frozen: boolean;
  outflows?: { asset: Address; amount: string }[];
  approvedExecuted: boolean;
}

/** Account events for one userOpHash in a receipt (Decision / PolicyBlocked / AgentFrozen / ApprovedExecuted). */
export function parseAccountEffects(logs: readonly Log[], account: Address, userOpHash: Hex): ParsedEffects {
  const out: ParsedEffects = { blocked: false, frozen: false, approvedExecuted: false };
  for (const l of logs) {
    if (l.address.toLowerCase() !== account.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: approvalAccountAbi, data: l.data, topics: l.topics });
    } catch {
      continue;
    }
    const a = ev.args as Record<string, unknown>;
    const same = typeof a.userOpHash === 'string' && a.userOpHash.toLowerCase() === userOpHash.toLowerCase();
    if (ev.eventName === 'PolicyBlocked' && same) {
      out.blocked = true;
      out.blockReason = describeRevert(a.reason as Hex);
    } else if (ev.eventName === 'Decision' && same) {
      out.outflows = (a.outflows as { asset: Address; amount: bigint }[]).map((x) => ({ asset: x.asset, amount: x.amount.toString() }));
    } else if (ev.eventName === 'AgentFrozen' && same) {
      out.frozen = true;
    } else if (ev.eventName === 'ApprovedExecuted') {
      out.approvedExecuted = true;
    }
  }
  return out;
}

export interface ServiceDeps {
  cfg: ApprovalConfig;
  store: Store;
  chain: ApprovalChain;
  submitter?: Submitter;
  log?: (m: string) => void;
  newId?: () => string;
  /** wall clock (unix s) for rate-limit windows; tests inject it. */
  clock?: () => number;
}

export class ApprovalService {
  private readonly inflight = new Set<Promise<void>>();
  private readonly inflightIds = new Set<string>();
  private readonly log: (m: string) => void;
  private readonly clock: () => number;

  constructor(private readonly d: ServiceDeps) {
    this.log = d.log ?? (() => {});
    this.clock = d.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  get cfg(): ApprovalConfig {
    return this.d.cfg;
  }

  /** resolves when every background relay has finished (tests, e2e). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private async chainNow(): Promise<number> {
    try {
      return await this.d.chain.now();
    } catch {
      return this.clock();
    }
  }

  // ------------------------------------------------------------------ create

  async create(body: unknown): Promise<Record<string, unknown>> {
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, 'BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const { account, chainId } = parsed.data;
    const note = parsed.data.note ?? '';
    if (note.length > this.cfg.maxNoteChars) throw new ApiError(400, 'NOTE_TOO_LONG', `note is limited to ${this.cfg.maxNoteChars} characters`);
    if (chainId !== this.cfg.chainId) throw new ApiError(400, 'WRONG_CHAIN', `this service approves for chainId ${this.cfg.chainId}`);

    let op: PackedUserOperation;
    try {
      op = parseUserOp(parsed.data.userOp);
    } catch (e) {
      throw new ApiError(400, 'BAD_USEROP', (e as Error).message.slice(0, 300));
    }
    if (op.sender.toLowerCase() !== account.toLowerCase()) throw new ApiError(400, 'SENDER_MISMATCH', 'userOp.sender must equal account');
    if (size(op.callData) > 16_384) throw new ApiError(400, 'BAD_USEROP', 'callData above 16 KiB');

    let env;
    try {
      env = decodeSignatureEnvelope(op.signature);
    } catch {
      throw new ApiError(400, 'BAD_SIGNATURE_ENVELOPE', 'signature must be abi.encode(uint8 role, bytes sig, bytes attestation, bytes approval)');
    }
    if (env.role !== ROLE.AGENT) throw new ApiError(400, 'NOT_AGENT_ROLE', 'only agent-role ops (role 1) need owner approval');
    if (env.approval !== '0x') throw new ApiError(400, 'APPROVAL_SLOT_SET', 'the approval slot must be empty; the owner fills it');
    if (size(env.sig) !== 65) throw new ApiError(401, 'BAD_AGENT_SIGNATURE', 'agent signature must be 65 bytes');

    const entryPoint = (await this.d.chain.entryPoint(account)) ?? this.cfg.entryPoint;
    const userOpHash = getUserOpHashV08(op, entryPoint, chainId);
    let agent: Address;
    try {
      agent = getAddress(await recoverAddress({ hash: userOpHash, signature: env.sig }));
    } catch {
      throw new ApiError(401, 'BAD_AGENT_SIGNATURE', 'agent signature does not recover');
    }

    // From here the request is attributable to `agent`: every outcome counts toward its rate limit.
    const now = this.clock();
    const seen = this.d.store.attemptsSince(account, agent, now - this.cfg.rateLimitWindowSeconds);
    if (seen.accepted + seen.refused >= this.cfg.rateLimitMax) {
      this.d.store.addAttempt(account, agent, 'rate_limited', now);
      throw new ApiError(429, 'RATE_LIMITED', `at most ${this.cfg.rateLimitMax} requests per ${this.cfg.rateLimitWindowSeconds} s per session key`, {
        retryAfterSeconds: this.cfg.rateLimitWindowSeconds,
      });
    }
    if (this.d.store.pendingCount(account, agent) >= this.cfg.maxPendingPerKey) {
      this.d.store.addAttempt(account, agent, 'rate_limited', now);
      throw new ApiError(429, 'TOO_MANY_PENDING', `at most ${this.cfg.maxPendingPerKey} pending requests per session key`);
    }
    try {
      const res = await this.createAttributed({ account, chainId, op, env, entryPoint, userOpHash, agent, note });
      this.d.store.addAttempt(account, agent, 'accepted', now);
      return res;
    } catch (e) {
      if (!(e instanceof ApiError && e.http === 503)) this.d.store.addAttempt(account, agent, 'refused', now);
      throw e;
    }
  }

  private async createAttributed(x: {
    account: Address;
    chainId: number;
    op: PackedUserOperation;
    env: { sig: Hex; attestation: Hex };
    entryPoint: Address;
    userOpHash: Hex;
    agent: Address;
    note: string;
  }): Promise<Record<string, unknown>> {
    const { account, chainId, op, env, entryPoint, userOpHash, agent } = x;
    const chain = this.d.chain;
    if (agentOfNonce(op.nonce) !== agent) throw new ApiError(400, 'NONCE_KEY_MISMATCH', 'the nonce key does not belong to the signing agent key');
    if (laneOfNonce(op.nonce) !== LANE.APPROVAL) throw new ApiError(400, 'WRONG_LANE', 'approval ops use nonce lane 1 (docs/api.md 4.5)');
    const key = nonceKeyOfNonce(op.nonce);
    const liveKey = await chain.nonceKeyOf(account, agent, LANE.APPROVAL);
    if (liveKey === 0n) throw new ApiError(403, 'NO_SESSION', 'the signer is not a session key of this account');
    if (liveKey !== null && liveKey !== key) throw new ApiError(400, 'STALE_NONCE_KEY', 'nonce key is not the session\'s current lane-1 key (policy changed or key rotated)');
    const session = await chain.session(account, agent);
    if (session?.revoked) throw new ApiError(403, 'REVOKED', 'session key revoked');

    let call: AgentCall;
    try {
      call = decodeAgentOp(op.callData);
    } catch (e) {
      throw new ApiError(400, 'OP_SHAPE', (e as Error).message);
    }
    if (call.kind !== OP_KIND.CALL) throw new ApiError(400, 'UNSUPPORTED_OP', 'only CALL agent ops can be approved by this service (voucher ops: see docs/api.md 16)');

    const dup = this.d.store.byUserOpHash(userOpHash);
    if (dup) throw new ApiError(409, 'DUPLICATE', 'this UserOp is already filed', { id: dup.id, status: dup.status });

    let current: bigint;
    try {
      current = await chain.getNonce(entryPoint, account, key);
    } catch (e) {
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', (e as Error).message);
    }
    if (op.nonce < current) throw new ApiError(409, 'STALE_NONCE', `nonce already used (next is ${current})`);
    if (op.nonce > current) throw new ApiError(400, 'NONCE_GAP', `nonce must be the next lane-1 nonce ${current}`);

    // Payee exactly as the account derives it (PAYEE argument rule), so the approval matches call.payee.
    let rules = await chain.ruleOf(account, agent, call.target, call.selector);
    if (rules && !rules.allowed && call.selector === ZERO_SELECTOR && size(call.data) === 0) {
      rules = await chain.ruleOf(account, agent, ANY_TARGET, ZERO_SELECTOR);
    }
    if (rules && !rules.allowed) throw new ApiError(422, 'POLICY_REFUSED', 'no (target, selector) rule; an owner approval cannot waive it', { reasonCode: REASON.TARGET, reason: 'TARGET' });
    let payee: Address;
    try {
      payee = rules ? payeeFromRules(call, rules.rules) : payeeHeuristic(call);
    } catch (e) {
      throw new ApiError(400, 'OP_SHAPE', (e as Error).message);
    }

    let chainNow: number;
    try {
      chainNow = await chain.now();
    } catch (e) {
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', (e as Error).message);
    }
    let validUntil = Math.min(chainNow + this.cfg.ttlSeconds, MAX_UINT48);
    if (session && session.validUntil < validUntil) validUntil = session.validUntil;
    if (validUntil <= chainNow) throw new ApiError(403, 'SESSION_EXPIRED', 'the session key has expired');

    const draft: OutcomeApproval = {
      account,
      chainId: BigInt(chainId),
      nonce: op.nonce,
      target: call.target,
      selector: call.selector,
      payee,
      maxOutflow: [],
      callDataHash: keccak256(op.callData),
      validUntil,
    };

    // Preflight: everything an approval cannot waive (session, revoke, freeze, rules, argument rules).
    const pc = await chain.policyCheck(account, agent, op.callData, env.attestation, encodeApprovalSlot(draft, ZERO_SIG65));
    if (pc && pc.reason !== REASON.OK && (pc.reason & 0xff) !== REASON.APPROVAL) {
      throw new ApiError(422, 'POLICY_REFUSED', `the account refuses this op before any approval: ${reasonName(pc.reason)}`, {
        reasonCode: pc.reason,
        reason: reasonName(pc.reason),
      });
    }

    const sim = await this.simulate(account, entryPoint, call);
    if (!sim.ok) {
      throw new ApiError(422, 'SIMULATION_REVERTED', 'the call reverts in simulation; nothing to approve', { simulation: simulationToJson(sim) });
    }
    const approval: OutcomeApproval = { ...draft, maxOutflow: sim.outflows };
    const approvalHash = outcomeApprovalDigest(approval);
    const id = this.d.newId?.() ?? randomBytes(12).toString('hex');
    const t = this.clock();
    const row: RequestRow = {
      id,
      account,
      chainId,
      agent,
      userOp: JSON.stringify(userOpToJson(op)),
      userOpHash,
      nonce: op.nonce.toString(),
      note: x.note,
      approval: JSON.stringify(approvalToJson(approval)),
      approvalHash,
      simulation: JSON.stringify(simulationToJson(sim)),
      status: 'pending',
      ownerSig: null,
      finalSig: null,
      txHash: null,
      success: null,
      blocked: null,
      reason: null,
      outflows: null,
      createdAt: t,
      updatedAt: t,
      expiresAt: validUntil,
    };
    this.d.store.insert(row);
    this.log(`request ${id} account=${account} agent=${agent} target=${call.target} payee=${payee} maxOutflow=${sim.outflows.map((o) => `${o.amount}@${o.asset}`).join(',') || 'none'}`);
    return {
      id,
      status: 'pending',
      userOpHash,
      approvalHash,
      agentKey: agent,
      payee,
      validUntil,
      simulation: simulationToJson(sim),
      preflight: pc ? { reasonCode: pc.reason, reason: reasonName(pc.reason), tier: pc.tier } : 'unavailable',
    };
  }

  private async simulate(account: Address, entryPoint: Address, call: AgentCall): Promise<Simulation> {
    const base = declaredSimulation(call);
    if (this.cfg.simulationMode === 'declared') return base;
    const tracked = (await this.d.chain.tracked(account)) ?? { assets: [], spenders: [], nfts: [] };
    const warnings: string[] = [];
    const d = base.declared;
    const declaredToken = d && BigInt(d.asset) !== 0n ? [d.asset] : [];
    const declaredSpender = d?.spender ? [d.spender] : [];
    if (d?.spender && !tracked.spenders.some((s) => s.toLowerCase() === d.spender!.toLowerCase())) {
      warnings.push(`untracked_spender ${d.spender}: the account meter does not measure this allowance`);
    }
    const q: SimRequest = {
      target: call.target,
      value: call.value,
      data: call.data,
      entryPoint,
      tokens: unionAddrs(tracked.assets, this.cfg.extraTrackedAssets, declaredToken),
      spenders: unionAddrs(tracked.spenders, declaredSpender),
      nfts: unionAddrs(tracked.nfts),
    };
    let raw;
    try {
      raw = await this.d.chain.simulate(account, q);
    } catch (e) {
      if (e instanceof ChainUnavailableError) throw new ApiError(503, 'SIMULATION_UNAVAILABLE', e.message);
      throw e;
    }
    return {
      mode: 'eth_call',
      ok: raw.ok,
      outflows: raw.ok ? outflowsFromRaw(raw, q) : [],
      declared: d,
      ...(raw.ok ? {} : { revertData: raw.ret }),
      gasUsed: raw.gasUsed,
      tracked: { assets: q.tokens, spenders: q.spenders, nfts: q.nfts },
      warnings,
    };
  }

  // ------------------------------------------------------------------ read

  private mustGet(id: string): RequestRow {
    const r = this.d.store.get(id);
    if (!r) throw new ApiError(404, 'NOT_FOUND', `no request ${id}`);
    return r;
  }

  /** lazy transitions: pending/approved past validUntil -> expired; pending whose nonce was consumed -> rejected. */
  private async refresh(r: RequestRow): Promise<RequestRow> {
    if (r.status !== 'pending' && r.status !== 'approved') return r;
    if (r.status === 'approved' && this.inflightIds.has(r.id)) return r;
    const now = await this.chainNow();
    if (now > r.expiresAt) {
      this.d.store.update(r.id, { status: 'expired', reason: 'validUntil passed' }, [r.status]);
      return this.mustGet(r.id);
    }
    if (r.status === 'pending') {
      try {
        const op = parseUserOp(JSON.parse(r.userOp) as Record<string, unknown>);
        const ep = (await this.d.chain.entryPoint(r.account)) ?? this.cfg.entryPoint;
        const cur = await this.d.chain.getNonce(ep, r.account, nonceKeyOfNonce(op.nonce));
        if (cur > op.nonce) {
          this.d.store.update(r.id, { status: 'rejected', reason: 'nonce_consumed' }, ['pending']);
          return this.mustGet(r.id);
        }
      } catch {
        /* chain down: leave as is */
      }
    }
    return r;
  }

  async status(id: string): Promise<Record<string, unknown>> {
    return this.view(await this.refresh(this.mustGet(id)));
  }

  view(r: RequestRow): Record<string, unknown> {
    const a = JSON.parse(r.approval) as ReturnType<typeof approvalToJson>;
    return {
      id: r.id,
      status: r.status,
      account: r.account,
      chainId: r.chainId,
      agentKey: getAddress(r.agent),
      userOpHash: r.userOpHash,
      approvalHash: r.approvalHash,
      nonce: r.nonce,
      target: a.target,
      selector: a.selector,
      payee: a.payee,
      maxOutflow: a.maxOutflow,
      validUntil: a.validUntil,
      note: r.note,
      simulation: JSON.parse(r.simulation) as unknown,
      ...(r.txHash ? { txHash: r.txHash } : {}),
      ...(r.success !== null ? { success: r.success } : {}),
      ...(r.blocked !== null ? { blocked: r.blocked } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.outflows ? { outflows: JSON.parse(r.outflows) as unknown } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async list(q: { account?: string; agentKey?: string; status?: string; limit?: string }): Promise<Record<string, unknown>> {
    const st = ['pending', 'approved', 'executed', 'rejected', 'expired', 'reverted'];
    if (q.status && !st.includes(q.status)) throw new ApiError(400, 'BAD_REQUEST', `status must be one of ${st.join(', ')}`);
    if ((q.account && !isAddress(q.account)) || (q.agentKey && !isAddress(q.agentKey))) throw new ApiError(400, 'BAD_REQUEST', 'bad address');
    const rows = this.d.store.list({
      account: q.account as Address | undefined,
      agent: q.agentKey as Address | undefined,
      status: q.status as RequestStatus | undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return { requests: rows.map((r) => this.view(r)) };
  }

  async typedData(id: string): Promise<Record<string, unknown>> {
    const r = await this.refresh(this.mustGet(id));
    const a = approvalFromJson(JSON.parse(r.approval));
    const v4 = approvalTypedDataV4Json(a);
    return {
      ...v4,
      status: r.status,
      approvalHash: r.approvalHash,
      // What a wallet should render [A15]. `note` is agent-written text: untrusted, never authority.
      display: {
        account: a.account,
        target: a.target,
        selector: a.selector,
        payee: a.payee,
        maxOutflow: v4.message.maxOutflow,
        validUntil: a.validUntil,
        validUntilIso: new Date(a.validUntil * 1000).toISOString(),
        agentKey: getAddress(r.agent),
        noteUntrusted: r.note,
        simulation: JSON.parse(r.simulation) as unknown,
      },
    };
  }

  async keyStats(agentKey: string, account: string | undefined): Promise<Record<string, unknown>> {
    if (!isAddress(agentKey) || !account || !isAddress(account)) throw new ApiError(400, 'BAD_REQUEST', 'agentKey and ?account= must be addresses');
    const now = this.clock();
    const s = this.d.store.attemptsSince(account, agentKey, now - this.cfg.rateLimitWindowSeconds);
    return {
      account: getAddress(account),
      agentKey: getAddress(agentKey),
      windowSeconds: this.cfg.rateLimitWindowSeconds,
      limit: this.cfg.rateLimitMax,
      maxPending: this.cfg.maxPendingPerKey,
      attempts: s.accepted + s.refused,
      accepted: s.accepted,
      refused: s.refused,
      rateLimited: s.rate_limited,
      pending: this.d.store.pendingCount(account, agentKey),
    };
  }

  /** the owner-approved, relay-ready UserOp (anyone may relay it). */
  async finalUserOp(id: string): Promise<Record<string, unknown>> {
    const r = this.mustGet(id);
    if (!r.finalSig) throw new ApiError(409, 'NOT_APPROVED', `request is ${r.status}; no owner signature yet`);
    const op = JSON.parse(r.userOp) as Record<string, string>;
    return { id: r.id, status: r.status, userOpHash: r.userOpHash, userOp: { ...op, signature: r.finalSig } };
  }

  // ------------------------------------------------------------------ owner actions

  async submitSignature(id: string, body: unknown, wait = false): Promise<Record<string, unknown>> {
    const sigP = z.object({ signature: hex }).safeParse(body);
    if (!sigP.success) throw new ApiError(400, 'BAD_REQUEST', 'body must be { signature: 0x... }');
    const signature = sigP.data.signature as Hex;
    const r = await this.refresh(this.mustGet(id));
    if (r.status !== 'pending') throw new ApiError(409, 'NOT_PENDING', `request is ${r.status}`, { status: r.status });
    const approval = approvalFromJson(JSON.parse(r.approval));
    let signer: Address;
    try {
      signer = getAddress(await recoverApprovalSigner(approval, signature));
    } catch {
      throw new ApiError(400, 'BAD_SIGNATURE', 'signature does not recover over the OutcomeApproval typed data');
    }
    let owner: Address;
    try {
      owner = await this.d.chain.owner(r.account);
    } catch (e) {
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', (e as Error).message);
    }
    if (signer !== owner) throw new ApiError(401, 'NOT_OWNER', `signature recovers ${signer}, not the account owner`);

    const op = parseUserOp(JSON.parse(r.userOp) as Record<string, unknown>);
    const env = decodeSignatureEnvelope(op.signature);
    const finalSig = encodeSignatureEnvelope({ role: ROLE.AGENT, sig: env.sig, attestation: env.attestation, approval: encodeApprovalSlot(approval, signature) });
    if (!this.d.store.update(id, { status: 'approved', ownerSig: signature, finalSig }, ['pending'])) {
      throw new ApiError(409, 'NOT_PENDING', 'request changed state');
    }
    this.log(`request ${id} approved by owner ${owner}`);
    this.inflightIds.add(id);
    const p = this.relay(id)
      .catch((e) => {
        this.d.store.update(id, { status: 'rejected', reason: `relay error: ${(e as Error).message.slice(0, 200)}` }, ['approved']);
      })
      .finally(() => {
        this.inflightIds.delete(id);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
    if (wait) {
      await p;
      return this.status(id);
    }
    return { id, status: 'approved' };
  }

  async reject(id: string, body: unknown): Promise<Record<string, unknown>> {
    const sigP = z.object({ signature: hex }).safeParse(body);
    if (!sigP.success) throw new ApiError(400, 'BAD_REQUEST', 'body must be { signature: 0x... } (EIP-191 over the reject message)');
    const r = await this.refresh(this.mustGet(id));
    if (r.status !== 'pending') throw new ApiError(409, 'NOT_PENDING', `request is ${r.status}`, { status: r.status });
    let signer: Address;
    try {
      signer = getAddress(await recoverMessageAddress({ message: rejectMessage(id), signature: sigP.data.signature as Hex }));
    } catch {
      throw new ApiError(400, 'BAD_SIGNATURE', 'signature does not recover');
    }
    let owner: Address;
    try {
      owner = await this.d.chain.owner(r.account);
    } catch (e) {
      throw new ApiError(503, 'CHAIN_UNAVAILABLE', (e as Error).message);
    }
    if (signer !== owner) throw new ApiError(401, 'NOT_OWNER', `signature recovers ${signer}, not the account owner`);
    this.d.store.update(id, { status: 'rejected', reason: 'owner_rejected' }, ['pending']);
    return { id, status: 'rejected' };
  }

  // ------------------------------------------------------------------ relay

  private async relay(id: string): Promise<void> {
    const r = this.mustGet(id);
    const op = parseUserOp(JSON.parse(r.userOp) as Record<string, unknown>);
    const finalOp: PackedUserOperation = { ...op, signature: r.finalSig as Hex };
    const pre = await this.d.chain.checkUserOp(r.account, finalOp, r.userOpHash);
    if (pre && pre.reason !== REASON.OK) {
      this.d.store.update(id, { status: 'rejected', reason: `preflight checkUserOp: ${reasonName(pre.reason)}` }, ['approved']);
      return;
    }
    if (!this.d.submitter) {
      this.d.store.update(id, { reason: 'no_relayer: fetch GET /v1/requests/:id/userop and relay it' }, ['approved']);
      return;
    }
    const res = await this.d.submitter.submit(finalOp, r.userOpHash);
    if (res.status === 'rejected') {
      this.d.store.update(id, { status: 'rejected', reason: res.reason ?? 'relay rejected', txHash: res.txHash ?? null }, ['approved']);
      this.log(`request ${id} rejected on relay: ${res.reason}`);
      return;
    }
    if (res.status === 'unknown') {
      this.d.store.update(id, { reason: res.reason ?? 'relay pending', txHash: res.txHash ?? null }, ['approved']);
      return;
    }
    const fx = parseAccountEffects(res.logs ?? [], r.account, r.userOpHash);
    const status: RequestStatus = fx.blocked || !res.success ? 'reverted' : 'executed';
    const reason = fx.blocked ? `PolicyBlocked: ${fx.blockReason}${fx.frozen ? ' (agent key frozen)' : ''}` : res.success ? null : 'target_reverted';
    this.d.store.update(
      id,
      {
        status,
        txHash: res.txHash ?? null,
        success: res.success ?? null,
        blocked: fx.blocked,
        reason,
        outflows: fx.outflows ? JSON.stringify(fx.outflows) : null,
      },
      ['approved'],
    );
    // The EntryPoint nonce is consumed: no other request filed with it can ever execute.
    for (const o of this.d.store.pendingWithNonce(r.account, r.nonce, id)) {
      this.d.store.update(o.id, { status: 'rejected', reason: 'nonce_consumed' }, ['pending']);
    }
    this.log(`request ${id} ${status} tx=${res.txHash}${reason ? ` (${reason})` : ''}`);
  }
}
