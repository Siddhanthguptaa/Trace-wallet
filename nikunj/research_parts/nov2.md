### E1 | Recurring x402 payments | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.metamask.io/smart-accounts-kit/1.5.0/guides/x402/buyer/recurring-payments/
Quote: "In this example, you request an ERC-20 periodic permission with a weekly allowance of 10 USDC."
Claim: A shipped on-chain window cap for agent x402 spend: an `erc20-token-periodic` Advanced Permission with periodAmount 10 USDC and periodDuration 604800 s (1 week). The same page says the agent can keep paying until the weekly cap is reached and resumes in the next period, and a redeemer enforcer limits redemption to facilitator addresses that the server provides. D3 reuses this per-window, contract-metered cap for its exploration budget. Here one cap covers every payee.
Regime: EVM; a MetaMask extension user grants an Advanced Permission to an agent; x402 buyer flow; enforced by the delegation framework's caveat enforcers (inferred from "redeemer enforcer").
Limits: Page undated; header year 2026 is the access year (accessed 2026-10-24). The cap is keyed to the permission, not the recipient. Payee trust or tier is not an input (not shown), so a new payee and a proven one draw from the same allowance. Facilitator addresses come from the server, so that rule does not exclude a hostile seller (inferred). Needs MetaMask extension users (stated).
Reqs: R3, R7
Verified: pending

### E2 | Agent wallet identity, permissions, and compliance | 2026
Kind: writeup
arXiv:
DOI:
URL: https://www.openfort.io/blog/agent-permissions
Quote: "block transfers to addresses outside an allowlist, or cap the amount argument."
Claim: Current agent-wallet practice treats recipients as a yes/no question: scoped, expiring session keys whose policy holds spending caps and allowlists, with calldata rules that block non-allowlisted addresses or cap the amount. An unknown payee is either blocked or must be added by the owner. D3 adds a third, metered path: unknown payees get a small on-chain exploration budget (2-5% of the daily cap) instead of a block.
Regime: Openfort smart-account session keys on EVM; the owner grants the policy; guidance writeup.
Limits: Page undated; header year 2026 is the access year (accessed 2026-10-24). Writeup, not a spec. The allowlist is static and owner-maintained; no trust score, attestation or newcomer track is shown (not shown). Blocking unknown payees stops discovery, and allowlisting them gives them the full cap (inferred).
Reqs: R3, R7
Verified: pending

