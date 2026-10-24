### E1 | ERC-4337: Account Abstraction Using Alt Mempool | 2021
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-4337
Quote: "The return value MUST be packed of `aggregator`/`authorizer`, `validUntil` and `validAfter` timestamps."
QuoteB: "`validUntil` is 6-byte timestamp value, or zero for “infinite”."
QuoteC: "The `userOpHash` is a hash over the `userOp` (except `signature`), `entryPoint` and `chainId`."
QuoteD: "the `signature` MUST depend on `chainid` and the `EntryPoint` address."
QuoteE: "The `userOpHash` is calculated as an [EIP-712] typed message hash with the following parameters:"
QuoteF: "uses a single `uint256` nonce value in the `UserOperation`, but treats it as two values:"
QuoteG: "192-bit “key"
QuoteH: "64-bit “sequence”."
QuoteI: "The `sender` MAY pay more than this minimum to cover future transactions."
QuoteJ: "Validate the account's deposit in the `EntryPoint` is high enough to cover the max possible cost."
Claim: Session-key expiry (R8) must be returned as 6-byte validUntil (and validAfter) packed into validationData from validateUserOp; EntryPoint enforces the time window, so account never reads block.timestamp in validation. validUntil=0 means infinite, so agent sessions must always set nonzero validUntil.
Regime: ERC-4337 Final standard; any EntryPoint (v0.7/v0.8/v0.9); EVM chains with bundler alt-mempool.
Limits: Only gives a time window per UserOp, not cumulative/daily caps (those must be tracked in execution phase storage) (inferred); zero = infinite is a footgun if a session record defaults to 0 (inferred); bundler/block time skew makes expiry approximate (inferred).
Reqs: R1, R3, R8, R11, R14, R16
ClaimB: Signing userOpHash binds chainId + EntryPoint address, so a leaked agent signature cannot be replayed on another chain or another EntryPoint version (T8 cross-chain replay handled by protocol if account verifies against userOpHash only). Current spec computes userOpHash as an EIP-712 typed hash (R11).
ClaimC: 2D nonce (192-bit key, 64-bit sequence) lets owner and each agent session use separate nonce lanes (e.g. key = session id) so agent ops do not block owner ops and a revoke/kill-switch op from owner is never stuck behind agent nonce (R11, R14). Attack-suite case for T8: two sessions mapped to same nonce key must not let one replay/override the other.
ClaimD: T5 gas-prefund drain: agent-signed UserOps make the account pay missingAccountFunds/deposit for gas, so a leaked agent key can burn ETH via high gas limits/fees or many failing in-policy ops without moving tokens; policy must cap gas (maxFeePerGas, gas limits, daily gas budget) or use a capped paymaster.
LimitsB: Breaks if the account or a validator module signs/accepts any custom hash not derived from userOpHash (e.g. off-chain "enable session" signatures without chainId/account address) (inferred); same account address + same EntryPoint on a fork with same chainId is not protected (inferred); signature field itself is excluded from hash so validator must not trust unsigned data inside it (inferred).
LimitsC: Nonce key is chosen by the signer, not authenticated by itself; if validator selection is derived from nonce key (as in some modular accounts) the key-to-validator mapping must be checked or key collisions route to the wrong validator (inferred); parallel lanes allow agent to submit many ops concurrently, so per-tx caps alone do not bound spend (inferred).
LimitsD: Spec does not frame prefund as attack; with paymaster the account's deposit is unused ("`missingAccountFunds` of 0"), shifting drain risk to paymaster (inferred).
Verified: pending
Origin: c1.md:E1 + c1.md:E2, c1.md:E3, c3.md:E4

### E2 | ERC-7562: Account Abstraction Validation Scope Rules | 2023
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-7562
Quote: "Opcodes that access information outside of storage and code, referred to here as the “environment”, are blocked:"
QuoteB: "`TIMESTAMP` (`0x42`)"
QuoteC: "`NUMBER` (`0x43`)"
QuoteD: "[STO-010] Access to the “account” storage is always allowed."
QuoteE: "If the `paymaster` or `factory` entity is staked, then it is also allowed:"
QuoteF: "[STO-031] Access the entity’s own storage."
QuoteG: "The “canonical mempool” defines an entity as staked if it has at least `MIN_STAKE_VALUE`"
Claim: Verifies T1: TIMESTAMP and NUMBER are banned during validation, so expiry must go via validUntil/validAfter (E1) and any daily-window logic that reads block.timestamp must run in execution phase (or a hook). Validation may read/write account storage, so session-key registry and per-session counters stored keyed by account address are mempool-compliant.
Regime: Canonical/shared mempool bundler rules; unstaked account; v0.7+ EntryPoint.
Limits: Rules are enforced by bundlers off-chain, not by EntryPoint; a private bundler or direct handleOps call can include ops that break them, so on-chain logic must stay correct even if rules are bypassed (inferred). Module storage outside "account-associated" slots (e.g. global mapping not keyed by account) gets ops rejected by public bundlers (inferred).
Reqs: R3, R8, R12
ClaimB: Storage access beyond the account's associated storage requires staking; for a hackathon wallet, keep policy state (spent-today, session records, revocation flag) in account-associated storage so no staking is needed and ops propagate in public mempool.
LimitsB: Staking adds operational cost and reputation/throttling rules (inferred); these are mempool rules, not consensus rules (inferred).
Verified: pending
Origin: c1.md:E4 + c1.md:E5

