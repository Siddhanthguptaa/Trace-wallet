/**
 * Every backend path the frontend calls, in one place.
 * IDEA.md names the operations (7.2, 7.3, 7.5, 7.6) but not all paths. These are the
 * frontend's assumption until the backend team confirms them (FRONTEND_PLAN.md O3).
 */
export const endpoints = {
  agentTools: {
    /** POST JSON args, returns JSON. One route per tool named in IDEA 7.2. */
    tool: (name: 'get_policy' | 'get_budget' | 'check' | 'pay' | 'approval_status') => `/tools/${name}`,
  },
  approval: {
    list: (wallet: string, status?: string) =>
      `/v1/requests?wallet=${encodeURIComponent(wallet)}${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    one: (id: string) => `/v1/requests/${encodeURIComponent(id)}`,
    signature: (id: string) => `/v1/requests/${encodeURIComponent(id)}/signature`,
    decline: (id: string) => `/v1/requests/${encodeURIComponent(id)}/decline`,
  },
  attestor: {
    attest: (wallet: string, payee: string) =>
      `/v1/attest?wallet=${encodeURIComponent(wallet)}&payee=${encodeURIComponent(payee)}`,
  },
  runner: {
    cards: () => '/v1/cards',
    configs: () => '/v1/configs',
    bounty: () => '/v1/bounty',
    results: () => '/v1/results',
    runs: () => '/v1/runs',
    events: (runId: string) => `/v1/runs/${encodeURIComponent(runId)}/events`,
  },
} as const;
