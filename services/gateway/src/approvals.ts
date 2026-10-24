/**
 * Adapter between the frontend's approval wire format (wire.ts) and the REAL approval service
 * (services/approval, docs/api.md s16), plus the approval sink the agent tools use to file a request
 * with that service when an op needs the owner.
 *
 * Status map (service -> frontend): pending -> pending, approved -> signed, executed/reverted/expired
 * unchanged, rejected -> declined.
 */
import { type Address, type Hex, getAddress, zeroAddress } from 'viem';
import { DEFAULT_AGENT_GAS, nextApprovalNonce, signAgentOp } from '../../../packages/shared/src/approval/agentClient.ts';
import type { ApprovalRequest as ToolRequest, ApprovalSink } from '../../../agent/src/tools/engine.ts';
import type { GatewayConfig } from './config.ts';
import type { Reader } from './policy.ts';
import type { Live } from './world.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SIGS: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x00000000': 'plain value send',
};
const FRONT_STATUS: Record<string, string> = { pending: 'pending', approved: 'signed', executed: 'executed', reverted: 'reverted', expired: 'expired', rejected: 'declined' };
const SERVICE_STATUS: Record<string, string> = { signed: 'approved', declined: 'rejected' };

const seconds = (t: number) => (t > 1e12 ? Math.floor(t / 1000) : t);

export function userOpJson(op: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(op)) out[k] = typeof v === 'bigint' ? v.toString() : String(v);
  return out;
}

export class Approvals {
  /** declined from the UI without an owner signature: a local dismissal, the service still has it pending */
  private dismissed = new Set<string>();
  /** tool request id -> approval service id */
  readonly toolToService = new Map<string, string>();
  private trackCache = new Map<string, { at: number; track: 'proven' | 'unproven' | 'flagged' }>();

  constructor(
    readonly cfg: GatewayConfig,
    readonly live: Live,
    readonly reader: Reader,
  ) {}

