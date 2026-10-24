# nov2 log: D3 prior check (TRACE two-track recipient policy, on-chain)

Date 2026-10-24. Goal: hackathon (light check). Engines: web search, arXiv API, GitHub API. Every page cited with a [nov2:E#] tag or described below was fetched in this session with the verifier's user agent. Items marked "snippet only" were seen as an arXiv API title plus abstract snippet. Items marked "not fetched" are search hits only, and no claim is made from them.

Covered by another agent, cited by name only: ERC-8004 EIP page, arXiv 2606.26028, arXiv 2606.14200, EIP-712, VerifyingPaymaster, Trace_CIKM repo, TRACE paper, Foundry, Halmos, Freysa, aixbt.

## (a) On-chain spend policy giving unknown payees a separate budget or tier, keyed to trust attestations

Queries run:
1. arXiv API, sortBy=submittedDate desc, max 10: `(abs:x402 OR abs:"ERC-8004" OR abs:"agent wallet" OR abs:"smart account" OR abs:"session key") AND (abs:reputation OR abs:trust) AND (abs:spending OR abs:budget OR abs:limit OR abs:policy)` (10 results)
2. Web search (extended): `agent smart account spending limit policy new recipients reputation attestation gated payments ERC-8004 x402 session key 2026`

Top hits:
- Recurring x402 payments (MetaMask), https://docs.metamask.io/smart-accounts-kit/1.5.0/guides/x402/buyer/recurring-payments/ [nov2:E1]
- Agent wallet identity, permissions, and compliance (Openfort), https://www.openfort.io/blog/agent-permissions [nov2:E2]
- SoK: Blockchain Agent-to-Agent Payments, https://arxiv.org/abs/2604.03733 [nov2:E3]
- From Agent Identity to Agent Economy: Measuring the Operational Readiness of ERC-8004 AI Agents, https://arxiv.org/abs/2606.12128 (fetched; abstract says reputation formation and service exposure "remain limited" and feedback activity is "highly concentrated"; no percentages in the abstract)
- Making x402 Programmable with Smart Accounts (Nevermined), https://nevermined.ai/blog/making-x402-programmable (fetched; lists "per-merchant caps" among smart-account policies; a trust input is not shown)
- What a disclosed x402 SDK flaw looks like on Base, measured (dev.to, posted Oct 24), https://dev.to/agenticfinancegraph/what-a-disclosed-x402-sdk-flaw-looks-like-on-base-measured-34nk (fetched; V12 reported on 22 October 2026 that x402 client SDKs before 2.23.0 "signed whatever amount a 402 response asked for"; the fix sets a $1 per-payment cap by default; the article says a $1 cap lets a tenfold overcharge of a cheap resource through)
- Paying to Know: Micro-Transaction Markets for Verified Product Information in Agentic E-Commerce, https://arxiv.org/abs/2606.24783 (snippet only)
- Towards Multi-Agent Economies: Enhancing the A2A Protocol with Ledger-Anchored Identities and x402 Micropayments for AI Agents, https://arxiv.org/abs/2507.19550 (snippet only)
- Not fetched: Coinbase Agentic Wallets Explained (https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained), Agent Wallet: How AI Agents Hold and Spend Onchain (https://www.allium.so/blog/agent-wallet-how-ai-agents-hold-and-spend-onchain/), ERC-4337 AI Agent Payments: Spending Limits, Session Keys (https://rebelfi.io/blog/erc-4337-ai-agent-payments-smart-wallets).

Closest prior work we found is MetaMask's periodic x402 permission [nov2:E1] (a contract-metered weekly cap on an agent's x402 spend) together with allowlist rules such as Openfort's [nov2:E2] (block non-allowlisted addresses or cap the amount). It differs from D3 in this: both apply one policy whoever the payee is, and payee trust is not an input (not shown). An unknown payee is either inside the shared cap or blocked. D3 picks the budget per recipient from an attestor-signed EIP-712 tier checked in validateUserOp (validUntil folded into validationData, account storage only). Unproven or unattested payees go to a separate exploration budget (2-5% of the daily cap, tight per-tx cap) metered by measured outflow in execution, and flagged payees go to owner approval or block.
Why it matters: per the dev.to case, a per-payment cap alone lets overcharges through; a per-window budget for unproven payees bounds their total (inferred). Per the ERC-8004 readiness paper, thin reputation is the norm today, so the unattested track will carry most new payees, and concentrated feedback points to sybil and clique risk (inferred).

## (b) Budgeted or conservative exploration for newcomers (bandits, reputation, routing)

Queries run:
1. arXiv API, sortBy=submittedDate desc, max 10: `ti:conservative AND (ti:bandit OR ti:bandits OR ti:exploration)` (31 results)
2. arXiv API, sortBy=submittedDate desc, max 10: `(abs:newcomer OR abs:newcomers OR abs:"cold-start" OR abs:"cold start") AND (abs:reputation OR abs:trust) AND (abs:exploration OR abs:bandit OR abs:bandits)` (8 results)
Plus a direct fetch of the classic arXiv 1602.04282.

Top hits:
- Reserve-Aware Contrast Certificates for Conservative Bandits with Uncertain Baselines (2026-09-30), https://arxiv.org/abs/2609.39106 [nov2:E5]
- MonoScale: Scaling Multi-Agent System with Monotonic Improvement (2026-01-30), https://arxiv.org/abs/2601.23219 [nov2:E6]
- Conservative Bandits (2016), https://arxiv.org/abs/1602.04282 [nov2:E4]
- Multi-Task Representation Learning for Conservative Linear Bandits (2026-05-12), https://arxiv.org/abs/2605.12176 (snippet only)
- Multi-Agent Stage-wise Conservative Linear Bandits (2025-10-01), https://arxiv.org/abs/2510.00602 (snippet only)
- Conservative Contextual Bandits: Beyond Linear Representations (2024-12-09), https://arxiv.org/abs/2412.06165 (snippet only)
- Conservative Exploration for Policy Optimization via Off-Policy Policy Evaluation (2023-12-24), https://arxiv.org/abs/2312.15458 (snippet only)
- Trust-Based Collaborative Filtering: Tackling the Cold Start Problem Using Regular Equivalence, https://arxiv.org/abs/1807.06839 (snippet only; recommender cold start, not spend)

Closest prior work we found is conservative bandits [nov2:E4] and its 2026 descendant Reserve-C4B [nov2:E5] (explore only within a performance budget relative to a baseline; the latter keeps a reserve ledger), plus MonoScale [nov2:E6] (a separate onboarding track for new agents in an LLM router, with a monotonic guarantee). They differ from D3 in this: they bound the reward shortfall of a learner that runs the algorithm honestly, and the budget is statistical. D3 assumes the chooser may be hostile (a prompt-injected agent) and enforces the budget as a hard per-window outflow cap in the account contract. D3's newcomer signal is an external attestor's tier, not the learner's own confidence bounds. D3 claims a loss bound, not a regret bound; how fast honest newcomers graduate is not covered by these results.

## (c) Consumer-banking "new payee" limits (plain-world analog)

Queries run:
1. Web search: `bank "new payee" lower limit "first 24 hours" fraud protection`
2. Web search: `"newly added beneficiary" cooling period maximum amount first 24 hours bank`

Top hits:
- Payment limits for new payees (Bank of Ireland UK), https://bankofirelanduk.com/?p=30583, which redirects to "Changes to online banking", https://www.bankofirelanduk.com/online-banking/changes-to-online-banking/ [nov2:E7]
- New security measures for your digital banking transactions (Standard Chartered Singapore), https://www.sc.com/sg/important-information/cooling-period/ (fetched; a 12-hour cooling period for adding a new payee, effective 13 September 2026; transfers to a newly added payee only after it ends; limit decreases take effect at once)
- Not fetched: About online payment limits (https://bankofireland.com/help-centre/faq/much-can-transfer-365-online), Tide new-payee help pages (Tide is not a bank), Axis Bank NRI query page, Kotak help page (limit after registration, not per payee), Santander UK payments page, HDFC Bank cooling period page (https://www.hdfc.bank.in/security-measures/cooling-period), Standard Chartered UAE new-beneficiary notice, Razorpay blog.

Closest analog we found is Bank of Ireland UK [nov2:E7]: new payees are capped at €1,000 / £1,000 per day for up to 48 hours against €20,000 / £20,000 for existing payees (5%). It differs from D3 in this: the bank's new-payee status ends by time, while D3's ends by evidence (an attestor tier), so an old but unproven payee stays in the exploration track. The bank enforces the limit in its own systems; D3 enforces it in the account contract even when an attacker drives the agent key. Standard Chartered Singapore uses a 12-hour hold instead of a budget; D3 uses a budget, not a hold.

## Competitors (GitHub)

Query run: `gh api -X GET search/repositories -f q='x402 reputation spending in:name,description,readme' -f per_page=20` (best-match order; total_count 1709)

Top hits: 0xgasless/agentkit, xpaysh/awesome-x402, Merit-Systems/awesome-agentic-commerce, Stellar-Ecosystem/lodestar, BankrBot/skills, sudeepb02/awesome-erc8004, Micopay/micopay-protocol, keep-starknet-strange/starknet-agentic, nirholas/agenti, bitrefill/awesome-agentic-payments, sodofi/awesome-onchain-agents. Most are curated lists or general agent-wallet toolkits.

Read: keep-starknet-strange/starknet-agentic repo page and raw README [nov2:E8]; nirholas/agenti repo page (keyword scan only; reputation-keyed spend not shown).

Closest competitor we found is keep-starknet-strange/starknet-agentic [nov2:E8]. It differs from D3 in this: it uses Starknet (Cairo) accounts rather than ERC-4337, and its README shows a spending policy and ERC-8004 identity, reputation and validation registries side by side. A policy that reads reputation, a separate budget for unproven payees, and a signed score checked during validation are not shown.

## Light verdict for D3

Closest prior work we found is MetaMask's periodic x402 permission (on-chain window cap) plus static allowlists. It differs in using one cap for all payees with no trust input. The two-track split itself matches bank new-payee limits (Bank of Ireland UK: 5% of the daily cap) and the conservative-bandit budget idea, and neither of those is on-chain or keyed to a trust score. Claim to test is unchanged: loss to unproven payees <= exploration budget per window even if the agent is injected. Test it in the attack harness with an injected agent paying many fresh payees.
