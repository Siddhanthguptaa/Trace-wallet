/**
 * On anvil, against test/anvil/AttestorStub.sol (digest from CORE's contracts/src/lib/TypedData.sol):
 *  - every vector digest equals the contract's; PROVEN vectors pass the on-chain check, the rest fail;
 *  - replays across chain, wallet, epoch and recipient fail (F25);
 *  - the flag sender flags on-chain, is idempotent, and skips wallets whose attestor is someone else;
 *  - the x402 receipt verifier reads real Transfer logs.
 * The end-to-end against the real AgentAccount is INT's (FASTPLAN). Skips if anvil or solc is missing.
 */
import { readFileSync } from 'node:fs';
import { type Address, type Hex, createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Artifact, DEV_KEYS, type DevChain, compileStubs, deploy, findAnvil, findSolc, startAnvil } from '../scripts/lib/devchain.ts';
import { VECTORS_PATH } from '../scripts/vectors.ts';
import { chainFor, viemChainAccess } from '../src/chain.ts';
import { FlagSender } from '../src/flagSender.ts';
import { Store } from '../src/store.ts';

const anvil = findAnvil();
const solc = findSolc();
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
const ATTESTOR = privateKeyToAccount(DEV_KEYS.attestor).address;

describe.skipIf(!anvil || !solc)('anvil: signer and flag sender against the TypedData.sol stub', { timeout: 30_000 }, () => {
  let local: DevChain;
  let base: DevChain;
  let arts: { stub: Artifact; token: Artifact };
  let stubA: Address;
  let stubB: Address;
  let stubBase: Address;
  const pubOf = (c: DevChain) => createPublicClient({ chain: chainFor(c.chainId, c.rpcUrl), transport: http(c.rpcUrl), pollingInterval: 100 });
  const read = <T>(c: DevChain, address: Address, functionName: string, args: unknown[] = []) =>
    pubOf(c).readContract({ address, abi: arts.stub.abi, functionName, args }) as Promise<T>;

  beforeAll(async () => {
    arts = compileStubs(solc!);
    [local, base] = await Promise.all([startAnvil(anvil!, 31337), startAnvil(anvil!, 8453)]);
    // Fresh anvil: deployer nonce 0 and 1 give the vectors' WALLET_A and WALLET_B.
    stubA = await deploy(local, arts.stub, [ATTESTOR]);
    stubB = await deploy(local, arts.stub, [ATTESTOR]);
    stubBase = await deploy(base, arts.stub, [ATTESTOR]);
  }, 60_000);
  afterAll(() => {
    local?.stop();
    base?.stop();
  });

  it('deploys at the vector wallets', () => {
    expect(stubA).toBe(getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3'));
    expect(stubB).toBe(getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512'));
    expect(stubBase).toBe(stubA);
  });

  it('every vector digest == TypedData.sol digest; on-chain check == expectProven (epoch 1)', async () => {
    let checked = 0;
    for (const c of vectors.cases) {
      const chain = c.chainId === '31337' ? local : c.chainId === '8453' ? base : null;
      if (!chain) continue;
      const wallet = getAddress(c.wallet);
      const d = await read<Hex>(chain, wallet, 'digestOf', [c.recipient, Number(c.tier), Number(c.validUntil), BigInt(c.epoch)]);
      expect(d, c.name).toBe(c.digest);
      const [proven, vu] = await read<[boolean, number]>(chain, wallet, 'check', [c.recipient, c.attestation]);
      const epochMatches = BigInt(c.epoch) === 1n;
      expect(proven, c.name).toBe(c.expectProven && epochMatches);
      if (proven) expect(Number(vu)).toBe(Number(c.validUntil));
      checked++;
    }
    expect(checked).toBe(vectors.cases.length);
  });

  it('replays fail: wrong chain, wrong wallet, wrong recipient, old epoch (F25)', async () => {
    const r = Object.fromEntries(vectors.replays.map((x: { name: string }) => [x.name, x]));
    const SHOP = r.replay_wrong_chain.checkRecipient;
    expect((await read<[boolean]>(base, stubBase, 'check', [SHOP, r.replay_wrong_chain.attestation]))[0]).toBe(false);
    expect((await read<[boolean]>(local, stubB, 'check', [SHOP, r.replay_wrong_wallet.attestation]))[0]).toBe(false);
    expect((await read<[boolean]>(local, stubA, 'check', [r.replay_wrong_recipient.checkRecipient, r.replay_wrong_recipient.attestation]))[0]).toBe(false);
    // Owner bumps the epoch on stub B: an epoch-1 attestation for B dies, an epoch-2 one lives.
    const c = chainFor(local.chainId, local.rpcUrl);
    const owner = privateKeyToAccount(DEV_KEYS.deployerOwner);
    const wc = createWalletClient({ account: owner, chain: c, transport: http(local.rpcUrl) });
    const caseB = vectors.cases.find((x: { name: string }) => x.name === 'proven_wallet_b');
    expect((await read<[boolean]>(local, stubB, 'check', [caseB.recipient, caseB.attestation]))[0]).toBe(true);
    const h = await wc.writeContract({ address: stubB, abi: arts.stub.abi, functionName: 'bumpEpoch', args: [], account: owner, chain: c });
    await pubOf(local).waitForTransactionReceipt({ hash: h });
    expect((await read<[boolean]>(local, stubB, 'check', [caseB.recipient, caseB.attestation]))[0]).toBe(false);
  });

  it('flag sender: flag(payee) lands on-chain, second call is "already", foreign wallets are skipped', async () => {
    const payee = getAddress('0x00000000000000000000000000000000000BAD01');
    const access = viemChainAccess({ rpcUrl: local.rpcUrl, chainId: 31337, attestorKey: DEV_KEYS.attestor });
    const store = new Store();
    const fs = new FlagSender({ store, writer: access.writer, reader: access.reader, attestor: ATTESTOR });
    expect(await read<boolean>(local, stubA, 'isFlagged', [payee])).toBe(false);
    const r1 = await fs.ensureFlagged(stubA, payee);
    expect(r1.status).toBe('sent');
    expect(await read<boolean>(local, stubA, 'isFlagged', [payee])).toBe(true);
    expect((await fs.ensureFlagged(stubA, payee)).status).toBe('already');
    // A wallet whose attestor is the agent key: our flag would revert, so the sender skips it.
    const foreign = await deploy(local, arts.stub, [privateKeyToAccount(DEV_KEYS.agent).address]);
    expect(await fs.ensureFlagged(foreign, payee)).toMatchObject({ status: 'skipped', reason: 'not_this_wallets_attestor' });
    // Without the reader pre-check the contract itself refuses a non-attestor caller (I10 shape).
    const rogue = viemChainAccess({ rpcUrl: local.rpcUrl, chainId: 31337, attestorKey: DEV_KEYS.attacker });
    const fsRogue = new FlagSender({ store: new Store(), writer: rogue.writer, reader: null, attestor: privateKeyToAccount(DEV_KEYS.attacker).address });
    expect((await fsRogue.ensureFlagged(stubA, getAddress('0x00000000000000000000000000000000000BAD02'))).status).toBe('error');
  });

  it('receipt verifier: accepts a matching Transfer log, rejects wrong payee / amount / unknown tx', async () => {
    const token = await deploy(local, arts.token, []);
    const c = chainFor(local.chainId, local.rpcUrl);
    const buyer = privateKeyToAccount(DEV_KEYS.relayer);
    const wc = createWalletClient({ account: buyer, chain: c, transport: http(local.rpcUrl) });
    const shop = getAddress('0x000000000000000000000000000000000000bEEF');
    const hash = await wc.writeContract({ address: token, abi: arts.token.abi, functionName: 'transfer', args: [shop, 200_000n], account: buyer, chain: c });
    await pubOf(local).waitForTransactionReceipt({ hash });
    const { receipts } = viemChainAccess({ rpcUrl: local.rpcUrl, chainId: 31337 });
    const ok = await receipts.verify({ wallet: buyer.address, payee: shop, asset: token, amount: 200_000n, txHash: hash });
    expect(ok.ok).toBe(true);
    expect(await receipts.verify({ wallet: buyer.address, payee: stubA, asset: token, amount: 1n, txHash: hash })).toMatchObject({ ok: false, reason: 'no_matching_transfer' });
    expect(await receipts.verify({ wallet: buyer.address, payee: shop, asset: token, amount: 200_001n, txHash: hash })).toMatchObject({ ok: false });
    expect(await receipts.verify({ wallet: buyer.address, payee: shop, asset: stubA, amount: 1n, txHash: hash })).toMatchObject({ ok: false });
    expect(await receipts.verify({ wallet: buyer.address, payee: shop, asset: token, amount: 1n, txHash: `0x${'ab'.repeat(32)}` })).toMatchObject({ ok: false, reason: 'tx_not_found' });
  });
});
