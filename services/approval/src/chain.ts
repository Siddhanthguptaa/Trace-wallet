/**
 * Chain access for the approval service. Reads use the real account's ABI (docs/api.md 2.2 / 2.3);
 * optional reads return null when the account does not answer (older or stub wallets), required
 * reads throw ChainUnavailableError (-> HTTP 503). An interface so unit tests can fake it.
 */
import { type Address, type Hex, type PublicClient, createPublicClient, getAddress, http } from 'viem';
import type { PackedUserOperation } from '@hypnexis/shared';
import {
  type AgentCall,
  type ArgRuleView,
  approvalAccountAbi,
  chainForId,
  entryPointHandleOpsAbi,
} from '../../../packages/shared/src/approval/index.ts';
import { type SimRequest, type SimRaw, decodeSimResult, simulateCalldata, stateOverrideFor } from './simulate.ts';

export class ChainUnavailableError extends Error {}

export interface SessionView {
  validAfter: number;
  validUntil: number;
  revoked: boolean;
  nonceKey: bigint;
}

export interface ApprovalChain {
  readonly chainId: number;
  /** latest block timestamp (unix s). */
  now(): Promise<number>;
  owner(account: Address): Promise<Address>;
  entryPoint(account: Address): Promise<Address | null>;
  /** null = not readable; 0n = no session for this key. */
  nonceKeyOf(account: Address, agent: Address, lane: number): Promise<bigint | null>;
  session(account: Address, agent: Address): Promise<SessionView | null>;
  ruleOf(account: Address, agent: Address, target: Address, selector: Hex): Promise<{ allowed: boolean; rules: ArgRuleView[] } | null>;
  tracked(account: Address): Promise<{ assets: Address[]; spenders: Address[]; nfts: Address[] } | null>;
  policyCheck(account: Address, agent: Address, callData: Hex, attestation: Hex, approval: Hex): Promise<{ reason: number; tier: number; track: number; validUntil: number } | null>;
  checkUserOp(account: Address, op: PackedUserOperation, userOpHash: Hex): Promise<{ reason: number; validAfter: number; validUntil: number } | null>;
  /** EntryPoint 2D nonce for `key` (throws ChainUnavailableError). */
  getNonce(entryPoint: Address, account: Address, key: bigint): Promise<bigint>;
  /** raw simulator result; throws ChainUnavailableError if the eth_call itself fails. */
  simulate(account: Address, q: SimRequest): Promise<SimRaw>;
}

export class ViemApprovalChain implements ApprovalChain {
  readonly pub: PublicClient;
  constructor(
    readonly chainId: number,
    rpcUrl: string,
  ) {
    this.pub = createPublicClient({ chain: chainForId(chainId, rpcUrl), transport: http(rpcUrl, { timeout: 15_000 }) }) as PublicClient;
  }

  private async opt<T>(f: () => Promise<T>): Promise<T | null> {
    try {
      return await f();
    } catch {
      return null;
    }
  }

  private read(account: Address, functionName: string, args: unknown[] = []) {
    return this.pub.readContract({ address: account, abi: approvalAccountAbi, functionName, args } as never) as Promise<unknown>;
  }

  async now(): Promise<number> {
    try {
      const b = await this.pub.getBlock({ blockTag: 'latest' });
      return Number(b.timestamp);
    } catch (e) {
      throw new ChainUnavailableError(`block read failed: ${(e as Error).message}`);
    }
  }

  async owner(account: Address): Promise<Address> {
    try {
      return getAddress((await this.read(account, 'owner')) as Address);
    } catch (e) {
      throw new ChainUnavailableError(`owner() unreadable on ${account}: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  entryPoint(account: Address) {
    return this.opt(async () => getAddress((await this.read(account, 'entryPoint')) as Address));
  }

  nonceKeyOf(account: Address, agent: Address, lane: number) {
    return this.opt(async () => BigInt((await this.read(account, 'nonceKeyOf', [agent, lane])) as bigint));
  }

  session(account: Address, agent: Address) {
    return this.opt(async () => {
      const [sid, s] = (await this.read(account, 'sessionOf', [agent])) as [bigint, { validAfter: number; validUntil: number; revoked: boolean; nonceKey: bigint }];
      if (sid === 0n) return null;
      return { validAfter: Number(s.validAfter), validUntil: Number(s.validUntil), revoked: s.revoked, nonceKey: s.nonceKey };
    });
  }

  ruleOf(account: Address, agent: Address, target: Address, selector: Hex) {
    return this.opt(async () => {
      const [allowed, rules] = (await this.read(account, 'ruleOf', [agent, target, selector])) as [boolean, readonly { argIndex: number; op: number; bound: bigint }[]];
      return { allowed, rules: rules.map((r) => ({ argIndex: Number(r.argIndex), op: Number(r.op), bound: r.bound })) };
    });
  }

  tracked(account: Address) {
    return this.opt(async () => {
      const [assets, spenders, nfts] = (await Promise.all([
        this.read(account, 'trackedAssets'),
        this.read(account, 'trackedSpenders'),
        this.read(account, 'trackedNFTs'),
      ])) as [Address[], Address[], Address[]];
      return { assets: [...assets], spenders: [...spenders], nfts: [...nfts] };
    });
  }

  policyCheck(account: Address, agent: Address, callData: Hex, attestation: Hex, approval: Hex) {
    return this.opt(async () => {
      const [reason, tier, track, validUntil] = (await this.read(account, 'policyCheck', [agent, callData, attestation, approval])) as [number, number, number, number];
      return { reason: Number(reason), tier: Number(tier), track: Number(track), validUntil: Number(validUntil) };
    });
  }

  checkUserOp(account: Address, op: PackedUserOperation, userOpHash: Hex) {
    return this.opt(async () => {
      const [reason, validAfter, validUntil] = (await this.read(account, 'checkUserOp', [op, userOpHash])) as [number, number, number];
      return { reason: Number(reason), validAfter: Number(validAfter), validUntil: Number(validUntil) };
    });
  }

  async getNonce(entryPoint: Address, account: Address, key: bigint): Promise<bigint> {
    try {
      return (await this.pub.readContract({ address: entryPoint, abi: entryPointHandleOpsAbi, functionName: 'getNonce', args: [account, key] })) as bigint;
    } catch (e) {
      throw new ChainUnavailableError(`EntryPoint.getNonce failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  async simulate(account: Address, q: SimRequest): Promise<SimRaw> {
    let data: Hex | undefined;
    try {
      ({ data } = await this.pub.call({ to: account, data: simulateCalldata(q), stateOverride: stateOverrideFor(account) }));
    } catch (e) {
      throw new ChainUnavailableError(`simulation eth_call failed: ${(e as Error).message.split('\n')[0]}`);
    }
    if (!data) throw new ChainUnavailableError('simulation returned no data (state override unsupported?)');
    return decodeSimResult(data);
  }
}

/** Not used for decisions; lets status readers show what the agent asked for. */
export function describeCall(c: AgentCall) {
  return { kind: c.kind, target: c.target, value: c.value.toString(), selector: c.selector, data: c.data };
}
