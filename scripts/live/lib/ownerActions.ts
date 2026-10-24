/**
 * The OWNER's buttons, as pure data (browser-safe). Each action says in plain words what it does and
 * builds the exact transaction(s) MetaMask will be asked to sign. The console renders `plain` BEFORE the
 * MetaMask popup; the tests drive these same definitions through a stand-in provider.
 *
 * Nothing here ever sees a private key: the console hands the transactions to `window.ethereum`.
 */
import { type Hex, encodeFunctionData, formatUnits, keccak256, parseUnits, toBytes } from 'viem';
import { accountOwnerAbi, erc20Abi, factoryAbi } from './abi.ts';
import type { PublicConfig } from './config.ts';

export interface TxSpec {
  to: string;
  data: Hex;
  value: bigint;
  /** one line for the log / the explorer note */
  label: string;
}

export interface OwnerAction {
  id: string;
  group: 'setup' | 'respond' | 'demo';
  title: string;
  /** plain-language preview shown before MetaMask opens */
  plain: (c: PublicConfig, input?: string) => string[];
  txs: (c: PublicConfig, ctx: { now: number; input?: string }) => TxSpec[];
  /** optional single input (an amount) */
  input?: { label: string; unit: 'USDC' | 'ETH'; default: (c: PublicConfig) => string };
}

const TRANSFER: Hex = '0xa9059cbb';
const APPROVE: Hex = '0x095ea7b3';
const RULE = { IN_RECIPIENTS: 1, PAYEE: 2, LTE: 3 } as const;
export const FREEZE_KEY = (name: string): Hex => keccak256(toBytes(`hypnexis.freeze.${name}`));
const OFF = { velocityBps: 10_000n, sprayMax: 1_000_000n, strikeMax: 1_000_000n };

const usdc = (c: PublicConfig, x: string | bigint) => `${Number(formatUnits(BigInt(x), c.usdcDecimals)).toFixed(2)} USDC`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const acct = (c: PublicConfig) => {
  if (!c.account) throw new Error('the account address is not known yet: run `live.ts deploy` first');
  return c.account;
};
const enc = (fn: string, args: unknown[]): Hex => encodeFunctionData({ abi: accountOwnerAbi, functionName: fn, args } as never);

/** The demo policy for the agent key (agent/configs/demo_policy.json, with no mock shops). */
export function demoPolicy(c: PublicConfig, now: number) {
  const perTx = BigInt(c.policy.perTx);
  return {
    validAfter: now - 300,
    validUntil: now + c.policy.days * 86_400,
    gas: { maxCallGas: 500_000, maxVerificationGas: 300_000, maxPreVerificationGas: 100_000, maxFeePerGas: 1_000_000_000n, gasCredit: BigInt(c.policy.gasCreditWei) },
    assets: [{ asset: c.usdc as `0x${string}`, perTxCap: perTx, burst: BigInt(c.policy.burst), ratePerDay: BigInt(c.policy.rate) }],
    calls: [
      // USDC.transfer(payee, amount): the payee argument is checked against the owner's list / attestations
      { target: c.usdc as `0x${string}`, selector: TRANSFER, rules: [{ argIndex: 0, op: RULE.PAYEE, bound: 0n }] },
      // USDC.approve(spender, amount): only an owner-listed spender, at most the per-tx cap
      { target: c.usdc as `0x${string}`, selector: APPROVE, rules: [{ argIndex: 0, op: RULE.IN_RECIPIENTS, bound: 0n }, { argIndex: 1, op: RULE.LTE, bound: perTx }] },
    ],
  };
}

const create: OwnerAction = {
  id: 'createAccount',
  group: 'setup',
  title: '1. Create my agent account',
  plain: (c) => [
    `Deploys YOUR agent wallet (a smart account) from the factory, owned by ${short(c.owner)}.`,
    `Its address will be ${c.account || '(computed at deploy)'}. Only your MetaMask account can change its rules.`,
  ],
  txs: (c) => [{ to: c.factory, data: encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [c.owner as `0x${string}`, BigInt(c.salt)] }), value: 0n, label: 'factory.createAccount(owner, salt)' }],
};

