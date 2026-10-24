/**
 * Recorded data served to the frontend: the 13 X1 cards, and the x1Table (web/src/api/schemas.ts) built from
 * results/x1_table.json (the Foundry reader, 49 cells, published) plus results/x1_llm.json for the LLM column.
 * Nothing here is invented: every cell is a recorded result and carries the test that proves it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Address } from 'viem';
import { CONFIG_IDS, type ConfigId } from './config.ts';

export type Guard = 'D1' | 'D2' | 'D3' | 'core';
export interface CardInfo {
  id: string;
  title: string;
  summary: string;
  guard: Guard;
}

const SHORT: Record<string, { title: string; guard: Guard }> = {
  legit_only: { title: 'Honest agent, no attack', guard: 'core' },
  ticket_to_attacker: { title: 'Ticket to the attacker', guard: 'core' },
  set_approval_for_all: { title: 'setApprovalForAll to the attacker', guard: 'core' },
  batch_selfcall_delegatecall: { title: 'Batch, self-call, delegatecall', guard: 'core' },
  gas_burn_griefing: { title: 'Gas burn by an attacker bundler', guard: 'core' },
  replay_wrong_chain: { title: 'Replay and wrong chain', guard: 'core' },
  greedy_merchant: { title: 'Greedy merchant', guard: 'D2' },
  approve_max: { title: 'Approve MAX, then pull', guard: 'D2' },
  midnight_double_spend: { title: 'Midnight double spend', guard: 'D2' },
  multi_key_cap: { title: 'Many keys, one cap', guard: 'D2' },
  x402_side_door: { title: 'x402 side door', guard: 'D1' },
  sybil_payee: { title: 'Sybil payees', guard: 'D3' },
  attestor_compromise: { title: 'Compromised attestor', guard: 'D3' },
};
export const CARD_ORDER = Object.keys(SHORT);

const readJson = <T>(root: string, rel: string): T | null => {
  const p = join(root, rel);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
};

interface DeckFile {
  cards: { id: string; title: string; expected?: Record<string, string>; fumbles?: string[] }[];
}
interface ParamsFile {
  cards: { id: string; attack?: string }[];
}

export function loadCards(root: string): CardInfo[] {
  const deck = readJson<DeckFile>(root, 'contracts/test/cards/deck.json');
  return CARD_ORDER.map((id) => {
    const d = deck?.cards.find((c) => c.id === id);
    return { id, title: SHORT[id]!.title, summary: d?.title ?? 'The honest baseline: a legitimate payment stream with no attack.', guard: SHORT[id]!.guard };
  });
}

interface RecordedCell {
  card: string;
  config: ConfigId;
  asset: string;
  lostBaseUnits: string | number;
  beyondPolicyBaseUnits: string | number;
  legitBlocked: number;
  legitNeededApproval: number;
}
interface LlmFile {
  status: string;
  model?: string;
  cells: { card: string; config: ConfigId; runs: number; hijacked: number; attempted?: number; meanLossBaseUnits: string }[];
}

export const recordedCells = (root: string): RecordedCell[] => readJson<{ cells: RecordedCell[] }>(root, 'results/x1_table.json')?.cells ?? [];
export const llmFile = (root: string): LlmFile | null => readJson<LlmFile>(root, 'results/x1_llm.json');

const ETH = '0x0000000000000000000000000000000000000000' as Address;
const assetOf = (symbol: string, usdc: Address) =>
  symbol.toUpperCase().startsWith('ETH') ? { address: ETH, symbol: 'ETH', decimals: 18 } : { address: usdc, symbol: 'USDC', decimals: 6 };

type Out = { outcome: 'lost' | 'refused' | 'bounded' | 'na' | 'pending'; amount?: string; asset?: ReturnType<typeof assetOf>; reasonCode?: string; test?: string; runs?: { k: number; n: number } };

export function buildResults(root: string, usdc: Address) {
  const cells = recordedCells(root);
  const params = readJson<ParamsFile>(root, 'agent/fixtures/deck_params.json');
  const deck = readJson<DeckFile>(root, 'contracts/test/cards/deck.json');
  const tablePath = join(root, 'results/x1_table.json');
  const stamp = existsSync(tablePath) ? Math.floor(statSync(tablePath).mtimeMs / 1000) : null;

  const rows = CARD_ORDER.map((id) => {
    const out = {} as Record<ConfigId, Out>;
    for (const cfg of CONFIG_IDS) {
      const c = cells.find((x) => x.card === id && x.config === cfg);
      const test = `Card_${id}::test_${cfg}`;
      if (!c) {
        out[cfg] = { outcome: 'na', test };
        continue;
      }
      const lost = BigInt(c.lostBaseUnits);
      const beyond = BigInt(c.beyondPolicyBaseUnits);
      out[cfg] = {
        outcome: beyond > 0n ? 'lost' : lost > 0n ? 'bounded' : 'refused',
        ...(lost > 0n ? { amount: lost.toString(), asset: assetOf(c.asset, usdc) } : {}),
        test,
      };
    }
    const d = deck?.cards.find((x) => x.id === id);
    return {
      cardId: id,
      title: SHORT[id]!.title,
      guard: SHORT[id]!.guard,
      attack: params?.cards.find((x) => x.id === id)?.attack,
      defense: d?.expected?.R4,
      test: `Card_${id}`,
      cells: out,
    };
  });

  // LLM injection pages: three extra rows, k of n runs that got the cell's outcome.
  const llm = llmFile(root);
  if (llm?.status === 'ran') {
    for (const id of [...new Set(llm.cells.map((c) => c.card))].filter((c) => c !== 'control')) {
      const out = {} as Record<ConfigId, Out>;
      for (const cfg of CONFIG_IDS) {
        const c = llm.cells.find((x) => x.card === id && x.config === cfg);
        if (!c) {
          out[cfg] = { outcome: 'na' };
          continue;
        }
        const lost = c.hijacked > 0;
        out[cfg] = {
          outcome: lost ? 'lost' : 'refused',
          ...(lost ? { amount: c.meanLossBaseUnits, asset: assetOf('USDC', usdc) } : {}),
          runs: { k: lost ? c.hijacked : c.runs, n: c.runs },
          test: 'agent/src/shooter/llm.ts',
        };
      }
      rows.push({ cardId: `llm:${id}`, title: `LLM injection: ${id.replace(/_/g, ' ')}`, guard: 'core', attack: `a page that hypnotizes ${llm.model ?? 'the model'}`, defense: 'the wallet, not the model', test: 'results/x1_llm.json', cells: out });
    }
  }

  // metric 2 (openness): the legit stream, 6 steps, from the legit_only cells.
  const steps = readJson<{ steps: unknown[] }>(root, 'agent/fixtures/legit_stream.json')?.steps.length ?? 6;
  const legit = cells.filter((c) => c.card === 'legit_only');
  const metric2 = legit.length
    ? (Object.fromEntries(
        CONFIG_IDS.map((cfg) => {
          const c = legit.find((x) => x.config === cfg);
          if (!c) return [cfg, { outcome: 'pending' as const }];
          const bad = c.legitBlocked + c.legitNeededApproval;
          return [cfg, { outcome: c.legitBlocked > 0 ? ('blocked' as const) : c.legitNeededApproval > 0 ? ('ping' as const) : ('paid' as const), paid: steps - bad, total: steps }];
        }),
      ) as Record<ConfigId, { outcome: 'paid' | 'blocked' | 'ping' | 'pending'; paid?: number; total?: number }>)
    : null;

  return { generatedAt: stamp, rows, metric2 };
}
