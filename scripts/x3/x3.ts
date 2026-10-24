/**
 * X3: a real x402 payment on Base mainnet from the agent account with a CONTRACT signature
 * (EXPERIMENTS X3, docs/x3_runbook.md). USER-RUN. Nothing here holds the owner key: `plan` prints the
 * owner transactions for MetaMask; the agent key is a fresh throwaway; every command that would send
 * a transaction or a payment is a dry run unless --send is passed.
 *
 *   x3.ts agent-key                       generate the throwaway agent key (scripts/x3/.agent.key, git-ignored)
 *   x3.ts plan   --owner 0x.. --pay-to 0x.. [--salt 1] [--eth 0.002]   owner tx pack -> scripts/x3/owner_txs.json
 *   x3.ts voucher [--send]                register the voucher (agent op, kind 1) via an EOA handleOps
 *   x3.ts pay    [--send]                 the 402 dance against $TRACE_X402_URL with the one-door envelope
 *   x3.ts verify --tx 0x..                receipt checks + the three negative checks (read-only)
 *
 * Env: BASE_RPC (default https://mainnet.base.org), TRACE_X402_URL (the live endpoint, POST),
 * RELAYER_KEY (an EOA with a little Base ETH; only for --send), plus deployments/8453.json from
 * scripts/deploy.ts --allow-mainnet (factory, entryPoint).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toBytes,
  encodeAbiParameters,
  concat,
  defineChain,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { BUILD_ROOT, accountAbi, loadArtifact } from '../lib/stack.ts';
import { RULE_OP, TRANSFER, agentOpCallData, policyInput } from '../lib/policy.ts';
import { agentEnvelope, nonceKeyOf, opHash, unsignedOp } from '../lib/ops.ts';

export const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const EP_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const DIR = join(BUILD_ROOT, 'scripts', 'x3');
const STATE = join(DIR, 'state.json');
const KEY_FILE = join(DIR, '.agent.key');
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (n: string) => process.argv.includes(n);

const usdcAbi = parseAbi([
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address, bytes32) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const erc1271 = parseAbi(['function isValidSignature(bytes32, bytes) view returns (bytes4)']);

// ------------------------------------------------------------------ pure builders (unit-tested by selftest.ts)

/** EIP-3009 TransferWithAuthorization digest in the token's own domain separator. */
export function twaDigest(domainSeparator: Hex, a: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }): Hex {
  const typehash = keccak256(toBytes('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      [typehash, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}
/** The one-door envelope: abi.encode(1, to, value, validAfter, validBefore, nonce, agentSig) (docs/api.md 4.6). */
export function envelope(a: { to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }, agentSig: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes' }],
    [1, a.to, a.value, a.validAfter, a.validBefore, a.nonce, agentSig],
  );
}
export const voucherBody = (a: { to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }): Hex =>
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [a.to, a.value, a.validAfter, a.validBefore, a.nonce]);

/** x402 "exact" X-PAYMENT header: base64 JSON { x402Version, scheme, network, payload }. */
export function paymentHeader(network: string, signature: Hex, a: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }): string {
  const authorization = { from: a.from, to: a.to, value: a.value.toString(), validAfter: a.validAfter.toString(), validBefore: a.validBefore.toString(), nonce: a.nonce };
  return Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network, payload: { signature, authorization } })).toString('base64');
}

/** The owner transactions for MetaMask (the owner key never enters this repo). */
export function ownerTxPack(o: {
  factory: Address;
  owner: Address;
  salt: bigint;
  account: Address;
  agent: Address;
  payTo: Address;
  now: number;
  ethDeposit: bigint;
  topUp?: bigint;
}): { to: Address; data: Hex; value: string; what: string }[] {
  const A = accountAbi();
  const fac = loadArtifact('AgentAccountFactory').abi;
  const enc = (fn: string, args: unknown[]) => encodeFunctionData({ abi: A, functionName: fn, args } as never);
  const burst = 25_000n; // 0.025 USDC burst + 0.025 USDC / day = 0.05 USDC daily limit
  return [
    { to: o.factory, data: encodeFunctionData({ abi: fac, functionName: 'createAccount', args: [o.owner, o.salt] } as never), value: '0', what: 'factory.createAccount(owner, salt): deploys the agent account' },
    { to: o.account, data: enc('setGlobalCap', [USDC_BASE, burst, burst]), value: '0', what: 'daily limit 0.05 USDC (burst 0.025 + 0.025/day)' },
    { to: o.account, data: enc('setRecipient', [o.payTo, true]), value: '0', what: 'the TRACE payTo address is the only listed payee' },
    {
      to: o.account,
      data: enc('setPolicy', [
        o.agent,
        policyInput({
          validAfter: o.now - 60,
          validUntil: o.now + 7 * 86400,
          assets: [{ asset: USDC_BASE, perTxCap: 10_000n, burst, ratePerDay: burst }],
          calls: [{ target: USDC_BASE, selector: TRANSFER, rules: [{ argIndex: 0, op: RULE_OP.PAYEE }] }],
        }),
      ]),
      value: '0',
      what: 'agent session: USDC transfer(payee) only, 0.01 USDC per tx, expires in 7 days',
    },
    { to: o.account, data: enc('setSig1271Mode', [1]), value: '0', what: 'ERC-1271 mode: owner + x402 voucher (opt-in)' },
    { to: o.account, data: enc('addDeposit', []), value: o.ethDeposit.toString(), what: 'EntryPoint deposit for the voucher UserOp prefund' },
    ...(o.topUp ? [{ to: USDC_BASE, data: encodeFunctionData({ abi: usdcAbi, functionName: 'transfer', args: [o.account, o.topUp] }), value: '0', what: 'fund the account with the USDC top-up (about 1 USDC)' }] : []),
  ];
}

