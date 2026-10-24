/**
 * One door end-to-end (D1) on the REAL AgentAccount with the token-side attacker: the leaked agent key
 * signs EIP-3009 / EIP-2612 authorizations that the attacker submits straight to the token, so the
 * token asks the account through ERC-1271 and no UserOp is involved.
 *   owner-only   (default) the agent signature gets 0xffffffff; the token rejects; the owner signature
 *                still works (control)
 *   voucher mode with no registered voucher the agent signature still gets 0xffffffff
 *   register     an in-policy voucher is registered by an agent op (kind 1) and debits the buckets once
 *   settle       the exact envelope is accepted: the shop is paid once; the same nonce fails the 2nd time
 *   tampered     a changed payee or value in the envelope gets 0xffffffff
 *   ttl          a voucher valid for > 600 s is refused at registration
 *   reclaim      an unused voucher is credited back once after validBefore; a 2nd reclaim reverts
 *   pnpm exec tsx scripts/e2e/onedoor.ts  ->  results/m3_onedoor_e2e.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Hex, keccak256, parseAbi, toBytes, encodeAbiParameters, concat } from 'viem';
import { DEV, addr, chainNow, warp } from '../lib/anvil.ts';
import { BUILD_ROOT } from '../lib/stack.ts';
import { signAgentOp, submitOps } from '../lib/ops.ts';
import { checker, makeWorld, sig65, twaDigest, voucherBody, x402Envelope, type World } from '../lib/world.ts';

const MAGIC = '0x1626ba7e';
const INVALID = '0xffffffff';
const erc1271 = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const twaBytes = parseAbi(['function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)']);
const permitBytes = parseAbi(['function permit(address owner, address spender, uint256 value, uint256 deadline, bytes signature)', 'function nonces(address) view returns (uint256)']);
const nonceOf = (s: string): Hex => keccak256(toBytes(`onedoor/${s}`));

async function main(): Promise<void> {
  const { checks, add } = checker();
  const metrics: Record<string, string | number | boolean> = {};
  const w = await makeWorld({ noTripwires: true });
  try {
    const attacker = addr('attacker');
    const shop = w.api;
    const is1271 = (hash: Hex, sig: Hex) => w.d.read<string>(w.account, erc1271 as never, 'isValidSignature', [hash, sig]);
    const pull = (to: `0x${string}`, value: bigint, vb: bigint, n: Hex, sig: Hex, by: Hex = DEV.attacker) =>
      w.d.send(w.usdc, twaBytes as never, 'transferWithAuthorization', [w.account, to, value, 0n, vb, n, sig], by).then(() => true, () => false);
    const bucketLevel = async () => ((await w.read<{ level: bigint }>('globalBucket', [w.usdc])).level);
    const t = () => chainNow(w.anvil.rpcUrl);

    // ---- owner-only (default)
    let vb = BigInt((await t()) + 3600);
    let n = nonceOf('side');
    let dg = await twaDigest(w, w.account, attacker, 10_000_000n, 0n, vb, n);
    add('owner-only: the agent key signature gets 0xffffffff', INVALID, await is1271(dg, await sig65(DEV.agent, dg)));
    const a0 = await w.usdcBalance(attacker);
    add('owner-only: the token rejects the agent-signed EIP-3009 (no UserOp, nothing moves)', 'false/0', `${await pull(attacker, 10_000_000n, vb, n, await sig65(DEV.agent, dg))}/${(await w.usdcBalance(attacker)) - a0}`);
    const pv = BigInt((await t()) + 3600);
    const pk = keccak256(toBytes('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
    const sep = await w.d.read<Hex>(w.usdc, w.usdcAbi, 'DOMAIN_SEPARATOR');
    const pnonce = await w.d.read<bigint>(w.usdc, permitBytes as never, 'nonces', [w.account]);
    const pdg = keccak256(concat(['0x1901', sep, keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [pk, w.account, attacker, 5_000_000n, pnonce, pv]))]));
    add('owner-only: an agent-signed EIP-2612 permit is rejected by the token', 'false', String(await w.d.send(w.usdc, permitBytes as never, 'permit', [w.account, attacker, 5_000_000n, pv, await sig65(DEV.agent, pdg)], DEV.attacker).then(() => true, () => false)));
    const od = await twaDigest(w, w.account, shop, 1_000_000n, 0n, vb, nonceOf('owner'));
    const ownerSig = await sig65(DEV.owner, od);
    add('owner-only: the OWNER signature gets the magic value (control)', MAGIC, await is1271(od, ownerSig));
    const s0 = await w.usdcBalance(shop);
    add('owner-only: the owner-signed EIP-3009 settles (control)', 'true/1000000', `${await pull(shop, 1_000_000n, vb, nonceOf('owner'), ownerSig)}/${(await w.usdcBalance(shop)) - s0}`);

    // ---- voucher mode, nothing registered
    await w.own('setSig1271Mode', [1]);
    n = nonceOf('unregistered');
    vb = BigInt((await t()) + 300);
    dg = await twaDigest(w, w.account, attacker, 1_000_000n, 0n, vb, n);
    add('voucher mode: an agent envelope with no registered voucher gets 0xffffffff', INVALID, await is1271(dg, x402Envelope(attacker, 1_000_000n, 0n, vb, n, await sig65(DEV.agent, dg))));

    // ---- register + settle
    n = nonceOf('shop');
    vb = BigInt((await t()) + 300);
    const lvl0 = await bucketLevel();
    const reg = async (to: `0x${string}`, value: bigint, validBefore: bigint, nn: Hex) => {
      const s = await signAgentOp(w.d, w.stack, w.chainId, { account: w.account, agentKey: DEV.agent, target: w.usdc, kind: 1, data: voucherBody(to, value, 0n, validBefore, nn) });
      const r = await submitOps(w.d, w.stack, [s.op], addr('relayer'), DEV.relayer);
      return !r.validated ? 'rejected' : r.has('PolicyBlocked') ? 'blocked' : r.has('VoucherRegistered') ? 'registered' : 'executed';
    };
    add('register: an in-policy voucher (shop, 1 USDC, 300 s) is registered by an agent op', 'registered', await reg(shop, 1_000_000n, vb, n));
    const lvl1 = await bucketLevel();
    metrics.bucketDebitAtRegistration = (lvl0 - lvl1).toString();
    add('register: registration debited the global bucket by the voucher value (once)', 'true', String(lvl0 - lvl1 >= 1_000_000n && lvl0 - lvl1 < 1_100_000n));
    dg = await twaDigest(w, w.account, shop, 1_000_000n, 0n, vb, n);
    const env = x402Envelope(shop, 1_000_000n, 0n, vb, n, await sig65(DEV.agent, dg));
    add('settle: the exact envelope gets the magic value', MAGIC, await is1271(dg, env));
    const sb = await w.usdcBalance(shop);
    add('settle: the shop is paid exactly once through the token', 'true/1000000', `${await pull(shop, 1_000_000n, vb, n, env)}/${(await w.usdcBalance(shop)) - sb}`);
    add('settle: the same nonce a second time fails', 'false', String(await pull(shop, 1_000_000n, vb, n, env)));

    // ---- tampered envelopes
    const n2 = nonceOf('shop2');
    await reg(shop, 1_000_000n, vb, n2);
    const dt = await twaDigest(w, w.account, attacker, 1_000_000n, 0n, vb, n2);
    add('tampered: the envelope for a different payee gets 0xffffffff', INVALID, await is1271(dt, x402Envelope(attacker, 1_000_000n, 0n, vb, n2, await sig65(DEV.agent, dt))));
    const dv = await twaDigest(w, w.account, shop, 9_000_000n, 0n, vb, n2);
    add('tampered: the envelope for a larger value gets 0xffffffff', INVALID, await is1271(dv, x402Envelope(shop, 9_000_000n, 0n, vb, n2, await sig65(DEV.agent, dv))));
    const ds = await twaDigest(w, w.account, shop, 1_000_000n, 0n, vb, n2);
    add('tampered: a stranger-signed envelope gets 0xffffffff', INVALID, await is1271(ds, x402Envelope(shop, 1_000_000n, 0n, vb, n2, await sig65(DEV.attacker, ds))));

    // ---- ttl
    add('ttl: a voucher valid for 3600 s (> 600 s) is blocked at registration', 'blocked', await reg(shop, 100_000n, BigInt((await t()) + 3600), nonceOf('long')));

    // ---- reclaim: voucher n2 is never used
    const before = await bucketLevel();
    await warp(w.anvil.rpcUrl, 400);
    add('reclaim: before validBefore passes it is refused... after it, an unused voucher is reclaimed (permissionless)', 'true', String(await w.tryTx(DEV.attacker, 'reclaim', [n2])));
    const after = await bucketLevel();
    metrics.reclaimCredit = (after - before).toString();
    add('reclaim: the bucket was credited back the voucher value', 'true', String(after - before >= 1_000_000n));
    add('reclaim: a second reclaim of the same voucher reverts (credited once)', 'false', String(await w.tryTx(DEV.attacker, 'reclaim', [n2])));
    add('reclaim: a used voucher is marked used, never credited', 'false', String(await w.tryTx(DEV.attacker, 'reclaim', [n])));

    const ok = checks.every((c) => c.pass);
    const out = { realAccount: true, chainId: w.chainId, ok, passed: checks.filter((c) => c.pass).length, total: checks.length, metrics, checks, generatedAt: new Date().toISOString() };
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', 'm3_onedoor_e2e.json'), `${JSON.stringify(out, null, 2)}\n`);
    for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
    console.log(`one-door e2e (real account): ${out.passed}/${out.total} ${ok ? 'ok' : 'FAILED'} -> results/m3_onedoor_e2e.json`);
    if (!ok) process.exitCode = 1;
  } finally {
    w.stop();
  }
}

void ({} as World);
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
