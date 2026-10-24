### E19 | Overview | 2025
Kind: docs
URL: https://docs.privy.io/controls/policies/overview
Quote: "If no rules resolve, the policy will default to `DENY`."
QuoteB: "By default, the trusted execution environment (secure enclave) enforces policies for wallet actions."
QuoteC: "Allows a condition to evaluate against historical data such as cumulative transaction values over a time window."
Claim: Privy policy engine: default-deny, TEE-enforced, recipient allow/denylists, calldata constraints, stateful cumulative-over-window conditions — closest offchain analog covering R5/R6/R7.
Regime: Embedded/server wallets, policy over RPC requests; stateful window "Only supported for Ethereum methods"; `in` operator up to 100 values.
Limits: Trust in TEE/provider, not onchain — leaked owner/app auth bypasses (inferred); "evaluates numerical data exactly as passed in the request body—no conversion is applied" → raw wei/units, T9 multi-asset mismatch; T6 batch/split vs window depends on stateful config (inferred); no onchain owner co-sign R9 (inferred).
Reqs: R5, R6, R7
Verified: pending
Origin: c2.md:E10

### E20 | Scheme: `exact` on `EVM` | 2025
Kind: docs
URL: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
Quote: "uses the `transferWithAuthorization` function directly on token contracts that support it."
QuoteB: "Settlement is performed via the facilitator calling the `transferWithAuthorization` function"
QuoteC: "Verify the signature is valid and recovers to the `authorization.from` address."
Claim: x402 "exact" EVM scheme settles by a facilitator calling EIP-3009 transferWithAuthorization (or a Permit2 proxy) with an off-chain signature; no UserOp/EntryPoint is involved, so a smart-wallet policy enforced only in validateUserOp/execute never sees x402 payments (T2). Basis for R13 (x402 API-credit payments) design: route x402 signing through a policy-checked path.
Regime: Off-chain signed authorization + facilitator-submitted tx; EVM tokens implementing EIP-3009 (e.g. USDC) or Permit2.
Limits: Spec text does not mention ERC-1271 or ERC-6492; smart accounts covered only via ERC-7710 ("It is particularly suited for smart contract accounts"); "recovers to" wording implies EOA ecrecover, so smart-account support depends on token/facilitator implementation (inferred).
Reqs: R3, R13, R14
Verified: pending
Origin: c3.md:E1

### E21 | stablecoin-evm/contracts/v2/EIP3009.sol at master · circlefin/stablecoin-evm · GitHub | 2023
Kind: repo
URL: https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol
Quote: "Signature byte array produced by an EOA wallet or a contract wallet"
QuoteB: "SignatureChecker.isValidSignatureNow("
Claim: Confirms T2 for USDC: Circle's EIP-3009 implementation validates via SignatureChecker.isValidSignatureNow, which accepts contract-wallet (ERC-1271) signatures; if the 4337 account's isValidSignature accepts the agent key, a leaked/injected agent key can sign transferWithAuthorization and move USDC with zero UserOps, bypassing per-tx/daily/recipient limits. Fix: isValidSignature must reject agent-key sigs or decode and policy-check the EIP-712 payload.
Regime: USDC FiatToken v2.x on EVM chains; any signer key accepted by account's ERC-1271.
Limits: Page did not include SignatureChecker source or explicit ERC-1271 text; behavior on older token versions / other chains not shown (inferred).
Reqs: R3, R13, R14, R15
Verified: pending
Origin: c3.md:E2

### E22 | SignatureVerification.sol | 2022
Kind: repo
URL: https://github.com/Uniswap/permit2/blob/main/src/libraries/SignatureVerification.sol
Quote: "bytes4 magicValue = IERC1271(claimedSigner).isValidSignature(hash, signature);"
QuoteB: "if (magicValue != IERC1271.isValidSignature.selector) revert InvalidContractSignature();"
Claim: Permit2 falls back to ERC-1271 for signers with code, so any token the account has approved to Permit2 can be pulled by a Permit2 signature validated by the account's isValidSignature; second T2 bypass path (also used by x402 Permit2 variant).
Regime: Any ERC-20 with prior approval to Permit2 contract; account with deployed code.
Limits: Requires existing Permit2 allowance from the account; stock EIP-2612 tokens using ecrecover-only do not accept contract signatures (inferred).
Reqs: R3, R14, R15
Verified: pending
Origin: c3.md:E3

