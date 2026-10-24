Prior work (Nikunj) relevant to W3-02 Agent Wallet. Read-only survey 2026-10-24.

1. TRACE paper (CIKM 2026). https://zenodo.org/records/22706499, DOI 10.5281/zenodo.22706499
- Local PDF: D:\sats_router\paper\arxiv\TRACE_CIKM2026_preprint.pdf, source trace_arxiv.tex.
- Related DOI 10.1145/3799682.3841014 (ACM version) currently returns 404 on doi.org. UNVERIFIED.
- What it scores: providers/agents in a pseudonymous marketplace. Inputs are uncertainty-aware evidence
  weighting (Bayesian confidence bounds) plus structural coordination detection (Sybil/clique). It does
  NOT propagate trust through the graph.
- Numbers (trace_arxiv.tex:59, same text on Zenodo): "EigenTrust routes 81.7% of jobs to malicious agents
  under Sybil attack, while reputation-only contains the same attack to 29.0%". With no Thompson sampling,
  fraud goes 10.7/46.5/19.0/83.7 -> 4.7/6.4/7.1/31.7 sats. N=1,000, 30% adversaries, 10 seeds;
  replicated at N=5,000 and on Bitcoin OTC/Alpha.
- Caveat (trace_arxiv.tex:105): under partitioned views greedy gives "6.8x higher fraud" than Thompson on
  strategic-default.
- Plug-in: TRACE score/routing_decision (ROUTE, ROUTE_WITH_CAUTION, HOLD, INVESTIGATE, REFER, QUARANTINE,
  DENY) acts as a recipient-risk oracle. Low trust or unknown recipient -> needs owner approval (R9).