### E3 | ERC-7579: Minimal Modular Smart Accounts | 2023
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-7579
Quote: "A module used during the validation phase to determine if a transaction is valid and should be executed on the account."
QuoteB: "MUST validate that the signature is a valid signature of the userOpHash"
QuoteC: "MUST implement authorization control"
QuoteD: "treats validators and executors as the same type of module"
QuoteE: "Malicious Hooks may revert on `preCheck` or `postCheck`"
Claim: Standard validator-module interface for an agent session-key validator (R2): owner validator and agent session validator as separate modules, each verifying signatures over userOpHash; lets wallet plug into Kernel/Nexus/Safe7579 ecosystems.
Regime: ERC-7579 modular accounts on ERC-4337.
Limits: Standard defines interfaces, not policy semantics; precise policy expression (targets, selectors, caps) is left to module authors (inferred).
Reqs: R1, R2, R3, R12, R14, R16
ClaimB: Corrects T12: ERC-7579 only says installModule/uninstallModule "MUST implement authorization control" and does not itself mandate EntryPoint-or-self only; so wallet must explicitly forbid agent sessions from calling the account itself (installModule, uninstallModule, upgradeToAndCall, execute-on-self). Attack suite must include agent UserOp targeting address(this).
LimitsB: If install path is reachable via self-call (onlyEntryPointOrSelf) and agent policy allows target == account, a leaked agent key can install an executor and escape all policies (inferred); malicious/buggy hooks can brick execution (stated: revert in preCheck/postCheck).
Verified: pending
Origin: c1.md:E6 + c1.md:E7

### E4 | EIP-7702: Set Code for EOAs | 2024
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-7702
Quote: "Verify the chain ID is 0 or the ID of the current chain."
QuoteB: "When universal deployment is preferred, simply set chain ID to 0."
QuoteC: "A poorly implemented delegate can allow a malicious actor to take near complete control over a signer’s EOA."
QuoteD: "Replay protection (e.g., a nonce) should be implemented by the delegate and signed over."
Claim: If wallet supports 7702 owner EOA delegation, chain_id=0 authorizations are valid on all chains (cross-chain replay of delegation, T8); delegate must implement its own signed nonce. Also "does not provide developers the opportunity to run initcode" so initializer front-running must be prevented.
Regime: EIP-7702 Final (Pectra); EOA delegating to smart-account code.
Limits: Original EOA key keeps full control and cannot be revoked by the account, so a 7702 wallet's owner key compromise is unrecoverable (inferred); storage collisions when re-delegating between implementations (source: "avoids accidental collisions").
Reqs: R1, R11, R14
Verified: pending
Origin: c1.md:E8

### E5 | Releases · eth-infinitism/account-abstraction | 2025
Kind: repo
URL: https://github.com/eth-infinitism/account-abstraction/releases
Quote: "Native support for ERC-712 based UserOperation hash and signatures (AA-508)"
QuoteB: "the UserOperation hash and signature calculation is now compatible with ERC-712."
QuoteC: "Native support for EIP-7702 authorizations in the EntryPoint contract"
QuoteD: "Enable use of a two-dimensional nonce in UserOperations with `initCode`."
QuoteE: "this change may affect the security of your Account"
QuoteF: "Always verify the EntryPoint deployment address and code hash with the official security audit report before updating."
Claim: EntryPoint v0.8.0 (released 26 Mar, year inferred 2025) switched userOpHash to ERC-712 typed hash and added native 7702; v0.7.0 (22 Feb) moved validation rules to separate doc (ERC-7562). Pick v0.8 for EIP-712 typed signing so owner approval prompts are human-readable (R11).
Regime: Reference EntryPoint + SimpleAccount/Simple7702Account implementations.
Limits: Hash differs between v0.7 and v0.8, so signer code and tests must pin one EntryPoint version (inferred); release years not shown on page (dates inferred).
Reqs: R1, R11, R16
ClaimB: v0.9.0 (16 Nov, year inferred 2025) allows 2D nonce with initCode and warns it may affect account security; nonce-key collision / first-op replay tests (T8) are needed if targeting v0.9.
LimitsB: Release notes do not detail the attack; impact on specific accounts must be analyzed (inferred).
Verified: pending
Origin: c1.md:E9 + c1.md:E10

