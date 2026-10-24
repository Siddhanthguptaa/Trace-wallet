/**
 * Owner-console logic with NO DOM and NO node imports: it talks to an EIP-1193 provider (MetaMask's
 * `window.ethereum`, or a stand-in in the tests / rehearsal) and to the console server over fetch.
 * The owner's key never enters this code: transactions go through `eth_sendTransaction`, signatures
 * through `eth_signTypedData_v4` / `personal_sign`, both of which the wallet confirms in its popup.
 */
import { type Hex, keccak256, toBytes } from 'viem';
import { OUTCOME_TYPES, outcomeTypedData } from '../../../packages/shared/src/attestor/typedData.ts';
import type { PublicConfig } from '../lib/config.ts';
import { type OwnerAction, type TxSpec, SETUP_ACTIONS, actionById } from '../lib/ownerActions.ts';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WalletError extends Error {}

/** Connect, require the connected account to be the OWNER, and put the wallet on the right chain. */
export async function connect(p: Eip1193, cfg: PublicConfig): Promise<string> {
  const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
  const owner = accounts[0];
  if (!owner) throw new WalletError('the wallet returned no account');
  if (cfg.owner && owner.toLowerCase() !== cfg.owner.toLowerCase()) {
    throw new WalletError(`MetaMask is on ${owner} but this account is owned by ${cfg.owner}. Switch account in MetaMask.`);
  }
  await ensureChain(p, cfg);
  return owner;
}

export async function ensureChain(p: Eip1193, cfg: PublicConfig): Promise<void> {
  const current = Number(BigInt((await p.request({ method: 'eth_chainId' })) as string));
  if (current === cfg.chainId) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(cfg.chainId) }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4902 || code === -32603) {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: hex(cfg.chainId), chainName: cfg.chainName, rpcUrls: [cfg.rpcUrl], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [] }],
      });
    } else throw e;
  }
  const after = Number(BigInt((await p.request({ method: 'eth_chainId' })) as string));
  if (after !== cfg.chainId) throw new WalletError(`the wallet is on chain ${after}, expected ${cfg.chainId} (${cfg.chainName})`);
}

/** Chain time (not the browser clock): policy windows are judged against block.timestamp. */
export async function chainTime(p: Eip1193): Promise<number> {
  const b = (await p.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })) as { timestamp: string };
  return Number(BigInt(b.timestamp));
}

export interface SentTx {
  hash: Hex;
  label: string;
  status: 'success' | 'reverted';
  url: string;
}

/** Send one owner transaction through the wallet and wait for its receipt. */
export async function sendTx(p: Eip1193, cfg: PublicConfig, from: string, tx: TxSpec): Promise<SentTx> {
  const hash = (await p.request({ method: 'eth_sendTransaction', params: [{ from, to: tx.to, data: tx.data, value: tx.value > 0n ? hex(tx.value) : '0x0' }] })) as Hex;
  for (let i = 0; i < 180; i++) {
    const r = (await p.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status: string } | null;
    if (r) {
      const status = r.status === '0x1' ? 'success' : 'reverted';
      if (status === 'reverted') throw new WalletError(`${tx.label} reverted on-chain (tx ${hash})`);
      return { hash, label: tx.label, status, url: cfg.explorer ? `${cfg.explorer}/tx/${hash}` : hash };
    }
    await sleep(1500);
  }
  throw new WalletError(`timed out waiting for ${tx.label} (tx ${hash})`);
}

export interface RunResult {
  action: string;
  sent: SentTx[];
}

/** Run one owner action: preview is the caller's job (call `previewAction` first and show it). */
export async function runAction(p: Eip1193, cfg: PublicConfig, id: string, input?: string, onTx?: (t: SentTx) => void): Promise<RunResult> {
  const a = actionById(id);
  const owner = await connect(p, cfg);
  const now = await chainTime(p);
  const sent: SentTx[] = [];
  for (const tx of a.txs(cfg, { now, input })) {
    const s = await sendTx(p, cfg, owner, tx);
    sent.push(s);
    onTx?.(s);
  }
  return { action: id, sent };
}

export function previewAction(cfg: PublicConfig, a: OwnerAction, input?: string): { title: string; lines: string[]; txs: string[] } {
  return { title: a.title, lines: a.plain(cfg, input), txs: a.txs(cfg, { now: Math.floor(Date.now() / 1000), input: input ?? a.input?.default(cfg) }).map((t) => `${t.label}  ->  ${t.to}${t.value > 0n ? `  (+${t.value} wei)` : ''}`) };
}

/** Steps 1-11, in order, one MetaMask confirmation per transaction. */
export async function runSetupAll(p: Eip1193, cfg: PublicConfig, inputs: Record<string, string>, onStep?: (id: string, tx: SentTx) => void): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const a of SETUP_ACTIONS) out.push(await runAction(p, cfg, a.id, inputs[a.id] ?? a.input?.default(cfg), (t) => onStep?.(a.id, t)));
  return out;
}

// ---------------------------------------------------------------- signatures

export interface TypedDataJson {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** eth_signTypedData_v4: the wallet shows the structured message and the owner confirms. */
export async function signTypedData(p: Eip1193, owner: string, td: TypedDataJson): Promise<Hex> {
  return (await p.request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(td)] })) as Hex;
}