### E23 | Real AI Agents with Fake Memories: Fatal Context Manipulation Attacks on Web3 Agents | 2025
Kind: paper
arXiv: 2503.16248
URL: https://arxiv.org/abs/2503.16248
Quote: "a representative decentralized AI agent framework for automated Web3 operations."
QuoteB: "150+ realistic blockchain tasks"
QuoteC: "500+ attack test cases using context manipulation"
QuoteD: "significantly more vulnerable to memory injection"
QuoteE: "a Web3-focused benchmark covering 150+ realistic blockchain tasks"
QuoteF: "only provide limited protection when stored context is corrupted"
Claim: On ElizaOS and CrAIBench (150+ blockchain tasks, 500+ attack cases), injected context/memory triggers unauthorized transfers and models are more vulnerable to memory injection than prompt injection; prompt-injection detectors give limited protection -> agent-side defenses insufficient, justify on-chain enforcement for R15 live demo.
Regime: LLM Web3 agents (ElizaOS), text context/memory, simulated blockchain tasks; v3 July 2025.
Limits: Fine-tuning defenses "substantially reduce" attack success per authors, so not purely hopeless agent-side; benchmark is simulated, not mainnet (inferred).
Reqs: R3, R10, R13, R15, R16
ClaimB: Closest match for R15 and R16. CrAIBench has 150+ Web3 tasks (token transfers, trading, bridges, cross-chain) and 500+ context-manipulation attack cases. Run its transfer and trade attacks through our agent with the session key and count how many the on-chain policy blocks (target: 100% of out-of-policy txs reverted, whatever the agent outputs). Memory injection beats prompt-injection defenses, which supports enforcing at the wallet.
LimitsB: Code and data release status not stated in the abstract (inferred, check the repo); tasks may target ElizaOS-style tools, not ERC-4337 UserOps, so an adapter is needed (inferred); fine-tuning defenses are evaluated only on single-step tasks.
Verified: pending
Origin: c3.md:E5 + c4.md:E4

### E24 | Defeating Prompt Injections by Design | 2025
Kind: paper
arXiv: 2503.18813
URL: https://arxiv.org/abs/2503.18813
Quote: "solving $77\%$ of tasks with provable security (compared to $84\%$ with an undefended system) in AgentDojo"
Claim: CaMeL (dual-LLM / capability control-flow) solves 77% of AgentDojo tasks with provable security vs 84% undefended; contrast: agent-side defense costs ~7 points utility and requires trusted agent runtime, whereas on-chain policy holds for any open model or scripted bot (R10) and even if runtime/key compromised (R14).
Regime: AgentDojo benchmark, tool-using LLM agents; v2 June 2025 with newer models.
Limits: Defense lives in agent harness; useless if agent key leaks or attacker runs own bot (inferred); 23% tasks unsolved.
Reqs: R3, R10, R15
Verified: pending
Origin: c3.md:E6

### E25 | Powering AI commerce with the new Agent Payments Protocol (AP2) | 2025
Kind: writeup
URL: https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
Quote: "When you delegate a task like, "Buy concert tickets the moment they go on sale," you sign a detailed Intent Mandate upfront. This mandate specifies the rules of engagement—price limits, timing, and other conditions."
Claim: AP2 (Sept 17 2025) encodes user-signed Intent/Cart Mandates (price limits, timing) as verifiable credentials and ships A2A x402 extension; our on-chain policy = enforced mandate; Cart Mandate ≈ owner approval for out-of-policy spend (R3, R13).
Regime: Off-chain VC-based mandates verified by merchants/payment networks; human-present and human-not-present flows.
Limits: Mandates are evidence/audit trail, not on-chain enforcement; a leaked agent or forged cart still relies on verifier honesty (inferred).
Reqs: R3, R13
Verified: pending
Origin: c3.md:E7

