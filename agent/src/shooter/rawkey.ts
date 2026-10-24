/**
 * Raw-key shooter (BUILD.md M7). Fires the deck through the HTTP tools / raw key on anvil and writes
 * `results/x1_shooter.json` (the second independent reader; `tools/x1_agree.py` checks it against
 * the Foundry table). HARN ships this runnable; the SCORED run is the X1 lane's job in wave 4
 * (after INT integrates the modules). `--smoke` runs the ready cards on R1-R3 into agent/out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployBase } from '../world/deploy.ts';
import { harnessEnv, OUT_DIR, RESULTS_DIR } from '../env.ts';
import { CARDS, CONFIGS, READY_CARDS, type Card, type CardCtx, type ConfigId } from './cards.ts';
import { startMocks } from '../mock/stack.ts';

export interface ShooterOptions {
  configs?: ConfigId[];
  cards?: Card[];
  smoke?: boolean;
  outFile?: string;
  attestorUrl?: string;
  sellerBase?: string;
}

export interface ShooterOutput {
  meta: { shooter: 'rawkey'; chainMode: string; smoke: boolean; generatedAt: string; readyOnly: boolean };
  cells: Record<string, unknown>[];
}

export async function runRawKeyShooter(o: ShooterOptions = {}): Promise<ShooterOutput> {
  const env = harnessEnv();
  const cards = o.cards ?? (o.smoke ? READY_CARDS : CARDS);
  const configs = o.configs ?? (o.smoke ? (['R1', 'R2', 'R3'] as ConfigId[]) : [...CONFIGS]);
  const out: ShooterOutput = {
    meta: { shooter: 'rawkey', chainMode: env.cfg.CHAIN_MODE, smoke: !!o.smoke, generatedAt: new Date().toISOString(), readyOnly: o.smoke ? true : cards.every((c) => c.ready) },
    cells: [],
  };
  for (const config of configs) {
    for (const card of cards) {
      if (!card.configs.includes(config)) continue;
      // Each cell gets a fresh chain so buckets, time and balances never leak between cards.
      const w = await deployBase({ env });
      const mocks = await startMocks(w);
      try {
        const ctx: CardCtx = { world: w, config, attestorUrl: o.attestorUrl ?? mocks.attestorUrl, sellerBase: o.sellerBase ?? mocks.sellerBase };
        const r = await card.run(ctx);
        out.cells.push(r as unknown as Record<string, unknown>);
      } catch (e) {
        out.cells.push({ card: card.id, config, error: (e as Error).message });
      } finally {
        mocks.stop();
        w.anvil.stop();
      }
    }
  }
  const file = o.outFile ?? (o.smoke ? join(OUT_DIR, 'x1_shooter_smoke.json') : join(RESULTS_DIR, 'x1_shooter.json'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

if (process.argv[1]?.endsWith('rawkey.ts')) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const smoke = process.argv.includes('--smoke');
  const wantCards = arg('--cards')?.split(',');
  const wantConfigs = arg('--configs')?.split(',') as ConfigId[] | undefined;
  runRawKeyShooter({
    smoke,
    configs: wantConfigs,
    cards: wantCards ? CARDS.filter((c) => wantCards.includes(c.id)) : undefined,
    outFile: arg('--out'),
  })
    .then((o) => {
      const bad = o.cells.filter((c) => 'error' in c);
      for (const c of o.cells) {
        const r = c as Record<string, string | number | boolean>;
        console.log(`${String(r.card).padEnd(30)} ${r.config} lost=${r.lostBaseUnits} beyond=${r.beyondPolicyBaseUnits} legitBlocked=${r.legitBlocked} needApproval=${r.legitNeededApproval} ${r.error ?? r.notes ?? ''}`);
      }
      console.log(`x1 raw-key shooter: ${o.cells.length} cells (${o.cells.length - bad.length} ok, ${bad.length} errors), smoke=${o.meta.smoke}`);
      if (bad.length) process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
