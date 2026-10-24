/**
 * @hypnexis/agent (M7, lane HARN): HTTP agent tools, the raw-key and LLM shooters, the injection
 * deck, the legit stream, the mock x402 seller, R1-R4 wallet configs and X1 aggregation; plus the
 * Phase-2 X6 hijack harness (scenarios H1-H8, workloads L1-L4). Plain HTTP only (the MCP wrapper is
 * CUT, FASTPLAN cut 2).
 */
import OpenAI from 'openai';
import { loadConfig } from '@hypnexis/shared';

export const PACKAGE = '@hypnexis/agent';

/** OpenAI-compatible client for the LLM shooter (default: local Ollama, LLM_BASE_URL). */
export function createLlmClient(cfg = loadConfig()): { client: OpenAI; model: string } {
  return { client: new OpenAI({ baseURL: cfg.LLM_BASE_URL, apiKey: 'ollama' }), model: cfg.LLM_MODEL };
}

export * from './env.ts';
export * from './world/policy.ts';
export * from './world/deploy.ts';
export * from './ops/encode.ts';
export * from './ops/reasons.ts';
export * from './ops/submitter.ts';
export * from './tools/engine.ts';
export * from './tools/buckets.ts';
export { createToolsServer } from './tools/server.ts';
export { createMockAttestor, signAttestation } from './mock/attestor.ts';
export { createX402Seller } from './mock/x402Seller.ts';
export { fetchAttestation } from './attest/client.ts';
export { playLegitStream, loadLegitStream } from './legit/stream.ts';
export { payX402 } from './legit/x402.ts';
export { loadInjectionDeck, authoredCards, renderPage } from './injection/pages.ts';
export { runRawKeyShooter } from './shooter/rawkey.ts';
export { runLlmShooter } from './shooter/llm.ts';
export { CARDS, READY_CARDS } from './shooter/cards.ts';
