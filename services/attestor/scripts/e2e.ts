/**
 * Attestor end-to-end on anvil, through the real HTTP service (BUILD.md M6 Done-when):
 *   coldStartUnproven  - a never-seen payee gets no attestation (404, UNPROVEN)
 *   agentOnlyIgnored   - agent-signed outcome reports are ignored (202) and change nothing
 *   provenAccepted     - 3 x402 purchases (on-chain Transfer + verifier delivery check) -> PROVEN
 *                        attestation, accepted by the wallet's on-chain check
 *   flaggedOnChain     - an owner-signed Sybil payment ring -> FLAGGED -> flag(payee) on the wallet
 *
 * Target wallet: by default test/anvil/AttestorStub.sol (CORE's TypedData.sol digest, not the real
 * account) and the result goes to results/m6_attestor_e2e_stub.json. INT points
 * E2E_TARGET_MODULE at a module whose default export is an E2ETarget for the real AgentAccount;
 * only then is results/m6_attestor_e2e.json written.
 *   pnpm --filter @hypnexis/attestor e2e
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { type Address, type Hex, createPublicClient, createWalletClient, getAddress, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deliveryCheckTypedData, outcomeTypedData } from '../../../packages/shared/src/attestor/typedData.ts';
import { createApp } from '../src/app.ts';
import { buildAttestor } from '../src/build.ts';
import { ACCOUNT_ABI, chainFor } from '../src/chain.ts';
import { loadAttestorConfig } from '../src/config.ts';
import { type Artifact, BUILD_ROOT, DEV_KEYS, type DevChain, compileStubs, deploy, findAnvil, findSolc, startAnvil } from './lib/devchain.ts';

export interface E2ETarget {
  name: string;
  realAccount: boolean;
  /** deploy a wallet whose owner is `ownerKey`'s address and whose attestor is `attestor`. */
  deployWallet(chain: DevChain, o: { ownerKey: Hex; attestor: Address }): Promise<Address>;
  /** true iff the wallet treats `payee` as PROVEN under `attestation` (the userOp.signature slot). */
  checkProven(chain: DevChain, wallet: Address, payee: Address, attestation: Hex): Promise<boolean>;
}

/** anvil dev keys #6-#8: x402 buyers (public test keys). */
const BUYER_KEYS: Hex[] = [
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
];

function stubTarget(stub: Artifact): E2ETarget {
  return {
    name: 'AttestorStub (services/attestor/test/anvil, digest from contracts/src/lib/TypedData.sol)',
    realAccount: false,
    deployWallet: (chain, o) => deploy(chain, stub, [o.attestor], o.ownerKey),
    async checkProven(chain, wallet, payee, attestation) {
      const pub = createPublicClient({ chain: chainFor(chain.chainId, chain.rpcUrl), transport: http(chain.rpcUrl) });
      const [ok] = (await pub.readContract({ address: wallet, abi: stub.abi, functionName: 'check', args: [payee, attestation] })) as [boolean, number];
      return ok;
    },
  };
}