/** Sign an approval typed-data document returned by the approval service (/v1/requests/:id/typed-data). */
export async function signApproval(p: Eip1193, owner: string, doc: TypedDataJson & { display?: unknown }): Promise<Hex> {
  const { display: _display, ...td } = doc as TypedDataJson & { display?: unknown };
  void _display;
  return signTypedData(p, owner, td);
}

export async function rejectSignature(p: Eip1193, owner: string, id: string): Promise<Hex> {
  return (await p.request({ method: 'personal_sign', params: [`0x${Array.from(new TextEncoder().encode(`Hypnexis approval service: reject request ${id}`)).map((b) => b.toString(16).padStart(2, '0')).join('')}`, owner] })) as Hex;
}

/** An owner-signed TRACE outcome ("this payee delivered"); the attestor vouches after enough of them. */
export function outcomeDoc(cfg: PublicConfig, payee: string, ref: Hex, amount: bigint): TypedDataJson {
  const td = outcomeTypedData(cfg.chainId, { wallet: cfg.account as `0x${string}`, payee: payee as `0x${string}`, success: true, ref, asset: cfg.usdc as `0x${string}`, amount });
  return {
    domain: { name: td.domain.name, version: td.domain.version, chainId: Number(td.domain.chainId) },
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], Outcome: [...OUTCOME_TYPES.Outcome] },
    primaryType: 'Outcome',
    message: { wallet: cfg.account, payee, success: true, ref, asset: cfg.usdc, amount: amount.toString() },
  };
}

export async function vouchForPayee(p: Eip1193, cfg: PublicConfig, payee: string, base = '', onSigned?: (i: number) => void): Promise<{ ref: Hex; status: number; body: unknown }[]> {
  const owner = await connect(p, cfg);
  const out: { ref: Hex; status: number; body: unknown }[] = [];
  for (let i = 0; i < cfg.outcomeVouches; i++) {
    const ref = keccak256(toBytes(`hypnexis-live-vouch:${payee.toLowerCase()}:${i}:${Date.now()}`));
    const doc = outcomeDoc(cfg, payee, ref, 1_000_000n);
    const signature = await signTypedData(p, owner, doc);
    onSigned?.(i + 1);
    const res = await fetch(`${base}/attestor/v1/outcomes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'owner', outcome: { wallet: cfg.account, payee, success: true, ref, asset: cfg.usdc, amount: '1000000' }, signature }),
    });
    out.push({ ref, status: res.status, body: await res.json().catch(() => null) });
  }
  return out;
}

// ---------------------------------------------------------------- approvals (via the console server's proxy)

export interface ApprovalView {
  id: string;
  status: string;
  display?: { target: string; selector: string; payee: string; maxOutflow: { asset: string; amount: string }[]; validUntilIso: string; agentKey: string; noteUntrusted?: string; account: string };
  approvalHash?: string;
}

export async function listPending(base = '', cfg?: PublicConfig): Promise<{ id: string }[]> {
  const q = cfg?.account ? `?account=${cfg.account}&status=pending` : '?status=pending';
  const r = await fetch(`${base}/approval/v1/requests${q}`);
  if (!r.ok) throw new WalletError(`approval service answered HTTP ${r.status}`);
  return ((await r.json()) as { requests: { id: string }[] }).requests;
}

export async function loadApproval(base: string, id: string): Promise<{ doc: TypedDataJson & { display: NonNullable<ApprovalView['display']>; approvalHash: string }; }> {
  const r = await fetch(`${base}/approval/v1/requests/${id}/typed-data`);
  if (!r.ok) throw new WalletError(`typed-data for ${id}: HTTP ${r.status}`);
  return { doc: (await r.json()) as never };
}

/** Plain-words summary of an approval, shown BEFORE the signing popup. */
export function describeApproval(cfg: PublicConfig, d: NonNullable<ApprovalView['display']>): string[] {
  const out = (d.maxOutflow ?? []).map((o) => `at most ${o.amount} base units of ${o.asset.toLowerCase() === cfg.usdc.toLowerCase() ? 'USDC' : o.asset}`);
  return [
    `The agent ${d.agentKey} asks the account to call ${d.target} (function ${d.selector}).`,
    `Payee: ${d.payee}.`,
    `If you sign, the account may send ${out.length ? out.join(' and ') : 'nothing'} for this one request, until ${d.validUntilIso}. Anything above that is blocked on-chain.`,
    d.noteUntrusted ? `The agent’s own words (untrusted, they do not change what you sign): “${d.noteUntrusted}”` : '',
  ].filter(Boolean);
}

export async function approveRequest(p: Eip1193, cfg: PublicConfig, base: string, id: string): Promise<{ status: number; body: unknown }> {
  const owner = await connect(p, cfg);
  const { doc } = await loadApproval(base, id);
  const signature = await signApproval(p, owner, doc);
  const r = await fetch(`${base}/approval/v1/requests/${id}/signature?wait=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export async function rejectRequest(p: Eip1193, cfg: PublicConfig, base: string, id: string): Promise<{ status: number; body: unknown }> {
  const owner = await connect(p, cfg);
  const signature = await rejectSignature(p, owner, id);
  const r = await fetch(`${base}/approval/v1/requests/${id}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
