/**
 * Approval end-to-end on anvil through the real HTTP service (BUILD.md M5 Done-when):
 *   approved - agent files order(1) at the shop; simulation fills maxOutflow; the owner signs with the
 *              CLI (scripts/owner-sign.ts, spawned); relayed; executed; on-chain outflow == maxOutflow
 *   tampered - the shop raises its price by 1 base unit after the owner signed: measured outflow =
 *              maxOutflow + 1 -> blocked in execution (PolicyBlocked, nothing moved) -> "reverted"
 *   replay   - (a) the executed op re-sent, (b) its approval slot on a new op with the next nonce,
 *              (c) its owner signature posted for a new request: all rejected -> "rejected"
 *   extra    - PAYEE-rule transfer (payee from ruleOf) executes; a foreign-key request is refused
 *
 * Target: by default the stub (test/anvil/ApprovalStub.sol + EntryPoint v0.8) and the result goes
 * to results/m5_approval_e2e_stub.json (realAccount: false). INT sets E2E_TARGET_MODULE to a module
 * whose default export is an E2ETarget for the real AgentAccount; only then is
 * results/m5_approval_e2e.json (the BUILD M5 Done-when file) written.
 *   pnpm --filter @hypnexis/approval e2e
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { type Address, type Hex, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOpHashV08 } from '@hypnexis/shared';
import {
  DirectSubmitter,
  decodeApprovalSlot,
  decodeSignatureEnvelope,
  encodeSignatureEnvelope,
  nextApprovalNonce,
  signAgentOp,
} from '../../../packages/shared/src/approval/index.ts';
import { createApp } from '../src/app.ts';
import { buildService } from '../src/build.ts';
import { loadApprovalConfig } from '../src/config.ts';
import { parseUserOp } from '../src/service.ts';
import { type TypedDataResponse, ownerSign, signTypedDataResponse } from '../src/ownerSigner.ts';
import { BUILD_ROOT, DEV_KEYS, SVC_ROOT, clients, findAnvil, findSolc, startAnvil } from './lib/devchain.ts';
import { type E2ETarget, compileStubWorld, shopAbi, stubTarget, tokenAbi } from './lib/stubTarget.ts';

async function loadTarget(): Promise<E2ETarget> {
  const mod = process.env.E2E_TARGET_MODULE;
  if (mod) return (await import(pathToFileURL(mod).href)).default as E2ETarget;
  const solc = findSolc();
  if (!solc) throw new Error('solc 0.8.28 is required for the stub target (SOLC)');
  return stubTarget(compileStubWorld(solc));
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/owner-sign.ts', ...args], { cwd: SVC_ROOT });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += String(d)));
    p.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => p.kill(), 120_000);
    p.on('close', (status) => {
      clearTimeout(timer);
      ok({ status, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const anvilBin = findAnvil();
  if (!anvilBin) throw new Error('anvil is required (FOUNDRY_BIN)');
  const target = await loadTarget();
  const chain = await startAnvil(anvilBin);
  const details: Record<string, unknown> = {};
  let server: ReturnType<typeof serve> | undefined;
  try {
    const keys = { owner: DEV_KEYS.owner, agent: DEV_KEYS.agent, shop: DEV_KEYS.shop };
    const w = await target.setup(chain, keys);
    const cfg = loadApprovalConfig({
      CHAIN_ID: String(chain.chainId),
      RPC_URL: chain.rpcUrl,
      ENTRYPOINT: w.entryPoint,
      RELAYER_PRIVATE_KEY: DEV_KEYS.relayer,
    });
    const svc = buildService(cfg, (m) => console.log(`[approval] ${m}`));
    const port = await new Promise<number>((ok) => {
      server = serve({ fetch: createApp(svc).fetch, port: 0, hostname: '127.0.0.1' }, (info) => ok(info.port));
    });
    const base = `http://127.0.0.1:${port}`;
    const { pub } = clients(chain, DEV_KEYS.owner);
    const agent = privateKeyToAccount(DEV_KEYS.agent).address;
    const bal = (who: Address) => pub.readContract({ address: w.token, abi: tokenAbi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
    const http = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const jsonOp = (op: Record<string, unknown>) => Object.fromEntries(Object.entries(op).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
    const orderData = encodeFunctionData({ abi: shopAbi, functionName: 'order', args: [1n] });
    const file = async (call: { target: Address; data: Hex }, key: Hex = DEV_KEYS.agent, note = 'e2e') => {
      const nonce = await nextApprovalNonce(pub as never, w.account, agent, w.entryPoint);
      const s = await signAgentOp({ account: w.account, entryPoint: w.entryPoint, chainId: chain.chainId, agentKey: key, nonce, call });
      return { signed: s, res: await http('POST', '/v1/requests', { account: w.account, chainId: chain.chainId, userOp: jsonOp(s.userOp as never), note }) };
    };
    const status = async (id: string) => (await http('GET', `/v1/requests/${id}`)).body;

    // ---- approved (owner CLI, spawned)
    const shop0 = await bal(w.shop);
    const acct0 = await bal(w.account);
    const a = await file({ target: w.shop, data: orderData }, DEV_KEYS.agent, 'buy 1 ticket (agent text, untrusted)');
    if (a.res.status !== 201) throw new Error(`approved: create failed ${JSON.stringify(a.res.body)}`);
    const aId = a.res.body.id as string;
    // async spawn: the service runs in this process, so the event loop must stay free to serve the CLI
    const cli = await runCli(['--id', aId, '--url', base, '--dev-key', '0', '--wait', '--account', w.account, '--chain-id', String(chain.chainId)]);
    const aStatus = await status(aId);
    const simOut = BigInt(a.res.body.simulation.outflows[0]?.amount ?? 0);
    const measured = acct0 - (await bal(w.account));
    details.approved = {
      id: aId,
      cliExit: cli.status,
      cliStdout: cli.stdout.trim().split('\n').pop(),
      status: aStatus.status,
      txHash: aStatus.txHash,
      simulatedOutflow: simOut.toString(),
      measuredOutflow: measured.toString(),
      shopReceived: ((await bal(w.shop)) - shop0).toString(),
      maxOutflow: aStatus.maxOutflow,
    };
    const approved = cli.status === 0 && aStatus.status === 'executed' && measured === simOut && simOut === w.price ? 'executed' : `failed:${aStatus.status}`;

    // ---- PAYEE-rule transfer (payee from ruleOf), signed programmatically
    const p = await file({ target: w.token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [w.payee, 500_000n] }) });
    const pSign = p.res.status === 201 ? await ownerSign({ baseUrl: base, id: p.res.body.id, key: DEV_KEYS.owner, wait: true }) : null;
    details.payeeTransfer = { create: p.res.status, payee: p.res.body.payee, expectedPayee: w.payee, status: pSign?.body.status, payeeBalance: (await bal(w.payee)).toString() };
    const payeeOk = p.res.body.payee === w.payee && pSign?.body.status === 'executed' && (await bal(w.payee)) === 500_000n;

    // ---- tampered: price +1 after the owner signed
    const t = await file({ target: w.shop, data: orderData });
    if (t.res.status !== 201) throw new Error(`tampered: create failed ${JSON.stringify(t.res.body)}`);
    const tId = t.res.body.id as string;
    const td = (await http('GET', `/v1/requests/${tId}/typed-data`)).body as TypedDataResponse;
    const tSig = await signTypedDataResponse(td, DEV_KEYS.owner);
    await w.setPrice(w.price + 1n);
    const tAcct0 = await bal(w.account);
    const tRes = await http('POST', `/v1/requests/${tId}/signature?wait=1`, { signature: tSig });
    const tMoved = tAcct0 - (await bal(w.account));
    await w.setPrice(w.price);
    details.tampered = { id: tId, maxOutflow: td.message.maxOutflow, realPrice: (w.price + 1n).toString(), status: tRes.body.status, blocked: tRes.body.blocked, success: tRes.body.success, reason: tRes.body.reason, moved: tMoved.toString() };
    const tampered = tRes.body.status === 'reverted' && tMoved === 0n ? 'reverted' : `failed:${tRes.body.status}`;

    // ---- replay
    const final = (await http('GET', `/v1/requests/${aId}/userop`)).body;
    const finalOp = parseUserOp(final.userOp);
    const sub = new DirectSubmitter({ rpcUrl: chain.rpcUrl, chainId: chain.chainId, entryPoint: w.entryPoint, relayerKey: DEV_KEYS.relayer });
    const r1 = await sub.submit(finalOp, final.userOpHash);
    const nextNonce = await nextApprovalNonce(pub as never, w.account, agent, w.entryPoint);
    const fresh = await signAgentOp({ account: w.account, entryPoint: w.entryPoint, chainId: chain.chainId, agentKey: DEV_KEYS.agent, nonce: nextNonce, call: { target: w.shop, data: orderData } });
    const oldApproval = decodeSignatureEnvelope(finalOp.signature).approval;
    const replayOp = { ...fresh.userOp, signature: encodeSignatureEnvelope({ sig: decodeSignatureEnvelope(fresh.userOp.signature).sig, approval: oldApproval }) };
    const r2 = await sub.submit(replayOp, getUserOpHashV08(replayOp, w.entryPoint, chain.chainId));
    const c = await file({ target: w.shop, data: orderData });
    const ownerSigOld = decodeApprovalSlot(oldApproval).ownerSig;
    const r3 = c.res.status === 201 ? await http('POST', `/v1/requests/${c.res.body.id}/signature`, { signature: ownerSigOld }) : { status: c.res.status, body: c.res.body };
    details.replay = {
      resendExecutedOp: { status: r1.status, reason: r1.reason },
      oldApprovalOnNewOp: { status: r2.status, reason: r2.reason },
      oldOwnerSigOnNewRequest: { http: r3.status, code: r3.body?.error?.code },
    };
    const replay = r1.status === 'rejected' && r2.status === 'rejected' && r3.status === 401 ? 'rejected' : 'failed';

    // ---- foreign key request
    const f = await file({ target: w.shop, data: orderData }, DEV_KEYS.attacker);
    details.foreignKey = { http: f.res.status, code: f.res.body?.error?.code };
    const foreignOk = f.res.status >= 400 && f.res.status < 500;

    await svc.idle();
    const ok = approved === 'executed' && tampered === 'reverted' && replay === 'rejected' && payeeOk && foreignOk;
    const out = {
      target: target.name,
      realAccount: target.realAccount,
      chainMode: 'local',
      chainId: chain.chainId,
      approved,
      tampered,
      replay,
      payeeTransfer: payeeOk ? 'executed' : 'failed',
      foreignKeyRefused: foreignOk,
      ok,
      details,
    };
    const file_ = target.realAccount ? 'm5_approval_e2e.json' : 'm5_approval_e2e_stub.json';
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', file_), `${JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
    console.log(`approval e2e (${target.realAccount ? 'real account' : 'stub'}): approved=${approved} tampered=${tampered} replay=${replay} payee=${payeeOk} foreign=${foreignOk} -> results/${file_}`);
    if (!ok) process.exitCode = 1;
  } finally {
    server?.close();
    chain.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