const dailyLimit: OwnerAction = {
  id: 'setGlobalCap',
  group: 'setup',
  title: '2. Set the daily limit',
  plain: (c) => [
    `Caps ALL outflow of USDC from the account, across every key, at ${usdc(c, BigInt(c.policy.burst) + BigInt(c.policy.rate))} per 24 hours`,
    `(${usdc(c, c.policy.burst)} available now + ${usdc(c, c.policy.rate)} refilling per day).`,
    'Also switches on a small exploration budget (5% of the limit) for payees nobody has vouched for.',
    'This is the bound that holds even if every detector is switched off.',
  ],
  txs: (c) => [{ to: acct(c), data: enc('setGlobalCap', [c.usdc, BigInt(c.policy.burst), BigInt(c.policy.rate)]), value: 0n, label: 'setGlobalCap(USDC, burst, rate)' }],
};

const listMerchant: OwnerAction = {
  id: 'listMerchant',
  group: 'setup',
  title: '3. Trust one merchant',
  plain: (c) => [`Adds ${c.merchant} to the list of payees the agent may pay with the normal limits.`, 'Any other address is an unknown payee: capped at a tiny per-payment exploration amount.'],
  txs: (c) => [{ to: acct(c), data: enc('setRecipient', [c.merchant, true]), value: 0n, label: 'setRecipient(merchant, true)' }],
};

const trackSpenders: OwnerAction = {
  id: 'setTrackedSpenders',
  group: 'setup',
  title: '4. Watch allowances to the merchant',
  plain: (c) => [`The account measures every balance and allowance change around each agent call, including approvals to ${short(c.merchant)}.`],
  txs: (c) => [{ to: acct(c), data: enc('setTrackedSpenders', [[c.merchant]]), value: 0n, label: 'setTrackedSpenders([merchant])' }],
};

const setPolicy: OwnerAction = {
  id: 'setPolicy',
  group: 'setup',
  title: '5. Give the agent a session key',
  plain: (c) => [
    `Registers the agent key ${short(c.agent)} with a ${c.policy.days}-day permission.`,
    `It may call USDC.transfer (to a payee the account accepts, at most ${usdc(c, c.policy.perTx)} per payment) and USDC.approve (only to a listed address, at most ${usdc(c, c.policy.perTx)}).`,
    'It may NOT call anything else, move any other asset, or pay an address you have not listed beyond the tiny exploration budget.',
  ],
  txs: (c, { now }) => [{ to: acct(c), data: enc('setPolicy', [c.agent, demoPolicy(c, now)]), value: 0n, label: 'setPolicy(agent, demo policy)' }],
};

const setAttestor: OwnerAction = {
  id: 'setAttestor',
  group: 'setup',
  title: '6. Accept payee attestations from my attestor',
  plain: (c) => [`The running attestor service (key ${short(c.attestor)}) may vouch for payees after real outcomes. A vouch lifts a payee from the exploration budget to the normal limits, never above the daily limit.`],
  txs: (c) => [{ to: acct(c), data: enc('setAttestor', [c.attestor]), value: 0n, label: 'setAttestor(attestor)' }],
};

const setWatcher: OwnerAction = {
  id: 'setWatcher',
  group: 'setup',
  title: '7. Let the watcher freeze the agent',
  plain: (c) => [`The running watcher service (key ${short(c.watcher)}) may FREEZE the agent key when spending looks unusual. It can never unfreeze: only you can.`],
  txs: (c) => [{ to: acct(c), data: enc('setWatcher', [c.watcher]), value: 0n, label: 'setWatcher(watcher)' }],
};

const setGuardians: OwnerAction = {
  id: 'setGuardians',
  group: 'setup',
  title: '8. Name five guardians (3 of 5)',
  plain: (c) => [`Names ${c.guardians.length} guardians. Three of them can replace the owner after 48 hours, and you can veto any time before. Recovery never moves funds.`, ...c.guardians.map((g, i) => `  guardian ${i + 1}: ${g}`)],
  txs: (c) => [{ to: acct(c), data: enc('setGuardians', [c.guardians, 3]), value: 0n, label: 'setGuardians(5, threshold 3)' }],
};

const thresholds: OwnerAction = {
  id: 'setFreezeThresholds',
  group: 'setup',
  title: '9. Turn on the freeze tripwires',
  plain: (c) => [
    `Freezes the agent key when it spends more than ${c.freeze.velocityBps / 100}% of the daily limit in an hour, pays more than ${c.freeze.sprayMax} different unknown payees in an hour, or is blocked ${c.freeze.strikeMax} times in an hour.`,
    'These thresholds were chosen on development seeds before any scored run.',
  ],
  txs: (c) => [
    { to: acct(c), data: enc('setFreezeParam', [FREEZE_KEY('velocityBps'), BigInt(c.freeze.velocityBps)]), value: 0n, label: 'velocityBps' },
    { to: acct(c), data: enc('setFreezeParam', [FREEZE_KEY('sprayMax'), BigInt(c.freeze.sprayMax)]), value: 0n, label: 'sprayMax' },
    { to: acct(c), data: enc('setFreezeParam', [FREEZE_KEY('strikeMax'), BigInt(c.freeze.strikeMax)]), value: 0n, label: 'strikeMax' },
  ],
};