### E6 | Permissions (Session Keys) | 2025
Kind: docs
URL: https://docs.zerodev.app/sdk/permissions/intro
Quote: "Permission = 1 signer + N policies + 1 action"
QuoteB: "Signers specify the keys and the algorithms the keys use."
QuoteC: "Policies are the conditions under which the keys can be used."
QuoteD: "Actions are arbitrary functions that the smart account will `delegatecall` to."
Claim: Kernel's production model for agent keys: one signer + N composable policies (Sudo, Call, Gas, Signature, Rate limit, Timestamp) + one action; template for R2/R12 policy expression (call policy = contracts/functions/args, rate limit = frequency, timestamp = expiry).
Regime: ZeroDev Kernel (ERC-7579) smart accounts; SDK-managed session keys.
Limits: Page does not mention AI agents or prompt injection; no built-in rolling daily value cap listed, so daily spend must be custom (inferred); year of docs page not stated (inferred 2025).
Reqs: R2, R4, R5, R6, R8, R12
ClaimB: ZeroDev Kernel signer+policy+action split; policy set = Sudo, Call, Gas, Signature, Rate limit, Timestamp — maps to R4 (call policy), expiry (timestamp), rate limits.
LimitsB: Rate limit = count of uses, not value-over-window (R6 rolling value cap absent) (inferred); actions use `delegatecall` → misconfigured action = full account takeover, T12 (inferred); no cross-asset value cap T9, no owner-approval path R9 (inferred); year of page not stated (2025 assumed).
Verified: pending
Origin: c1.md:E11 + c2.md:E6

### E7 | GitHub - erc7579/smartsessions | 2025
Kind: repo
URL: https://github.com/erc7579/smartsessions
Quote: "SmartSession is an advanced module for ERC-7579 compatible smart accounts, enabling granular control over session keys."
QuoteB: "This software is in beta and should be used at your own risk."
Claim: Rhinestone/Biconomy shared session-key validator for ERC-7579 accounts (Safe7579, Nexus, Kernel): user-op validation policies, action-specific policies, ERC-1271 policies, external policy contracts, and an enable flow inside the first UserOp. Baseline to compare our policy module against (R12) and its enable flow is a T8/R11 risk point.
Regime: ERC-7579 accounts; ERC-4337 EntryPoint v0.7.
Limits: Self-described beta; enable-flow signatures must bind account+chain to avoid replay (inferred); audit contents not stated on README; year inferred.
Reqs: R2, R11, R12
Verified: pending
Origin: c1.md:E12

### E8 | GitHub - alchemyplatform/modular-account | 2025
Kind: repo
URL: https://github.com/alchemyplatform/modular-account
Quote: "Enforces ERC-20 spend limits and address/selector allowlists."
QuoteB: "Enforces native token spend limits."
QuoteC: "Enforces time ranges for a given entity."
Claim: Alchemy Modular Account (ERC-6900) splits policy into hook modules: AllowlistModule (ERC-20 limits + address/selector allowlist), NativeTokenLimitModule, PaymasterGuardModule, TimeRangeModule; maps directly to our R12 policy fields (contracts/functions, per-asset caps, expiry). Conforms to "ERC-4337: v0.9.0".
Regime: ERC-6900 modular account; develop branch.
Limits: README warns develop branch "contains changes that are under development"; spend limits are lifetime/total, not rolling daily (inferred); audits in folder, vendors not named on page.
Reqs: R1, R2, R12
Verified: pending
Origin: c1.md:E13

### E9 | Account Abstraction, Analysed | 2023
Kind: paper
arXiv: 2309.00448
URL: https://arxiv.org/abs/2309.00448
Quote: "preliminary security evaluation to qualitatively assess the extent of security enhancements"
Claim: Academic qualitative security evaluation of ERC-4337 account abstraction; use as background for threat model (R1, R3).
Regime: Qualitative analysis; no dataset/benchmark numbers in abstract.
Limits: Pre-dates v0.7/v0.8 EntryPoint, ERC-7579 and EIP-7702; "preliminary" and qualitative only (stated).
Reqs: R1, R3
Verified: pending
Origin: c1.md:E14

