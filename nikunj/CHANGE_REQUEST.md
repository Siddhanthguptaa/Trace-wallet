# CHANGE REQUEST 2: C18-C31 (user, 2026-10-24)

User said, verbatim: "modify the plan.md based on everything you now know and run /nikunj-mode execute and build just the backend in multiple phases".
No plan.md exists. "The plan" means IDEA.md + WIN.md + EXPERIMENTS.md + HANDOFF.md. Apply C18-C31 below, then merge them into CHANGES.md as before.
Order: re-run Phase C (C18 touches novelty), then Phase D, then the approval gate.

Source status: [ORCH] means the orchestrator fetched or read the source this session. Phase agents must re-fetch and verify it per common.md before citing. Nothing in this file counts as verified for IDEA.md.

## C18. D3: TRACE two-track recipient policy (adds to D1/D2, does not replace them)
- A static recipient allowlist breaks in an open agent market: payees are pseudonymous and new ones appear daily. TRACE (user's paper) scores which unknown payee deserves payment.
- Pitch line: "spending limits bound how much; TRACE bounds who."
- Recipient tiers come from a signed TRACE attestation (C19):
  - proven (high LCB): normal per-tx and daily caps.
  - unproven / cold-start / no valid attestation: separate on-chain EXPLORATION BUDGET, a small slice of the daily cap (e.g. 2-5%), with a tight per-tx cap.
  - flagged (Sybil or clique penalty): owner approval (existing approval path) or block.
- Paper hook: TRACE §7.1 says fraud defense and newcomer discovery "need separate tracks with independent budgets", left as future work ("risk-conditioned exploration"). The wallet enforces it on-chain. That gives a hard bound: loss to new payees is at most the exploration budget per window, even if the agent is injected into favoring a fresh Sybil.
- Count the exploration budget with the D2 effect meter (measured outflow), not calldata amounts.
- Keep the wallet first: about 70% wallet + red team, about 30% TRACE. TRACE gets one slide, not the centerpiece.

## C19. Score attestation, ERC-7562-safe
- An off-chain TRACE attestor signs EIP-712 `ScoreAttestation{recipient, tier, validUntil, epoch}`.
  - Domain: {name, version, chainId, verifyingContract = wallet}. This blocks cross-chain and cross-wallet replay.
- The agent attaches the attestation inside `userOp.signature`. The wallet verifies it with ecrecover against an owner-set attestor address, rotatable by the owner only.
- Validation reads only the account's own storage, never a shared registry (ERC-7562 storage rules).
- Fold validUntil into validationData (min with session expiry). Never use the TIMESTAMP opcode in validation.
- A missing or expired attestation means unproven, never proven.
- The attestor key must be separate from the agent key and the agent host.
- Honest bound if the attestor is compromised: payees can be upgraded to proven, but loss stays within the global cap (D2 global bucket). State this.
- Budget enforcement that depends on measured effects happens in execution. Pair it with per-key gas caps (C25) so execution reverts can't be used for gas griefing.

## C20. Outcome signal for TRACE
- TRACE needs a success/default outcome per job.
- On EVM, take it from x402 settlement plus a delivery check, ERC-8004 feedback, or an owner/verifier-signed outcome. The plan already has a signed outcome in D2.
- Never accept outcomes reported by the agent alone, since the agent may be injected.
- The attestor consumes outcomes and re-scores.

## C21. TRACE paper facts [ORCH: Zenodo 10.5281/zenodo.22706499, full PDF read; CIKM '26, DOI 10.1145/3799682.3841014; code https://github.com/NikunjKaushik20/Trace_CIKM]
- **Score:** non-propagating. Utility = 0.40 trace - 0.30 risk - 0.15 norm + 0.10 net + 0.10 cap - 0.35 sybil - 0.25 clique. Components:
  - Bayesian LCB (Beta(1,3) prior, 95% LCB)
  - EWMA default probability plus CUSUM
  - PPR from an honest seed
  - counterparty entropy
  - edge-to-job Sybil ratio
  - clique and contamination penalties
- **Native stack:** Lightning (SatsRouter, L402, 5-20 sats per job). It needs porting to EVM.
- **Setup:** N=1000, 30% malicious, 60 rounds x 5 jobs, 5 buyers, 10 seeds, sparse synthetic graph.
- **Table 1, fraud in sats** (strat / collusion / sybil / GT):

  | Policy | strat | collusion | sybil | GT |
  |---|---|---|---|---|
  | no-bandit | 4.7 | 6.4 | 7.1 | 31.7 |
  | full | 10.7 | 46.5 | 19.0 | 83.7 |
  | REPUTATION | 16.0 | 58.0 | 18.0 | 56.9 |
  | PRICE | 11.1 | 74.4 | 32.8 | 79.4 |
  | EigenTrust | 22.0 | 183.4 | 185.4 | 4.4 |

- **Table 2, malicious-routing rate (MR):** EigenTrust is 81.7% on sybil and 41.2% on GT.
- **Table 8:** served honest providers are 125/700 for full vs 66/700 for no-bandit (-47%).
- **§7.1 recovery attempts:** loose round-robin served 104/700 with fraud 13.0±8.4. Tight round-robin added only +4 providers.
- **Table 9, partitioned views** (5 buyers x 60 jobs, n=5; strat / collusion / sybil / GT):

  | Policy | strat | collusion | sybil | GT |
  |---|---|---|---|---|
  | full | 6.4 | 44.6 | 24.2 | 86.8 |
  | no-bandit | 32.0 | 51.6 | 32.8 | 64.4 |
  | REPUTATION | 18.0 | 55.4 | 20.0 | 85.0 |
  | PRICE | 5.0 | 46.6 | 25.6 | 68.4 |
  | EigenTrust | 8.2 | 291.0 | 103.8 | 47.6 |

- **Density boundary:** collusion fraud is 6.2 at 0.8% density and 47.1 at 1.2%.
- **Scale, N=5000:** no-bandit 4.6 / 17.6 / 14.2 / 37.7. EigenTrust collusion 244.4.
- **§7.6:** the edge-to-job ratio gives false positives on real graphs. The suggested fix is a Louvain/Leiden community baseline.
- **§7.5:** outcomes are binary only and adversaries are scripted.
- **Cited [14] Xiong et al. arXiv:2606.26028 (ERC-8004 audit):** 73.5% / 59.2% / 90.6% of reviewers on Ethereum / BSC / Base share a first funding source, at $0.0027-$0.055 per fake review. This motivates not trusting raw on-chain reputation.
- **Cited [15] Xia & Wang arXiv:2606.14200:** skill-conditional reputation laundering. It applies if trust is made per capability.
- **Honesty traps the plan must state:**
  - (a) One wallet is a partitioned view. Under local evidence greedy fails (32.0 vs 6.4 on strat), so per-wallet scoring needs exploration. The exploration budget is the bounded insurance. A shared attestor gives a global view.
  - (b) Density boundary plus §7.6 false positives: the demo uses simulated agents, and the plan says so.

## C22. New experiment X4: simulator sweep (backend/analysis)
- Fork the Trace_CIKM simulator. Add the policy "TRACE + exploration budget B": greedy on proven payees, Thompson sampling on unproven payees, with spend capped at B.
- Sweep B in {0, 1, 2, 5, 10}% across the 4 attacks with 10 seeds each. Run both the sparse-centralized and the partitioned regime; partitioned is the wallet's real regime.
- Metrics: fraud, MR, served-honest providers. Baselines: full, no-bandit, REPUTATION, EigenTrust.
- Plot fraud against served-honest (the Pareto frontier).
- Pre-register the hypothesis.
  - If the frontier moves, the headline is "resolved our paper's open trade-off with an on-chain mechanism".
  - If not, report the hard bound only. No claim before the runs.

## C23. Proof layer
- Foundry invariant fuzzing: no sequence of agent-signed ops moves more than globalCap + exploration budget per window per asset, across all keys.
- Halmos symbolic test of the policy-check function, keeping loops and arrays bounded.
- THREAT_MODEL.md maps each attack to its defense and to the test name that proves it.

## C24. Results table, extends X1
- Rows: raw agent key / static allowlist + caps (what other teams build) / ours without D3 / ours with D3.
- Columns: about 10 attacks, including the existing cards, a Sybil-payee card and prompt-injection cards.
- Two metrics per cell: funds lost, and legitimate new-payee payments blocked. This is the paper's fraud-openness trade-off, measured on-chain.

## C25. Fumble checklist (verify each is covered; add any that are missing)
- ERC-7562 TIMESTAMP ban: use validUntil/validAfter.
- Gas griefing: cap maxFeePerGas and gas limits per session key, because an attacker-run bundler collects the fees.
- ERC-20 calldata: approve, transferFrom, and approve-MAX.
- ERC-1271 / Permit2 / EIP-2612 side door: covered by D1.
- Self-calls into the wallet, delegatecall, nested executeBatch, and batch splitting.
- Owner approval: EIP-712 with chainId + verifyingContract, single use, with expiry, bound to userOpHash or to target/payee/maxOutflow.

## C26. Pitch hook: real incidents [ORCH]
- Freysa, Nov 2024: 13.19 ETH (~$47k) sent after 482 attempts. The winning message redefined approveTransfer. Sources: https://the-decoder.com/hacker-wins-47000-by-tricking-ai-chatbot-with-smart-prompting/ and https://simonwillison.net/b/8335
- aixbt, 2025-03-18: 55.5 ETH (~$106k) moved via a dashboard breach, not AI manipulation. Sources: https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth and https://incidentdatabase.ai/entities/aixbt-autonomous-ai-crypto-bot/
- These map to the brief's two threats: manipulation, and key/control compromise.

## C27. Key-on-projector bounty: honest bound
- Announce the maximum extractable amount before the challenge: exploration budget per window. In-policy spend can reach only proven or allowlisted payees.
- Testnet by default. Use a small mainnet amount only after X1 + fuzzing/Halmos pass and the event rules allow it.
- Prerequisites: gas caps, 1271 owner-only, self-call block, batch-aware caps.

## C28. Credibility framing
- "TRACE, CIKM '26 (Rome, Nov 7-11 2026)".
- The ICLR submission is "under review". Its content is unknown, since the user hasn't shared it, so don't describe it.

## C29. Scope: BUILD BACKEND ONLY, in multiple milestones
- In scope:
  - Solidity contracts with Foundry tests, proofs and deploy scripts.
  - Off-chain services as HTTP/JSON APIs: the TRACE attestor (port the scoring from Trace_CIKM), the approval store with eth_call simulation, and outcome ingestion.
  - The agent runner and attack harness (scripted + LLM injection cards), which writes the results table as CSV/JSON.
  - X4 simulator scripts and plots.
- Out of scope: web frontend, dashboard, mobile UI.
- Owner approval is exercised through a scripted signer plus typedData/passkey test vectors. The UI comes later.

## C30. Time
- Dropping the frontend frees time. The earlier estimate was 17.1 of 16.8 person-days.
- Re-budget with D3 + X4 + proofs, and keep an explicit cut order. Candidates: ERC-7579/7702 shaping first, then Halmos (keep the fuzzing), then the mainnet bounty (keep testnet), then reduce X4 to the partitioned regime only.

## C31. Paper inconsistency (user informed; don't repeat it in the pitch)
- The abstract, §1 contribution (6) and §8 say greedy gives "6.8x higher fraud than Thompson sampling" under partitioned views.
- Table 9 shows 32.0 vs 6.4, which is 5.0x. The 6.8x figure is 32.0 vs 4.7: greedy partitioned vs greedy centralized (§7.3 text).
- Cite 5.0x when comparing against Thompson sampling.

## Context
- C:\Users\siddh\Downloads\AGENTS.md is AgentCredit, a Lightning credit-layer spec for another project. Its ideas can be reused, but it is not the build target.
- The user's CLAUDE.md asks for shell commands to be prefixed with `rtk` (installed: rtk 0.35.0).
