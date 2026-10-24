/**
 * Scripted owner signer (IDEA 7.3, [A18]): fetches a request's OutcomeApproval typed data, checks it
 * is well-formed for the account, prints what a wallet would show [A15], signs it with an anvil dev
 * key or a testnet key, and posts the signature (or an EIP-191 rejection). MetaMask
 * eth_signTypedData_v4 replaces this once the UI exists. Never use a real owner key here.
 */
import { type Address, type Hex, getAddress, hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  APPROVAL_DOMAIN_NAME,
  APPROVAL_DOMAIN_VERSION,
  type OutcomeApprovalJson,
  approvalFromJson,
  outcomeApprovalDigest,
  outcomeApprovalTypedData,
} from '../../../packages/shared/src/approval/index.ts';
import { rejectMessage } from './service.ts';

/** anvil / hardhat default mnemonic keys #0-#9 (public). */
export const ANVIL_DEV_KEYS: readonly Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];

/** chains where any key may sign: anvil/hardhat local, Base Sepolia, Ethereum Sepolia. */
export const TESTNET_CHAIN_IDS: readonly number[] = [31337, 1337, 84532, 11155111];

export class KeyPolicyError extends Error {}

/** [A18]: anvil dev keys anywhere (they are public; fork mode runs chainId 8453 locally), other keys only on testnets. */
export function checkKeyPolicy(key: Hex, chainId: number): void {
  const isDev = ANVIL_DEV_KEYS.some((k) => k.toLowerCase() === key.toLowerCase());
  if (isDev || TESTNET_CHAIN_IDS.includes(chainId)) return;
  throw new KeyPolicyError(`refusing to sign for chainId ${chainId} with a non-dev key: the scripted signer is for anvil and testnet keys only [A18]`);
}

export interface TypedDataResponse {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  primaryType: string;
  message: OutcomeApprovalJson;
  status: string;
  approvalHash: Hex;
  display: Record<string, unknown>;
}

/** Structural checks before signing: right type, domain bound to the message's account and chain. */
export function checkTypedData(td: TypedDataResponse, expect: { account?: Address; chainId?: number } = {}): void {
  if (td.primaryType !== 'OutcomeApproval') throw new Error(`primaryType ${td.primaryType} is not OutcomeApproval`);
  if (td.domain.name !== APPROVAL_DOMAIN_NAME || td.domain.version !== APPROVAL_DOMAIN_VERSION) throw new Error('domain is not AgentAccount v1');
  if (getAddress(td.domain.verifyingContract) !== getAddress(td.message.account)) throw new Error('domain.verifyingContract != message.account');
  if (BigInt(td.domain.chainId) !== BigInt(td.message.chainId)) throw new Error('domain.chainId != message.chainId');
  if (expect.account && getAddress(expect.account) !== getAddress(td.message.account)) throw new Error('typed data is for another account');
  if (expect.chainId !== undefined && BigInt(expect.chainId) !== BigInt(td.message.chainId)) throw new Error('typed data is for another chain');
  const a = approvalFromJson(td.message);
  if (outcomeApprovalDigest(a).toLowerCase() !== td.approvalHash.toLowerCase()) throw new Error('approvalHash does not match the typed data');
}

export function formatDisplay(td: TypedDataResponse): string {
  const m = td.message;
  const lines = [
    `OutcomeApproval for account ${m.account} (chain ${m.chainId})`,
    `  target     ${m.target}  selector ${m.selector}`,
    `  payee      ${m.payee}`,
    ...(m.maxOutflow.length ? m.maxOutflow.map((o) => `  maxOutflow ${o.amount} of ${o.asset}`) : ['  maxOutflow none (the call may move nothing)']),
    `  validUntil ${m.validUntil} (${new Date(m.validUntil * 1000).toISOString()})`,
    `  nonce      ${m.nonce}`,
    `  agent note (untrusted): ${JSON.stringify(td.display?.noteUntrusted ?? '')}`,
  ];
  return lines.join('\n');
}

export interface SignOptions {
  baseUrl: string;
  id: string;
  key: Hex;
  reject?: boolean;
  wait?: boolean;
  expect?: { account?: Address; chainId?: number };
  /** refuse if any single maxOutflow amount is above this (base units). */
  maxAmount?: bigint;
  fetchImpl?: typeof fetch;
}

export interface SignResult {
  http: number;
  body: Record<string, unknown>;
  signer: Address;
  signature: Hex;
  display: string;
}

/** Sign the typed data the service returns, locally (no service trust for the digest). */
export async function signTypedDataResponse(td: TypedDataResponse, key: Hex): Promise<Hex> {
  const acct = privateKeyToAccount(key);
  const a = approvalFromJson(td.message);
  const typed = outcomeApprovalTypedData(a);
  const sig = await acct.signTypedData(typed);
  if (hashTypedData(typed).toLowerCase() !== td.approvalHash.toLowerCase()) throw new Error('digest mismatch');
  return sig;
}

export async function ownerSign(o: SignOptions): Promise<SignResult> {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  const tdRes = await f(`${base}/v1/requests/${o.id}/typed-data`);
  const td = (await tdRes.json()) as TypedDataResponse & { error?: unknown };
  if (!tdRes.ok) throw new Error(`typed-data ${tdRes.status}: ${JSON.stringify(td.error ?? td)}`);
  checkKeyPolicy(o.key, Number(td.message.chainId));
  checkTypedData(td, o.expect);
  if (o.maxAmount !== undefined) {
    for (const x of td.message.maxOutflow) {
      if (BigInt(x.amount) > o.maxAmount) throw new Error(`maxOutflow ${x.amount} of ${x.asset} is above --max ${o.maxAmount}`);
    }
  }
  const acct = privateKeyToAccount(o.key);
  const display = formatDisplay(td);
  let signature: Hex;
  let res: Response;
  if (o.reject) {
    signature = await acct.signMessage({ message: rejectMessage(o.id) });
    res = await f(`${base}/v1/requests/${o.id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) });
  } else {
    signature = await signTypedDataResponse(td, o.key);
    res = await f(`${base}/v1/requests/${o.id}/signature${o.wait ? '?wait=1' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature }),
    });
  }
  return { http: res.status, body: (await res.json()) as Record<string, unknown>, signer: acct.address, signature, display };
}
