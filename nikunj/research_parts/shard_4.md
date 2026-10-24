### E42 | Wallet compatibility | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.x402.org/advanced-concepts/wallet-compatibility.md
Quote: "**Permit2** (`permitWitnessTransferFrom`) code-routes through its internal `SignatureVerification` library, so any Permit2 payment from an address with code calls `isValidSignature` on that address."
Claim: Confirms the no-UserOp spend path for D1: x402 `exact`/`upto` via Permit2 and EIP-3009 on USDC v2.2 settle by calling the account's ERC-1271 `isValidSignature`, and a deployed ERC-4337 account is "Type B" (EIP-1271). The docs also say a permissive account's `isValidSignature` accepts a raw 65-byte ECDSA sig from the controlling key, so a key that the account accepts there can pay without any UserOp.
Regime: x402 facilitator settlement on EVM; token must code-route (USDC v2.2+, Permit2); older USDC v1/v2.0/2.1 use ecrecover only.
Limits: Describes compatibility, not policy. Says nothing about limiting session keys inside `isValidSignature`. Token-version dependent: on ecrecover-only tokens a smart account cannot pay at all (stated).
Reqs: R3, R11, R13
Verified: pending
Origin: nov.md:E1

### E43 | ERC-7598: Use contract signature for signed transfer | 2024
Kind: docs
arXiv:
DOI:
URL: https://eips.ethereum.org/EIPS/eip-7598
Quote: "An ERC to extend ERC-3009 Transfer with Authorization to support ERC-1271 signature validation."
Claim: Standards basis for D1. EIP-3009 transfers signed by a contract wallet are checked through ERC-1271, so the account's `isValidSignature` is the only gate on that path.
Regime: ERC-3009 tokens that implement the 7598 extension (e.g. USDC v2.2 per E42).
Limits: Draft status. Defines the validation call only; any spend policy is left to the wallet (inferred).
Reqs: R3, R13
Verified: pending
Origin: nov.md:E3

### E44 | Smart Wallet Hooks | 2026
Kind: docs
arXiv:
DOI:
URL: https://developers.uniswap.org/docs/protocols/smart-wallet/concepts/hooks.md
Quote: "Hooks must revert to indicate that the given action should revert."
Claim: Prior art for D2's mechanism slot. Per-key `beforeExecute`/`afterExecute` hooks (plus `afterIsValidSignature`) exist, and the docs list "Spending limits" as an example use.
Regime: Uniswap smart wallet; hooks attached per key; call sites encoded in the hook address.
Limits: The docs say the example hooks "are not production code and may contain bugs". No balance-delta or allowance-delta spend-cap hook is described (inferred).
Reqs: R5, R6
Verified: pending
Origin: nov.md:E4

### E45 | safe-smart-account/contracts/base/GuardManager.sol | 2026
Kind: repo
arXiv:
DOI:
URL: https://raw.githubusercontent.com/safe-global/safe-smart-account/main/contracts/base/GuardManager.sol
Quote: "function checkAfterExecution(bytes32 hash, bool success) external;"
Claim: Prior art for D2's post-execution hook. Safe guards "perform pre- and post-checks on Safe transactions", which allows pre/post balance snapshots.
Regime: Safe multisig transactions (execTransaction); a guard is a single installed contract.
Limits: The interface only gives the tx hash and a success flag. The guard must store its own pre-snapshot in checkTransaction. No spend-cap logic ships in this file (inferred).
Reqs: R5, R6
Verified: pending
Origin: nov.md:E5

### E46 | PACE: Policy-Attested Contract Execution for Safe AI Agents in Decentralized Finance | 2026
Kind: paper
arXiv: 2608.17220
DOI:
URL: https://arxiv.org/abs/2608.17220v1
Quote: "PACE introduces typed transaction intents, a deterministic policy verifier, and signed Policy Decision Records (PDRs) that cryptographically bind the approved intent, policy, and simulation report to the exact execution bytes, with replay and expiration protection."
Claim: Closest prior work for D2's "sign the outcome". The smart account enforces signed PDRs at 29,826-31,822 gas. Results: 0.00 unsafe-execution rate vs 0.80 for the unguarded baseline, over 40 tasks, 4 attack categories, 2,800 trials, 10 seeds.
Regime: Deterministic sandbox benchmark. LLM DeFi agent; an off-chain verifier signs; the on-chain account checks the signature.
Limits: The authors call it "logic-level safety within a reproducible benchmark rather than deployment-ready DeFi security". The binding is to the simulation report plus exact bytes. The abstract does not describe an on-chain measured balance/allowance delta check at execution (inferred).
Reqs: R5, R9, R12
Verified: pending
Origin: nov.md:E6

### E47 | Phylax SDK - HackQuest | 2026
Kind: product
arXiv:
DOI:
URL: https://hackquest.io/projects/Phylax-SDK
Quote: "By combining ERC-4337 smart accounts, delegated session keys, recipient and contract-level policy guardrails, and centralized gas sponsorship, Phylax allows owners to provision AI agents that can act independently without exposing master keys, bypassing policy limits, or spending capital outside predefined boundaries."
Claim: Competitor hackathon project in our exact problem space: ERC-4337, agent session keys, recipient allowlist guardrails, on Arbitrum.
Regime: Hackathon project listing (HackQuest).
Limits: The listing does not mention ERC-1271/x402 signature paths or post-execution delta metering (inferred from page text). Event and year are not confirmed.
Reqs: R1, R2, R7
Verified: pending
Origin: nov.md:E7

### E48 | Ramprasad4121/session-policy-wallet | 2026
Kind: repo
arXiv:
DOI:
URL: https://github.com/Ramprasad4121/session-policy-wallet
Quote: "Restricted session keys with on-chain spend limits and contract allowlists. Protects humans and AI agents from drains. Built on Monad."
Claim: Competitor repo (last pushed 2026-09-22): session keys with on-chain spend limits and contract allowlists, aimed at agent drains.
Regime: Monad EVM; GitHub repo description only.
Limits: Only the repo description was read; code not inspected. Coverage of the ERC-1271 path and delta metering is unknown (inferred).
Reqs: R2, R4, R6
Verified: pending
Origin: nov.md:E8

### E49 | ChainGPT-org/chaingpt-claude-skill | 2026
Kind: repo
arXiv:
DOI:
URL: https://github.com/ChainGPT-org/chaingpt-claude-skill
Quote: "Plus an agent wallet prompt injection can't drain"
Claim: Competitor (last pushed 2026-09-09) that markets per-tx, daily, and on-chain (ERC-4337) spending caps against prompt-injection drains, packaged as an MCP tool bundle for Claude Code.
Regime: MCP tool bundle plus agent wallet; GitHub description only.
Limits: Only the description was read; code not inspected. Whether caps cover `isValidSignature` paths is unknown (inferred).
Reqs: R5, R6, R15
Verified: pending
Origin: nov.md:E9