  private async call(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await fetch(this.cfg.approvalUrl + path, {
        method: init?.method ?? 'GET',
        headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new HttpError(502, `approval service unreachable at ${this.cfg.approvalUrl}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: { message: text.slice(0, 200) } };
    }
    return { status: res.status, json };
  }

  private fail(r: { status: number; json: any }): never {
    const m = r.json?.error?.message ?? r.json?.error ?? `approval service answered ${r.status}`;
    throw new HttpError(r.status >= 400 && r.status < 600 ? r.status : 502, typeof m === 'string' ? m : JSON.stringify(m));
  }

  async track(payee: Address): Promise<'proven' | 'unproven' | 'flagged'> {
    if (payee === zeroAddress) return 'proven';
    const hit = this.trackCache.get(payee);
    if (hit && Date.now() - hit.at < 20_000) return hit.track;
    let track: 'proven' | 'unproven' | 'flagged' = 'unproven';
    if (await this.reader.read<boolean>('isFlagged', [payee])) track = 'flagged';
    else if (await this.reader.read<boolean>('isRecipient', [payee])) track = 'proven';
    else {
      try {
        const r = await fetch(`${this.cfg.attestorUrl}/v1/attest?wallet=${this.cfg.wallet}&payee=${payee}`, { signal: AbortSignal.timeout(4000) });
        if (r.status === 200) track = 'proven';
      } catch {
        /* attestor down: unproven, never proven */
      }
    }
    this.trackCache.set(payee, { at: Date.now(), track });
    return track;
  }

  private pickOutflow(v: { maxOutflow?: { asset: Address; amount: string }[] }): { asset: Address; amount: bigint } {
    const rows = (v.maxOutflow ?? []).filter((x) => BigInt(x.amount) > 0n);
    const usdc = rows.find((x) => x.asset.toLowerCase() === this.cfg.usdc.toLowerCase()) ?? rows[0];
    return usdc ? { asset: getAddress(usdc.asset), amount: BigInt(usdc.amount) } : { asset: this.cfg.usdc, amount: 0n };
  }

  private async summary(v: any) {
    const out = this.pickOutflow(v);
    const payee = getAddress(v.payee ?? zeroAddress);
    const dismissed = this.dismissed.has(v.id) && v.status === 'pending';
    return {
      id: v.id as string,
      wallet: getAddress(v.account),
      createdAt: seconds(Number(v.createdAt)),
      expiresAt: Number(v.validUntil),
      status: dismissed ? 'declined' : (FRONT_STATUS[v.status] ?? 'pending'),
      payee,
      payeeTrack: await this.track(payee),
      asset: await this.reader.assetInfo(out.asset),
      maxOutflow: out.amount.toString(),
      targetLabel: v.target?.toLowerCase() === this.cfg.usdc.toLowerCase() ? this.cfg.usdcSymbol : undefined,
      functionName: SIGS[String(v.selector).toLowerCase()]?.split('(')[0],
    };
  }

  async list(wallet: string, status?: string) {
    const q = new URLSearchParams({ account: wallet });
    const s = status ? (SERVICE_STATUS[status] ?? status) : undefined;
    if (s && ['pending', 'approved', 'executed', 'rejected', 'expired', 'reverted'].includes(s)) q.set('status', s);
    const r = await this.call(`/v1/requests?${q}`);
    if (r.status !== 200) this.fail(r);
    const rows = await Promise.all((r.json.requests as any[]).map((v) => this.summary(v)));
    return status ? rows.filter((x) => x.status === status || x.status === (FRONT_STATUS[status] ?? status)) : rows;
  }

  async one(id: string) {
    const r = await this.call(`/v1/requests/${encodeURIComponent(id)}`);
    if (r.status !== 200) this.fail(r);
    const v = r.json;
    const base = await this.summary(v);
    const out = this.pickOutflow(v);
    let typedData: unknown = null;
    if (v.status === 'pending') {
      const t = await this.call(`/v1/requests/${encodeURIComponent(id)}/typed-data`);
      if (t.status === 200) {
        const { EIP712Domain: _d, ...types } = t.json.types as Record<string, unknown>;
        typedData = { domain: t.json.domain, types, primaryType: t.json.primaryType, message: t.json.message };
      }
    }
    const selector = String(v.selector).toLowerCase();
    const args =
      selector === '0xa9059cbb' || selector === '0x095ea7b3'
        ? [
            { name: selector === '0xa9059cbb' ? 'to' : 'spender', type: 'address', value: base.payee },
            { name: 'amount', type: 'uint256', value: out.amount.toString() },
          ]
        : [];
    const sim = v.simulation as { outflows?: { asset: Address; amount: string }[] } | null;
    const simulated = sim?.outflows
      ? {
          outflow: out.amount.toString(),
          deltas: await Promise.all(
            sim.outflows.map(async (o) => {
              const info = await this.reader.assetInfo(getAddress(o.asset));
              return { label: info.symbol, kind: 'erc20' as const, delta: `-${o.amount}`, decimals: info.decimals };
            }),
          ),
        }
      : null;
    return {
      ...base,
      chainId: Number(v.chainId),
      agentKey: getAddress(v.agentKey),
      agentNote: v.note ?? null,
      decoded: {
        target: getAddress(v.target),
        targetLabel: base.targetLabel,
        selector: v.selector,
        functionSignature: SIGS[selector] ?? selector,
        args,
      },
      simulated,
      nonce: String(v.nonce),
      validUntil: Number(v.validUntil),
      typedData,
      ...(v.txHash ? { txHash: v.txHash } : {}),
      ...(v.reason ? { revertReason: String(v.reason) } : {}),
    };
  }

  async sign(id: string, signature: string) {
    const r = await this.call(`/v1/requests/${encodeURIComponent(id)}/signature?wait=1`, { method: 'POST', body: { signature } });
    if (r.status >= 400) this.fail(r);
    return this.one(id);
  }

  /** With an owner EIP-191 signature the service rejects it for real; without one it is a local dismissal only. */
  async decline(id: string, signature?: string) {
    if (signature) {
      const r = await this.call(`/v1/requests/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { signature } });
      if (r.status >= 400) this.fail(r);
    } else {
      await this.one(id);
      this.dismissed.add(id);
    }
    return this.one(id);
  }

  /** The agent tools file an out-of-policy op here: a lane-1 op signed by the agent key, no owner key anywhere. */
  readonly sink: ApprovalSink = {
    decide: async (req: ToolRequest) => {
      try {
        return await this.file(req);
      } catch {
        return null; // approval service down: the request stays unfiled, the op is still not executed
      }
    },
  };

  private async file(req: ToolRequest) {
    {
      const { cfg, live } = this;
      const agent = live.wallet.agentAddress;
      const nonce = await nextApprovalNonce(live.pub as never, cfg.wallet, agent, cfg.entryPoint);
      const fee = live.world.policy.opGas.maxFeePerGas;
      const signed = await signAgentOp({
        account: cfg.wallet,
        entryPoint: cfg.entryPoint,
        chainId: cfg.chainId,
        agentKey: cfg.agentKey,
        nonce,
        call: { target: req.target, value: req.value, data: req.data as Hex },
        gas: { ...DEFAULT_AGENT_GAS, maxFeePerGas: fee, maxPriorityFeePerGas: fee },
      });
      const r = await this.call('/v1/requests', {
        method: 'POST',
        body: { account: cfg.wallet, chainId: cfg.chainId, userOp: userOpJson(signed.userOp as unknown as Record<string, unknown>), note: req.reason.slice(0, 280) },
      });
      if (r.status === 201 || r.status === 409) {
        const id = (r.json?.id ?? r.json?.error?.id) as string | undefined;
        if (id) this.toolToService.set(req.requestId, id);
      }
      return null; // pending: only the owner's MetaMask signature can approve
    }
  }
}
