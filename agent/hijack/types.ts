/**
 * X6 hijack-detection harness types (EXPERIMENTS X6). A Scenario is a scripted hijack; a Workload
 * is a legit activity pattern. Both drive the X6 wallet (agent/configs/X6.json = R4 + watcher +
 * guardians + optional paymaster) through the same `fire` primitive the raw-key shooter uses, and
 * return a RunRecord the X6 aggregator turns into detection rate, time-to-freeze and false freezes.
 */
import type { Address } from 'viem';
import type { Wallet, World } from '../src/world/deploy.ts';
import type { AgentTools } from '../src/tools/engine.ts';
import type { WatcherService } from '../../services/watcher/src/index.ts';

/** Which detectors are armed (see harness.ts). */
export type DetectorMode = 'combined' | 'tripwires' | 'watcher' | 'none';
export const DETECTOR_MODES: DetectorMode[] = ['combined', 'tripwires', 'watcher', 'none'];

export interface RunContext {
  world: World;
  wallet: Wallet;
  tools: AgentTools;
  attackers: Address[];
  seed: number;
  mode: DetectorMode;
  /** Seeded rng for this run (amounts, gaps, payees): a seed reproduces the run exactly. */
  rng: () => number;
  /** Mock x402 seller bound to this run's chain. */
  sellerBase: string;
  /** Observe a freeze mid-run: true once AgentFrozen fired / isFrozen(agentKey) is true. */
  frozen: () => Promise<boolean>;
  /** One watcher poll (no-op when the mode has no watcher). */
  tick: () => Promise<void>;
  watcher: WatcherService | null;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

/** One op the harness fired, with the value that reached attacker addresses measured just after. */
export interface Op {
  label: string;
  moved: boolean;
  cumulativeLossBaseUnits: string;
  frozenAfter: boolean;
}

export interface FreezeAttribution {
  /** 'onchain' = tripwire or strike streak inside the account, 'watcher' = off-chain freeze tx. */
  by: 'onchain' | 'watcher' | 'owner' | null;
  /** T1_velocity | T2_or_T4_pre_call | T3_strikes | the watcher detector name | owner. */
  trigger: string | null;
  /** Every watcher detector that alarmed during the run (alarms continue after a freeze). */
  detectors: string[];
}

export interface RunRecord {
  kind: 'hijack' | 'legit';
  id: string;
  seed: number;
  mode?: DetectorMode;
  config: string;
  ops: number;
  /** UserOperations the EntryPoint mined for the wallet during the run (hijack runs). */
  opsMined?: number;
  /**
   * false for attacks stopped at a door the detectors never see (side-door signatures, a recovery
   * that cannot reach its threshold): they are contained, but "frozen" does not apply, so the
   * aggregator keeps them out of the detection-rate denominator and reports containment instead.
   */
  reachedWallet?: boolean;
  /** For hijack runs: did any detector freeze the key before the run ended? */
  frozen: boolean;
  /** ops fired before the first freeze (null if never frozen). */
  opsToFreeze: number | null;
  /** value lost to attacker addresses before the first freeze. */
  lossBeforeFreezeBaseUnits: string;
  /** total value lost to attacker addresses over the whole run. */
  lossTotalBaseUnits: string;
  /** loss to unproven payees (for the exploreCap assert). */
  lossUnprovenBaseUnits: string;
  /** For legit runs: >= 1 freeze happened (a false freeze). */
  falseFreeze: boolean;
  freezeBy?: FreezeAttribution['by'];
  freezeTrigger?: string | null;
  alarms?: string[];
  /** Scenario-specific measurements (paymaster drain, recovery outcome, ...). */
  metrics?: Record<string, string | number | boolean>;
  notes?: string;
}

export interface Scenario {
  id: string; // H1..H9
  title: string;
  /** true if the scenario can run on the current contracts; false until a Phase-2 module lands. */
  ready: boolean;
  appliesToLlm?: boolean;
  run(ctx: RunContext): Promise<RunRecord>;
}

export interface Workload {
  id: string; // L1..L4
  title: string;
  ready: boolean;
  run(ctx: RunContext): Promise<RunRecord>;
}
