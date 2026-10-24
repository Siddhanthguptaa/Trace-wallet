/**
 * Shared helpers for the X6 scenarios/workloads: build the RunContext (fresh chain + X6 wallet +
 * an in-process watcher), fire an op as the LEAKED KEY and measure cumulative loss, detect and
 * attribute a freeze, and assemble a RunRecord. Scenarios and workloads stay tiny by using these.
 *
 * Detector modes (each X6 cell is run per mode so detectors are reported separately and combined):
 *   combined  : on-chain tripwires T1-T4 + the off-chain watcher (the product configuration)
 *   tripwires : on-chain only (no watcher service)
 *   watcher   : off-chain only (tripwire thresholds pushed out of reach via setFreezeParam)
 *   none      : neither; only the caps and the policy hold (shows the loss bound without detection)
 *
 * A hijack scenario submits ops straight from the leaked agent key (`forceAgent`): a hijacker does
 * not use our tools' pre-check, so the wallet's own validation and sandbox are what get tested.
 * Legit workloads go through the tools like an honest agent does.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { deployBase, deployWallet, send, type World } from '../src/world/deploy.ts';
import { AgentTools, type ApprovalSink } from '../src/tools/engine.ts';
import { fire, type FireOptions } from '../src/shooter/fire.ts';
import { attackerAddresses, sybilAddress, totalToAttackers } from '../src/shooter/measure.ts';
import { harnessEnv, type HarnessEnv } from '../src/env.ts';
import { devchain } from '../src/chain/anvil.ts';
import { startMocks } from '../src/mock/stack.ts';
import { ChainSource, FreezeSender, WatcherService, chainFor, publicClientFor, viemReader, viemWriter } from '../../services/watcher/src/index.ts';
import type { DetectorMode, FreezeAttribution, Op, RunContext, RunRecord } from './types.ts';

export interface BuildOptions {
  env?: HarnessEnv;
  attestorUrl?: string;
  extraAgentKeys?: Hex[];
  mode?: DetectorMode;
}

/** mulberry32: the scenario/workload randomness, so a seed reproduces a run exactly. */
export function rngFor(seed: number, salt = ''): () => number {
  let a = (seed ^ parseInt(keccak256(toBytes(`x6:${salt}`)).slice(2, 10), 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi] from the run's rng. */
export const between = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

const FREEZE_PARAM = (name: string): Hex => keccak256(toBytes(`hypnexis.freeze.${name}`));

export interface Thresholds {
  version: number;
  fixedOnDevSeeds: boolean;
  onchain: { velocityBps: number; sprayMax: number; strikeMax: number };
  watcher: {
    spend: { binSeconds: number; k: number; h: number };
    revert: { streakMax: number; cusumH: number };
    approval: { windowSeconds: number; max: number };
  };
}

/** hijack/thresholds.json, or the file named by X6_THRESHOLDS (used by the dev-seed sweep). */
export function loadThresholds(): Thresholds {
  const path = process.env.X6_THRESHOLDS ?? join(dirname(fileURLToPath(import.meta.url)), 'thresholds.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Thresholds;
}

export async function buildRun(seed: number, o: BuildOptions = {}): Promise<{ ctx: RunContext; world: World; stop: () => void }> {
  const env = o.env ?? harnessEnv();
  const mode = o.mode ?? 'combined';
  const world = await deployBase({ env });
  const wallet = await deployWallet(world, 'X6', { extraAgentKeys: o.extraAgentKeys });
  const mocks = await startMocks(world);

  // The watcher service runs in-process on the same chain; it starts at the head, so setup events
  // are not replayed. A tick after each op stands in for its poll loop (latency = one op).
  const client = publicClientFor(world.chainId, world.c.rpcUrl);
  const reader = viemReader(client);
  const writer = viemWriter(client, chainFor(world.chainId, world.c.rpcUrl), world.c.rpcUrl, world.keys.watcher);
  const source = new ChainSource({ client, accounts: [wallet.address], entryPoint: world.ep });
  const freezer = new FreezeSender({ writer, reader, watcher: world.addrOf.watcher });
  const th = loadThresholds();
  const watcher =
    mode === 'combined' || mode === 'watcher'
      ? new WatcherService({ accounts: [wallet.address], freezer, reader, source, config: th.watcher })
      : null;

  // Tripwires use the thresholds file in 'combined' / 'tripwires'; 'watcher' / 'none' push every
  // on-chain threshold out of reach so only the other detector (or nothing) can freeze.
  const set = (k: Hex, v: bigint) => send(world, world.keys.owner, wallet.address, world.accountAbi, 'setFreezeParam', [k, v]);
  if (mode === 'watcher' || mode === 'none') {
    await set(FREEZE_PARAM('velocityBps'), 10_000n);
    await set(FREEZE_PARAM('sprayMax'), 1_000_000n);
    await set(FREEZE_PARAM('strikeMax'), 1_000_000n);
  } else {
    await set(FREEZE_PARAM('velocityBps'), BigInt(th.onchain.velocityBps));
    await set(FREEZE_PARAM('sprayMax'), BigInt(th.onchain.sprayMax));
    await set(FREEZE_PARAM('strikeMax'), BigInt(th.onchain.strikeMax));
  }
  if (watcher) await watcher.tick(); // consume the setup events, if any

  const chainNow = async () => Number((await world.c.pub.getBlock()).timestamp);
  // Owner approval requests reach the watcher the way the approval service reports them; the owner
  // never answers (a hijacked agent's requests stay pending).
  const sink: ApprovalSink = {
    async decide() {
      if (watcher) await watcher.approvalRequest(wallet.address, wallet.agentAddress, await chainNow());
      return null;
    },
  };
  const tools = new AgentTools({ world, wallet, attestorUrl: o.attestorUrl ?? mocks.attestorUrl, approvalSink: sink });
  const attackers = attackerAddresses(world, Array.from({ length: 64 }, (_, i) => sybilAddress(i)));
  const frozen = async () =>
    (await world.c.pub.readContract({ address: wallet.address, abi: world.accountAbi, functionName: 'isFrozen', args: [wallet.agentAddress] })) as boolean;
  const ctx: RunContext = {
    world,
    wallet,
    tools,
    attackers,
    seed,
    mode,
    rng: rngFor(seed, 'run'),
    sellerBase: mocks.sellerBase,
    frozen,
    tick: async () => {
      if (watcher) await watcher.tick();
    },
    watcher,
    log: () => {},
  };
  return {
    ctx,
    world,
    stop: () => {
      mocks.stop();
      world.anvil.stop();
    },
  };
}

/** Fire one op as the leaked key (straight to the bundler) and record cumulative loss + freeze state. */
export async function step(ctx: RunContext, label: string, target: Address, value: bigint, data: Hex, o: FireOptions = {}): Promise<Op> {
  await fire(ctx.world, ctx.wallet, ctx.tools, target, value, data, { forceAgent: true, ...o }).catch(() => undefined);
  await ctx.tick();
  return observe(ctx, label);
}

/** Record cumulative loss + freeze state after something other than `step` acted. */
export async function observe(ctx: RunContext, label: string): Promise<Op> {
  const loss = await totalToAttackers(ctx.world, ctx.attackers);
  return { label, moved: loss > 0n, cumulativeLossBaseUnits: loss.toString(), frozenAfter: await ctx.frozen() };
}

export async function warp(ctx: RunContext, seconds: number): Promise<void> {
  await devchain.warp(ctx.world.c.rpcUrl, seconds);
}

/** Who froze the agent key: an on-chain tripwire / strike streak (by = the account), the watcher, or the owner. */
export async function attribute(ctx: RunContext): Promise<FreezeAttribution> {
  const w = ctx.world;
  const logs = await w.c.pub.getContractEvents({ address: ctx.wallet.address, abi: w.accountAbi, fromBlock: 0n, toBlock: 'latest' });
  const frozen = logs.find((l) => l.eventName === 'AgentFrozen');
  const none: FreezeAttribution = { by: null, trigger: null, detectors: ctx.watcher ? ctx.watcher.alarms.map((a) => a.alarm.detector) : [] };
  if (!frozen) return none;
  const args = frozen.args as { by: Address };
  if (args.by.toLowerCase() === w.addrOf.watcher.toLowerCase()) {
    const first = ctx.watcher?.alarms.find((a) => a.freeze?.status === 'sent');
    return { ...none, by: 'watcher', trigger: first?.alarm.detector ?? 'watcher' };
  }
  if (args.by.toLowerCase() === w.addrOf.owner.toLowerCase()) return { ...none, by: 'owner', trigger: 'owner' };
  // On-chain: classify by the PolicyBlocked revert data that preceded it in the same transaction.
  const tx = frozen.transactionHash;
  const blocked = logs.filter((l) => l.eventName === 'PolicyBlocked' && l.transactionHash === tx).pop();
  const reason = ((blocked?.args as { reason?: Hex } | undefined)?.reason ?? '0x') as Hex;
  // TripwireTripped(uint8 stage): stage 0 = before the call (T4 / T2), stage 1 = after metering (T1).
  const tripSel = keccak256(toBytes('TripwireTripped(uint8)')).slice(0, 10);
  let trigger = 'T3_strikes';
  if (reason.toLowerCase().startsWith(tripSel)) trigger = reason.endsWith('1') ? 'T1_velocity' : 'T2_or_T4_pre_call';
  return { ...none, by: 'onchain', trigger };
}

/** Turn a list of ops into a hijack RunRecord (first freeze = detection). */
export async function hijackRecord(id: string, ctx: RunContext, ops: Op[], unprovenLoss = 0n, notes?: string, extra: Partial<RunRecord> = {}): Promise<RunRecord> {
  let opsToFreeze: number | null = null;
  let lossBeforeFreeze = '0';
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.frozenAfter) {
      opsToFreeze = i + 1;
      lossBeforeFreeze = ops[i]!.cumulativeLossBaseUnits;
      break;
    }
  }
  const total = ops.length ? ops[ops.length - 1]!.cumulativeLossBaseUnits : '0';
  const attribution = await attribute(ctx);
  // An op "reached the wallet" if the EntryPoint mined it (UserOperationEvent). Ops rejected in
  // validation are never included and leave no trace a chain-based detector could see.
  const mined = await ctx.world.c.pub.getContractEvents({
    address: ctx.world.ep,
    abi: ctx.world.arts.EntryPoint.abi,
    eventName: 'UserOperationEvent',
    args: { sender: ctx.wallet.address },
    fromBlock: 0n,
    toBlock: 'latest',
  });
  return {
    kind: 'hijack',
    id,
    seed: ctx.seed,
    mode: ctx.mode,
    config: ctx.wallet.id,
    ops: ops.length,
    opsMined: mined.length,
    reachedWallet: mined.length > 0,
    frozen: opsToFreeze !== null,
    opsToFreeze,
    lossBeforeFreezeBaseUnits: opsToFreeze !== null ? lossBeforeFreeze : total,
    lossTotalBaseUnits: total,
    lossUnprovenBaseUnits: unprovenLoss.toString(),
    falseFreeze: false,
    freezeBy: attribution.by,
    freezeTrigger: attribution.trigger,
    alarms: attribution.detectors,
    ...(notes ? { notes } : {}),
    ...extra,
  };
}

/** Largest USDC outflow the account made inside any rolling hour, from its Decision events. */
export async function peakHourSpend(ctx: RunContext): Promise<bigint> {
  const w = ctx.world;
  const evs = await w.c.pub.getContractEvents({ address: ctx.wallet.address, abi: w.accountAbi, eventName: 'Decision', fromBlock: 0n, toBlock: 'latest' });
  const spends: { t: number; v: bigint }[] = [];
  for (const e of evs) {
    const outflow = ((e.args as { outflows?: { asset: Address; amount: bigint }[] }).outflows ?? []).filter((o) => o.asset.toLowerCase() === w.usdc.toLowerCase());
    const v = outflow.reduce((a, o) => a + o.amount, 0n);
    if (v > 0n) spends.push({ t: Number((await w.c.pub.getBlock({ blockNumber: e.blockNumber! })).timestamp), v });
  }
  let peak = 0n;
  for (let i = 0; i < spends.length; i++) {
    let sum = 0n;
    for (let j = i; j < spends.length && spends[j]!.t - spends[i]!.t < 3600; j++) sum += spends[j]!.v;
    if (sum > peak) peak = sum;
  }
  return peak;
}

export async function legitRecord(id: string, ctx: RunContext, ops: Op[], notes?: string): Promise<RunRecord> {
  const falseFreeze = ops.some((o) => o.frozenAfter) || (await ctx.frozen());
  const attribution = falseFreeze ? await attribute(ctx) : { by: null, trigger: null, detectors: [] as string[] };
  return {
    kind: 'legit',
    id,
    seed: ctx.seed,
    mode: ctx.mode,
    config: ctx.wallet.id,
    ops: ops.length,
    reachedWallet: true,
    frozen: falseFreeze,
    opsToFreeze: null,
    lossBeforeFreezeBaseUnits: '0',
    lossTotalBaseUnits: ops.length ? ops[ops.length - 1]!.cumulativeLossBaseUnits : '0',
    lossUnprovenBaseUnits: '0',
    falseFreeze,
    freezeBy: attribution.by,
    freezeTrigger: attribution.trigger,
    alarms: attribution.detectors,
    metrics: { peakHourSpendBaseUnits: (await peakHourSpend(ctx)).toString() },
    ...(notes ? { notes } : {}),
  };
}