### E26 | Scam Sniffer 2025: Crypto Phishing Losses Fall 83% to $84 Million | 2026
Kind: writeup
URL: https://drops.scamsniffer.io/scam-sniffer-2025-crypto-phishing-losses-fall-83-to-84-million/
Quote: "Total losses: $83.85M across 106,106 victims"
QuoteB: "Permit/Permit2 signatures accounted for 38% of large-case losses."
QuoteC: "$6.5M via Permit signature (September)"
QuoteD: "$83.85M across 106,106 victims — down 83% and 68% respectively from 2024"
QuoteE: "EIP-7702 malicious signatures emerged after the Pectra upgrade, with 2 large cases in August"
Claim: 2025 signature-phishing losses $83.85M / 106,106 victims (EVM drainers); Permit/Permit2 = 38% of >$1M cases, largest $6.5M Permit; EIP-7702 malicious sigs appeared (Aug, $2.54M from 2 incidents) -> off-chain signature path (T2) and misleading signing requests (T11) are the real-world attack surface; motivates blocking agent-key ERC-1271 and decoded approval prompts.
Regime: Trackable wallet-drainer activity via phishing sites, EVM chains, calendar 2025.
Limits: "Lower bound estimate; based on trackable drainer activity only; unreported incidents not captured"; human victims, not agents (inferred).
Reqs: R14, R15, R16
ClaimB: Threat motivation plus R16 attack cases: Permit/Permit2 caused 38% of large-case losses in 2025 ($83.85M total), so the suite must include an agent tricked into signing permit/permit2/7702 delegations, and the wallet policy must block off-allowlist signature types (ERC-1271 isValidSignature gating).
LimitsB: "Lower bound estimate; based on trackable drainer activity only; unreported incidents not captured"; only covers drainers on phishing websites, not agent-specific attacks.
Verified: pending
Origin: c3.md:E8 + c4.md:E9

### E27 | AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents | 2024
Kind: benchmark
arXiv: 2406.13352
URL: https://arxiv.org/abs/2406.13352
Quote: "populate the environment with 97 realistic tasks"
QuoteB: "629 security test cases"
Claim: Use the AgentDojo banking suite (97 tasks / 629 security test cases overall, e-banking setting) as a template for R15: put our wallet behind a banking-style tool and report utility under attack plus how many injections end in an unauthorized transfer. Our policy layer should turn "agent complied" into "transfer reverted".
Regime: Python env, tool-calling LLM agent (API or open model), text injections in tool outputs; runs on a laptop with API keys; no chain needed.
Limits: Banking tools are simulated, with no on-chain settlement or signature semantics (inferred); it measures the agent's compliance, not whether the wallet enforces anything, so on-chain revert needs a custom adapter (inferred); 2024 attacks may be stale vs newer adaptive attacks (inferred).
Reqs: R10, R15, R16
Verified: pending
Origin: c4.md:E1

### E28 | WASP: Benchmarking Web Agent Security Against Prompt Injection Attacks | 2025
Kind: benchmark
arXiv: 2504.18575
URL: https://arxiv.org/abs/2504.18575
Quote: "a new publicly available benchmark for end-to-end evaluation of Web Agent Security against Prompt injection attacks"
QuoteB: "partially succeed in up to 86% of the case"
Claim: For the R15 demo story: attacks partially succeed in up to 86% of cases even on top web agents, so a wallet that "holds" when the agent is fooled is the right design point; borrow WASP's end-to-end attacker-goal scoring for our injection sim.
Regime: Web agent in a sandboxed web environment, low-effort human-written injections; needs browser plus an LLM; heavier than laptop-only (inferred).
Limits: Web-UI injections (GitLab/Reddit style), not payment or crypto tasks (inferred); authors note agents "often struggle to fully complete the attacker goals", so the success rate understates the risk once agents get more capable.
Reqs: R15, R16
Verified: pending
Origin: c4.md:E2

