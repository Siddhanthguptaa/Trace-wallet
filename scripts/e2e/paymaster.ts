/**
 * AgentPaymaster end-to-end on the REAL AgentAccount (problem statement: "sponsor gas with a
 * per-agent quota that spam cannot drain"). Fresh anvil, the stack deployed from contracts/out with
 * libraries linked, a staked paymaster, two owner-registered agent accounts (A, B) and one
 * unregistered (C).
 *
 *   sponsored        an in-policy op names the paymaster: executes, the account pays no gas, the
 *                    paymaster deposit pays, GasSponsored is emitted with charged <= reserved
 *   spam             A's leaked key sends ops that pass validation and revert in execution, with the
 *                    ATTACKER as bundler beneficiary: the attacker's gain is bounded by the quota
 *                    window bound and further ops are refused at validation once the quota is gone
 *   isolation        B (a second registered agent) is still sponsored while A is exhausted
 *   unregistered     C names the paymaster but is not registered: refused (NotRegistered)
 *   wrongPaymaster   an op naming any paymaster other than the owner-set one: refused (PAYMASTER)
 *   gasFieldCap      a gas field above the paymaster cap: refused (GasFieldAboveCap)
 *   refill           after 24 h A is sponsored again
 *   noPaymaster      with the paymaster cleared, the same op is paid from the account's own deposit
 *   pnpm exec tsx scripts/e2e/paymaster.ts  ->  results/m12_paymaster_e2e.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, type Hex, encodeFunctionData, erc20Abi, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildPaymasterAndData } from '../../packages/shared/src/paymaster/index.ts';
import { DEV, addr, chainNow, startAnvil, warp } from '../lib/anvil.ts';
import { BUILD_ROOT, Deployer, createAccount, deployStack, loadArtifact } from '../lib/stack.ts';
import { RULE_OP, TRANSFER, policyInput } from '../lib/policy.ts';
import { DEFAULT_OP_GAS, signAgentOp, submitOps, type OpGas } from '../lib/ops.ts';

interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}

const PM_VERIF = 80_000n;
const PM_POSTOP = 50_000n;

async function main(): Promise<void> {
  const anvil = await startAnvil();
  const checks: Check[] = [];
  const add = (name: string, expected: string, observed: string) => checks.push({ name, expected, observed, pass: expected === observed });
  const metrics: Record<string, string | number | boolean> = {};
  try {
    const owner = addr('owner');
    const agent = addr('agent');
    const attacker = addr('attacker');
    const d = new Deployer(anvil, DEV.owner);
    const caps = {
      maxFeePerGas: 2_000_000_000n,
      callGasLimit: 500_000,
      verificationGasLimit: 300_000,
      preVerificationGas: 100_000,
      paymasterVerificationGasLimit: 100_000,
      paymasterPostOpGasLimit: 100_000,
    };
    const stack = await deployStack(d, { paymaster: { owner, caps } });
    const pm = stack.paymaster!;
    const A = stack.abi.account;
    const PM = stack.abi.paymaster;
    const usdc = await d.deploy(loadArtifact('MockUSDC3009', 'MockUSDC3009.sol'));
    const usdcAbi = loadArtifact('MockUSDC3009', 'MockUSDC3009.sol').abi;
    const shop = addr('verifier');

    await d.send(pm, PM, 'deposit', [], DEV.owner, 2n * 10n ** 18n);
    await d.send(pm, PM, 'addStake', [86_400], DEV.owner, 10n ** 18n);
    metrics.paymasterStaked = await d.read<boolean>(pm, PM, 'isStaked');

    const perOp = (DEFAULT_OP_GAS.verificationGasLimit + DEFAULT_OP_GAS.callGasLimit + DEFAULT_OP_GAS.preVerificationGas + PM_VERIF + PM_POSTOP) * DEFAULT_OP_GAS.maxFeePerGas;
    const burst = perOp * 6n;
    const rate = burst;
    const now0 = await chainNow(anvil.rpcUrl);

    async function newAgentAccount(salt: bigint, register: boolean): Promise<Address> {
      const acct = await createAccount(d, stack, owner, salt);
      await d.send(acct, A, 'addDeposit', [], DEV.owner, 10n ** 18n);
      await d.send(usdc, usdcAbi, 'mint', [acct, 1_000_000n]);
      await d.send(acct, A, 'setGlobalCap', [usdc, 10_000_000n, 10_000_000n]);
      await d.send(acct, A, 'setRecipient', [shop, true]);
      await d.send(acct, A, 'setPolicy', [
        agent,
        policyInput({
          validAfter: now0 - 1,
          validUntil: now0 + 30 * 86400,
          assets: [{ asset: usdc, perTxCap: 10_000_000n, burst: 10_000_000n, ratePerDay: 10_000_000n }],
          calls: [{ target: usdc, selector: TRANSFER, rules: [{ argIndex: 0, op: RULE_OP.PAYEE }] }],
        }),
      ]);
      await d.send(acct, A, 'setAgentPaymaster', [pm]);
      if (register) await d.send(pm, PM, 'registerAgent', [acct, burst, rate]);
      return acct;
    }
    const acctA = await newAgentAccount(1n, true);
    const acctB = await newAgentAccount(2n, true);
    const acctC = await newAgentAccount(3n, false);

    const pmd = (who: Address = pm, gas: { v?: bigint; p?: bigint } = {}): Hex => buildPaymasterAndData({ paymaster: who, verificationGasLimit: gas.v ?? PM_VERIF, postOpGasLimit: gas.p ?? PM_POSTOP });
    const transfer = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
    const ok = (acct: Address, extra: Partial<{ paymasterAndData: Hex; gas: OpGas; amount: bigint }> = {}) =>
      signAgentOp(d, stack, anvil.chainId, { account: acct, agentKey: DEV.agent, target: usdc, data: transfer(shop, extra.amount ?? 100_000n), paymasterAndData: extra.paymasterAndData ?? pmd(), gas: extra.gas });
    const fail = (acct: Address) => ok(acct, { amount: 50_000_000n }); // passes validation (per-tx cap is checked on the declared amount <= 10M? see below)
    void fail;
    // in-policy by every validation check but reverts in execution: more than the account holds, within the per-tx cap
    const reverting = (acct: Address, paymasterAndData = pmd()) => ok(acct, { amount: 5_000_000n, paymasterAndData });
    const depositOf = (a: Address) => d.read<bigint>(stack.entryPoint, stack.abi.entryPoint, 'balanceOf', [a]);
    const ethOf = (a: Address) => d.pub.getBalance({ address: a });
    const relayer = DEV.relayer;

    // ---- sponsored op executes, the account pays nothing, the paymaster deposit pays
    const accDep0 = await depositOf(acctA);
    const pmDep0 = await depositOf(pm);
    const s1 = await ok(acctA);
    const r1 = await submitOps(d, stack, [s1.op], addr('relayer'), relayer);
    const sponsored = r1.events.find((e) => e.eventName === 'GasSponsored');
    const reserved = BigInt((sponsored?.args.reserved as bigint) ?? 0n);
    const charged = BigInt((sponsored?.args.charged as bigint) ?? 0n);
    add('sponsored in-policy op executes', 'validated/success', `${r1.validated ? 'validated' : `rejected:${r1.reason}`}/${r1.success ? 'success' : 'reverted'}`);
    add('GasSponsored emitted with 0 < charged <= reserved', 'true', String(sponsored !== undefined && charged > 0n && charged <= reserved));
    add("the account's own EntryPoint deposit is untouched", 'true', String((await depositOf(acctA)) === accDep0));
    add('the paymaster deposit paid for the op', 'true', String((await depositOf(pm)) < pmDep0));
    metrics.sponsoredCharged = charged.toString();
    metrics.sponsoredReserved = reserved.toString();

    // ---- spam: reverting ops, attacker as bundler beneficiary
    const t0 = await chainNow(anvil.rpcUrl);
    const gain0 = await ethOf(attacker);
    const drain0 = await depositOf(pm);
    let accepted = 0;
    let refused = 0;
    let firstRefusal = '';
    for (let i = 0; i < 40; i++) {
      const s = await reverting(acctA);
      const r = await submitOps(d, stack, [s.op], attacker, relayer);
      if (r.validated) accepted++;
      else {
        refused++;
        firstRefusal ||= r.reason ?? '';
      }
    }
    const t1 = await chainNow(anvil.rpcUrl);
    const gain = (await ethOf(attacker)) - gain0;
    const drained = drain0 - (await depositOf(pm));
    const windowBound = burst + (rate * BigInt(t1 - t0)) / 86_400n;
    add('spam: attacker-as-bundler gain <= burst + rate x elapsed', 'true', String(gain <= windowBound));
    add('spam: paymaster deposit drain <= the quota window bound', 'true', String(drained <= windowBound));
    add('spam: ops are refused at validation once the quota is gone', 'true', String(refused > 0 && accepted > 0));
    add('spam: the first refusal is the quota (AA32 paymaster not due)', 'true', String(/AA32/.test(firstRefusal)));
    metrics.spamAccepted = accepted;
    metrics.spamRefused = refused;
    metrics.attackerGainWei = gain.toString();
    metrics.paymasterDrainWei = drained.toString();
    metrics.quotaWindowBoundWei = windowBound.toString();
    metrics.firstRefusal = firstRefusal;

    // ---- isolation: B is untouched by A's exhaustion
    const sb = await ok(acctB);
    const rb = await submitOps(d, stack, [sb.op], addr('relayer'), relayer);
    add("A's spam leaves B's quota intact: B's sponsored op executes", 'validated/success', `${rb.validated ? 'validated' : `rejected:${rb.reason}`}/${rb.success ? 'success' : 'reverted'}`);

    // ---- unregistered
    const sc = await ok(acctC);
    const rc = await submitOps(d, stack, [sc.op], addr('relayer'), relayer);
    add('an account the owner did not register is refused (NotRegistered)', 'refused:NotRegistered', `${rc.validated ? 'validated' : 'refused'}:${/NotRegistered/.test(rc.reason ?? '') ? 'NotRegistered' : (rc.reason ?? '')}`);

    // ---- wrong paymaster (agent names a paymaster the owner did not set)
    // a second, fully funded and staked paymaster that has B registered: only the account's own rule can refuse it
    const pm2 = await d.deploy(loadArtifact('AgentPaymaster'), [stack.entryPoint, owner, caps]);
    await d.send(pm2, PM, 'deposit', [], DEV.owner, 10n ** 18n);
    await d.send(pm2, PM, 'addStake', [86_400], DEV.owner, 10n ** 18n);
    await d.send(pm2, PM, 'registerAgent', [acctB, burst, rate]);
    const sw = await ok(acctB, { paymasterAndData: pmd(pm2) });
    const rw = await submitOps(d, stack, [sw.op], addr('relayer'), relayer);
    add('an agent op naming a funded, registering paymaster other than the owner-set one is refused by the account', 'refused', rw.validated ? 'validated' : 'refused');
    metrics.wrongPaymasterReason = rw.reason ?? '';

    // ---- gas field above the paymaster cap
    const sg = await ok(acctB, { gas: { ...DEFAULT_OP_GAS, preVerificationGas: 150_000n } });
    const rg = await submitOps(d, stack, [sg.op], addr('relayer'), relayer);
    add('a gas field above the paymaster cap (preVerificationGas 150k > 100k) is refused', 'refused', rg.validated ? 'validated' : 'refused');
    metrics.gasFieldReason = rg.reason ?? '';

    // ---- refill after 24 h
    await warp(anvil.rpcUrl, 86_400 + 60);
    const sr = await ok(acctA);
    const rr = await submitOps(d, stack, [sr.op], addr('relayer'), relayer);
    add('after 24 h the quota has refilled: A is sponsored again', 'validated/success', `${rr.validated ? 'validated' : `rejected:${rr.reason}`}/${rr.success ? 'success' : 'reverted'}`);

    // ---- no paymaster: the account pays from its own deposit
    await d.send(acctB, A, 'setAgentPaymaster', ['0x0000000000000000000000000000000000000000']);
    const dB0 = await depositOf(acctB);
    const sn = await ok(acctB, { paymasterAndData: '0x' });
    const rn = await submitOps(d, stack, [sn.op], addr('relayer'), relayer);
    add("with the paymaster cleared the op is paid from the account's own deposit", 'validated/success/paid', `${rn.validated ? 'validated' : 'rejected'}/${rn.success ? 'success' : 'reverted'}/${(await depositOf(acctB)) < dB0 ? 'paid' : 'unpaid'}`);
    void privateKeyToAccount;
    void parseAbi;

    const allOk = checks.every((c) => c.pass);
    const out = {
      realAccount: true,
      chainId: anvil.chainId,
      ok: allOk,
      passed: checks.filter((c) => c.pass).length,
      total: checks.length,
      accounts: { A: acctA, B: acctB, C: acctC },
      paymaster: pm,
      quota: { burstWei: burst.toString(), ratePerDayWei: rate.toString(), perOpReservedWei: perOp.toString() },
      metrics,
      checks,
      generatedAt: new Date().toISOString(),
    };
    mkdirSync(join(BUILD_ROOT, 'results'), { recursive: true });
    writeFileSync(join(BUILD_ROOT, 'results', 'm12_paymaster_e2e.json'), `${JSON.stringify(out, null, 2)}\n`);
    for (const c of checks) if (!c.pass) console.log(`FAIL ${c.name}: expected ${c.expected}, observed ${c.observed}`);
    console.log(`paymaster e2e (real account): ${out.passed}/${out.total} ${allOk ? 'ok' : 'FAILED'} -> results/m12_paymaster_e2e.json`);
    if (!allOk) process.exitCode = 1;
  } finally {
    anvil.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
