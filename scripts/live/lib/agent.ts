/**
 * The agent / attacker side of the live demo. Everything is submitted as a real UserOp straight to
 * EntryPoint.handleOps from the relayer EOA (no bundler on testnet, no tools pre-check): that is what
 * a hijacker holding the leaked agent key can do. Each operation prints its transaction link, whether
 * it was PAID or refused / undone, the running attacker total against the daily limit, and KEY FROZEN.
 */
import { type Address, type Hex, concat, encodeAbiParameters, encodeFunctionData, formatUnits, keccak256, maxUint256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { type OpGas, signAgentOp, submitOps, type Submitted } from '../../lib/ops.ts';
import { type Stack, accountAbi } from '../../lib/stack.ts';
import { decodeReason } from '../../../agent/src/ops/reasons.ts';
import { nextApprovalNonce, signAgentOp as signRequestOp } from '../../../packages/shared/src/approval/agentClient.ts';
import { encodeAttestation, scoreAttestationTypedData } from '../../../packages/shared/src/attestor/typedData.ts';
import { erc1271Abi, fetchJson, liveOpGas, loadState, makeDeployer, publicClient, saveState, sleep, stackOf, usdcAbi } from './chainio.ts';
import { txUrl } from './chains.ts';
import type { Live } from './envfile.ts';

// ---------------------------------------------------------------- output

const color = process.env.NO_COLOR ? false : true;
const c = (code: number, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
export const green = (s: string) => c(32, s);
export const red = (s: string) => c(31, s);
export const yellow = (s: string) => c(33, s);
export const bold = (s: string) => c(1, s);
export const dim = (s: string) => c(2, s);
const usd = (x: bigint, d = 6) => `${Number(formatUnits(x, d)).toFixed(2)} USDC`;

export interface Ctx {
  L: Live;
  stack: Stack;
  d: ReturnType<typeof makeDeployer>;
  gas: OpGas;
  account: Address;
  log: (m: string) => void;
}

export async function makeCtx(L: Live, log: (m: string) => void = console.log): Promise<Ctx> {
  if (!L.account) throw new Error('ACCOUNT is empty in .env.live: run `live.ts deploy` first');
  return { L, stack: stackOf(L), d: makeDeployer(L), gas: await liveOpGas(L), account: L.account, log };
}

const pubOf = (x: Ctx) => publicClient(x.L);
const rd = <T>(x: Ctx, fn: string, args: unknown[] = []) => pubOf(x).readContract({ address: x.account, abi: accountAbi(), functionName: fn, args } as never) as Promise<T>;
const usdcBal = (x: Ctx, a: Address) => pubOf(x).readContract({ address: x.L.usdc, abi: usdcAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
const ZERO = '0x0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- one op

export type OpStatus = 'PAID' | 'UNDONE' | 'REFUSED' | 'REVERTED';
export interface OpOutcome {
  status: OpStatus;
  txHash?: Hex;
  reason?: string;
  frozen: boolean;
  paid: bigint;
}

const REASON_TEXT: Record<string, string> = {
  FROZEN: 'the key is frozen',
  EXPLORE_PER_TX: 'unknown payee: over the per-payment exploration cap',
  EXPLORE_BUCKET: 'unknown payee: exploration budget used up',
  GLOBAL_BUCKET: 'the account-wide daily limit is used up',
  KEY_BUCKET: 'this key’s daily limit is used up',
  PER_TX: 'over the per-payment cap',
  RECIPIENT: 'not a listed recipient',
  ARG_RULE: 'an argument rule of the policy forbids it',
  TARGET: 'the policy does not allow that contract / function',
  GAS_CREDIT: 'the gas credit is used up',
  EXPIRED: 'the permission expired',
  REVOKED: 'the key is revoked',
};

function explainRevert(text: string): string {
  const m = /PolicyViolation\((\d+)\)/.exec(text);
  if (m) {
    const d = decodeReason(Number(m[1]));
    return `${d.name}${REASON_TEXT[d.name] ? ` (${REASON_TEXT[d.name]})` : ''}`;
  }
  const t = /TripwireTripped\((\d+)\)/.exec(text);
  if (t) return `TRIPWIRE ${t[1] === '0' ? '(new-payee spray / canary)' : '(velocity)'} -> key frozen`;
  for (const name of Object.keys(REASON_TEXT)) if (text.includes(name)) return `${name} (${REASON_TEXT[name]})`;
  return text.slice(0, 160);
}

function classify(sub: Submitted): OpOutcome {
  const frozen = sub.has('AgentFrozen');
  if (!sub.validated) return { status: 'REFUSED', reason: explainRevert(sub.reason ?? 'rejected before inclusion'), frozen, paid: 0n };
  const blocked = sub.events.find((e) => e.eventName === 'PolicyBlocked');
  if (blocked) {
    let reason = 'blocked in execution, spend undone';
    try {
      const data = blocked.args.reason as Hex;
      const dec = accountAbi();
      // PolicyViolation(uint16) / TripwireTripped(uint8) are account errors
      reason = explainRevert(`${decodeAccountError(data, dec)}`);
    } catch {
      /* keep generic */
    }
    return { status: 'UNDONE', txHash: sub.txHash, reason, frozen, paid: 0n };
  }
  if (!sub.success) return { status: 'REVERTED', txHash: sub.txHash, reason: 'the call itself reverted', frozen, paid: 0n };
  const decision = sub.events.find((e) => e.eventName === 'Decision');
  const outflows = (decision?.args.outflows as { asset: Address; amount: bigint }[] | undefined) ?? [];
  return { status: 'PAID', txHash: sub.txHash, frozen, paid: outflows.reduce((a, o) => a + o.amount, 0n) };
}

import { decodeErrorResult, type Abi } from 'viem';
function decodeAccountError(data: Hex, abi: Abi): string {
  const d = decodeErrorResult({ abi, data });
  return `${d.errorName}(${(d.args ?? []).map(String).join(',')})`;
}

async function sendAgentOp(x: Ctx, o: { target: Address; data: Hex; attestation?: Hex }): Promise<OpOutcome> {
  const { op } = await signAgentOp(x.d, x.stack, x.L.chainId, { account: x.account, agentKey: x.L.agentKey, target: o.target, data: o.data, gas: x.gas, attestation: o.attestation });
  const sub = await submitOps(x.d, x.stack, [op], x.L.addr.deployer, x.L.deployerKey);
  return classify(sub);
}

// ---------------------------------------------------------------- attacker accounting

export async function attackerTotal(x: Ctx): Promise<bigint> {
  let t = await usdcBal(x, x.L.addr.attacker);
  for (const a of loadState().spray) t += await usdcBal(x, a);
  return t;
}

export interface Limits {
  dailyLimit: bigint;
  explorePerTx: bigint;
  exploreCap: bigint;
  perTx: bigint;
}
export async function readLimits(x: Ctx): Promise<Limits> {
  const g = await rd<{ burst: bigint; ratePerDay: bigint }>(x, 'globalBucket', [x.L.usdc]);
  const e = await rd<{ burst: bigint; ratePerDay: bigint }>(x, 'exploreBucket', [x.L.usdc]);
  const k = await rd<{ perTxCap: bigint }>(x, 'keyAsset', [x.L.addr.agent, x.L.usdc]);
  return { dailyLimit: g.burst + g.ratePerDay, explorePerTx: await rd<bigint>(x, 'explorePerTxCap', [x.L.usdc]), exploreCap: e.burst + e.ratePerDay, perTx: k.perTxCap };
}

const isFrozen = (x: Ctx) => rd<boolean>(x, 'isFrozen', [x.L.addr.agent]);

async function requireLiveAgent(x: Ctx): Promise<void> {
  const [sid, s] = await rd<[bigint, { revoked: boolean; validUntil: number }]>(x, 'sessionOf', [x.L.addr.agent]);
  if (sid === 0n) throw new Error('the agent key has no session on the account: the owner must run "5. Give the agent a session key" in the console');
  if (s.revoked) throw new Error('the agent key is REVOKED');
}

export interface AttackSummary {
  attack: string;
  ops: number;
  paidOps: number;
  gain: bigint;
  frozenAtOp: number | null;
  dailyLimit: bigint;
  withinLimit: boolean;
  lines: string[];
}

/** Print a live line and keep it for the summary. */
function mk(x: Ctx) {
  const lines: string[] = [];
  return {
    lines,
    say: (m: string) => {
      lines.push(m.replace(/\u001b\[[0-9;]*m/g, ''));
      x.log(m);
    },
  };
}

async function loop(
  x: Ctx,
  name: string,
  n: number,
  limits: Limits,
  next: (i: number) => { label: string; amount: bigint; target: Address; data: Hex; attestation?: Hex; spray?: Address },
  opts: { keepGoing?: boolean } = {},
): Promise<AttackSummary> {
  const { say, lines } = mk(x);
  const base = await attackerTotal(x);
  let paidOps = 0;
  let frozenAt: number | null = null;
  let i = 0;
  for (i = 1; i <= n; i++) {
    const spec = next(i);
    if (spec.spray) {
      const st = loadState();
      if (!st.spray.includes(spec.spray)) st.spray.push(spec.spray);
      saveState(st);
    }
    const out = await sendAgentOp(x, spec);
    const gain = (await attackerTotal(x)) - base;
    if (out.status === 'PAID') paidOps++;
    const tag = out.status === 'PAID' ? green('PAID    ') : out.status === 'UNDONE' ? yellow('UNDONE  ') : red('REFUSED ');
    const link = out.txHash ? `  ${dim(txUrl(x.L.explorer, out.txHash))}` : '';
    say(`    op ${String(i).padStart(2)}  ${spec.label.padEnd(26)} ${tag} ${out.reason ? `${out.reason}  ` : ''}-> attacker holds ${bold(usd(gain))} of the ${usd(limits.dailyLimit)} daily limit${out.frozen ? '  ' + red(bold('KEY FROZEN')) : ''}${link}`);
    if (out.frozen && frozenAt === null) frozenAt = i;
    if (out.status === 'REFUSED' && /FROZEN|no session|REVOKED/.test(out.reason ?? '')) {
      frozenAt ??= i;
      break;
    }
    if (out.frozen && !opts.keepGoing) break;
    await sleep(400);
  }
  const gain = (await attackerTotal(x)) - base;
  const sum: AttackSummary = { attack: name, ops: Math.min(i, n), paidOps, gain, frozenAtOp: frozenAt, dailyLimit: limits.dailyLimit, withinLimit: gain <= limits.dailyLimit, lines };
  say(`  => ${bold(name)}: attacker gained ${bold(usd(gain))} in ${sum.ops} op(s)${frozenAt ? `, key frozen at op ${frozenAt}` : ', key not frozen'}; daily limit ${usd(limits.dailyLimit)} ${sum.withinLimit ? green('(bound held)') : red('(BOUND EXCEEDED)')}`);
  const st = loadState();
  st.attackLog.push({ at: new Date().toISOString(), attack: name, summary: `gain ${usd(gain)}, frozen at ${frozenAt ?? '-'}` });
  saveState(st);
  return sum;
}

// ---------------------------------------------------------------- usdc calldata

const transferData = (to: Address, amount: bigint): Hex => encodeFunctionData({ abi: usdcAbi, functionName: 'transfer', args: [to, amount] });
const APPROVE_ABI = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const approveData = (to: Address, amount: bigint): Hex => encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [to, amount] });

// ---------------------------------------------------------------- attacks

/** Attack A: pay an unknown (unproven) attacker address, as fast as possible. */
export async function attackUnproven(x: Ctx): Promise<AttackSummary> {
  await requireLiveAgent(x);
  const lim = await readLimits(x);
  x.log(bold(`ATTACK unproven: the leaked key pays ${x.L.addr.attacker} (an address nobody vouched for), ${usd(lim.explorePerTx)} at a time`));
  return loop(x, 'unproven drain', 12, lim, (i) => ({ label: `pay ${usd(lim.explorePerTx)}`, amount: lim.explorePerTx, target: x.L.usdc, data: transferData(x.L.addr.attacker, lim.explorePerTx) }));
}

/** The attestor key leaked too: forge a PROVEN attestation for the attacker and drain at the normal limits. */
export async function forgeAttestation(x: Ctx, payee: Address): Promise<Hex> {
  const epoch = await rd<bigint>(x, 'attestEpoch');
  const block = await pubOf(x).getBlock();
  const msg = { recipient: payee, tier: 1, validUntil: Number(block.timestamp) + 20 * 3600, epoch };
  const signature = await privateKeyToAccount(x.L.attestorKey).signTypedData(scoreAttestationTypedData(x.L.chainId, x.account, msg));
  return encodeAttestation({ ...msg, signature });
}

export async function attackForged(x: Ctx): Promise<AttackSummary> {
  await requireLiveAgent(x);
  const lim = await readLimits(x);
  const onchain = await rd<Address>(x, 'attestor');
  if (onchain.toLowerCase() !== x.L.addr.attestor.toLowerCase()) x.log(yellow('  note: the account does not trust this attestor yet (console step 6), so the forged attestation will be ignored'));
  const att = await forgeAttestation(x, x.L.addr.attacker);
  x.log(bold(`ATTACK forged: the attestor key leaked too, so ${x.L.addr.attacker} reads as PROVEN. Drain at the normal limits.`));
  const bal = await usdcBal(x, x.account);
  const amounts = [0.9, 0.8, 0.7, 0.6, 0.5, 0.9, 0.8, 0.7, 0.6, 0.5, 0.9, 0.8, 0.7, 0.6].map((f) => (lim.perTx * BigInt(Math.round(f * 100))) / 100n);
  return loop(x, 'forged-PROVEN drain', amounts.length, lim, (i) => {
    const a = amounts[i - 1]! > bal ? bal : amounts[i - 1]!;
    return { label: `pay ${usd(a)}`, amount: a, target: x.L.usdc, data: transferData(x.L.addr.attacker, a), attestation: att };
  });
}

/** Spray fresh addresses (each one unknown): trips the new-payee tripwire. */
export async function attackSpray(x: Ctx): Promise<AttackSummary> {
  await requireLiveAgent(x);
  const lim = await readLimits(x);
  x.log(bold('ATTACK spray: the leaked key pays many brand-new addresses'));
  const targets = Array.from({ length: 10 }, () => privateKeyToAccount(generatePrivateKey()).address);
  const amt = (lim.explorePerTx * 6n) / 10n;
  return loop(x, 'new-payee spray', targets.length, lim, (i) => ({ label: `pay fresh #${i}`, amount: amt, target: x.L.usdc, data: transferData(targets[i - 1]!, amt), spray: targets[i - 1]! }));
}

/** approve(attacker, MAX) to launder the limit: refused by the policy. */
export async function attackApproveMax(x: Ctx): Promise<AttackSummary> {
  await requireLiveAgent(x);
  const lim = await readLimits(x);
  x.log(bold('ATTACK approve-MAX: the leaked key approves the attacker for the whole balance'));
  return loop(x, 'approve MAX', 1, lim, () => ({ label: 'approve(attacker, MAX)', amount: 0n, target: x.L.usdc, data: approveData(x.L.addr.attacker, maxUint256) }));
}

/** EIP-3009 side door: a signature from the leaked key, submitted straight to the token. No UserOp. */
export async function attackSideDoor(x: Ctx): Promise<AttackSummary> {
  const lim = await readLimits(x);
  const { say, lines } = mk(x);
  say(bold('ATTACK side door: the leaked key signs an EIP-3009 transferWithAuthorization(from = the account), the attacker submits it to USDC itself (no UserOp, no EntryPoint)'));
  const pub = pubOf(x);
  const value = (await usdcBal(x, x.account)) > 5_000_000n ? 5_000_000n : await usdcBal(x, x.account);
  const block = await pub.getBlock();
  const validBefore = BigInt(Number(block.timestamp) + 3600);
  const nonce = keccak256(toBytes(`side-door:${Date.now()}`));
  const domain = (await pub.readContract({ address: x.L.usdc, abi: usdcAbi, functionName: 'DOMAIN_SEPARATOR' })) as Hex;
  const typehash = keccak256(toBytes('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));
  const structHash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [typehash, x.account, x.L.addr.attacker, value, 0n, validBefore, nonce]));
  const digest = keccak256(concat(['0x1901', domain, structHash]));
  const sig = await sign({ hash: digest, privateKey: x.L.agentKey, to: 'hex' });
  const answer = (await pub.readContract({ address: x.account, abi: erc1271Abi, functionName: 'isValidSignature', args: [digest, sig] })) as Hex;
  say(`    the token asks the account (ERC-1271) whether the agent key's signature is valid; the account answers ${bold(answer)} ${answer === '0xffffffff' ? green('(NO)') : red('(YES: the side door is open!)')}`);
  const before = await attackerTotal(x);
  let reverted = false;
  let reason = '';
  try {
    await pub.simulateContract({ address: x.L.usdc, abi: usdcAbi, functionName: 'transferWithAuthorization', args: [x.account, x.L.addr.attacker, value, 0n, validBefore, nonce, sig], account: x.L.addr.deployer });
  } catch (e) {
    reverted = true;
    reason = ((e as Error).message.split('\n').find((l) => /revert|reason|invalid/i.test(l)) ?? (e as Error).message.split('\n')[0]!).trim().slice(0, 160);
  }
  if (!reverted) {
    // not expected: the account would have accepted it. Send it for real so the loss is measured, not assumed.
    const h = await x.d.send(x.L.usdc, usdcAbi, 'transferWithAuthorization', [x.account, x.L.addr.attacker, value, 0n, validBefore, nonce, sig], x.L.deployerKey);
    say(`    ${red('SENT')} ${dim(txUrl(x.L.explorer, h))}`);
  } else say(`    the token rejects it before any transaction: ${red('REFUSED')} (${reason || 'invalid signature'})`);
  const gain = (await attackerTotal(x)) - before;
  say(`  => side door: attacker gained ${bold(usd(gain))}; daily limit ${usd(lim.dailyLimit)} ${gain === 0n ? green('(nothing moved)') : red('(MONEY MOVED)')}`);
  return { attack: 'side door', ops: 1, paidOps: gain > 0n ? 1 : 0, gain, frozenAtOp: null, dailyLimit: lim.dailyLimit, withinLimit: gain <= lim.dailyLimit, lines };
}

/** Wait (live) until the owner unfreezes the key in the console. */
export async function waitForUnfreeze(x: Ctx, maxMinutes = 15): Promise<boolean> {
  if (!(await isFrozen(x))) return true;
  x.log(yellow(bold('  >>> the key is FROZEN. Owner: open the console and press "Unfreeze the agent key" in MetaMask. Waiting...')));
  const deadline = Date.now() + maxMinutes * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (!(await isFrozen(x))) {
      x.log(green('  the owner unfroze the key; continuing'));
      return true;
    }
  }
  return false;
}

export async function runAll(x: Ctx): Promise<AttackSummary[]> {
  const out: AttackSummary[] = [];
  out.push(await attackSideDoor(x));
  out.push(await attackApproveMax(x));
  out.push(await attackUnproven(x));
  if (!(await waitForUnfreeze(x))) {
    x.log(red('  the owner did not unfreeze within 15 minutes; stopping'));
    return out;
  }
  out.push(await attackForged(x));
  return out;
}

// ---------------------------------------------------------------- legit

/** An in-policy payment. With --attested the real attestor service is asked for an attestation first. */
export async function agentPay(x: Ctx, to: Address, amount: bigint, useAttestation: boolean): Promise<OpOutcome> {
  await requireLiveAgent(x);
  let attestation: Hex | undefined;
  if (useAttestation) {
    const r = await fetchJson<{ attestation?: string; tier?: string; reason?: string }>(`${x.L.urls.attestor}/v1/attest?wallet=${x.account}&payee=${to}&chainId=${x.L.chainId}`, undefined, 8000).catch(() => null);
    if (r?.ok && r.body.attestation) {
      attestation = r.body.attestation as Hex;
      x.log(`  the real attestor service vouches for ${to}: tier ${green('PROVEN')} (signed attestation attached)`);
    } else x.log(`  the attestor does not vouch for ${to} (${r ? `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}` : 'service unreachable'}): paying as an UNKNOWN payee`);
  }
  const out = await sendAgentOp(x, { target: x.L.usdc, data: transferData(to, amount), attestation });
  const tag = out.status === 'PAID' ? green('PAID') : red(out.status);
  x.log(`  pay ${usd(amount)} -> ${to}: ${tag}${out.reason ? ` (${out.reason})` : ''}${out.txHash ? `  ${dim(txUrl(x.L.explorer, out.txHash))}` : ''}`);
  return out;
}

// ---------------------------------------------------------------- approval request (out-of-policy)

export async function fileApprovalRequest(x: Ctx, to: Address, amount: bigint, note: string): Promise<{ id?: string; status: number; body: unknown }> {
  await requireLiveAgent(x);
  const pub = pubOf(x);
  const nonce = await nextApprovalNonce(pub as never, x.account, x.L.addr.agent, x.L.entryPoint);
  const g = x.gas;
  const s = await signRequestOp({
    account: x.account,
    entryPoint: x.L.entryPoint,
    chainId: x.L.chainId,
    agentKey: x.L.agentKey,
    nonce,
    call: { target: x.L.usdc, data: transferData(to, amount) },
    gas: { callGasLimit: g.callGasLimit, verificationGasLimit: g.verificationGasLimit + 30_000n, preVerificationGas: g.preVerificationGas, maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: g.maxPriorityFeePerGas },
  });
  const jsonOp = Object.fromEntries(Object.entries(s.userOp).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
  const r = await fetchJson<{ id?: string }>(`${x.L.urls.approval}/v1/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: x.account, chainId: x.L.chainId, userOp: jsonOp, note }) }, 30_000);
  // The approval service reports nothing to the watcher by itself; the agent tools layer does (docs/api.md 12.2).
  await fetchJson(`${x.L.urls.watcher}/v1/approval-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: x.account, agentKey: x.L.addr.agent }) }, 5000).catch(() => null);
  return { id: r.body?.id, status: r.status, body: r.body };
}

export { ZERO };
