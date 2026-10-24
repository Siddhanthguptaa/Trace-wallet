/**
 * Local self-test of the X3 builders against the real AgentAccount on anvil (no mainnet, no keys that
 * hold value): the owner tx pack applied from the OWNER key produces the intended policy; the voucher
 * body / digest / envelope the `pay` command builds are accepted by the account through the token's
 * ERC-1271 call and settle exactly once; the X-PAYMENT header round-trips.
 *   pnpm exec tsx scripts/x3/selftest.ts  ->  results/x3_selftest.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, keccak256, parseAbi, toBytes } from 'viem';
import { DEV, addr, chainNow } from '../lib/anvil.ts';
import { BUILD_ROOT } from '../lib/stack.ts';
import { signAgentOp, submitOps } from '../lib/ops.ts';
import { TICKET_PRICE, checker, makeWorld, sig65 } from '../lib/world.ts';
import { USDC_BASE, envelope, ownerTxPack, paymentHeader, twaDigest, voucherBody } from './x3.ts';

const erc1271 = parseAbi(['function isValidSignature(bytes32, bytes) view returns (bytes4)']);
const twaBytes = parseAbi(['function transferWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes)']);

async function main(): Promise<void> {
  const { checks, add } = checker();
  void TICKET_PRICE;
  const w = await makeWorld({ noTripwires: true, sig1271Mode: 1 });
  try {
    // ---- the owner tx pack, applied to a SECOND account from the owner key
    const owner = addr('owner');
    const payTo = addr('verifier');
    const agent = addr('agent2');
    const now = await chainNow(w.anvil.rpcUrl);
    const account2 = (await w.d.read<Address>(w.stack.factory, w.stack.abi.factory, 'getAddress', [owner, 99n])) as Address;
    const pack = ownerTxPack({ factory: w.stack.factory, owner, salt: 99n, account: account2, agent, payTo, now, ethDeposit: 10n ** 15n });
    let applied = 0;
    for (const t of pack) {
      const wc = (await import('viem')).createWalletClient({ account: (await import('viem/accounts')).privateKeyToAccount(DEV.owner), chain: (await import('../lib/stack.ts')).chainOf(w.anvil), transport: (await import('viem')).http(w.anvil.rpcUrl) });
      const h = await wc.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value), gas: 5_000_000n } as never);
      const r = await w.d.pub.waitForTransactionReceipt({ hash: h });
      if (r.status === 'success') applied++;
    }
    add('owner tx pack: every transaction succeeds from the owner key', String(pack.length), String(applied));
    const [sid] = await w.d.read<[bigint]>(account2, w.A, 'sessionOf', [agent]);
    add('owner tx pack: the agent session exists', 'true', String(sid !== 0n));
    add('owner tx pack: the pay-to address is a listed recipient', 'true', String(await w.d.read<boolean>(account2, w.A, 'isRecipient', [payTo])));
    add('owner tx pack: ERC-1271 mode is owner + x402 voucher', '1', String(await w.d.read<number>(account2, w.A, 'sig1271Mode')));

    // ---- voucher + envelope + settlement on the main world account
    const vb = BigInt(now + 540);
    const nonce = keccak256(toBytes('x3/selftest'));
    const v = { to: w.api, value: 5_000n, validAfter: 0n, validBefore: vb, nonce };
    const s = await signAgentOp(w.d, w.stack, w.chainId, { account: w.account, agentKey: DEV.agent, target: w.usdc, kind: 1, data: voucherBody(v) });
    const r = await submitOps(w.d, w.stack, [s.op], addr('relayer'), DEV.relayer);
    add('voucher: the op built with x3 voucherBody registers', 'registered', r.has('VoucherRegistered') ? 'registered' : `not registered (${r.reason ?? ''})`);
    const sep = await w.d.read<Hex>(w.usdc, w.usdcAbi, 'DOMAIN_SEPARATOR');
    const a = { from: w.account, to: w.api, value: 5_000n, validAfter: 0n, validBefore: vb, nonce };
    const digest = twaDigest(sep, a);
    const env = envelope(a, await sig65(DEV.agent, digest));
    add('pay: the x3 digest + envelope get the ERC-1271 magic value', '0x1626ba7e', await w.d.read<string>(w.account, erc1271 as never, 'isValidSignature', [digest, env]));
    const header = paymentHeader('base', env, a);
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString()) as { x402Version: number; scheme: string; payload: { signature: Hex; authorization: Record<string, string> } };
    add('pay: the X-PAYMENT header round-trips (x402Version 1, exact, same signature and authorization)', 'true', String(parsed.x402Version === 1 && parsed.scheme === 'exact' && parsed.payload.signature === env && parsed.payload.authorization.value === '5000' && parsed.payload.authorization.nonce === nonce));
    const bal0 = await w.usdcBalance(w.api);
    const settled = await w.d.send(w.usdc, twaBytes as never, 'transferWithAuthorization', [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, env], DEV.facilitator).then(() => true, () => false);
    add('pay: the token settles the payment through the contract signature', 'true/5000', `${settled}/${(await w.usdcBalance(w.api)) - bal0}`);
    add('pay: a second use of the same nonce is refused by the token', 'false', String(await w.d.send(w.usdc, twaBytes as never, 'transferWithAuthorization', [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, env], DEV.facilitator).then(() => true, () => false)));
    const ndg = twaDigest(sep, { ...a, to: addr('attacker'), nonce: keccak256(toBytes('x3/negative')) });
    add('verify: the agent signature with no voucher gets 0xffffffff', '0xffffffff', await w.d.read<string>(w.account, erc1271 as never, 'isValidSignature', [ndg, await sig65(DEV.agent, ndg)]));
    void USDC_BASE;

    const ok = checks.every((c) => c.pass);
    const out = { ok, passed: checks.filter((c) => c.pass).length, total: checks.length, checks, generatedAt: new Date().toISOString() };
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', 'x3_selftest.json'), `${JSON.stringify(out, null, 2)}\n`);
    for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
    console.log(`x3 selftest (local anvil): ${out.passed}/${out.total} ${ok ? 'ok' : 'FAILED'} -> results/x3_selftest.json`);
    if (!ok) process.exitCode = 1;
  } finally {
    w.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
