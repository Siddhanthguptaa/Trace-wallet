/** Fakes for unit tests: an in-memory ApprovalChain and a scripted Submitter. */
import {
  type Address,
  type Hex,
  type Log,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PackedUserOperation } from '@hypnexis/shared';
import {
  type ArgRuleView,
  type SubmitResult,
  type Submitter,
  approvalAccountAbi,
  makeNonce,
  signAgentOp,
} from '../../../packages/shared/src/approval/index.ts';
import type { ApprovalChain, SessionView } from '../src/chain.ts';
import { ChainUnavailableError } from '../src/chain.ts';
import { loadApprovalConfig, type ApprovalConfig } from '../src/config.ts';
import { type SimRaw, type SimRequest } from '../src/simulate.ts';
import { ApprovalService } from '../src/service.ts';
import { Store } from '../src/store.ts';

export const KEYS = {
  owner: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  attacker: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
} as const satisfies Record<string, Hex>;
export const OWNER = privateKeyToAccount(KEYS.owner).address;
export const AGENT = privateKeyToAccount(KEYS.agent).address;
export const ACCOUNT = getAddress('0x95e6B4D9D3f8360e66048eD484302099c7A3f545');
export const ENTRYPOINT = getAddress('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');
export const TOKEN = getAddress('0x4444444444444444444444444444444444444444');
export const PAYEE = getAddress('0x3333333333333333333333333333333333333333');
export const LANE1_KEY = (BigInt(AGENT) << 32n) | (0x123n << 8n) | 1n;
export const NOW = 1_800_000_000;

export const erc20 = parseAbi(['function transfer(address,uint256)', 'function approve(address,uint256)']);

export class FakeChain implements ApprovalChain {
  readonly chainId = 31337;
  ownerAddr: Address = OWNER;
  t = NOW;
  sessions = new Map<string, SessionView>([[AGENT.toLowerCase(), { validAfter: 0, validUntil: NOW + 6 * 86400, revoked: false, nonceKey: LANE1_KEY - 1n }]]);
  rules = new Map<string, { allowed: boolean; rules: ArgRuleView[] }>();
  trackedLists: { assets: Address[]; spenders: Address[]; nfts: Address[] } | null = { assets: [TOKEN], spenders: [], nfts: [] };
  seq = new Map<string, bigint>();
  /** reason policyCheck returns with the dummy approval; null = unsupported. */
  policyReason: number | null = 17;
  checkReason: number | null = 0;
  simRaw: (q: SimRequest) => SimRaw = (q) => ({ ok: true, ret: '0x', nativeOut: 0n, tokenOut: q.tokens.map(() => 5_000_000n), nftOut: q.nfts.map(() => 0n), gasUsed: 30_000n });
  down = false;
  lastSim?: SimRequest;

  async now() {
    if (this.down) throw new ChainUnavailableError('down');
    return this.t;
  }
  async owner() {
    if (this.down) throw new ChainUnavailableError('down');
    return this.ownerAddr;
  }
  async entryPoint() {
    return ENTRYPOINT;
  }
  async nonceKeyOf(_a: Address, agent: Address, lane: number) {
    const s = this.sessions.get(agent.toLowerCase());
    return s ? s.nonceKey | BigInt(lane) : 0n;
  }
  async session(_a: Address, agent: Address) {
    return this.sessions.get(agent.toLowerCase()) ?? null;
  }
  async ruleOf(_a: Address, _g: Address, target: Address, selector: Hex) {
    return this.rules.get(`${target.toLowerCase()}:${selector}`) ?? { allowed: true, rules: [] };
  }
  async tracked() {
    return this.trackedLists;
  }
  async policyCheck() {
    return this.policyReason === null ? null : { reason: this.policyReason, tier: 2, track: 2, validUntil: 0 };
  }
  async checkUserOp() {
    return this.checkReason === null ? null : { reason: this.checkReason, validAfter: 0, validUntil: 0 };
  }
  async getNonce(_ep: Address, _a: Address, key: bigint) {
    if (this.down) throw new ChainUnavailableError('down');
    return makeNonce(key, this.seq.get(key.toString()) ?? 0n);
  }
  async simulate(_a: Address, q: SimRequest) {
    if (this.down) throw new ChainUnavailableError('down');
    this.lastSim = q;
    return this.simRaw(q);
  }
  consume(key: bigint) {
    this.seq.set(key.toString(), (this.seq.get(key.toString()) ?? 0n) + 1n);
  }
}

export class FakeSubmitter implements Submitter {
  readonly kind = 'direct' as const;
  calls: PackedUserOperation[] = [];
  next: (op: PackedUserOperation, h: Hex) => SubmitResult = (_op, h) => ({ status: 'included', userOpHash: h, txHash: `0x${'ab'.repeat(32)}`, success: true, logs: [] });
  constructor(private chain?: FakeChain) {}
  async submit(op: PackedUserOperation, h: Hex) {
    this.calls.push(op);
    const r = this.next(op, h);
    if (r.status === 'included' && this.chain) this.chain.consume(op.nonce >> 64n);
    return r;
  }
}

export function testConfig(over: Record<string, string> = {}): ApprovalConfig {
  return loadApprovalConfig({ CHAIN_ID: '31337', ENTRYPOINT: ENTRYPOINT, RATE_LIMIT_MAX: '5', MAX_PENDING_PER_KEY: '3', ...over });
}

export function makeService(over: { chain?: FakeChain; submitter?: Submitter | null; cfg?: Record<string, string>; clock?: () => number } = {}) {
  const chain = over.chain ?? new FakeChain();
  const submitter = over.submitter === null ? undefined : (over.submitter ?? new FakeSubmitter(chain));
  let n = 0;
  const svc = new ApprovalService({ cfg: testConfig(over.cfg), store: new Store(), chain, submitter, newId: () => `req${++n}`, clock: over.clock ?? (() => NOW) });
  return { svc, chain, submitter: submitter as FakeSubmitter | undefined };
}

export function transferData(to: Address = PAYEE, amount = 5_000_000n): Hex {
  return encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [to, amount] });
}

export async function agentRequest(o: { seq?: bigint; key?: Hex; nonceKey?: bigint; data?: string; target?: Address; value?: bigint; note?: string; approval?: Hex } = {}) {
  const s = await signAgentOp({
    account: ACCOUNT,
    entryPoint: ENTRYPOINT,
    chainId: 31337,
    agentKey: o.key ?? KEYS.agent,
    nonce: makeNonce(o.nonceKey ?? LANE1_KEY, o.seq ?? 0n),
    call: { target: o.target ?? TOKEN, value: o.value, data: (o.data as Hex | undefined) ?? transferData() },
    approval: o.approval,
  });
  const userOp = Object.fromEntries(Object.entries(s.userOp).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
  return { body: { account: ACCOUNT, chainId: 31337, userOp, note: o.note ?? 'buy 5 USDC of API credits' }, signed: s };
}

export function policyBlockedLog(account: Address, userOpHash: Hex, reason: Hex): Log {
  const topics = encodeEventTopics({ abi: approvalAccountAbi, eventName: 'PolicyBlocked', args: { userOpHash, agentKey: AGENT, target: TOKEN } });
  const data = encodeAbiParameters([{ type: 'bytes4' }, { type: 'bytes' }], ['0xa9059cbb', reason]);
  return { address: account, topics: topics as [Hex, ...Hex[]], data, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false } as Log;
}
