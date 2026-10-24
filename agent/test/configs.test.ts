import { between, loadThresholds, rngFor } from '../hijack/harness.ts';
import { DETECTOR_MODES } from '../hijack/types.ts';
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { RULE_OPS, labelAddress, loadDemoPolicy, loadFixture, loadWalletConfig, policyInput, r2Config } from '../src/world/policy.ts';
import { SCENARIOS } from '../hijack/scenarios/index.ts';
import { WORKLOADS } from '../hijack/workloads/index.ts';
import { CARDS } from '../src/shooter/cards.ts';
import { loadInjectionDeck } from '../src/injection/pages.ts';

const labels = {
  USDC: getAddress('0x0000000000000000000000000000000000000001'),
  TicketShop: getAddress('0x0000000000000000000000000000000000000002'),
  GroceryShop: getAddress('0x0000000000000000000000000000000000000003'),
  ApiSeller: getAddress('0x0000000000000000000000000000000000000004'),
};

describe('demo policy (BUILD.md Demo policy, docs/api.md 11)', () => {
  const p = loadDemoPolicy();
  it('matches the announced numbers', () => {
    expect(p.globalCap.burst + p.globalCap.ratePerDay).toBe(20_000_000n);
    expect(p.exploreCap.burst + p.exploreCap.ratePerDay).toBe(1_000_000n); // 5% of globalCap
    expect(p.explorePerTxCap).toBe(200_000n); // 1% of globalCap
    expect(p.perTxCap).toBe(10_000_000n);
    expect(p.gasCredit).toBe(1_000_000_000_000_000n);
    expect(p.recipients).toEqual(['ApiSeller', 'TicketShop', 'GroceryShop']);
  });
  it('builds a PolicyInput with 5 rule entries, never open-ended', () => {
    const pi = policyInput(p, labels, 1_800_000_000);
    expect(pi.calls).toHaveLength(5);
    expect(pi.validUntil).toBeGreaterThan(pi.validAfter);
    expect(pi.validAfter).toBe(1_800_000_000 - 1);
    const transfer = pi.calls[0]!;
    expect(transfer.rules[0]!.op).toBe(RULE_OPS.indexOf('PAYEE'));
  });
  it('R2 config = same pairs without argument rules, static recipients', () => {
    const c = r2Config(p, labels);
    expect(c.targets).toHaveLength(5);
    expect(c.recipients).toHaveLength(3);
    expect(c.dailyCaps[0]).toBe(20_000_000n);
  });
});

describe('wallet configs R1-R4 (EXPERIMENTS X1)', () => {
  it('R3 has no attestor and no exploration; R4 has both', () => {
    expect(loadWalletConfig('R1').kind).toBe('eoa');
    expect(loadWalletConfig('R2').kind).toBe('naive');
    const r3 = loadWalletConfig('R3');
    const r4 = loadWalletConfig('R4');
    expect(r3.attestor).toBe(false);
    expect(r3.exploration).toBe(false);
    expect(r4.attestor).toBe(true);
    expect(r4.exploration).toBe(true);
  });
  it('X6 adds watcher + 3-of-5 guardians on top of R4', () => {
    const x6 = loadWalletConfig('X6');
    expect(x6.watcher).toBe(true);
    expect(x6.guardians).toEqual({ count: 5, threshold: 3 });
  });
});

describe('fixtures', () => {
  it('legit stream payees are keccak(label) addresses and fit in the burst', () => {
    const fx = loadFixture<{ steps: { amount: string }[]; payees: Record<string, { label: string; address: string }> }>('legit_stream.json');
    for (const p of Object.values(fx.payees)) expect(labelAddress(p.label)).toBe(getAddress(p.address));
    const total = fx.steps.reduce((s, x) => s + BigInt(x.amount), 0n);
    expect(total).toBe(9_250_000n);
    expect(total < 10_000_000n).toBe(true);
  });
  it('every deck card has a registered TypeScript reader', () => {
    const deck = loadFixture<{ cards: { id: string }[] }>('deck_params.json');
    const ids = new Set(CARDS.map((c) => c.id));
    for (const c of deck.cards) expect(ids.has(c.id)).toBe(true);
  });
  it('injection deck lists the 3 X1 cards + a control; unauthored pages stay null (never invented)', () => {
    const d = loadInjectionDeck();
    expect(d.cards.map((c) => c.id)).toEqual(['control', 'poisoned_page', 'delivery_fee', 'approve_transfer_redefinition']);
  });
});

describe('X6 harness (EXPERIMENTS X6)', () => {
  it('registers H1-H9 and L1-L4, all ready', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9']);
    expect(WORKLOADS.map((w) => w.id)).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(SCENARIOS.every((s) => s.ready) && WORKLOADS.every((w) => w.ready)).toBe(true);
  });

  it('the seeded rng reproduces a run and differs across seeds', () => {
    const a = rngFor(42, 'run');
    const b = rngFor(42, 'run');
    const c = rngFor(43, 'run');
    const xs = [a(), a(), a()];
    expect(xs).toEqual([b(), b(), b()]);
    expect(xs).not.toEqual([c(), c(), c()]);
    const r = rngFor(7);
    for (let i = 0; i < 200; i++) {
      const v = between(r, 3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('the pinned thresholds are fixed on dev seeds and sane', () => {
    const th = loadThresholds();
    expect(th.fixedOnDevSeeds).toBe(true);
    expect(th.onchain.velocityBps).toBeGreaterThan(0);
    expect(th.onchain.velocityBps).toBeLessThan(10_000);
    expect(th.onchain.strikeMax).toBeGreaterThanOrEqual(1);
    expect(DETECTOR_MODES).toEqual(['combined', 'tripwires', 'watcher', 'none']);
  });
});

describe('X1 card registry', () => {
  it('has the 13 cards of the deck, all ready, R4-only attestor card', async () => {
    const { CARDS } = await import('../src/shooter/cards.ts');
    expect(CARDS.map((c) => c.id)).toEqual([
      'legit_only', 'ticket_to_attacker', 'set_approval_for_all', 'approve_max', 'x402_side_door',
      'batch_selfcall_delegatecall', 'gas_burn_griefing', 'replay_wrong_chain', 'greedy_merchant',
      'midnight_double_spend', 'multi_key_cap', 'sybil_payee', 'attestor_compromise',
    ]);
    expect(CARDS.every((c) => c.ready)).toBe(true);
    expect(CARDS.find((c) => c.id === 'attestor_compromise')!.configs).toEqual(['R4']);
    expect(CARDS.filter((c) => c.id !== 'attestor_compromise').every((c) => c.configs.length === 4)).toBe(true);
  });
});