### E10 | Toward Web 4.0: Bidirectional Trust between AI Agents and Blockchain | 2026
Kind: paper
arXiv: 2605.08922
URL: https://arxiv.org/abs/2605.08922
Quote: "Autonomous AI agents are increasingly deployed on blockchain platforms"
Claim: 2026 framing of agent-blockchain trust as bidirectional; supports positioning: chain must constrain agent (on-chain policy) rather than trust it, motivating enforcement that survives prompt injection (R3).
Regime: Position/survey paper (May 2026); no wallet implementation numbers in abstract.
Limits: Abstract gives no concrete smart-wallet mechanism or evaluation numbers (inferred); fetched via arXiv API listing, abs page text assumed identical.
Reqs: R3
Verified: pending
Origin: c1.md:E15

### E11 | ERC-7715: Request Permissions from Wallets | 2024
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-7715
Quote: "This ERC does not specify an exhaustive list of rule or permission types."
QuoteB: "Since this ERC only specifies the interaction between the wallet and the DApp but not how the wallet enforces permissions."
QuoteC: "Wallets MUST correctly enforce permissions."
Claim: Standard request surface (wallet_requestExecutionPermissions, ex types "native-token-allowance", "erc20-token-allowance", "erc721-token-allowance", expiry rule "only valid until a specified timestamp") — use as the dapp/agent-facing API shape for granting our policy (R5 per-asset cap, expiry); our contracts = the enforcement it leaves open.
Regime: JSON-RPC wallet<->dapp spec, created 2024-05-24; no onchain logic; method name is wallet_requestExecutionPermissions (page has no wallet_grantPermissions).
Limits: Explicitly does not define enforcement; no mandated target+selector allowlist (R4), recipient allowlist (R7), rolling window (R6) or owner-approval fallback (R9) (inferred); T3/T4/T6/T7/T9/T12 all delegated to wallet implementation (inferred).
Reqs: R4, R5, R6, R9
Verified: pending
Origin: c2.md:E1

### E12 | ERC-7710: Smart Contract Delegation | 2024
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-7710
Quote: "The Delegation Manager then verifies the delegation’s validity and, if valid, calls the privileged function"
QuoteB: "dApps MUST NOT assume that having received a delegation in the past guarantees future execution rights."
Claim: Onchain redemption model: delegate calls redeemDelegations on a Delegation Manager, "a smart contract that validates delegation authority and calls on the Delegator to execute an action" — pattern for agent key as delegate, owner as delegator, revocable authority.
Regime: Onchain interface spec, created 2024-05-20; caveat enforcement only described as feature of MetaMask reference impl.
Limits: Spec defines no caveats itself, so no per-tx/daily/recipient semantics (R5/R6/R7) at standard level; no out-of-policy owner approval path (R9) (inferred); safety depends entirely on chosen enforcers (inferred).
Reqs: R4, R9
Verified: pending
Origin: c2.md:E2

### E13 | GitHub - MetaMask/delegation-framework: The contracts that power the Delegation Framework · GitHub | 2026
Kind: repo
URL: https://github.com/MetaMask/delegation-framework
Quote: "Caveats are used to add restrictions and rules for Delegations."
QuoteB: "They are managed by Caveat Enforcer contracts."
Claim: Reference ERC-7710 impl; composable caveat enforcer contracts = closest prior art to our policy modules (target/method/amount caveats per kit docs; enforcer names not shown on README page).
Regime: Solidity contracts, audited tagged releases; "the `main` branch is the working development branch."
Limits: Each caveat checks one dimension; combining amount + recipient + window is integrator's job, so T3 approve-laundering (approve then transferFrom elsewhere) and T6 split across delegations not covered unless caveats chained correctly (inferred); per-token caps only, no cross-asset USD cap T9 (inferred); no built-in owner co-sign escalation R9 (inferred).
Reqs: R4, R5, R6, R7
Verified: pending
Origin: c2.md:E3

