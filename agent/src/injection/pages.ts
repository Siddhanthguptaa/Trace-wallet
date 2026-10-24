/**
 * Injection-card loader for the LLM shooter (EXPERIMENTS X1 prompt-injection cards).
 * The harness ships no page text: page bodies are authored by the team in
 * agent/fixtures/injection_pages.json and published with the deck so judges can add cards.
 * A card whose body is null is reported as skipped by the LLM shooter (never invented).
 */
import { loadFixture } from '../world/policy.ts';

export interface InjectionCard {
  id: string;
  title: string;
  /** Page / message text the agent's fetch_page tool returns; `{ATTACKER}` is substituted at run time. */
  page: string | null;
  control?: boolean;
}

export interface InjectionDeck {
  version: number;
  cards: InjectionCard[];
}

export function loadInjectionDeck(): InjectionDeck {
  return loadFixture<InjectionDeck>('injection_pages.json');
}

export function renderPage(card: InjectionCard, vars: Record<string, string>): string | null {
  if (card.page === null) return null;
  return card.page.replace(/\{([A-Z_]+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function authoredCards(deck: InjectionDeck): InjectionCard[] {
  return deck.cards.filter((c) => typeof c.page === 'string' && c.page.length > 0);
}