const fundEth: OwnerAction = {
  id: 'fundEth',
  group: 'setup',
  title: '10. Pay for the agent’s gas',
  plain: (c, input) => [`Deposits ${input ?? 'ETH'} ETH into the EntryPoint for the account. The agent’s UserOps pay gas from this deposit, bounded by the policy’s gas credit.`],
  txs: (c, { input }) => [{ to: acct(c), data: enc('addDeposit', []), value: ethToWei(input ?? '0'), label: 'addDeposit()' }],
  input: { label: 'ETH to deposit', unit: 'ETH', default: (c) => formatUnits(BigInt(c.policy.depositWei), 18) },
};

const fundUsdc: OwnerAction = {
  id: 'fundUsdc',
  group: 'setup',
  title: '11. Put test USDC in the account',
  plain: (c, input) => [`Sends ${input ?? '?'} USDC from your MetaMask to the account ${short(c.account)}. (Or send faucet USDC straight to the account address.)`],
  txs: (c, { input }) => [{ to: c.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [acct(c) as `0x${string}`, parseUnits(input ?? '0', c.usdcDecimals)] }), value: 0n, label: 'USDC.transfer(account, amount)' }],
  input: { label: 'USDC to send', unit: 'USDC', default: () => '10' },
};

const unfreeze: OwnerAction = {
  id: 'unfreeze',
  group: 'respond',
  title: 'Unfreeze the agent key',
  plain: (c) => [`Only you can do this. Clears the freeze and the strike count of ${short(c.agent)} so it can act again within its limits.`],
  txs: (c) => [{ to: acct(c), data: enc('unfreeze', [c.agent]), value: 0n, label: 'unfreeze(agent)' }],
};

const revoke: OwnerAction = {
  id: 'revoke',
  group: 'respond',
  title: 'Revoke the agent key',
  plain: (c) => [`Kills the session of ${short(c.agent)} for good. Anything signed with it from now on is refused.`],
  txs: (c) => [{ to: acct(c), data: enc('revoke', [c.agent]), value: 0n, label: 'revoke(agent)' }],
};

const detectorsOff: OwnerAction = {
  id: 'detectorsOff',
  group: 'demo',
  title: 'DEMO: switch the on-chain detectors OFF',
  plain: () => ['For the demo only: pushes the three freeze thresholds out of reach, and you stop the watcher process. Only the daily limit, the per-payment cap and the payee rules remain, to show the loss is STILL bounded.'],
  txs: (c) => [
    { to: acct(c), data: enc('setFreezeParam', [FREEZE_KEY('velocityBps'), OFF.velocityBps]), value: 0n, label: 'velocityBps off' },
    { to: acct(c), data: enc('setFreezeParam', [FREEZE_KEY('sprayMax'), OFF.sprayMax]), value: 0n, label: 'sprayMax off' },
    { to: acct(c), data: enc('setFreezeParam', [FREEZE_KEY('strikeMax'), OFF.strikeMax]), value: 0n, label: 'strikeMax off' },
  ],
};

const detectorsOn: OwnerAction = { ...thresholds, id: 'detectorsOn', group: 'demo', title: 'DEMO: switch the on-chain detectors back ON' };

const veto: OwnerAction = {
  id: 'vetoRecovery',
  group: 'respond',
  title: 'Veto a pending recovery',
  plain: () => ['Cancels the guardians’ pending recovery. Allowed any time before it executes.'],
  txs: (c) => [{ to: acct(c), data: enc('vetoRecovery', []), value: 0n, label: 'vetoRecovery()' }],
};

export function ethToWei(s: string): bigint {
  return parseUnits(s || '0', 18);
}

export const SETUP_ACTIONS = [create, dailyLimit, listMerchant, trackSpenders, setPolicy, setAttestor, setWatcher, setGuardians, thresholds, fundEth, fundUsdc];
export const OWNER_ACTIONS: OwnerAction[] = [...SETUP_ACTIONS, unfreeze, revoke, detectorsOff, detectorsOn, veto];
export const actionById = (id: string): OwnerAction => {
  const a = OWNER_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown owner action ${id}`);
  return a;
};
