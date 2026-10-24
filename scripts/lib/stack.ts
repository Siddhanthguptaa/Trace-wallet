/**
 * Deploy the Hypnexis stack from forge artifacts with viem: external libraries first (MeterLib,
 * OneDoorLib, FreezeTripwires, ApprovalLib, found through each artifact's linkReferences), then
 * EntryPoint (unless given), AgentAccountAdmin, the AgentAccount implementation (libraries linked
 * into its bytecode), the factory, PolicyLens and, optionally, AgentPaymaster.
 *
 * Used by scripts/deploy.ts, the real-account e2e targets (services/*) and the demo beats. Reads
 * artifacts from <build root>/contracts/<STACK_ARTIFACTS | out>; it never builds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const BUILD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Artifact {
  name: string;
  abi: Abi;
  bytecode: Hex;
  linkReferences: Record<string, Record<string, { start: number; length: number }[]>>;
}

/** Source file (under out/) of every contract the stack deploys. */
const FILES: Record<string, string> = {
  EntryPoint: 'EntryPoint.sol',
  AgentAccountAdmin: 'AgentAccountAdmin.sol',
  AgentAccount: 'AgentAccount.sol',
  AgentAccountFactory: 'AgentAccountFactory.sol',
  PolicyLens: 'PolicyLens.sol',
  AgentPaymaster: 'AgentPaymaster.sol',
};

export function artifactsDir(): string {
  return resolve(BUILD_ROOT, 'contracts', process.env.STACK_ARTIFACTS ?? 'out');
}

export function loadArtifact(name: string, file?: string, dir = artifactsDir()): Artifact {
  const f = file ?? FILES[name];
  if (!f) throw new Error(`no source file known for ${name}`);
  const p = join(dir, f, `${name}.json`);
  if (!existsSync(p)) throw new Error(`artifact missing: ${p} (run forge build)`);
  const j = JSON.parse(readFileSync(p, 'utf8')) as { abi: Abi; bytecode: { object: Hex; linkReferences?: Artifact['linkReferences'] } };
  const obj = j.bytecode.object;
  return { name, abi: j.abi, bytecode: (obj.startsWith('0x') ? obj : `0x${obj}`) as Hex, linkReferences: j.bytecode.linkReferences ?? {} };
}

/** Replace the library placeholders of `art` with deployed addresses. */
export function linkBytecode(art: Artifact, libs: Record<string, Address>): Hex {
  let hex = art.bytecode.slice(2);
  for (const byName of Object.values(art.linkReferences)) {
    for (const [lib, refs] of Object.entries(byName)) {
      const addr = libs[lib];
      if (!addr) throw new Error(`${art.name}: library ${lib} not deployed`);
      for (const r of refs) hex = hex.slice(0, r.start * 2) + addr.slice(2).toLowerCase() + hex.slice(r.start * 2 + r.length * 2);
    }
  }
  if (/__\$[0-9a-fA-F]{34}\$__/.test(hex)) throw new Error(`${art.name}: unlinked placeholder left in bytecode`);
  return `0x${hex}` as Hex;
}

export interface ChainRef {
  rpcUrl: string;
  chainId: number;
}

