/**
 * The demo world for the scripts/e2e/* checks: fresh anvil, the stack from forge artifacts, the M0
 * mocks (MockUSDC3009, TicketNFT, GroceryMerchant, ApiSeller, GreedyMerchant) and one AgentAccount
 * configured with the announced demo policy (docs/api.md section 11), mirroring M1Fixture.
 */
import { type Address, type Hex, encodeFunctionData, erc20Abi, keccak256, encodeAbiParameters, concat, toBytes } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { DEV, addr, chainNow, startAnvil, type Anvil } from './anvil.ts';
import { Deployer, createAccount, deployStack, loadArtifact, type Stack } from './stack.ts';
import { RULE_OP, TRANSFER, APPROVE, policyInput, sel, type CallSpec } from './policy.ts';

export const SET_APPROVAL_FOR_ALL: Hex = '0xa22cb465';
export const BUY = sel('buy(uint256,address)');
export const ORDER = sel('order(uint256,address)');
export const GREEDY_BUY = sel('buy()');
export const CAP = 10_000_000n; // demo burst and ratePerDay: 20 USDC per 24 h
export const TICKET_PRICE = 2_000_000n;

export interface World {
  anvil: Anvil;
  d: Deployer;
  stack: Stack;
  usdc: Address;
  usdcAbi: import('viem').Abi;
  ticket: Address;
  grocery: Address;
  api: Address;
  greedy: Address;
  account: Address;
  agent: Address;
  now: number;
  A: import('viem').Abi;
  chainId: number;
  /** owner tx on the account */
  own: (fn: string, args?: unknown[], value?: bigint) => Promise<Hex>;
  /** like own but resolves to success/failure */
  tryTx: (key: Hex, fn: string, args?: unknown[]) => Promise<boolean>;
  read: <T>(fn: string, args?: unknown[]) => Promise<T>;
  usdcBalance: (a: Address) => Promise<bigint>;
  stop: () => void;
}

export function demoCalls(w: { usdc: Address; ticket: Address; grocery: Address; greedy?: Address }): CallSpec[] {
  const calls: CallSpec[] = [
    { target: w.usdc, selector: TRANSFER, rules: [{ argIndex: 0, op: RULE_OP.PAYEE }] },
    { target: w.usdc, selector: APPROVE, rules: [{ argIndex: 0, op: RULE_OP.IN_RECIPIENTS }, { argIndex: 1, op: RULE_OP.LTE, bound: CAP }] },
    { target: w.ticket, selector: BUY, rules: [{ argIndex: 1, op: RULE_OP.EQ_SELF }] },
    { target: w.ticket, selector: SET_APPROVAL_FOR_ALL, rules: [{ argIndex: 0, op: RULE_OP.IN_RECIPIENTS }] },
    { target: w.grocery, selector: ORDER, rules: [{ argIndex: 0, op: RULE_OP.LTE, bound: CAP }, { argIndex: 1, op: RULE_OP.EQ_SELF }] },
  ];
  if (w.greedy) calls.push({ target: w.greedy, selector: GREEDY_BUY, rules: [] });
  return calls;
}

export interface WorldOptions {
  /** also allow GreedyMerchant.buy() for the agent (greedy-merchant card) */
  greedy?: boolean;
  extraAgents?: Hex[];
  sig1271Mode?: number;
  /** push the freeze tripwires (T1-T3) out of reach so only the meter / buckets bound the agent (M2-style isolation) */
  noTripwires?: boolean;
}

