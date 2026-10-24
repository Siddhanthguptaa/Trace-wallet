import { describe, expect, it } from 'vitest';
import { type Hex, encodeErrorResult, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  REASON,
  RULE_OP,
  decodeApprovalSlot,
  decodeSignatureEnvelope,
  makeNonce,
  outcomeApprovalTypedData,
  approvalFromJson,
} from '../../../packages/shared/src/approval/index.ts';
import { createApp } from '../src/app.ts';
import { describeRevert, rejectMessage } from '../src/service.ts';
import {
  ACCOUNT,
  AGENT,
  FakeChain,
  FakeSubmitter,
  KEYS,
  LANE1_KEY,
  NOW,
  OWNER,
  PAYEE,
  TOKEN,
  agentRequest,
  makeService,
  policyBlockedLog,
} from './helpers.ts';

async function call(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function ownerSig(app: ReturnType<typeof createApp>, id: string, key: Hex = KEYS.owner) {
  const td = await call(app, 'GET', `/v1/requests/${id}/typed-data`);
  const a = approvalFromJson(td.body.message);
  return privateKeyToAccount(key).signTypedData(outcomeApprovalTypedData(a));
}

function setup(over: Parameters<typeof makeService>[0] = {}) {
  const m = makeService(over);
  return { ...m, app: createApp(m.svc) };
}

describe('POST /v1/requests', () => {
  it('accepts an agent-signed lane-1 op: simulation fills maxOutflow, payee from the PAYEE rule', async () => {
    const { app, chain } = setup();
    chain.rules.set(`${TOKEN.toLowerCase()}:0xa9059cbb`, { allowed: true, rules: [{ argIndex: 0, op: RULE_OP.PAYEE, bound: 0n }] });
    const { body } = await agentRequest();
    const r = await call(app, 'POST', '/v1/requests', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'req1', status: 'pending', agentKey: AGENT, payee: PAYEE, validUntil: NOW + 3600 });
    expect(r.body.simulation).toMatchObject({ mode: 'eth_call', ok: true, outflows: [{ asset: TOKEN, amount: '5000000' }] });
    expect(r.body.preflight).toMatchObject({ reason: 'APPROVAL' });
    const td = await call(app, 'GET', '/v1/requests/req1/typed-data');
    expect(td.body).toMatchObject({ primaryType: 'OutcomeApproval', domain: { name: 'AgentAccount', version: '1', chainId: 31337, verifyingContract: ACCOUNT } });
    expect(td.body.message).toMatchObject({ account: ACCOUNT, chainId: '31337', target: TOKEN, selector: '0xa9059cbb', payee: PAYEE, maxOutflow: [{ asset: TOKEN, amount: '5000000' }] });
    expect(td.body.message.nonce).toBe(makeNonce(LANE1_KEY, 0n).toString());
    expect(td.body.display.noteUntrusted).toBe('buy 5 USDC of API credits');
  });

  it('without a PAYEE rule the payee is the zero address (matches call.payee)', async () => {
    const { app } = setup();
    const r = await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect(r.body.payee).toBe('0x0000000000000000000000000000000000000000');
  });

  it('clamps validUntil to the session expiry', async () => {
    const { app, chain } = setup();
    chain.sessions.get(AGENT.toLowerCase())!.validUntil = NOW + 100;
    const r = await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect(r.body.validUntil).toBe(NOW + 100);
  });

  it('refuses non-agent signers, wrong lane, stale key, prefilled approval slot, wrong chain', async () => {
    const { app } = setup();
    const notAgent = await agentRequest({ key: KEYS.attacker, nonceKey: LANE1_KEY });
    expect((await call(app, 'POST', '/v1/requests', notAgent.body)).body.error.code).toBe('NONCE_KEY_MISMATCH');
    const attackerKey = (BigInt(privateKeyToAccount(KEYS.attacker).address) << 32n) | 1n;
    const noSession = await agentRequest({ key: KEYS.attacker, nonceKey: attackerKey });
    const ns = await call(app, 'POST', '/v1/requests', noSession.body);
    expect([ns.status, ns.body.error.code]).toEqual([403, 'NO_SESSION']);
    const lane0 = await agentRequest({ nonceKey: LANE1_KEY - 1n });
    expect((await call(app, 'POST', '/v1/requests', lane0.body)).body.error.code).toBe('WRONG_LANE');
    const stale = await agentRequest({ nonceKey: (BigInt(AGENT) << 32n) | (0x999n << 8n) | 1n });
    expect((await call(app, 'POST', '/v1/requests', stale.body)).body.error.code).toBe('STALE_NONCE_KEY');
    const pre = await agentRequest({ approval: '0x1234' });
    expect((await call(app, 'POST', '/v1/requests', pre.body)).body.error.code).toBe('APPROVAL_SLOT_SET');
    const wc = await agentRequest();
    expect((await call(app, 'POST', '/v1/requests', { ...wc.body, chainId: 8453 })).body.error.code).toBe('WRONG_CHAIN');
  });

  it('refuses a tampered op (callData changed after the agent signed): signature recovers a non-session key', async () => {
    const { app } = setup();
    const { body } = await agentRequest();
    const tampered = { ...body, userOp: { ...body.userOp, callData: (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(64) })).body.userOp.callData } };
    const r = await call(app, 'POST', '/v1/requests', tampered);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(['NONCE_KEY_MISMATCH', 'BAD_AGENT_SIGNATURE']).toContain(r.body.error.code);
  });

  it('refuses stale and future nonces and duplicates', async () => {
    const { app, chain } = setup();
    const first = await agentRequest();
    expect((await call(app, 'POST', '/v1/requests', first.body)).status).toBe(201);
    const dup = await call(app, 'POST', '/v1/requests', first.body);
    expect([dup.status, dup.body.error.code, dup.body.error.id]).toEqual([409, 'DUPLICATE', 'req1']);
    expect((await call(app, 'POST', '/v1/requests', (await agentRequest({ seq: 1n })).body)).body.error.code).toBe('NONCE_GAP');
    chain.consume(LANE1_KEY);
    chain.consume(LANE1_KEY);
    expect((await call(app, 'POST', '/v1/requests', (await agentRequest({ seq: 1n })).body)).body.error.code).toBe('STALE_NONCE');
  });

  it('preflight refusals an approval cannot waive (TARGET, ARG_RULE, FROZEN) return 422 with the reason', async () => {
    const { app, chain } = setup();
    chain.policyReason = REASON.ARG_RULE | (1 << 8);
    let r = await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect([r.status, r.body.error.code, r.body.error.reason]).toEqual([422, 'POLICY_REFUSED', 'ARG_RULE(1)']);
    chain.policyReason = REASON.FROZEN;
    r = await call(app, 'POST', '/v1/requests', (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(63) + '01' })).body);
    expect(r.body.error.reason).toBe('FROZEN');
    chain.policyReason = 17;
    chain.rules.set(`${TOKEN.toLowerCase()}:0xa9059cbb`, { allowed: false, rules: [] });
    r = await call(app, 'POST', '/v1/requests', (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(62) + '0002' })).body);
    expect(r.body.error.reason).toBe('TARGET');
  });

  it('a call that reverts in simulation is refused (422) and nothing is stored', async () => {
    const { app, chain, svc } = setup();
    chain.simRaw = () => ({ ok: false, ret: '0x08c379a0', nativeOut: 0n, tokenOut: [], nftOut: [], gasUsed: 1n });
    const r = await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect([r.status, r.body.error.code]).toEqual([422, 'SIMULATION_REVERTED']);
    expect((await svc.list({})).requests).toEqual([]);
  });

  it('simulation includes tracked assets, extra assets and the decoded token; declared mode uses the decoded amount', async () => {
    const extra = '0x5555555555555555555555555555555555555555';
    const { app, chain } = setup({ cfg: { EXTRA_TRACKED_ASSETS: extra } });
    chain.trackedLists = { assets: [], spenders: [], nfts: [] };
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect(chain.lastSim!.tokens.map((t) => t.toLowerCase())).toEqual([extra, TOKEN.toLowerCase()]);
    const d = setup({ cfg: { SIMULATION_MODE: 'declared' } });
    const r = await call(d.app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect(r.body.simulation).toMatchObject({ mode: 'declared', outflows: [{ asset: TOKEN, amount: '5000000' }] });
    expect(d.chain.lastSim).toBeUndefined();
  });

  it('chain down -> 503 and the attempt is not counted', async () => {
    const { app, chain, svc } = setup();
    chain.down = true;
    const r = await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect(r.status).toBe(503);
    expect((await svc.keyStats(AGENT, ACCOUNT)).attempts).toBe(0);
  });
});

