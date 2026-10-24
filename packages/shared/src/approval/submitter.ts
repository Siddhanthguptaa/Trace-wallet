/**
 * Submitter: relays one signed PackedUserOperation (BUILD.md Layout: "direct handleOps or bundler
 * RPC"). M1 deferred the shared Submitter; this one lives under approval/ until INT promotes it.
 *   DirectSubmitter  - eth_call-simulates EntryPoint.handleOps([op]) first (a validation failure is
 *                      reported as FailedOp without spending gas), then sends it from a relayer key.
 *   BundlerSubmitter - eth_sendUserOperation + eth_getUserOperationReceipt (ERC-4337 bundler RPC).
 * Anyone may relay: the signatures inside the op are the authority (IDEA 7.3). Lane APPS (M5).
 */
import {
  type Address,
  type Chain,
  type Hex,
  type Log,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  numberToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type PackedUserOperation, unpackUserOp } from '../userop.ts';
import { entryPointHandleOpsAbi } from './abi.ts';

export interface SubmitResult {
  /** included: the op ran on-chain (check `success`); rejected: never included (validation / RPC);
   *  unknown: sent to a bundler but no receipt before the timeout (may still land). */
  status: 'included' | 'rejected' | 'unknown';
  userOpHash: Hex;
  txHash?: Hex;
  /** UserOperationEvent.success (false = the target reverted; policy blocks are success=true + PolicyBlocked). */
  success?: boolean;
  /** FailedOp reason ("AA24 signature error", "AA25 invalid account nonce", ...) or RPC error text. */
  reason?: string;
  actualGasCost?: bigint;
  /** receipt logs, for the caller to read account events (Decision, PolicyBlocked, ApprovedExecuted). */
  logs?: Log[];
}

export interface Submitter {
  readonly kind: 'direct' | 'bundler';
  submit(op: PackedUserOperation, userOpHash: Hex): Promise<SubmitResult>;
}

export function chainForId(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** FailedOp / FailedOpWithRevert reason from a handleOps revert, else the short error text. */
export function handleOpsErrorReason(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName === 'FailedOp' || rev?.data?.errorName === 'FailedOpWithRevert') {
      const args = rev.data.args as readonly unknown[];
      return String(args[1]);
    }
    if (rev?.data?.errorName) return rev.data.errorName;
    return e.shortMessage;
  }
  return (e as Error)?.message ?? String(e);
}

/** UserOperationEvent for `userOpHash` in a set of logs. */
export function findUserOperationEvent(
  logs: readonly Log[],
  entryPoint: Address,
  userOpHash: Hex,
): { success: boolean; actualGasCost: bigint; nonce: bigint } | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== entryPoint.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: entryPointHandleOpsAbi, data: l.data, topics: l.topics });
      if (ev.eventName === 'UserOperationEvent' && ev.args.userOpHash.toLowerCase() === userOpHash.toLowerCase()) {
        return { success: ev.args.success, actualGasCost: ev.args.actualGasCost, nonce: ev.args.nonce };
      }
    } catch {
      /* other event */
    }
  }
  return null;
}

export interface DirectSubmitterOptions {
  rpcUrl: string;
  chainId: number;
  entryPoint: Address;
  relayerKey: Hex;
  /** receives the gas refund; default the relayer. */
  beneficiary?: Address;
}

export class DirectSubmitter implements Submitter {
  readonly kind = 'direct' as const;
  private readonly pub;
  private readonly wallet;
  private readonly beneficiary: Address;

  constructor(private readonly o: DirectSubmitterOptions) {
    const chain = chainForId(o.chainId, o.rpcUrl);
    const account = privateKeyToAccount(o.relayerKey);
    this.pub = createPublicClient({ chain, transport: http(o.rpcUrl), pollingInterval: 100 });
    this.wallet = createWalletClient({ account, chain, transport: http(o.rpcUrl) });
    this.beneficiary = o.beneficiary ?? account.address;
  }

