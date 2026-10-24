/** Fixed inputs for the port-vs-fork cross-check (test/port.test.ts, test/fork/oracle.ts). */

const e = (source: string, target: string, successfulCoJobs: number, weight: number, economicVolume = 20 * successfulCoJobs, escrowReliability = 1) => ({
  source,
  target,
  successfulCoJobs,
  economicVolume,
  weight,
  escrowReliability,
});

/** Honest wallets paying two shops, plus a 3-node payment ring and a stray link into it. */
const mainEdges = [
  e('w1', 'shop', 5, 1.9),
  e('w2', 'shop', 4, 1.7),
  e('w3', 'shop', 6, 2.1),
  e('w4', 'shop', 2, 1.1),
  e('w1', 'cafe', 3, 1.4),
  e('w2', 'cafe', 1, 0.6),
  e('s1', 's2', 4, 1.5),
  e('s2', 's3', 4, 1.5),
  e('s3', 's1', 4, 1.5),
  e('w4', 's1', 1, 0.5),
];
const mainNodes = ['w1', 'w2', 'w3', 'w4', 'shop', 'cafe', 's1', 's2', 's3'];

const clique = ['c1', 'c2', 'c3', 'c4'];
const cliqueEdges = clique.flatMap((a) => clique.filter((b) => b !== a).map((b) => e(a, b, 2, 1.2)));

export const fixture = {
  lcbGrid: [
    [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [4, 1], [10, 2], [30, 3], [0, 5], [100, 0], [7, 7],
  ] as Array<[number, number]>,
  cusumSeqs: [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 1, 0, 0, 1, 0, 0, 0, 1],
  ] as Array<Array<0 | 1>>,
  traceScoreInputs: [
    { completionRate: 1, repaymentRate: 1, networkTrust: 0, stakeRatio: 0, successfulEscrowRate: 1, defaultProbability: 0.2275, sybilRisk: 0, disputeRate: 0 },
    { completionRate: 0.6, repaymentRate: 0.6, networkTrust: 0.4, stakeRatio: 0, successfulEscrowRate: 0.6, defaultProbability: 0.5, sybilRisk: 0.9, disputeRate: 0 },
    { completionRate: 0, repaymentRate: 0, networkTrust: 0, stakeRatio: 0, successfulEscrowRate: 0, defaultProbability: 1, sybilRisk: 1, disputeRate: 1 },
  ],
  defaultProbInputs: [
    { totalJobs: 0, failedJobs: 0, defaultedJobs: 0, disputedJobs: 0, scoreVolatility: 0, stakeSats: 0, totalEconomicVolume: 0, repaymentRate: 1 },
    { totalJobs: 3, failedJobs: 0, defaultedJobs: 0, disputedJobs: 0, scoreVolatility: 12.5, stakeSats: 0, totalEconomicVolume: 60, repaymentRate: 1, recentFailureSignal: 0 },
    { totalJobs: 8, failedJobs: 3, defaultedJobs: 3, disputedJobs: 0, scoreVolatility: 40, stakeSats: 0, totalEconomicVolume: 160, repaymentRate: 0.625, recentFailureSignal: 0.6 },
    { totalJobs: 25, failedJobs: 1, defaultedJobs: 1, disputedJobs: 1, scoreVolatility: 150, stakeSats: 10, totalEconomicVolume: 500, repaymentRate: 0.96, recentFailureSignal: 0.2 },
  ],
  adaptiveN: [2, 9, 30, 100, 1000],
  graph: {
    nodes: mainNodes,
    edges: mainEdges,
    seeds: ['w1', 'w2', 'w3'],
    trustMap: { w1: 0.8, w2: 0.7, shop: 0.9, s1: 0.25 },
    sybil: { s1: 0.9, s2: 0.9, s3: 0.9, w4: 0.1 },
  },
  spectral: [
    { scc: ['r1', 'r2', 'r3', 'r4'], weights: { 'r1→r2': 1, 'r2→r3': 1, 'r3→r4': 1, 'r4→r1': 1 } },
    { scc: clique, weights: Object.fromEntries(cliqueEdges.map((x) => [`${x.source}→${x.target}`, x.weight])) },
    { scc: ['a', 'b'], weights: { 'a→b': 1, 'b→a': 1 } },
  ],
  sybilGraphs: [
    { nodes: mainNodes, edges: mainEdges },
    {
      nodes: [...clique, 'h1', 'h2', 'h3', 'h4', 'h5', 'm', 'x1', 'x2'],
      edges: [
        ...cliqueEdges,
        e('h1', 'm', 3, 1.4),
        e('h2', 'm', 2, 1.1),
        e('h3', 'm', 1, 0.6),
        e('h4', 'm', 4, 1.7),
        e('h5', 'm', 2, 1.0),
        e('x1', 'x2', 3, 1.3),
        e('x2', 'x1', 3, 1.3),
      ],
    },
    { nodes: ['lonely1', 'lonely2'], edges: [] },
  ],
  edgeUpdates: [
    [{ amount: 10, success: true }, { amount: 10, success: true }, { amount: 10, success: true }],
    [{ amount: 50, success: true }, { amount: 50, success: false }, { amount: 50, success: true }],
    [{ amount: 1, success: true }],
  ],
  scoreCases: [
    { jobs: [{ success: true, price: 20, round: 1 }, { success: true, price: 20, round: 2 }, { success: true, price: 20, round: 3 }], networkTrust: 0, sybilRisk: 0 },
    {
      jobs: [
        { success: true, price: 15, round: 1 },
        { success: true, price: 25, round: 2 },
        { success: false, price: 30, round: 3 },
        { success: true, price: 10, round: 4 },
      ],
      networkTrust: 0.3,
      sybilRisk: 0.1,
    },
    {
      jobs: [
        { success: false, price: 20, round: 1 },
        { success: false, price: 20, round: 1 },
        { success: false, price: 20, round: 2 },
        { success: false, price: 20, round: 3 },
        { success: false, price: 20, round: 3 },
      ],
      networkTrust: 0,
      sybilRisk: 0,
    },
    {
      jobs: [
        { success: true, price: 5, round: 10 },
        { success: true, price: 50, round: 10 },
        { success: true, price: 20, round: 12 },
        { success: true, price: 8, round: 20 },
        { success: true, price: 100, round: 21 },
      ],
      networkTrust: 0.8,
      sybilRisk: 0.6,
    },
  ],
};
