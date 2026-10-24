### E36 | Five Attacks on x402 Agentic Payment Protocol | 2026
Kind: paper
arXiv: 2605.11781
URL: https://arxiv.org/abs/2605.11781
Quote: "We present five concrete attacks that reveal weaknesses in authorization, binding, replay protection, and web-layer handling, showing that x402 is vulnerable across multiple stages of the payment workflow. We validate these attacks through a reproducible testbed on local chains, Base Sepolia, and live endpoints and further audit three open-source SDKs and endpoints."
Claim: Five concrete x402 attacks on authorization, binding, replay protection and web-layer handling, validated on local chains, Base Sepolia and live endpoints, with three open-source SDKs and endpoints audited; outcomes are unpaid service or paid-but-denied. Supports binding signed payment authorizations to resource, nonce and chain rather than trusting the HTTP layer.
Regime: Protocol formal analysis plus testbed (local chain, Base Sepolia, live endpoints); EIP-3009-style signed transfers; client and facilitator SDKs.
Limits: Covers the x402 protocol and SDKs only, not ERC-4337 session-key validators or wallet-side spend policy (inferred). Attacks mostly harm merchant or payer service outcomes, not unbounded payer drain (inferred from abstract).
Reqs: R11, R12, R16
Verified: pending
Origin: s2.md:E1

### E37 | Free-Riding the Agentic Web: A Systematic Security Analysis of x402 Payments | 2026
Kind: paper
arXiv: 2605.30998
URL: https://arxiv.org/abs/2605.30998
Quote: "We identify four flaw classes: cross-resource substitution, duplicate-settlement race (independently corroborated by subsequent third-party reports), allowance overdraft, and denial of settlement. Against official SDKs and a production deployment, these reach resource-leakage ratios up to 100%."
Claim: Systematic analysis built on 5 invariants finds 4 flaw classes, including allowance overdraft and duplicate-settlement races. Resource-leakage ratio reaches up to 100% against official SDKs and a production deployment; the proposed defense cuts per-call reasoning cost by 47% at 2.8% overhead. This is the case for on-chain cumulative spend accounting (daily cap) and atomic nonce use.
Regime: Official x402 SDKs plus one production deployment; pay-per-token pricing analysis; v2 revised 22 Jun 2026.
Limits: Findings were disclosed vendor bugs and may since be patched (inferred). Analysis targets x402 facilitator/SDK layers, not smart-account policy enforcement (inferred).
Reqs: R6, R11, R16
Verified: pending
Origin: s2.md:E2

### E38 | Hardening x402: PII-Safe Agentic Payments via Pre-Execution Metadata Filtering | 2026
Kind: paper
arXiv: 2604.11430
URL: https://arxiv.org/abs/2604.11430
Quote: "We present presidio-hardened-x402, the first open-source middleware that intercepts x402 payment requests before transmission to detect and redact personally identifiable information (PII), enforce declarative spending policies, and block duplicate replay attempts."
Claim: presidio-hardened-x402: open-source middleware that intercepts x402 payment requests before transmission, redacts PII, enforces declarative spending policies and blocks duplicate replays; NLP mode reaches micro-F1 = 0.894 (precision 0.972) at p99 5.73ms on a synthetic corpus of 2,000 x402 metadata triples. It is a client-side, off-chain policy baseline that on-chain enforcement should beat when the key leaks.
Regime: Synthetic labeled corpus of 2,000 metadata triples; regex vs NLP detection sweep; client middleware.
Limits: Policy runs off-chain in the agent's own process, so a leaked key or compromised host bypasses it (inferred). PII evaluation uses a synthetic corpus only.
Reqs: R12, R14, R5
Verified: pending
Origin: s2.md:E3

### E39 | The Attacker Moves Second: Stronger Adaptive Attacks Bypass Defenses Against Llm Jailbreaks and Prompt Injections | 2025
Kind: paper
arXiv: 2510.09023
URL: https://arxiv.org/abs/2510.09023
Quote: "By systematically tuning and scaling general optimization techniques-gradient descent, reinforcement learning, random search, and human-guided exploration-we bypass 12 recent defenses (based on a diverse set of techniques) with attack success rate above 90% for most; importantly, the majority of defenses originally reported near-zero attack success rates."
Claim: Negative result: adaptive attacks bypass 12 recent jailbreak and prompt-injection defenses, most at >90% ASR, though most of them had reported near-zero ASR. Model-level injection defenses cannot be the security boundary, so wallet policy must hold even with a fully hijacked agent.
Regime: 12 published defenses; adaptive attacks using gradient, RL, random search and human red-teaming with significant compute.
Limits: Measures LLM-layer defenses only, not on-chain policy enforcement (inferred). Attacks spend considerable compute per defense; a weaker attacker may do worse (inferred).
Reqs: R10, R15
Verified: pending
Origin: s2.md:E4

### E40 | allowance.eth | 2026
Kind: repo
URL: https://ethglobal.com/showcase/allowance-eth-ejosk
Quote: "simulated against three gates: daily cap, contract allowlist, and time window."
Claim: Same-track competitor from ETHGlobal New York 2026 (Winner of ENS - Integrate ENS Prize Pool). Plain-English policy is translated by Claude to JSON, stored as an ENS text record and enforced on-chain by PolicyGuard.sol (Solidity/Foundry, Sepolia); every agent tx is simulated against three gates (daily cap, contract allowlist, time window), and txs above an approval threshold need a Ledger signature with ERC-7730 clear signing. Covers R4 (targets only), R6, R8, R9; no per-recipient, per-selector or per-tx rules and no attack suite shown. Code: https://github.com/dankot12/allowance.eth
Regime: Hackathon prototype; Sepolia; Solidity/Foundry; ENS-stored policy.
Limits: Enforces via simulate() and does not appear to be an ERC-4337 validator, so it may be bypassable if the agent key can call the account directly (inferred). No per-tx or recipient limits are stated, and there is no evidence of an injection demo (inferred).
Reqs: R3, R4, R6, R8, R9, R13
Verified: pending
Origin: s2.md:E5

### E41 | EIP-7702 Phishing Attack | 2025
Kind: paper
arXiv: 2512.12174
URL: https://arxiv.org/abs/2512.12174
Quote: "First, ERC-4337's EntryPoint pipeline enables remote and repeated activation of the delegated code without further victim involvement. Second, the chain-agnostic authorization mode permits replay-like compromises across independent networks."
QuoteB: "Analyzing over 150k authorization and execution events involving 26k addresses and hundreds of delegator contracts, we assess the protocol's real-world footprint."
Claim: EIP-7702 lets one signed authorization tuple give unconditional, persistent execution control of an EOA; the paper finds three trigger pathways to full takeover, shows the ERC-4337 EntryPoint can re-activate delegated code with no further victim action, and shows chain-agnostic (chainId 0) authorizations allow cross-network replay (T8). Measurement: over 150k authorization/execution events, 26k addresses, hundreds of delegator contracts, dominated by contract families linked to criminal activity. Argues for scoped session keys over full 7702 delegation for agents (R14) and for chain-bound signatures (R11).
Regime: Controlled experiments plus empirical measurement across major EVM chains (post-Pectra 2025).
Limits: Attacks need the victim (or a leaked key) to sign the authorization; does not study smart-account session-key validators (inferred). Measurement window ends at the paper's data cutoff, so later attack volumes may differ (inferred).
Reqs: R11, R14, R16
Verified: pending
Origin: replaced s2.md:E6 (theblock 403)