### E3 | SoK: Blockchain Agent-to-Agent Payments | 2026
Kind: paper
arXiv: 2604.03733
DOI:
URL: https://arxiv.org/abs/2604.03733
Quote: "We categorize representative designs at each stage and identify key challenges, including weak intent binding, misuse under valid authorization, payment-service decoupling, and limited accountability. We highlight future directions for strengthening cross-stage consistency, enabling behavior-aware control, and supporting compositional payment workflows across agents and systems."
Claim: A 2026 SoK of blockchain agent-to-agent payments (x402 among them) over four stages (discovery, authorization, execution, accounting) lists "misuse under valid authorization" as a key challenge and "behavior-aware control" as a future direction. That is D3's threat (an injected agent holding a valid key) and D3's remedy class (spend gated by the recipient's behaviour score).
Regime: Systematization of knowledge; payments between unknown and untrusted agents.
Limits: Only the abstract was read; it names no mechanism or numbers for behavior-aware control (not shown). The specific designs it covers are unverified here.
Reqs: R3, R7
Verified: pending

### E4 | Conservative Bandits | 2016
Kind: paper
arXiv: 1602.04282
DOI:
URL: https://arxiv.org/abs/1602.04282
Quote: "We study a novel multi-armed bandit problem that models the challenge faced by a company wishing to explore new strategies to maximize revenue whilst simultaneously maintaining their revenue above a fixed baseline, uniformly over time."
Claim: The classic formal model of budgeted exploration: try new options only while cumulative revenue stays above a fixed baseline at every time step, in stochastic and adversarial settings, with a lower bound showing the stochastic algorithm is almost optimal. D3's exploration budget is the payments version: spend on unproven payees is capped per window, so worst-case loss stays a fixed fraction (2-5%) of the daily cap at all times.
Regime: Multi-armed bandit; known baseline; the learner runs the algorithm honestly.
Limits: The constraint is on the reward shortfall of an honest learner. A hostile chooser (an injected agent) and payees that keep the money are not modeled (inferred). The abstract says the price of the constraint "appears to be higher" in the adversarial setting. No monetary budget numbers in the abstract.
Reqs: R3, R7
Verified: pending

### E5 | Reserve-Aware Contrast Certificates for Conservative Bandits with Uncertain Baselines | 2026
Kind: paper
arXiv: 2609.39106
DOI:
URL: https://arxiv.org/abs/2609.39106
Quote: "Conservative bandits must improve an incumbent policy without exhausting a prescribed performance budget."
Claim: The most recent conservative-bandit paper found (submitted 2026-09-30) treats exploration as spending a prescribed performance budget, and its abstract describes a "reserve ledger" that separates statistical evidence from permitted performance deficit. This is the accounting pattern of D3's on-chain exploration ledger: a fixed per-window allowance for unproven payees, drawn down by measured outflow.
Regime: Linear rewards; self-normalized confidence sets; high-probability conditional-mean performance constraint; uncertain incumbent baseline.
Limits: A statistical guarantee, not a hard cap. Assumes the learner follows the algorithm; arms are not adversarial (inferred). The abstract reports "limitations of frozen certificates". No monetary setting.
Reqs: R3, R7
Verified: pending

### E6 | MonoScale: Scaling Multi-Agent System with Monotonic Improvement | 2026
Kind: paper
arXiv: 2601.23219
DOI:
URL: https://arxiv.org/abs/2601.23219
Quote: "A natural way to expand capability is to scale up the agent pool by continually integrating new functional agents or tool interfaces, but naive expansion can trigger performance collapse when the router cold-starts on newly added, heterogeneous, and unreliable agents."
Claim: 2026 evidence from LLM agent routing that newcomers need their own onboarding track: naive pool growth can collapse performance when the router cold-starts on new, unreliable agents. MonoScale probes each newcomer with a small set of familiarization tasks, frames onboarding as a contextual bandit with trust-region memory updates, and states a monotonic non-decreasing performance guarantee across onboarding rounds (tested on GAIA and Humanity's Last Exam). Supports D3's split: newcomers get a bounded probe channel, not the main budget.
Regime: LLM multi-agent system with a router; task performance; new agents are unreliable but not hostile.
Limits: The guarantee covers task performance, not money. Newcomers are not modeled as adversarial or sybil (inferred). Probes are router-made tasks, not paid traffic, and the probe budget is not priced (not shown).
Reqs: R3, R7
Verified: pending

### E7 | Changes to online banking | 2026
Kind: docs
arXiv:
DOI:
URL: https://www.bankofirelanduk.com/online-banking/changes-to-online-banking/
Quote: "When you add a new payee or payees, there is a period of up to 48 hours when the maximum combined limit you can pay them per day is €1,000 / £1,000."
Claim: Plain-world analog with numbers: for up to 48 hours a new payee can receive at most €1,000 / £1,000 per day, while the same page sets €20,000 / £20,000 per day for existing payees, so the new-payee track is 5% of the normal daily cap. The page says the lower limit is there to protect customers from fraud while new payees are set up. D3's exploration budget (2-5% of the daily cap) sits in the same range.
Regime: UK retail phone and online banking (365); per customer; new-payee status set by time since the payee was added.
Limits: Page undated; header year 2026 is the access year (accessed 2026-10-24). Status expires by time (48 hours), not by evidence, so a fraudulent payee older than 48 hours gets the full limit (inferred). Enforced by the bank, not a contract. The page offers card payments as another route, so the limit covers bank transfers only.
Reqs: R3, R7
Verified: pending

### E8 | keep-starknet-strange/starknet-agentic | 2026
Kind: repo
arXiv:
DOI:
URL: https://github.com/keep-starknet-strange/starknet-agentic
Quote: "This repository is for developers building agents that need Starknet-native wallets, policy-enforced execution, on-chain identity, and composable tool access."
Claim: Closest competitor repo found (last push 2026-10-23): one stack with agent wallets, on-chain policy and ERC-8004. Its README lists an agent account with "Session keys, spending policy enforcement, ownership controls, and upgrade safety checks" and ERC-8004 Cairo "Identity, reputation, and validation registries adapted to Starknet". It holds the parts D3 joins, side by side.
Regime: Starknet (Cairo) account contracts, MCP server and agent skills; not ERC-4337.
Limits: README only. A spending policy that reads reputation is not shown; a separate budget for unproven payees is not shown; a signed score checked during validation is not shown. Starknet account validation follows Starknet rules, not ERC-7562, so its constraints differ (inferred).
Reqs: R3, R7
Verified: pending