describe('rate limit per session key', () => {
  it('counts every attributed attempt (accepted or refused) in the window and answers 429', async () => {
    const { app, svc } = setup({ cfg: { RATE_LIMIT_MAX: '3', MAX_PENDING_PER_KEY: '10' } });
    expect((await call(app, 'POST', '/v1/requests', (await agentRequest()).body)).status).toBe(201);
    expect((await call(app, 'POST', '/v1/requests', (await agentRequest({ seq: 5n })).body)).status).toBe(400);
    expect((await call(app, 'POST', '/v1/requests', (await agentRequest({ seq: 6n })).body)).status).toBe(400);
    const r = await call(app, 'POST', '/v1/requests', (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(63) + '07' })).body);
    expect([r.status, r.body.error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(await svc.keyStats(AGENT, ACCOUNT)).toMatchObject({ attempts: 3, accepted: 1, refused: 2, rateLimited: 1, pending: 1 });
  });

  it('window slides: attempts older than the window stop counting', async () => {
    let t = NOW;
    const { app } = setup({ cfg: { RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_SECONDS: '60' }, clock: () => t });
    expect((await call(app, 'POST', '/v1/requests', (await agentRequest()).body)).status).toBe(201);
    const second = await agentRequest({ data: '0xa9059cbb' + '00'.repeat(63) + '09' });
    expect((await call(app, 'POST', '/v1/requests', second.body)).status).toBe(429);
    t += 61;
    expect((await call(app, 'POST', '/v1/requests', second.body)).status).toBe(201);
  });

  it('caps pending requests per key', async () => {
    const { app } = setup({ cfg: { RATE_LIMIT_MAX: '50', MAX_PENDING_PER_KEY: '2' } });
    for (const v of ['01', '02']) expect((await call(app, 'POST', '/v1/requests', (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(63) + v })).body)).status).toBe(201);
    const r = await call(app, 'POST', '/v1/requests', (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(63) + '03' })).body);
    expect(r.body.error.code).toBe('TOO_MANY_PENDING');
  });
});

