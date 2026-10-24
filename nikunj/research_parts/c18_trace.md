### E1 | TRACE Reproducibility Package | 2026
Kind: repo
URL: https://raw.githubusercontent.com/NikunjKaushik20/Trace_CIKM/main/paper/reproducibility/README.md
Quote: "Publication matrix: seeds 42-51 (10 seeds per N level)"
QuoteB: "Full matrix: N=10,50,100,1000,5000 × 6 attacks × 4 policies × 10 seeds = 1200 cells"
QuoteC: "npx tsx scripts/_publicationMatrixWorker.ts _tmp_config.json"
Claim: Public code release of the TRACE v2.10 simulator that X4 forks and the attestor ports. A single cell runs through `scripts/_publicationMatrixWorker.ts` with a JSON config (policy, attack, seed, networkSize 1000, rounds 60, jobsPerRound 5, maliciousRatio 0.3). Canonical seeds are 42-51. The README's routing weights (alpha_traceScore 0.40, beta_defaultRisk 0.30, gamma_cost 0.15, delta_networkTrust 0.10, epsilon_capability 0.10, lambda_sybilPenalty 0.35, mu_cliquePenalty 0.25) match the paper's utility. Scoring lives in src/lib/trace (traceScore.ts, trustGraph.ts, traceRouter.ts).
Regime: TypeScript run with tsx on Node >= 18; Prisma ORM over SQLite through the better-sqlite3 adapter (src/lib/db.ts); README states 16 GB RAM minimum (32 GB for N >= 5000). One commit, "Code release: TRACE (CIKM 2026) simulation framework and experiment scripts", dated 2026-08-29 (GitHub API, fetched 2026-10-24).
Limits: The public tree (GitHub API recursive listing, fetched 2026-10-24) has no package.json and no tsconfig, so the README's `npm install` cannot run as published. runner.ts imports `../../openaiModel` and `../../../../scripts/recoveryBaseline`, and traceRouter.ts imports `../events`; none of the three is in the tree. X4 and the attestor port therefore need a reconstructed package.json plus stubs, or the author's full local copy (inferred). Runtime per cell is not stated. The simulator writes every job through Prisma, so a sweep of several hundred cells may be slow on a laptop (inferred). No license file (GitHub license: null).
Reqs: R7, R16
Verified: pending
