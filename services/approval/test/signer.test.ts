import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { approvalFromJson, outcomeApprovalTypedData, recoverApprovalSigner } from '../../../packages/shared/src/approval/index.ts';
import { createApp } from '../src/app.ts';
import { ANVIL_DEV_KEYS, KeyPolicyError, checkKeyPolicy, checkTypedData, formatDisplay, ownerSign, type TypedDataResponse } from '../src/ownerSigner.ts';
import { ACCOUNT, OWNER, agentRequest, makeService } from './helpers.ts';

describe('owner signer key policy [A18]', () => {
  it('anvil dev keys #0-#9 derive the well-known addresses', () => {
    expect(privateKeyToAccount(ANVIL_DEV_KEYS[0]!).address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(privateKeyToAccount(ANVIL_DEV_KEYS[9]!).address).toBe('0xa0Ee7A142d267C1f36714E4a8F75612F20a79720');
  });
  it('dev keys sign on any chain (fork mode = chainId 8453 on anvil); other keys only on testnets', () => {
    expect(() => checkKeyPolicy(ANVIL_DEV_KEYS[0]!, 8453)).not.toThrow();
    const k = generatePrivateKey();
    expect(() => checkKeyPolicy(k, 84532)).not.toThrow();
    expect(() => checkKeyPolicy(k, 31337)).not.toThrow();
    expect(() => checkKeyPolicy(k, 8453)).toThrow(KeyPolicyError);
    expect(() => checkKeyPolicy(k, 1)).toThrow(KeyPolicyError);
  });
});

describe('ownerSign against the HTTP app', () => {
  async function served() {
    const { svc } = makeService();
    const app = createApp(svc);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => app.request(String(url).replace('http://svc', ''), init)) as typeof fetch;
    await app.request('/v1/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify((await agentRequest()).body) });
    return { svc, app, fetchImpl };
  }

  it('checks, displays and signs; the service accepts and relays', async () => {
    const { svc, fetchImpl } = await served();
    const r = await ownerSign({ baseUrl: 'http://svc', id: 'req1', key: ANVIL_DEV_KEYS[0]!, fetchImpl, wait: true, expect: { account: ACCOUNT, chainId: 31337 } });
    expect(r.http).toBe(200);
    expect(r.body.status).toBe('executed');
    expect(r.signer).toBe(OWNER);
    expect(r.display).toContain('maxOutflow 5000000 of');
    expect(r.display).toContain('agent note (untrusted)');
    await svc.idle();
  });

  it('refuses above --max, for another account, and posts a rejection with --reject', async () => {
    const { fetchImpl } = await served();
    await expect(ownerSign({ baseUrl: 'http://svc', id: 'req1', key: ANVIL_DEV_KEYS[0]!, fetchImpl, maxAmount: 4_999_999n })).rejects.toThrow(/above --max/);
    await expect(
      ownerSign({ baseUrl: 'http://svc', id: 'req1', key: ANVIL_DEV_KEYS[0]!, fetchImpl, expect: { account: '0x0000000000000000000000000000000000000001' } }),
    ).rejects.toThrow(/another account/);
    const r = await ownerSign({ baseUrl: 'http://svc', id: 'req1', key: ANVIL_DEV_KEYS[0]!, fetchImpl, reject: true });
    expect(r.body).toEqual({ id: 'req1', status: 'rejected' });
  });

  it('checkTypedData catches a domain not bound to the message account / chain or a wrong approvalHash', async () => {
    const { app } = await served();
    const td = (await (await app.request('/v1/requests/req1/typed-data')).json()) as TypedDataResponse;
    expect(() => checkTypedData(td)).not.toThrow();
    expect(() => checkTypedData({ ...td, domain: { ...td.domain, verifyingContract: '0x0000000000000000000000000000000000000002' } })).toThrow(/verifyingContract/);
    expect(() => checkTypedData({ ...td, domain: { ...td.domain, chainId: 8453 } })).toThrow(/chainId/);
    expect(() => checkTypedData({ ...td, message: { ...td.message, maxOutflow: [] } })).toThrow(/approvalHash/);
    expect(formatDisplay(td)).toContain(ACCOUNT);
    const sig = await privateKeyToAccount(ANVIL_DEV_KEYS[0]!).signTypedData(outcomeApprovalTypedData(approvalFromJson(td.message)));
    expect(await recoverApprovalSigner(approvalFromJson(td.message), sig)).toBe(OWNER);
  });
});