  get relayer(): Address {
    return this.wallet.account.address;
  }

  async submit(op: PackedUserOperation, userOpHash: Hex): Promise<SubmitResult> {
    let request;
    try {
      ({ request } = await this.pub.simulateContract({
        address: this.o.entryPoint,
        abi: entryPointHandleOpsAbi,
        functionName: 'handleOps',
        args: [[op], this.beneficiary],
        account: this.wallet.account,
      }));
    } catch (e) {
      return { status: 'rejected', userOpHash, reason: handleOpsErrorReason(e) };
    }
    let txHash: Hex;
    try {
      txHash = await this.wallet.writeContract(request);
    } catch (e) {
      return { status: 'rejected', userOpHash, reason: handleOpsErrorReason(e) };
    }
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    const ev = findUserOperationEvent(receipt.logs, this.o.entryPoint, userOpHash);
    if (receipt.status !== 'success' || !ev) {
      return { status: 'rejected', userOpHash, txHash, reason: receipt.status !== 'success' ? 'handleOps reverted' : 'no UserOperationEvent', logs: receipt.logs };
    }
    return { status: 'included', userOpHash, txHash, success: ev.success, actualGasCost: ev.actualGasCost, logs: receipt.logs };
  }
}

/** Unpacked op in bundler JSON-RPC form (hex quantities). */
export function userOpToRpcJson(op: PackedUserOperation): Record<string, string> {
  const u = unpackUserOp(op);
  const q = (v: bigint) => numberToHex(v);
  const out: Record<string, string> = {
    sender: u.sender,
    nonce: q(u.nonce),
    callData: u.callData,
    callGasLimit: q(u.callGasLimit),
    verificationGasLimit: q(u.verificationGasLimit),
    preVerificationGas: q(u.preVerificationGas),
    maxFeePerGas: q(u.maxFeePerGas),
    maxPriorityFeePerGas: q(u.maxPriorityFeePerGas),
    signature: u.signature,
  };
  if (u.factory) {
    out.factory = u.factory;
    out.factoryData = u.factoryData ?? '0x';
  }
  if (u.paymaster) {
    out.paymaster = u.paymaster;
    out.paymasterVerificationGasLimit = q(u.paymasterVerificationGasLimit ?? 0n);
    out.paymasterPostOpGasLimit = q(u.paymasterPostOpGasLimit ?? 0n);
    out.paymasterData = u.paymasterData ?? '0x';
  }
  return out;
}

export interface BundlerSubmitterOptions {
  bundlerUrl: string;
  entryPoint: Address;
  pollMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class BundlerSubmitter implements Submitter {
  readonly kind = 'bundler' as const;
  constructor(private readonly o: BundlerSubmitterOptions) {}

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(this.o.bundlerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error) throw new Error(j.error.message ?? `${method} failed`);
    return j.result as T;
  }

  async submit(op: PackedUserOperation, userOpHash: Hex): Promise<SubmitResult> {
    try {
      await this.rpc<Hex>('eth_sendUserOperation', [userOpToRpcJson(op), this.o.entryPoint]);
    } catch (e) {
      return { status: 'rejected', userOpHash, reason: (e as Error).message };
    }
    const deadline = Date.now() + (this.o.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const r = await this.rpc<null | {
        success: boolean;
        reason?: string;
        actualGasCost?: Hex;
        receipt: { transactionHash: Hex; logs: Log[] };
      }>('eth_getUserOperationReceipt', [userOpHash]).catch(() => null);
      if (r) {
        return {
          status: 'included',
          userOpHash,
          txHash: r.receipt.transactionHash,
          success: r.success,
          actualGasCost: r.actualGasCost ? BigInt(r.actualGasCost) : undefined,
          logs: r.receipt.logs,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      await new Promise((ok) => setTimeout(ok, this.o.pollMs ?? 1000));
    }
    return { status: 'unknown', userOpHash, reason: 'bundler receipt timeout' };
  }
}