describe('owner signature, relay and status', () => {
  it('owner signature -> approved -> relayed with the approval slot -> executed', async () => {
    const { app, svc, submitter } = setup();
    const { body, signed } = await agentRequest();
    await call(app, 'POST', '/v1/requests', body);
    const sig = await ownerSig(app, 'req1');
    const r = await call(app, 'POST', '/v1/requests/req1/signature', { signature: sig });
    expect(r.body).toEqual({ id: 'req1', status: 'approved' });
    await svc.idle();
    const st = await call(app, 'GET', '/v1/requests/req1');
    expect(st.body).toMatchObject({ id: 'req1', status: 'executed', success: true, blocked: false, userOpHash: signed.userOpHash });
    const sent = submitter!.calls[0]!;
    const env = decodeSignatureEnvelope(sent.signature);
    expect(env.sig).toBe(decodeSignatureEnvelope(signed.userOp.signature).sig);
    const slot = decodeApprovalSlot(env.approval);
    expect(slot.ownerSig).toBe(sig);
    expect(slot.approval.maxOutflow).toEqual([{ asset: TOKEN, amount: 5_000_000n }]);
    const fin = await call(app, 'GET', '/v1/requests/req1/userop');
    expect(fin.body.userOp.signature).toBe(sent.signature);
  });

  it('?wait=1 returns the final status', async () => {
    const { app } = setup();
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    const r = await call(app, 'POST', '/v1/requests/req1/signature?wait=1', { signature: await ownerSig(app, 'req1') });
    expect(r.body.status).toBe('executed');
  });

  it('a signature by anyone but the on-chain owner is refused (401) and the request stays pending', async () => {
    const { app } = setup();
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    for (const k of [KEYS.agent, KEYS.attacker]) {
      const r = await call(app, 'POST', '/v1/requests/req1/signature', { signature: await ownerSig(app, 'req1', k) });
      expect([r.status, r.body.error.code]).toEqual([401, 'NOT_OWNER']);
    }
    expect((await call(app, 'GET', '/v1/requests/req1')).body.status).toBe('pending');
  });

  it('replayed owner signature (from an executed request) does not approve a new request', async () => {
    const { app, svc } = setup();
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    const sig = await ownerSig(app, 'req1');
    await call(app, 'POST', '/v1/requests/req1/signature', { signature: sig });
    await svc.idle();
    expect((await call(app, 'POST', '/v1/requests/req1/signature', { signature: sig })).body.error.code).toBe('NOT_PENDING');
    await call(app, 'POST', '/v1/requests', (await agentRequest({ seq: 1n })).body);
    const r = await call(app, 'POST', '/v1/requests/req2/signature', { signature: sig });
    expect([r.status, r.body.error.code]).toEqual([401, 'NOT_OWNER']);
  });

  it('PolicyBlocked in the receipt -> reverted (nothing moved), reason decoded', async () => {
    const chain = new FakeChain();
    const sub = new FakeSubmitter(chain);
    const { app, svc } = setup({ chain, submitter: sub });
    const reason = encodeErrorResult({ abi: parseAbi(['error PolicyViolation(uint16 reason)']), errorName: 'PolicyViolation', args: [17] });
    sub.next = (_op, h) => ({ status: 'included', userOpHash: h, txHash: `0x${'cd'.repeat(32)}`, success: true, logs: [policyBlockedLog(ACCOUNT, h, reason)] });
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    await call(app, 'POST', '/v1/requests/req1/signature', { signature: await ownerSig(app, 'req1') });
    await svc.idle();
    const st = (await call(app, 'GET', '/v1/requests/req1')).body;
    expect(st).toMatchObject({ status: 'reverted', success: true, blocked: true });
    expect(st.reason).toContain('PolicyViolation(APPROVAL)');
  });

  it('target revert (success=false) -> reverted; FailedOp -> rejected; preflight failure -> rejected without relay', async () => {
    const chain = new FakeChain();
    const sub = new FakeSubmitter(chain);
    const { app, svc } = setup({ chain, submitter: sub, cfg: { MAX_PENDING_PER_KEY: '9', RATE_LIMIT_MAX: '9' } });
    sub.next = (_op, h) => ({ status: 'included', userOpHash: h, success: false, logs: [] });
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    await call(app, 'POST', '/v1/requests/req1/signature', { signature: await ownerSig(app, 'req1') });
    await svc.idle();
    expect((await call(app, 'GET', '/v1/requests/req1')).body).toMatchObject({ status: 'reverted', reason: 'target_reverted' });

    sub.next = (_op, h) => ({ status: 'rejected', userOpHash: h, reason: 'AA24 signature error' });
    await call(app, 'POST', '/v1/requests', (await agentRequest({ seq: 1n })).body);
    await call(app, 'POST', '/v1/requests/req2/signature', { signature: await ownerSig(app, 'req2') });
    await svc.idle();
    expect((await call(app, 'GET', '/v1/requests/req2')).body).toMatchObject({ status: 'rejected', reason: 'AA24 signature error' });

    chain.checkReason = REASON.GAS_CREDIT;
    const before = sub.calls.length;
    await call(app, 'POST', '/v1/requests', (await agentRequest({ seq: 1n, data: '0xa9059cbb' + '00'.repeat(63) + '05' })).body);
    await call(app, 'POST', '/v1/requests/req3/signature', { signature: await ownerSig(app, 'req3') });
    await svc.idle();
    expect((await call(app, 'GET', '/v1/requests/req3')).body).toMatchObject({ status: 'rejected', reason: 'preflight checkUserOp: GAS_CREDIT' });
    expect(sub.calls.length).toBe(before);
  });

  it('without a relayer the request stays approved and the signed op is served for anyone to relay', async () => {
    const { app, svc } = setup({ submitter: null });
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    await call(app, 'POST', '/v1/requests/req1/signature', { signature: await ownerSig(app, 'req1') });
    await svc.idle();
    const st = (await call(app, 'GET', '/v1/requests/req1')).body;
    expect(st.status).toBe('approved');
    expect(st.reason).toMatch(/no_relayer/);
    expect((await call(app, 'GET', '/v1/requests/req1/userop')).status).toBe(200);
  });

  it('executing one request rejects its same-nonce siblings; pending requests expire after validUntil', async () => {
    const { app, svc, chain } = setup();
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    await call(app, 'POST', '/v1/requests', (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(63) + '11' })).body);
    await call(app, 'POST', '/v1/requests', (await agentRequest({ data: '0xa9059cbb' + '00'.repeat(63) + '12' })).body);
    await call(app, 'POST', '/v1/requests/req1/signature', { signature: await ownerSig(app, 'req1') });
    await svc.idle();
    expect((await call(app, 'GET', '/v1/requests/req2')).body).toMatchObject({ status: 'rejected', reason: 'nonce_consumed' });
    chain.t = NOW + 3601;
    const late = await call(app, 'POST', '/v1/requests/req3/signature', { signature: '0x' + '11'.repeat(65) });
    expect(late.body.error.code).toBe('NOT_PENDING');
    expect((await call(app, 'GET', '/v1/requests/req3')).body.status).toMatch(/expired|rejected/);
  });

  it('a pending request expires once chain time passes validUntil; signing it is refused', async () => {
    const { app, chain } = setup();
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    const sig = await ownerSig(app, 'req1');
    chain.t = NOW + 3601;
    expect((await call(app, 'GET', '/v1/requests/req1')).body.status).toBe('expired');
    expect((await call(app, 'POST', '/v1/requests/req1/signature', { signature: sig })).body.error).toMatchObject({ code: 'NOT_PENDING', status: 'expired' });
  });

  it('owner can reject with an EIP-191 signature; others cannot', async () => {
    const { app } = setup();
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    const bad = await privateKeyToAccount(KEYS.agent).signMessage({ message: rejectMessage('req1') });
    expect((await call(app, 'POST', '/v1/requests/req1/reject', { signature: bad })).status).toBe(401);
    const good = await privateKeyToAccount(KEYS.owner).signMessage({ message: rejectMessage('req1') });
    expect((await call(app, 'POST', '/v1/requests/req1/reject', { signature: good })).body).toEqual({ id: 'req1', status: 'rejected' });
    expect((await call(app, 'GET', '/v1/requests/req1')).body).toMatchObject({ status: 'rejected', reason: 'owner_rejected' });
  });

  it('404 for unknown ids, 400 for bad JSON, health shape, list filter', async () => {
    const { app } = setup();
    expect((await call(app, 'GET', '/v1/requests/nope')).status).toBe(404);
    const res = await app.request('/v1/requests', { method: 'POST', body: '{' });
    expect(res.status).toBe(400);
    expect((await call(app, 'GET', '/health')).body).toMatchObject({ service: '@hypnexis/approval', ok: true, status: 'ready', chainId: 31337 });
    await call(app, 'POST', '/v1/requests', (await agentRequest()).body);
    expect((await call(app, 'GET', `/v1/requests?account=${ACCOUNT}&status=pending`)).body.requests.length).toBe(1);
    expect((await call(app, 'GET', '/v1/requests?status=bogus')).status).toBe(400);
    expect(OWNER).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('describeRevert names known errors', () => {
    const e = encodeErrorResult({ abi: parseAbi(['error BucketExceeded(uint256 amount, uint256 available)']), errorName: 'BucketExceeded', args: [5n, 4n] });
    expect(describeRevert(e)).toBe('BucketExceeded(5,4)');
    expect(describeRevert('0xdeadbeef')).toBe('error 0xdeadbeef');
  });
});