### E29 | Agent Security Bench (ASB): Formalizing and Benchmarking Attacks and Defenses in LLM-based Agents | 2024
Kind: benchmark
arXiv: 2410.02644
URL: https://arxiv.org/abs/2410.02644
Quote: "10 scenarios (e.g., e-commerce, autonomous driving, finance), 10 agents targeting the scenarios"
QuoteB: "over 400 tools"
QuoteC: "27 different types of attack/defense methods"
QuoteD: "the highest average attack success rate of 84.30%"
Claim: Gives the attack taxonomy for R16 (direct/indirect prompt injection, memory poisoning, backdoors; 27 attack/defense types). Reuse its finance and e-commerce scenarios as agent-side attack categories, and cite the 84.30% average ASR to justify enforcing policy on-chain instead of in the prompt.
Regime: Python framework, 10 scenarios, 400+ tools, multiple LLM backbones (open models supported); GPU or API for the backbones.
Limits: Finance tools are mocked, not on-chain (inferred); ASR measures the LLM, not the effect on a wallet, so it needs mapping to tx outcomes (inferred); ICLR 2025 attack set predates 2025-26 adaptive attacks (inferred).
Reqs: R10, R15, R16
Verified: pending
Origin: c4.md:E3

### E30 | Breaking Agent Backbones: Evaluating the Security of Backbone LLMs in AI Agents | 2025
Kind: benchmark
arXiv: 2510.22620
URL: https://arxiv.org/abs/2510.22620
Quote: "a security benchmark based on 194,331 unique crowdsourced adversarial attacks"
QuoteB: "enhanced reasoning capabilities improve security, while model size does not correlate with security"
Claim: Use b3 (194,331 crowdsourced attacks, 34 LLMs) to pick the R10 open-model agent backbone and to source realistic injection strings for the R15 demo; the finding that size does not correlate with security supports "assume the agent will be compromised" plus on-chain caps.
Regime: Threat-snapshot evaluation of backbone LLMs; text attacks; API or local inference; laptop is fine for small open models (inferred).
Limits: Scores the LLM at isolated snapshots, not full wallet workflows; the abstract does not list a count of threat snapshots or attack categories; the attack dataset may not be fully public (inferred).
Reqs: R10, R15, R16
Verified: pending
Origin: c4.md:E5

### E31 | DeFiHackLabs | 2026
Kind: dataset
URL: https://github.com/SunWeb3Sec/DeFiHackLabs
Quote: "Reproduce DeFi hacked incidents using Foundry"
Claim: R16 Foundry attack suite: fork-replay real exploit PoCs (approval drains, reentrancy, price-manipulation call patterns) against the agent wallet's allowlist and spend policy, and report blocked/total; Apache-2.0 so code can be reused directly.
Regime: Foundry (forge test with mainnet/L2 fork RPC); Solidity PoCs; laptop is fine, needs an archive RPC endpoint (inferred).
Limits: Incident count not shown on the fetched page (4,011 commits ≠ incidents); exploits target protocols, not smart wallets, so only patterns like approve/transferFrom drains carry over (inferred); fork RPC rate limits (inferred).
Reqs: R16
Verified: pending
Origin: c4.md:E6

### E32 | bundler-spec-tests | 2026
Kind: repo
URL: https://github.com/eth-infinitism/bundler-spec-tests
Quote: "EIP4337 bundler compatibility tests"
Claim: R16 conformance layer: run the eth-infinitism suite (pdm test against a local node + EntryPoint + bundler) to show our account's validateUserOp stays bundler-compatible after adding policy checks, i.e. the policy does not break ERC-4337 validation rules.
Regime: Python ≥3.8 + PDM ≥2.2.1, local Ethereum node, deployed EntryPoint, running bundler; laptop-feasible.
Limits: Tests bundlers, not account policy logic; ERC-7562 rule coverage not confirmed on the fetched page; license not shown on the page.
Reqs: R16
Verified: pending
Origin: c4.md:E7