### E14 | GitHub - coinbase/spend-permissions · GitHub | 2026
Kind: repo
URL: https://github.com/coinbase/spend-permissions
Quote: "Spend Permissions enable apps to spend native and ERC-20 tokens on behalf of users."
QuoteB: "This approach does not enable apps to make arbitrary external calls from user accounts."
Claim: Narrow, audited (2024 + 2026 audits) allowance-per-period primitive for native+ERC-20 pulls — strong fit for R13 subscription-like use (API credits) and R6 recurring cap; good model of "no arbitrary calls" to kill T12 self-call.
Regime: Solidity SpendPermissionManager for Coinbase Smart Wallet; app is spender.
Limits: Only token pulls — no contract/selector allowlist for general calls (R4) and no recipient allowlist beyond spender itself (R7) (inferred); fixed period buckets reset at period boundary → T7 2x-at-boundary risk (inferred); per-token allowance, no multi-asset unit normalization T9 (inferred); no owner approval for overage R9 (inferred).
Reqs: R5, R6, R13
Verified: pending
Origin: c2.md:E4

### E15 | GitHub - erc7579/smartsessions · GitHub | 2026
Kind: repo
URL: https://github.com/erc7579/smartsessions
Quote: "Support for various policy types:"
QuoteB: "Integration with external policy contracts for flexible permission management"
QuoteC: "This software is in beta and should be used at your own risk."
Claim: Rhinestone/Biconomy ERC-7579 session-key module with user-op, action-specific and ERC-1271 policies — modular validator we can mirror (session key = agent, policies = R4/R5/R6).
Regime: ERC-7579 module, Solidity, beta; audits folder present.
Limits: Beta, authors disclaim loss of funds; README names no spending/usage/time/value policies (those live in external policy contracts); action policies keyed per target+selector so ERC-20 `to` decoding (T4) and approve (T3) depend on each policy contract (inferred); no owner-approval queue R9 (inferred); T12 module install via session not blocked unless policy denies self-calls (inferred).
Reqs: R4, R5, R6
Verified: pending
Origin: c2.md:E5

### E16 | GitHub - zodiaceco/zodiac-modifier-roles: Smart account toolkit for role-based access control · GitHub | 2026
Kind: repo
URL: https://github.com/gnosisguild/zodiac-modifier-roles
Quote: "Define a role by setting targets, functions, and parameters that it can call"
QuoteB: "Define conditions on function parameters"
QuoteC: "This repository hosts Roles v3, which is not yet released for production."
Claim: Strongest calldata-condition engine: target + function + per-parameter conditions → directly covers R4 and R7 decoded `to` (T4) on Safe; Roles v3 "audited by Côme du Crest (October 2026)".
Regime: Safe/Zodiac modifier, Solidity; v3 pre-production.
Limits: Not ERC-4337-native (Safe module path) (inferred); v3 not production; README mentions no allowances/rate limits, so daily cap R6 and T7 not addressed on page (inferred); policy authoring complexity high for 1-week build (inferred); no owner approval queue R9 (inferred).
Reqs: R4, R7
Verified: pending
Origin: c2.md:E7

### E17 | safe-modules/modules/allowances at main · safe-fndn/safe-modules · GitHub | 2025
Kind: repo
URL: https://github.com/safe-global/safe-modules/tree/main/modules/allowances
Quote: "All transfer allowances are specific to a Safe, token and delegate."
QuoteB: "If `resetTimeMin` is `0` the `spent` value will not automatically reset."
Claim: Safe Allowance Module = per-delegate per-token spend cap with periodic reset (resetTimeMin, counted from last reset) — baseline for R5/R6 and R13 groceries-style budget.
Regime: Safe module, ERC20 + Ether (zero address); delegate signs or msg.sender.
Limits: Transfers only, no arbitrary contract calls R4 (inferred from "registry for transfers"); reset-from-last-reset bucket not rolling window → T7 boundary 2x (inferred); per-token so no T9 normalization (inferred); refund to tx.origin "subject to the same allowance" adds leak surface; no out-of-policy approval R9 (inferred).
Reqs: R5, R6, R13
Verified: pending
Origin: c2.md:E8

### E18 | Policy Engine | 2025
Kind: docs
URL: https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/policies/overview
Quote: "Define rules that accept or reject wallet signing operations based on transaction parameters like destination and value."
QuoteB: "Within a policy, any matching `reject` rule for an operation rejects the request, even if an `accept` rule also matches."
Claim: Coinbase CDP server-wallet policies (ethValue, evmAddress criteria; reject-wins; project-level precedence) — offchain signing gate for agent wallets, ex "accepts `signEvmTransaction` requests of up to 1 ETH unless the destination address is on the denylist."
Regime: Custodial/API-key server wallets; offchain policy at signing.
Limits: Offchain — if provider/API key compromised, nothing onchain holds (inferred); page shows no daily/rolling aggregate (R6) or decoded ERC-20 `to` (T4) criteria; no owner approval escalation R9 (inferred); enforcement location not stated.
Reqs: R5, R7
Verified: pending
Origin: c2.md:E9