async function main(): Promise<void> {
  const anvilBin = findAnvil();
  const solc = findSolc();
  if (!anvilBin || !solc) throw new Error('anvil and solc 0.8.28 are required (FOUNDRY_BIN / SOLC)');
  const arts = compileStubs(solc);
  const target: E2ETarget = process.env.E2E_TARGET_MODULE
    ? ((await import(pathToFileURL(process.env.E2E_TARGET_MODULE).href)) as { default: E2ETarget }).default
    : stubTarget(arts.stub);

  const chain = await startAnvil(anvilBin, 31337);
  const viemChain = chainFor(chain.chainId, chain.rpcUrl);
  const pub = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl), pollingInterval: 100 });
  const attestorAddr = privateKeyToAccount(DEV_KEYS.attestor).address;
  const details: Record<string, unknown> = {};
  let server: ReturnType<typeof serve> | undefined;
  try {
    const token = await deploy(chain, arts.token, [], DEV_KEYS.relayer);
    const wallet = await target.deployWallet(chain, { ownerKey: DEV_KEYS.deployerOwner, attestor: attestorAddr });
    // The attacker's own wallets (owner = attacker, attestor = attacker: they do not use ours).
    const ring: Address[] = [];
    for (let i = 0; i < 3; i++) ring.push(await deploy(chain, arts.stub, [privateKeyToAccount(DEV_KEYS.attacker).address], DEV_KEYS.attacker));

    const cfg = loadAttestorConfig({
      ATTESTOR_PRIVATE_KEY: DEV_KEYS.attestor,
      AGENT_PRIVATE_KEY: DEV_KEYS.agent,
      VERIFIER_ADDRESSES: privateKeyToAccount(DEV_KEYS.verifier).address,
      CHAIN_ID: String(chain.chainId),
      RPC_URL: chain.rpcUrl,
      WALLETS: wallet,
    } as NodeJS.ProcessEnv);
    const attestor = buildAttestor(cfg);
    const port = await new Promise<number>((res) => {
      server = serve({ fetch: createApp(attestor).fetch, port: 0, hostname: '127.0.0.1' }, (info) => res(info.port));
    });
    const base = `http://127.0.0.1:${port}`;
    const get = async (path: string) => {
      const r = await fetch(base + path);
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    const post = async (body: unknown) => {
      const r = await fetch(`${base}/v1/outcomes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    const signOutcome = async (key: Hex, source: 'owner' | 'verifier', w: Address, payee: Address, success: boolean, tag: string) => {
      const msg = { wallet: w, payee, success, ref: keccak256(toHex(tag)), asset: token, amount: 200_000n };
      const signature = await privateKeyToAccount(key).signTypedData(outcomeTypedData(chain.chainId, msg));
      return { source, outcome: { ...msg, amount: msg.amount.toString() }, signature };
    };

    const shop = getAddress('0x0000000000000000000000000000000000C0FFEE');

    // 1. cold start
    const cold = await get(`/v1/attest?wallet=${wallet}&payee=${shop}`);
    const coldStartUnproven = cold.status === 404 && cold.body.tier === 'UNPROVEN' && cold.body.code === null;
    details.coldStart = cold;

    // 2. agent-only reports are ignored
    const agentRes = [];
    for (let i = 0; i < 4; i++) agentRes.push((await post(await signOutcome(DEV_KEYS.agent, 'verifier', getAddress(`0x${'1'.repeat(39)}${i}`), shop, true, `agent${i}`))).status);
    agentRes.push((await post({ source: 'agent', wallet, payee: shop, success: true })).status);
    const afterAgent = await get(`/v1/attest?wallet=${wallet}&payee=${shop}`);
    const agentOnlyIgnored = agentRes.every((s) => s === 202) && afterAgent.status === 404 && attestor.store.outcomeCount() === 0;
    details.agentOnly = { statuses: agentRes, attestAfter: afterAgent.status };

    // 3. three x402 purchases -> PROVEN
    const x402Statuses = [];
    for (const [i, key] of BUYER_KEYS.entries()) {
      const buyer = privateKeyToAccount(key);
      const wc = createWalletClient({ account: buyer, chain: viemChain, transport: http(chain.rpcUrl) });
      const txHash = await wc.writeContract({ address: token, abi: arts.token.abi, functionName: 'transfer', args: [shop, 200_000n], account: buyer, chain: viemChain });
      await pub.waitForTransactionReceipt({ hash: txHash });
      const delivery = { wallet: buyer.address, payee: shop, txHash, httpStatus: 200, schemaOk: true };
      const signature = await privateKeyToAccount(DEV_KEYS.verifier).signTypedData(deliveryCheckTypedData(chain.chainId, delivery));
      const r = await post({
        source: 'x402',
        wallet: buyer.address,
        payee: shop,
        asset: token,
        amount: '200000',
        receipt: { success: true, transaction: txHash, network: 'anvil', payer: buyer.address },
        delivery: { httpStatus: 200, schemaOk: true, signature },
      });
      x402Statuses.push(r.status);
      if (i === 1) details.attestAfter2 = (await get(`/v1/attest?wallet=${wallet}&payee=${shop}`)).status;
    }
    const proven = await get(`/v1/attest?wallet=${wallet}&payee=${shop}`);
    const onChainOk = proven.status === 200 ? await target.checkProven(chain, wallet, shop, proven.body.attestation as Hex) : false;
    const provenAccepted = x402Statuses.every((s) => s === 200) && details.attestAfter2 === 404 && proven.status === 200 && onChainOk;
    details.proven = { x402Statuses, attest: proven.status, tier: proven.body.tier, validUntil: proven.body.validUntil, epoch: proven.body.epoch, onChainCheck: onChainOk };

    // 4. Sybil ring -> FLAGGED -> flag(payee) on the served wallet
    let k = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) await post(await signOutcome(DEV_KEYS.attacker, 'owner', ring[i]!, ring[(i + 1) % 3]!, true, `ring${k++}`));
    }
    const ringPayee = ring[1]!;
    const flaggedAttest = await get(`/v1/attest?wallet=${wallet}&payee=${ringPayee}`);
    const flaggedOnChainValue = (await pub.readContract({ address: wallet, abi: ACCOUNT_ABI, functionName: 'isFlagged', args: [ringPayee] })) as boolean;
    const flaggedOnChain = flaggedAttest.status === 404 && flaggedAttest.body.tier === 'FLAGGED' && flaggedOnChainValue;
    details.sybil = {
      attest: flaggedAttest.status,
      tier: flaggedAttest.body.tier,
      code: flaggedAttest.body.code,
      sybilRisk: attestor.profile(ringPayee).sybilRisk,
      flagTx: attestor.store.flagRow(wallet, ringPayee)?.txHash ?? null,
      flaggedOnChain: flaggedOnChainValue,
    };

    const result = {
      target: target.name,
      realAccount: target.realAccount,
      chainMode: 'local',
      chainId: chain.chainId,
      attestor: attestorAddr,
      wallet,
      provenAccepted,
      flaggedOnChain,
      coldStartUnproven,
      agentOnlyIgnored,
      ok: provenAccepted && flaggedOnChain && coldStartUnproven && agentOnlyIgnored,
      details,
      note: target.realAccount ? 'against the real AgentAccount' : 'against the TypedData.sol stub; INT re-runs with E2E_TARGET_MODULE for the real AgentAccount',
      generatedAt: new Date().toISOString(),
    };
    const outDir = join(BUILD_ROOT, 'results');
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, target.realAccount ? 'm6_attestor_e2e.json' : 'm6_attestor_e2e_stub.json');
    writeFileSync(file, `${JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
    console.log(`[e2e] ${result.ok ? 'ok' : 'FAIL'}: provenAccepted=${provenAccepted} flaggedOnChain=${flaggedOnChain} coldStartUnproven=${coldStartUnproven} agentOnlyIgnored=${agentOnlyIgnored} -> ${file}`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    server?.close();
    chain.stop();
  }
}

await main();