// ------------------------------------------------------------------ plumbing

const chain = defineChain({ id: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [process.env.BASE_RPC ?? 'https://mainnet.base.org'] } } });
const pub = () => createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
const dep = () => {
  const p = join(BUILD_ROOT, 'deployments', '8453.json');
  if (!existsSync(p)) throw new Error('deployments/8453.json missing: deploy the stack first (scripts/deploy.ts --allow-mainnet), or copy a deployments file');
  return JSON.parse(readFileSync(p, 'utf8')) as { factory: Address; entryPoint: Address };
};
const loadAgentKey = (): Hex => {
  if (!existsSync(KEY_FILE)) throw new Error('no agent key: run `x3.ts agent-key`');
  return readFileSync(KEY_FILE, 'utf8').trim() as Hex;
};
const readState = (): Record<string, any> => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const writeState = (s: Record<string, unknown>) => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify({ ...readState(), ...s }, null, 2)}\n`);
};
const sig65 = (key: Hex, hash: Hex) => sign({ hash, privateKey: key, to: 'hex' });

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'agent-key') {
    if (existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} exists: refusing to overwrite`);
    mkdirSync(DIR, { recursive: true });
    const k = generatePrivateKey();
    writeFileSync(KEY_FILE, `${k}\n`, { mode: 0o600 });
    console.log(`agent address ${privateKeyToAccount(k).address} (key in scripts/x3/.agent.key; it holds no funds and no ETH)`);
    return;
  }
  if (cmd === 'plan') {
    const owner = getAddress(arg('--owner') ?? (() => { throw new Error('--owner required'); })());
    const payTo = getAddress(arg('--pay-to') ?? (() => { throw new Error('--pay-to required'); })());
    const salt = BigInt(arg('--salt', '0')!);
    const { factory } = dep();
    const agent = privateKeyToAccount(loadAgentKey()).address;
    const account = getAddress((await pub().readContract({ address: factory, abi: loadArtifact('AgentAccountFactory').abi, functionName: 'getAddress', args: [owner, salt] } as never)) as Address);
    const now = Number((await pub().getBlock()).timestamp);
    const eth = BigInt(Math.round(Number(arg('--eth', '0.002')) * 1e18));
    const pack = ownerTxPack({ factory, owner, salt, account, agent, payTo, now, ethDeposit: eth, topUp: 1_000_000n });
    writeState({ account, owner, payTo, agent });
    writeFileSync(join(DIR, 'owner_txs.json'), `${JSON.stringify({ chainId: 8453, account, note: 'Send these from the OWNER wallet (MetaMask), in order. The owner key is never given to any script.', txs: pack }, null, 2)}\n`);
    console.log(`account (counterfactual): ${account}\nagent: ${agent}\nowner transactions (${pack.length}) -> scripts/x3/owner_txs.json`);
    for (const [i, t] of pack.entries()) console.log(`  ${i + 1}. to ${t.to} value ${t.value} wei: ${t.what}`);
    return;
  }
  if (cmd === 'voucher' || cmd === 'pay') {
    const st = readState();
    if (!st.account || !st.payTo) throw new Error('run `plan` first');
    const key = loadAgentKey();
    const send = has('--send');
    if (cmd === 'voucher') {
      const { entryPoint } = dep();
      const now = Number((await pub().getBlock()).timestamp);
      const v = { to: st.payTo as Address, value: BigInt(arg('--value', '5000')!), validAfter: 0n, validBefore: BigInt(now + 540), nonce: keccak256(toBytes(`x3/${now}/${Math.random()}`)) };
      const A = accountAbi();
      const agent = privateKeyToAccount(key).address;
      const nk = BigInt((await pub().readContract({ address: st.account, abi: A, functionName: 'nonceKeyOf', args: [agent, 0] } as never)) as bigint);
      const nonce = (await pub().readContract({ address: entryPoint, abi: loadArtifact('EntryPoint').abi, functionName: 'getNonce', args: [st.account, nk] } as never)) as bigint;
      const op = unsignedOp(st.account, nonce, agentOpCallData(USDC_BASE, 0n, voucherBody(v), 1), { verificationGasLimit: 250_000n, callGasLimit: 300_000n, preVerificationGas: 60_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
      const hash = opHash(op, { entryPoint } as never, 8453);
      op.signature = agentEnvelope(await sig65(key, hash));
      writeState({ voucher: { ...v, value: v.value.toString(), validAfter: '0', validBefore: v.validBefore.toString() }, voucherOpHash: hash });
      console.log(`voucher op for ${v.value} base units to ${v.to}, valid ${v.validBefore - BigInt(now)} s (the account caps this at 600 s): run \`pay\` right away`);
      if (!send) return console.log('DRY RUN: nothing sent. Re-run with --send and RELAYER_KEY to submit handleOps.');
      const rk = process.env.RELAYER_KEY as Hex | undefined;
      if (!rk) throw new Error('RELAYER_KEY (an EOA with a little Base ETH) is required with --send');
      const wc = createWalletClient({ account: privateKeyToAccount(rk), chain, transport: http(chain.rpcUrls.default.http[0]) });
      const tx = await wc.writeContract({ address: entryPoint, abi: loadArtifact('EntryPoint').abi, functionName: 'handleOps', args: [[op], wc.account.address] } as never);
      console.log(`handleOps sent: ${tx}`);
      return;
    }
    const url = process.env.TRACE_X402_URL;
    if (!url) throw new Error('TRACE_X402_URL (the live endpoint, POST) is required');
    const v = st.voucher as { to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } | undefined;
    if (!v) throw new Error('run `voucher --send` first (the voucher must be Registered on-chain)');
    const r1 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const req = (await r1.json().catch(() => ({}))) as { accepts?: { scheme: string; network: string; maxAmountRequired: string; payTo: Address; asset: Address }[] };
    const acc = req.accepts?.[0];
    console.log(`first request: HTTP ${r1.status}; accepts ${JSON.stringify(acc)}`);
    if (r1.status !== 402 || !acc) throw new Error('expected a 402 with accepts[0]');
    if (getAddress(acc.payTo) !== getAddress(v.to) || BigInt(acc.maxAmountRequired) !== BigInt(v.value) || getAddress(acc.asset) !== USDC_BASE) throw new Error('the 402 terms differ from the registered voucher (payTo / amount / asset): refusing to sign');
    const a = { from: getAddress(st.account), to: getAddress(v.to), value: BigInt(v.value), validAfter: BigInt(v.validAfter), validBefore: BigInt(v.validBefore), nonce: v.nonce };
    const sep = (await pub().readContract({ address: USDC_BASE, abi: usdcAbi, functionName: 'DOMAIN_SEPARATOR' })) as Hex;
    const digest = twaDigest(sep, a);
    const env = envelope(a, await sig65(key, digest));
    const header = paymentHeader(acc.network, env, a);
    if (!has('--send')) return console.log(`DRY RUN: digest ${digest}; the X-PAYMENT header (${header.length} chars) was built but the payment was NOT sent. Re-run with --send.`);
    const r2 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': header }, body: JSON.stringify({}) });
    const settle = r2.headers.get('x-payment-response');
    console.log(`second request: HTTP ${r2.status}; X-PAYMENT-RESPONSE ${settle ? Buffer.from(settle, 'base64').toString() : '(none)'}`);
    writeState({ paymentHttpStatus: r2.status, paymentResponse: settle });
    return;
  }
  if (cmd === 'verify') {
    const st = readState();
    const txh = (arg('--tx') ?? (() => { throw new Error('--tx required'); })()) as Hex;
    const v = st.voucher as { to: Address; value: string; validBefore: string; nonce: Hex };
    const p = pub();
    const rc = await p.getTransactionReceipt({ hash: txh });
    let paid = 0n;
    for (const log of rc.logs) {
      if (log.address.toLowerCase() !== USDC_BASE.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: usdcAbi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: { from: Address; to: Address; value: bigint } };
        if (ev.eventName === 'Transfer' && ev.args.from.toLowerCase() === st.account.toLowerCase() && ev.args.to.toLowerCase() === v.to.toLowerCase()) paid += ev.args.value;
      } catch { /* other event */ }
    }
    const used = (await p.readContract({ address: USDC_BASE, abi: usdcAbi, functionName: 'authorizationState', args: [st.account, v.nonce] })) as boolean;
    const sep = (await p.readContract({ address: USDC_BASE, abi: usdcAbi, functionName: 'DOMAIN_SEPARATOR' })) as Hex;
    const agentKey = loadAgentKey();
    const neg = { from: getAddress(st.account), to: getAddress(st.agent), value: 1n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: keccak256(toBytes('x3/negative')) };
    const dg = twaDigest(sep, neg);
    const magic = (await p.readContract({ address: st.account, abi: erc1271, functionName: 'isValidSignature', args: [dg, await sig65(agentKey, dg)] })) as Hex;
    const report = {
      txHash: txh,
      usdcTransferAccountToPayTo: paid.toString(),
      expected: v.value,
      authorizationUsed: used,
      secondUseOfNonce: 'the token reverts a used authorization (authorizationState = true)',
      agentSignatureWithoutVoucher: magic,
      pass: paid === BigInt(v.value) && used && magic === '0xffffffff',
    };
    writeFileSync(join(BUILD_ROOT, 'results', 'x3_mainnet.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('usage: x3.ts agent-key | plan | voucher [--send] | pay [--send] | verify --tx 0x..  (see docs/x3_runbook.md)');
}

if (process.argv[1]?.endsWith('x3.ts')) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