export function chainOf(c: ChainRef): Chain {
  return defineChain({ id: c.chainId, name: `chain-${c.chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } } });
}

export class Deployer {
  readonly pub: PublicClient;
  readonly libs: Record<string, Address> = {};
  constructor(
    readonly chain: ChainRef,
    readonly key: Hex,
    readonly dir = artifactsDir(),
  ) {
    this.pub = createPublicClient({ chain: chainOf(chain), transport: http(chain.rpcUrl), pollingInterval: 100 }) as PublicClient;
  }

  private wallet(key: Hex = this.key) {
    const account = privateKeyToAccount(key);
    return createWalletClient({ account, chain: chainOf(this.chain), transport: http(this.chain.rpcUrl) });
  }

  /** Deploy `art` (libraries it links are deployed first, once each) and return its address. */
  async deploy(art: Artifact, args: unknown[] = [], key: Hex = this.key): Promise<Address> {
    for (const [file, byName] of Object.entries(art.linkReferences)) {
      for (const lib of Object.keys(byName)) {
        if (this.libs[lib]) continue;
        this.libs[lib] = await this.deploy(loadArtifact(lib, basename(file), this.dir), [], key);
      }
    }
    const w = this.wallet(key);
    const hash = await w.deployContract({ abi: art.abi, bytecode: linkBytecode(art, this.libs), args, account: w.account, chain: w.chain, gas: 15_000_000n } as never);
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${art.name} failed (tx ${hash})`);
    return getAddress(r.contractAddress);
  }

  async send(address: Address, abi: Abi, functionName: string, args: unknown[] = [], key: Hex = this.key, value = 0n): Promise<Hex> {
    const w = this.wallet(key);
    const hash = await w.writeContract({ address, abi, functionName, args, value, account: w.account, chain: w.chain, gas: 15_000_000n } as never);
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
    return hash;
  }

  read<T = unknown>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  }
}

export interface PaymasterCaps {
  maxFeePerGas: bigint;
  callGasLimit: number;
  verificationGasLimit: number;
  preVerificationGas: number;
  paymasterVerificationGasLimit: number;
  paymasterPostOpGasLimit: number;
}

export interface Stack {
  entryPoint: Address;
  libs: Record<string, Address>;
  admin: Address;
  implementation: Address;
  factory: Address;
  lens: Address;
  paymaster: Address | null;
  abi: { account: Abi; factory: Abi; entryPoint: Abi; paymaster: Abi; lens: Abi };
}

export interface StackOptions {
  /** use this EntryPoint (e.g. the canonical v0.8 on Base) instead of deploying one */
  entryPoint?: Address;
  paymaster?: { owner: Address; caps: PaymasterCaps } | false;
}

/** account ABI = AgentAccount + AgentAccountAdmin (the admin is reached through the account's fallback). */
export function accountAbi(): Abi {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const art of [loadArtifact('AgentAccount'), loadArtifact('AgentAccountAdmin')]) {
    for (const item of art.abi as readonly { type: string; name?: string; inputs?: { type: string }[] }[]) {
      const k = `${item.type}:${item.name ?? ''}:${(item.inputs ?? []).map((i) => i.type).join(',')}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
  }
  return out as Abi;
}

export async function deployStack(d: Deployer, o: StackOptions = {}): Promise<Stack> {
  const epArt = loadArtifact('EntryPoint');
  const entryPoint = o.entryPoint ?? (await d.deploy(epArt));
  const adminArt = loadArtifact('AgentAccountAdmin');
  const admin = await d.deploy(adminArt, [entryPoint]);
  const implArt = loadArtifact('AgentAccount');
  const implementation = await d.deploy(implArt, [entryPoint, admin]);
  const facArt = loadArtifact('AgentAccountFactory');
  const factory = await d.deploy(facArt, [implementation]);
  const lensArt = loadArtifact('PolicyLens');
  const lens = await d.deploy(lensArt);
  let paymaster: Address | null = null;
  const pmArt = loadArtifact('AgentPaymaster');
  if (o.paymaster) paymaster = await d.deploy(pmArt, [entryPoint, o.paymaster.owner, o.paymaster.caps]);
  return {
    entryPoint,
    libs: { ...d.libs },
    admin,
    implementation,
    factory,
    lens,
    paymaster,
    abi: { account: accountAbi(), factory: facArt.abi, entryPoint: epArt.abi, paymaster: pmArt.abi, lens: lensArt.abi },
  };
}

/** createAccount(owner, salt) through the factory; returns the counterfactual-equals-deployed address. */
export async function createAccount(d: Deployer, s: Stack, owner: Address, salt = 0n): Promise<Address> {
  await d.send(s.factory, s.abi.factory, 'createAccount', [owner, salt]);
  return getAddress(await d.read<Address>(s.factory, s.abi.factory, 'getAddress', [owner, salt]));
}

export const LANE_NORMAL = 0;
export const LANE_APPROVAL = 1;