### E33 | Home | 2026
Kind: product
URL: https://www.x402.org/
Quote: "x402 is an open, neutral standard for internet-native payments."
QuoteB: "Transactions"
Claim: R13 purchase use case: x402 ran 75.41M transactions / $24.24M volume over the last 30 days with 94.06K buyers, so the agent pays per request via x402 inside per-tx and per-day caps. Use the average ticket ($24.24M / 75.41M ≈ $0.32, inferred) to set demo policy limits and as the "real traffic" slide.
Regime: Live aggregate stats (30-day window), HTTP 402 micropayments, stablecoins on EVM chains (inferred).
Limits: Rolling 30-day numbers change on every fetch; aggregate only, with no per-tx dataset or methodology on the page (inferred); volume may include test or wash traffic (inferred).
Reqs: R13
Verified: pending
Origin: c4.md:E8

### E34 | TRACE: Graph-Aware Anomaly Detection for Trust Routing in Adversarial Decentralized Marketplaces | 2026
Kind: paper
DOI: 10.5281/zenodo.22706499
URL: https://zenodo.org/records/22706499
Quote: "Trust propagation amplifies coordinated attacks: EigenTrust routes 81.7% of jobs to malicious agents under Sybil attack, while reputation-only contains the same attack to 29.0%."
Claim: Non-propagating, uncertainty-aware trust score (TRACE) as an off-chain recipient/merchant risk signal feeding the wallet's recipient policy; EigenTrust-style propagation is the wrong design (81.7% vs 29.0% malicious routing, Sybil attack, N=1,000 agents, 30% adversaries, 10 seeds; replicates at N=5,000 and on Bitcoin OTC / Bitcoin Alpha signed-trust graphs). Greedy (no Thompson sampling) lowers fraud from 10.7/46.5/19.0/83.7 to 4.7/6.4/7.1/31.7 sats across strategic-default/collusion-ring/sybil-cluster/game-theoretic.
Regime: Simulated agent marketplace, N=1,000 (scale N=5,000) agents, 30% adversaries, 4 attack regimes, sats-denominated jobs; plus 2 real signed-trust graphs; CPU simulation.
Limits: Score is off-chain and advisory, so a leaked agent key or a compromised oracle can't be stopped by the score alone; it needs on-chain caps (inferred). Sparse-graph result reverses on dense or partitioned views (greedy gives 6.8x higher fraud under partitioned local evidence, per PDF only). Fresh recipient addresses have no history (cold start) (inferred).
Reqs: R7, R13, R16
Verified: pending
Origin: c5.md:E1

### E35 | SatsRouter — Lightning Agent Economy | 2026
Kind: repo
URL: https://github.com/NikunjKaushik20/sats_router
Quote: "Buyer can't spend more than `dailyBudgetSats` per day (auto-resets)"
Claim: Prior agent-spend policy design: daily budget cap plus a "Per-Incident Cap" (rolling 10-minute window), and loop detection ("3 identical calls in 60s = blocked"), enforced off-chain in src/lib/budget.ts and src/lib/safety.ts. This is the baseline that W3-02 moves on-chain (daily limit, per-window velocity) in a 4337 validation module; demo setting is a Lightning/L402 agent marketplace with sats-priced API calls.
Regime: Next.js + Prisma app, buyer agent "Riya" paying 2–20 sats per request; caps are DB checks, not cryptographic.
Limits: Caps live in the app server, so a leaked wallet key or anyone calling Lightning/x402 directly bypasses them (inferred). Public repo does not include src/lib/x402.ts or new_paper/x402_usenix (raw URL 404 on both).
Reqs: R3, R13, R14
Verified: pending
Origin: c5.md:E2