export async function makeWorld(o: WorldOptions = {}): Promise<World> {
  const anvil = await startAnvil();
  const d = new Deployer(anvil, DEV.owner);
  const stack = await deployStack(d);
  const A = stack.abi.account;
  const usdcArt = loadArtifact('MockUSDC3009', 'MockUSDC3009.sol');
  const usdc = await d.deploy(usdcArt);
  const treasury = (r: 'verifier' | 'attacker') => addr(r);
  const ticket = await d.deploy(loadArtifact('TicketNFT', 'TicketNFT.sol'), [usdc, TICKET_PRICE, addr('relayer')]);
  const grocery = await d.deploy(loadArtifact('GroceryMerchant', 'GroceryMerchant.sol'), [usdc, addr('relayer')]);
  const api = await d.deploy(loadArtifact('ApiSeller', 'ApiSeller.sol'), [usdc, 100_000n, addr('relayer')]);
  const greedy = await d.deploy(loadArtifact('GreedyMerchant', 'GreedyMerchant.sol'), [usdc, TICKET_PRICE, treasury('attacker')]);
  const owner = addr('owner');
  const agent = addr('agent');
  const account = await createAccount(d, stack, owner, 0n);
  const now = await chainNow(anvil.rpcUrl);
  const own = (fn: string, args: unknown[] = [], value = 0n) => d.send(account, A, fn, args, DEV.owner, value);
  await own('setGlobalCap', [usdc, CAP, CAP]);
  for (const r of [api, ticket, grocery]) await own('setRecipient', [r, true]);
  await own('setTrackedSpenders', [[ticket, grocery, ...(o.greedy ? [greedy] : [])]]);
  await own('setTrackedNFTs', [[ticket]]);
  if (o.sig1271Mode) await own('setSig1271Mode', [o.sig1271Mode]);
  const pol = policyInput({
    validAfter: now - 1,
    validUntil: now + 6 * 86400,
    assets: [{ asset: usdc, perTxCap: CAP, burst: CAP, ratePerDay: CAP }],
    calls: demoCalls({ usdc, ticket, grocery, greedy: o.greedy ? greedy : undefined }),
  });
  for (const k of [agent, ...(o.extraAgents ?? []).map((x) => privateKeyToAccount(x).address)]) await own('setPolicy', [k, pol]);
  await d.send(usdc, usdcArt.abi, 'mint', [account, 100_000_000n]);
  await own('addDeposit', [], 10n ** 18n);
  if (o.noTripwires) {
    const key = (n: string) => keccak256(toBytes(`hypnexis.freeze.${n}`));
    await own('setFreezeParam', [key('velocityBps'), 10_000n]);
    await own('setFreezeParam', [key('sprayMax'), 1_000_000n]);
    await own('setFreezeParam', [key('strikeMax'), 1_000_000n]);
  }
  return {
    anvil,
    d,
    stack,
    usdc,
    usdcAbi: usdcArt.abi,
    ticket,
    grocery,
    api,
    greedy,
    account,
    agent,
    now,
    A,
    chainId: anvil.chainId,
    own,
    tryTx: (key, fn, args = []) => d.send(account, A, fn, args, key).then(() => true, () => false),
    read: <T,>(fn: string, args: unknown[] = []) => d.read<T>(account, A, fn, args),
    usdcBalance: (a) => d.read<bigint>(usdc, usdcArt.abi, 'balanceOf', [a]),
    stop: () => anvil.stop(),
  };
}

export const erc20 = {
  transfer: (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
  approve: (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
};
export const shopCalls = {
  buy: (id: bigint, to: Address) => encodeFunctionData({ abi: [{ type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] }], functionName: 'buy', args: [id, to] }),
  order: (amount: bigint, to: Address) => encodeFunctionData({ abi: [{ type: 'function', name: 'order', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'order', args: [amount, to] }),
  setApprovalForAll: (op: Address, ok: boolean) => encodeFunctionData({ abi: [{ type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'op', type: 'address' }, { name: 'ok', type: 'bool' }], outputs: [] }], functionName: 'setApprovalForAll', args: [op, ok] }),
  greedyBuy: () => encodeFunctionData({ abi: [{ type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [], outputs: [] }], functionName: 'buy', args: [] }),
};

/** EIP-3009 TransferWithAuthorization digest in the token's own domain separator. */
export async function twaDigest(w: World, from: Address, to: Address, value: bigint, validAfter: bigint, validBefore: bigint, nonce: Hex): Promise<Hex> {
  const sep = await w.d.read<Hex>(w.usdc, w.usdcAbi, 'DOMAIN_SEPARATOR');
  const typehash = keccak256(toBytes('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      [typehash, from, to, value, validAfter, validBefore, nonce],
    ),
  );
  return keccak256(concat(['0x1901', sep, structHash]));
}
export const sig65 = (key: Hex, hash: Hex): Promise<Hex> => sign({ hash, privateKey: key, to: 'hex' });

export function x402Envelope(to: Address, value: bigint, validAfter: bigint, validBefore: bigint, nonce: Hex, agentSig: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes' }],
    [1, to, value, validAfter, validBefore, nonce, agentSig],
  );
}
export function voucherBody(to: Address, value: bigint, validAfter: bigint, validBefore: bigint, nonce: Hex): Hex {
  return encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [to, value, validAfter, validBefore, nonce]);
}

export interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean;
}
export const checker = () => {
  const checks: Check[] = [];
  return { checks, add: (name: string, expected: unknown, observed: unknown) => checks.push({ name, expected: String(expected), observed: String(observed), pass: String(expected) === String(observed) }) };
};