2. D:\sats_router (public: https://github.com/NikunjKaushik20/sats_router)
- src/lib/budget.ts:26 daily cap (dailyBudgetSats); :43 per-incident cap (rolling 10-min window).
- src/lib/safety.ts: SHA-256 input-hash loop detection.
- All caps are OFF-CHAIN DB checks, which is exactly the gap W3-02 closes.
- src/lib/x402.ts:9: the router "SIGNS an EIP-3009 authorization" (ExactEvmScheme + wrapFetchWithPayment).
  The key is a raw EOA from env X402_ROUTER_PRIVATE_KEY, so a leaked key = full drain.
  This is the motivating anti-pattern for R14. The file is NOT in the public repo.
- src/agents/orchestrator.ts:521 callX402Endpoint (402 -> sign EIP-3009 -> retry X-PAYMENT).
- src/agents/badScraper.ts: a scam provider agent, reusable as a malicious-recipient fixture.
- new_paper/x402_usenix (USENIX Sec '27 draft). Its README says "Nothing run, no chain data pulled." NO RESULTS.
  - Claim: on Base x402 settlements, payment-graph reputation (volume, TraceRank, EigenTrust, PPR) gets
    captured by fictitious/cluster-internal volume.
  - Cites Ling et al. arXiv:2607.12575: "21.20% fictitious, 63.78% internal" of 136.7M settlements.
    UNVERIFIED, third-party.
  - Protocol-level x402 attacks (arXiv:2605.30998, 2607.19545, 2605.11781) are listed "out of scope".
    W3-02 could mine them for EIP-3009 issues. UNVERIFIED.
  - extract/fetch_x402_settlements.py:7 says x402 "exact" settles via USDC transferWithAuthorization ->
    AuthorizationUsed event (extract/common.py:43).
  - config.yaml:18 notes facilitators can relay "through ... an ERC-4337 bundler, where tx.from isn't the
    facilitator".
  - No ERC-1271 analysis found anywhere (grep). Gap: a 4337 smart account must sign x402 payloads via
    ERC-1271/6492, and USDC's EIP-3009 needs a contract-signature path. Check the USDC v2.2 impl. (inferred)
  - replay/injection_attack.py: attacker min-cost grid search to enter top-k, reusable for a "cost to game
    trust-gated allowlist" metric.

3. D:\trace-api (GitHub NikunjKaushik20/TRACE-API returns 404, so private)
- sdk/x402_middleware.py and .ts: trust gate keyed on X-Payment-Sender.
  - ALLOW_DECISIONS allow-list {ROUTE, ROUTE_WITH_CAUTION}, fail-closed (x402_middleware.py:19, .ts:22).
  - DEFAULT_MIN_SCORE 0.25.
- sdk-python/x402_trace_trust/.../extension.py: x402 ResourceServerExtension hook on_after_verify.
  - BUG/THREAT (:107): it DENY-lists only ("HOLD","INVESTIGATE"), so QUARANTINE/DENY/REFER pass when
    score>=0.35.
  - :105 defaults a missing score to 1.0, which fails open.
  - Inconsistent with the SDK allow-list. Lesson: wallet policy must use an allow-list.
- buildathon/merchant/app.py:64-66 caps: MAX_CREDITS_PER_PURCHASE=20, MAX_ROLLING_AMOUNT_INR_PER_AGENT=2000,
  VELOCITY_WINDOW_SECONDS=300.
  - Checked before the trust gate.
  - Per-agent asyncio lock (:402) prevents concurrent cap race.
- Spend-cap bypass surface (inferred, not tested):
  - The velocity tracker is in-memory and keyed by agent_id, so it resets on restart.
  - Identity rotation (new agent_id) gets a fresh cap.
  - Only TRACE graph signals catch Sybils.
  - On-chain per-wallet daily limit fixes the first two.
- buildathon/agent/buyer.py: LLM buyer (gpt-4o-mini, temp 0), tools get_catalog/check_trust/buy_credits.
  - The client-side _dispatch_buy budget check is a "courtesy check" that injection can talk past.
- Prompt-injection demo already exists (NOTES.md:645-720, `--rogue`): "buy all 50 credits in ONE call" ->
  400 per-purchase cap -> splits 20+20 -> 429 rolling cap; stops at 40/50 (NOTES.md:711, :720). Direct
  template for R15.
- buildathon/attack_sim/agents.py + run_attack.py: honest (32 jobs), strategic defector
  (32 honest then burst of 8 failures), Sybil ring (mutual endorsements).
- README.md:192: "Blocked: 16/36, of which 16/16 were the fraud population". 0/20 honest blocked.
  - Run: 36 agents (20 honest, 1 defector, 15 Sybil); p95 292.0ms.
- README.md:149-152 TRACE improvement vs EigenTrust: sybil_cluster 74%, game_theoretic 69%, collusion 32%;
  strategic_default 0% (tie).

Hooks into W3-02
H1. Recipient policy (R7/R9): the on-chain allowlist is the hard bound. TRACE routing_decision (allow-list
    ROUTE*) is an off-chain co-signer/guardian signal. A non-allowlisted or low-trust payee goes to the
    owner-approval queue. The score never loosens on-chain caps, it only escalates.
H2. Attack suite (R16): port attack_sim classes (Sybil ring, defector) + rogue-prompt run into Foundry/Hardhat
    tests vs the 4337 module. Add: leaked session key drains, split-payment under daily cap, recipient swap,
    expired session, selector smuggling via execute/batch, EIP-3009 auth replay.
H3. Injection demo (R15): reuse buyer.py loop + `--rogue` kickoff_override. Swap merchant HTTP caps for
    on-chain validateUserOp reverts. Same 400/429 storyline with tx hashes.
H4. Use case (R13): x402 API credits. sats_router x402.ts flow + trace-api x402_middleware, with the payer
    as a 4337 smart account (EIP-3009 via ERC-1271 path, verify feasibility) under a session-key policy.
H5. Lessons: allow-list over deny-list (extension.py:107 bug); caps checked before scoring; per-key locking;
    report honest ties (strategic_default 0%).
