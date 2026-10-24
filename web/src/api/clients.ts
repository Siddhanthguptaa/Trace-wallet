import { z } from 'zod';
import { config } from '@/config';
import { endpoints } from './endpoints';
import { request, ApiError } from './http';
import * as S from './schemas';

const AGENT = 'agent tools service';
const APPROVAL = 'approval service';
const ATTESTOR = 'TRACE attestor';
const RUNNER = 'attack runner';

export const agentTools = {
  getPolicy: (wallet: string) =>
    request(config.agentToolsUrl, AGENT, endpoints.agentTools.tool('get_policy'), S.policy, { method: 'POST', body: { wallet } }),
  getBudget: (wallet: string) =>
    request(config.agentToolsUrl, AGENT, endpoints.agentTools.tool('get_budget'), S.budget, { method: 'POST', body: { wallet } }),
  pay: (body: { wallet: string; to: string; asset: string; amount: bigint }) =>
    request(config.agentToolsUrl, AGENT, endpoints.agentTools.tool('pay'), S.payResult, { method: 'POST', body, timeoutMs: 60_000 }),
};

export const approvals = {
  list: (wallet: string, status?: string) =>
    request(config.approvalUrl, APPROVAL, endpoints.approval.list(wallet, status), z.array(S.approvalSummary)),
  get: (id: string) => request(config.approvalUrl, APPROVAL, endpoints.approval.one(id), S.approvalRequest),
  postSignature: (id: string, signature: string) =>
    request(config.approvalUrl, APPROVAL, endpoints.approval.signature(id), S.approvalRequest, {
      method: 'POST',
      body: { signature },
    }),
  decline: (id: string) =>
    request(config.approvalUrl, APPROVAL, endpoints.approval.decline(id), S.approvalRequest, { method: 'POST', body: {} }),
};

export const attestor = {
  attest: (wallet: string, payee: string) =>
    request(config.attestorUrl, ATTESTOR, endpoints.attestor.attest(wallet, payee), S.attestation),
};

export const runner = {
  cards: () => request(config.runnerUrl, RUNNER, endpoints.runner.cards(), z.array(S.card)),
  configs: () => request(config.runnerUrl, RUNNER, endpoints.runner.configs(), z.array(S.walletConfig)),
  bounty: () => request(config.runnerUrl, RUNNER, endpoints.runner.bounty(), S.bounty),
  results: () => request(config.runnerUrl, RUNNER, endpoints.runner.results(), S.x1Table),
  fire: (cardId: string, shooter: 'raw' | 'llm') =>
    request(config.runnerUrl, RUNNER, endpoints.runner.runs(), S.runStarted, { method: 'POST', body: { cardId, shooter } }),
  /** Server-sent events for one run. Returns a close function. */
  stream(runId: string, onEvent: (e: S.RunEvent) => void, onError: (e: ApiError) => void): () => void {
    if (!config.runnerUrl) {
      onError(new ApiError(`${RUNNER} URL is not set`, 'not-configured'));
      return () => {};
    }
    const es = new EventSource(config.runnerUrl + endpoints.runner.events(runId));
    es.onmessage = (m) => {
      try {
        const parsed = S.runEvent.safeParse(JSON.parse(m.data as string));
        if (parsed.success) {
          onEvent(parsed.data);
          if (parsed.data.type === 'done') es.close();
        } else onError(new ApiError(`${RUNNER} sent an event in an unexpected shape`, 'schema'));
      } catch {
        onError(new ApiError(`${RUNNER} sent an event that is not JSON`, 'schema'));
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      onError(new ApiError(`Lost the live connection to the ${RUNNER}`, 'network'));
      es.close();
    };
    return () => es.close();
  },
};
