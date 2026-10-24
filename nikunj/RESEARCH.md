# Research

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
Claim: Session-key expiry (R8) must be returned as 6-byte validUntil (and validAfter) packed with aggregator/authorizer into validationData from validateUserOp. The spec says a UserOp "MUST be valid at the current time" and bundlers MUST drop ops that expire too soon; the spec page does not itself say EntryPoint reverts on expiry (that check is in the reference EntryPoint, inferred), and ERC-7562 bans TIMESTAMP in validation, so the account must not read block.timestamp there. validUntil=0 means infinite, so agent sessions must always set nonzero validUntil. Highest bit set on both fields switches to block-number ranges.
Regime: ERC-4337 Final standard (created 2021-09-29). The spec page names no EntryPoint versions. EIP-712 userOpHash applies only to EntryPoint v0.8+ (v0.7 uses the older non-712 hash, per E5), and block-number validity ranges arrive in v0.9 (per E5). EVM chains with bundler alt-mempool.
Limits: Only gives a time window per UserOp, not cumulative/daily caps (those must be tracked in execution phase storage) (inferred); zero = infinite is a footgun if a session record defaults to 0 (inferred); bundler/block time skew makes expiry approximate (inferred).
Reqs: R1, R3, R8, R11, R14, R16
ClaimB: Signing userOpHash binds chainId + EntryPoint address, so a leaked agent signature cannot be replayed on another chain or another EntryPoint version (T8 cross-chain replay handled by protocol if account verifies against userOpHash only). Current spec computes userOpHash as an EIP-712 typed hash (R11).
ClaimC: 2D nonce (192-bit key, 64-bit sequence) lets owner and each agent session use separate nonce lanes (e.g. key = session id) so agent ops do not block owner ops and a revoke/kill-switch op from owner is never stuck behind agent nonce (R11, R14). Attack-suite case for T8: two sessions mapped to same nonce key must not let one replay/override the other.
ClaimD: T5 gas-prefund drain: agent-signed UserOps make the account pay missingAccountFunds/deposit for gas, so a leaked agent key can burn ETH via high gas limits/fees or many failing in-policy ops without moving tokens; policy must cap gas (maxFeePerGas, gas limits, daily gas budget) or use a capped paymaster.
LimitsB: Breaks if the account or a validator module signs/accepts any custom hash not derived from userOpHash (e.g. off-chain "enable session" signatures without chainId/account address) (inferred); same account address + same EntryPoint on a fork with same chainId is not protected (inferred); signature field itself is excluded from hash so validator must not trust unsigned data inside it (inferred).
LimitsC: Nonce key is chosen by the signer, not authenticated by itself; if validator selection is derived from nonce key (as in some modular accounts) the key-to-validator mapping must be checked or key collisions route to the wrong validator (inferred); parallel lanes allow agent to submit many ops concurrently, so per-tx caps alone do not bound spend (inferred).
LimitsD: Spec does not frame prefund as attack; with paymaster the account's deposit is unused ("`missingAccountFunds` of 0"), shifting drain risk to paymaster (inferred).
Verified: corrected
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
Claim: Verifies T1: TIMESTAMP and NUMBER are banned during validation (OP-011), so expiry must go via validUntil/validAfter (E1), and any daily-window logic that reads block.timestamp must run in execution phase (or a hook). Account storage is always allowed (STO-010), and the account's associated storage in an external non-entity contract (e.g. a session-key module mapping keyed by account address) is allowed only if the account already exists, or if there is initCode and the factory is staked (STO-021/022). So per-account session registry and counters are mempool-compliant after deployment, but a first UserOp with initCode that touches module storage needs a staked factory.
Regime: Canonical/shared mempool bundler rules; unstaked account; v0.7+ EntryPoint.
Limits: Source states rules are enforced off-chain by block builders and standalone bundlers, not by EntryPoint, so a direct handleOps call or a non-conforming bundler can include violating ops, and on-chain logic must stay correct when rules are bypassed (inferred). Module storage not associated with the account (e.g. global mapping not keyed by account) gets ops rejected by conforming bundlers unless the entity is staked (inferred from STO rules). ERC-7562 is still under peer review (not Final).
Reqs: R3, R8, R12
ClaimB: Storage access beyond the account's associated storage requires staking; for a hackathon wallet, keep policy state (spent-today, session records, revocation flag) in account-associated storage so no staking is needed and ops propagate in public mempool.
LimitsB: Staking adds operational cost and reputation/throttling rules (inferred); these are mempool rules, not consensus rules (inferred).
Verified: corrected
Origin: c1.md:E4 + c1.md:E5

### E3 | ERC-7579: Minimal Modular Smart Accounts | 2023
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-7579
Quote: "A module used during the validation phase to determine if a transaction is valid and should be executed on the account."
QuoteB: "MUST validate that the signature is a valid signature of the userOpHash"
QuoteC: "MUST implement authorization control"
QuoteD: "treats validators and executors as the same type of module"
QuoteE: "Malicious Hooks may revert on `preCheck` or `postCheck`"
Claim: Standard validator-module interface (module type id 1) for an agent session-key validator (R2): owner validator and agent session validator as separate modules, each required to verify signatures over userOpHash and return SIG_VALIDATION_FAILED rather than revert on mismatch. ERC-7579 conformance should let the module plug into Kernel/Nexus/Safe7579 (inferred; the spec names no implementations). ERC-7579 is Draft (created 2023-12-14).
Regime: ERC-7579 modular accounts on ERC-4337.
Limits: Standard defines interfaces, not policy semantics; precise policy expression (targets, selectors, caps) is left to module authors (inferred).
Reqs: R1, R2, R3, R12, R14, R16
ClaimB: Corrects T12: ERC-7579 only says installModule/uninstallModule "MUST implement authorization control" and does not itself mandate EntryPoint-or-self only; so wallet must explicitly forbid agent sessions from calling the account itself (installModule, uninstallModule, upgradeToAndCall, execute-on-self). Attack suite must include agent UserOp targeting address(this).
LimitsB: If install path is reachable via self-call (onlyEntryPointOrSelf) and agent policy allows target == account, a leaked agent key can install an executor and escape all policies (inferred); malicious/buggy hooks can brick execution (stated: revert in preCheck/postCheck).
Verified: corrected
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
Verified: yes
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
ClaimB: v0.9.0 (16 Nov, year inferred 2025, latest, ABI-compatible with v0.8 and v0.7) allows 2D nonce with initCode: initCode is ignored if the account already exists, and an IgnoredInitCode event is emitted. Notes warn that accounts assuming nonzero initCode means the first UserOp must review their logic ("this change may affect the security of your Account"). v0.9 also adds a paymasterSignature field, block-number validUntil/validAfter, and getCurrentUserOpHash. If targeting v0.9, add tests for first-op detection and initCode handling with nonce-key lanes (T8).
LimitsB: Notes state the assumption that breaks (nonzero initCode as first-op signal) but give no exploit detail. Impact on a specific account must be analyzed (inferred).
Verified: corrected
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
Verified: yes
Origin: c1.md:E11 + c2.md:E6

### E7 | GitHub - erc7579/smartsessions | 2025
Kind: repo
URL: https://github.com/erc7579/smartsessions
Quote: "SmartSession is an advanced module for ERC-7579 compatible smart accounts, enabling granular control over session keys."
QuoteB: "This software is in beta and should be used at your own risk."
Claim: Rhinestone/Biconomy shared session-key validator for ERC-7579 compatible accounts: user-op validation policies, action-specific policies, ERC-1271 signature validation policies, external policy contracts, and an enable flow that creates session keys inside the first UserOp. Baseline to compare our policy module against (R12); its enable flow is a T8/R11 risk point. README names no specific accounts (Safe7579/Nexus/Kernel compatibility inferred).
Regime: ERC-7579 accounts on ERC-4337; README states no EntryPoint version; AGPL-3.0; beta.
Limits: Self-described beta; enable-flow signatures must bind account+chain to avoid replay (inferred); audit contents not stated on README; year inferred.
Reqs: R2, R11, R12
Verified: corrected
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
Verified: yes
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
Verified: yes
Origin: c1.md:E14

### E10 | Toward Web 4.0: Bidirectional Trust between AI Agents and Blockchain | 2026
Kind: paper
arXiv: 2605.08922
URL: https://arxiv.org/abs/2605.08922
Quote: "Autonomous AI agents are increasingly deployed on blockchain platforms"
Claim: May 2026 SoK framing agent-blockchain trust as bidirectional: blockchain as trust infrastructure for agents (identity, permissions and delegation, intent-based execution, tokenized agent economies) and agents taking part in blockchain mechanisms. It finds agent-specific standards immature and intent architectures lacking formal analysis. That supports positioning our wallet as an on-chain permission/delegation layer that constrains the agent and survives prompt injection (R3); the "constrain rather than trust" conclusion is our inference, not the paper's.
Regime: Position/survey paper (May 2026); no wallet implementation numbers in abstract.
Limits: SoK/survey (70 EIPs/ERCs, 20 industry projects, 118 papers catalogued; five-dimension assessment; nine open problems). No smart-wallet mechanism or experimental evaluation on the abstract page. Full PDF not reviewed.
Reqs: R3
Verified: corrected
Origin: c1.md:E15

### E11 | ERC-7715: Request Permissions from Wallets | 2024
Kind: docs
URL: https://eips.ethereum.org/EIPS/eip-7715
Quote: "This ERC does not specify an exhaustive list of rule or permission types."
QuoteB: "Since this ERC only specifies the interaction between the wallet and the DApp but not how the wallet enforces permissions."
QuoteC: "Wallets MUST correctly enforce permissions."
Claim: Standard request surface (wallet_requestExecutionPermissions, ex types "native-token-allowance", "erc20-token-allowance", "erc721-token-allowance", expiry rule "only valid until a specified timestamp") — use as the dapp/agent-facing API shape for granting our policy (R5 per-asset cap, expiry); our contracts = the enforcement it leaves open.
Regime: Draft JSON-RPC wallet<->dapp spec, created 2024-05-24. Requires EIP-4337 and ERC-7710 (permissions redeemed via redeemDelegations on a delegation manager), but defines no enforcement logic itself. Only rule type defined is expiry. Method is wallet_requestExecutionPermissions (also revoke/getSupported/getGranted variants; no wallet_grantPermissions).
Limits: Explicitly does not define enforcement; no mandated target+selector allowlist (R4), recipient allowlist (R7), rolling window (R6) or owner-approval fallback (R9) (inferred); T3/T4/T6/T7/T9/T12 all delegated to wallet implementation (inferred).
Reqs: R4, R5, R6, R9
Verified: corrected
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
Verified: yes
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
Verified: yes
Origin: c2.md:E3

### E14 | GitHub - coinbase/spend-permissions · GitHub | 2026
Kind: repo
URL: https://github.com/coinbase/spend-permissions
Quote: "Spend Permissions enable apps to spend native and ERC-20 tokens on behalf of users."
QuoteB: "This approach does not enable apps to make arbitrary external calls from user accounts."
Claim: Narrow allowance-per-recurring-period primitive (e.g. "10 USDC per month") for native and ERC-20 pulls by an app spender. SpendPermissionManager was audited by Spearbit via Cantina (10/29/2024, 11/2024 public competition, 12/10/2024); the 2026 audits (03/18/2026, 03/21/2026) cover SpendRouter, not the manager. Strong fit for R13 subscription-like use (API credits) and R6 recurring cap, and a good model of "no arbitrary calls" to kill T12 self-call.
Regime: Solidity SpendPermissionManager added as an owner of Coinbase Smart Wallet V1 (periphery addition); app-controlled spender calls the manager directly.
Limits: Only token pulls — no contract/selector allowlist for general calls (R4) and no recipient allowlist beyond spender itself (R7) (inferred); fixed period buckets reset at period boundary → T7 2x-at-boundary risk (inferred); per-token allowance, no multi-asset unit normalization T9 (inferred); no owner approval for overage R9 (inferred).
Reqs: R5, R6, R13
Verified: corrected
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
Verified: yes
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
Verified: yes
Origin: c2.md:E7

### E17 | safe-modules/modules/allowances at main · safe-fndn/safe-modules · GitHub | 2025
Kind: repo
URL: https://github.com/safe-global/safe-modules/tree/main/modules/allowances
Quote: "All transfer allowances are specific to a Safe, token and delegate."
QuoteB: "If `resetTimeMin` is `0` the `spent` value will not automatically reset."
Claim: Safe Allowance Module = per-delegate per-token spend cap with periodic reset (resetTimeMin, counted from last reset) — baseline for R5/R6 and R13 groceries-style budget.
Regime: Safe module, ERC20 + Ether (zero address); delegate signs or msg.sender.
Limits: Transfers only (README: "registry of transfer allowances"), so no arbitrary contract calls R4 (inferred). Reset is counted from last reset time, a bucket rather than a rolling window, so T7 boundary 2x applies (inferred). Per-token, so no T9 normalization (inferred). Refund to tx.origin counts against the allowance, and README notes anyone can front-run/execute once in mempool (paymentReceiver proposed). No contract signatures/approved hashes. No out-of-policy approval R9 (inferred). README states no audit.
Reqs: R5, R6, R13
Verified: corrected
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
Verified: yes
Origin: c2.md:E9

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
Verified: yes
Origin: c2.md:E10

### E20 | Scheme: `exact` on `EVM` | 2025
Kind: docs
URL: https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
Quote: "uses the `transferWithAuthorization` function directly on token contracts that support it."
QuoteB: "Settlement is performed via the facilitator calling the `transferWithAuthorization` function"
QuoteC: "Verify the signature is valid and recovers to the `authorization.from` address."
Claim: x402 "exact" EVM scheme settles by a facilitator calling EIP-3009 transferWithAuthorization (or, for tokens without EIP-3009, a Proxy + Permit2) with an off-chain signature; for these two methods no UserOp/EntryPoint is involved, so a smart-wallet policy enforced only in validateUserOp/execute never sees those x402 payments (T2, inferred). The spec also defines an ERC-7710 delegation method aimed at smart contract accounts (ERC-4337, ERC-7579), whose policy path depends on the delegation framework (inferred). Basis for R13 (x402 API-credit payments) design: route x402 signing through a policy-checked path.
Regime: Off-chain signed authorization + facilitator-submitted tx; EVM tokens implementing EIP-3009 (e.g. USDC) or Permit2.
Limits: Spec text does not mention ERC-1271 or ERC-6492; ERC-7710 is the method the spec says is "particularly suited for smart contract accounts", but it is not the only route, since EIP-3009 tokens like USDC accept contract-wallet signatures (see E21); "recovers to" wording implies EOA ecrecover, so smart-account support on the EIP-3009/Permit2 paths depends on token/facilitator implementation (inferred).
Reqs: R3, R13, R14
Verified: corrected
Origin: c3.md:E1

### E21 | stablecoin-evm/contracts/v2/EIP3009.sol at master · circlefin/stablecoin-evm · GitHub | 2023
Kind: repo
URL: https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol
Quote: "Signature byte array produced by an EOA wallet or a contract wallet"
QuoteB: "SignatureChecker.isValidSignatureNow("
Claim: Circle's EIP-3009 implementation (internal _transferWithAuthorization, wrapped by public functions in the token) validates via SignatureChecker.isValidSignatureNow and documents the signature as "produced by an EOA wallet or a contract wallet", so contract-wallet signatures are accepted (ERC-1271 mechanism inferred, library source not on page). Implication for T2 (inferred): if the 4337 account's isValidSignature accepts the agent key, a leaked/injected agent key can sign transferWithAuthorization and move USDC with zero UserOps, bypassing per-tx/daily/recipient limits. Fix: isValidSignature must reject agent-key sigs or decode and policy-check the EIP-712 payload.
Regime: USDC FiatToken v2.x on EVM chains; any signer key accepted by account's ERC-1271.
Limits: Page did not include SignatureChecker source or explicit ERC-1271 text; behavior on older token versions / other chains not shown (inferred).
Reqs: R3, R13, R14, R15
Verified: corrected
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
Verified: yes
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
ClaimB: Closest match for R15 and R16. CrAIBench has 150+ Web3 tasks and 500+ context-manipulation attack cases (task mix such as transfers, trading, bridges, cross-chain not listed in the abstract, inferred). Run its transfer and trade attacks through our agent with the session key and count how many the on-chain policy blocks (target: 100% of out-of-policy txs reverted, whatever the agent outputs). Memory injection beats prompt-injection defenses, which supports enforcing at the wallet.
LimitsB: Code and data release status not stated on the abstract page (inferred, check the repo); tasks may target ElizaOS-style tools, not ERC-4337 UserOps, so an adapter is needed (inferred); authors say fine-tuning defenses substantially reduce attack success while preserving performance on single-step tasks, and the abstract does not report multi-step task performance.
Verified: corrected
Origin: c3.md:E5 + c4.md:E4

### E24 | Defeating Prompt Injections by Design | 2025
Kind: paper
arXiv: 2503.18813
URL: https://arxiv.org/abs/2503.18813
Quote: "solving $77\%$ of tasks with provable security (compared to $84\%$ with an undefended system) in AgentDojo"
Claim: CaMeL (a system layer around the LLM that extracts control and data flows from the trusted query and uses capabilities to enforce security policies at tool calls) solves 77% of AgentDojo tasks with provable security vs 84% undefended; contrast: agent-side defense costs ~7 points utility and requires trusted agent runtime, whereas on-chain policy holds for any open model or scripted bot (R10) and even if runtime/key compromised (R14) (inferred).
Regime: AgentDojo benchmark, tool-using LLM agents; v2 June 2025 with newer models.
Limits: Defense lives in agent harness; useless if agent key leaks or attacker runs own bot (inferred); 23% of tasks not solved under the defense (16% unsolved even undefended).
Reqs: R3, R10, R15
Verified: corrected
Origin: c3.md:E6

### E25 | Powering AI commerce with the new Agent Payments Protocol (AP2) | 2025
Kind: writeup
URL: https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
Quote: "When you delegate a task like, "Buy concert tickets the moment they go on sale," you sign a detailed Intent Mandate upfront. This mandate specifies the rules of engagement—price limits, timing, and other conditions."
Claim: AP2 (Sept 17 2025) encodes user-signed Intent/Cart Mandates (price limits, timing) as verifiable credentials and ships A2A x402 extension; our on-chain policy = enforced mandate; Cart Mandate ≈ owner approval for out-of-policy spend (R3, R13).
Regime: Off-chain VC-based mandates verified by merchants/payment networks; human-present and human-not-present flows.
Limits: Mandates are evidence/audit trail, not on-chain enforcement; a leaked agent or forged cart still relies on verifier honesty (inferred).
Reqs: R3, R13
Verified: yes
Origin: c3.md:E7

### E26 | Scam Sniffer 2025: Crypto Phishing Losses Fall 83% to $84 Million | 2026
Kind: writeup
URL: https://drops.scamsniffer.io/scam-sniffer-2025-crypto-phishing-losses-fall-83-to-84-million/
Quote: "Total losses: $83.85M across 106,106 victims"
QuoteB: "Permit/Permit2 signatures accounted for 38% of large-case losses."
QuoteC: "$6.5M via Permit signature (September)"
QuoteD: "$83.85M across 106,106 victims — down 83% and 68% respectively from 2024"
QuoteE: "EIP-7702 malicious signatures emerged after the Pectra upgrade, with 2 large cases in August"
Claim: 2025 signature-phishing losses $83.85M / 106,106 victims (EVM drainers); Permit/Permit2 = 38% of large-case (≥$1M) losses, largest single case $6.5M via Permit (September); EIP-7702 malicious sigs appeared after Pectra (2 large cases in August, $2.54M) -> off-chain signature path (T2) and misleading signing requests (T11) are the real-world attack surface; motivates blocking agent-key ERC-1271 and decoded approval prompts (inferred).
Regime: Trackable wallet-drainer activity via phishing sites, EVM chains, calendar 2025.
Limits: "Lower bound estimate; based on trackable drainer activity only; unreported incidents not captured"; human victims, not agents (inferred).
Reqs: R14, R15, R16
ClaimB: Threat motivation plus R16 attack cases: Permit/Permit2 caused 38% of large-case losses in 2025 ($83.85M total), so the suite must include an agent tricked into signing permit/permit2/7702 delegations, and the wallet policy must block off-allowlist signature types (ERC-1271 isValidSignature gating).
LimitsB: "Lower bound estimate; based on trackable drainer activity only; unreported incidents not captured"; only covers drainers on phishing websites, not agent-specific attacks.
Verified: corrected
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
Verified: yes
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
Verified: yes
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
Verified: yes
Origin: c4.md:E3

### E30 | Breaking Agent Backbones: Evaluating the Security of Backbone LLMs in AI Agents | 2025
Kind: benchmark
arXiv: 2510.22620
URL: https://arxiv.org/abs/2510.22620
Quote: "a security benchmark based on 194,331 unique crowdsourced adversarial attacks"
QuoteB: "enhanced reasoning capabilities improve security, while model size does not correlate with security"
Claim: Use b3 (194,331 crowdsourced attacks, 34 LLMs) to pick the R10 open-model agent backbone and to source realistic injection strings for the R15 demo; the finding that size does not correlate with security supports "assume the agent will be compromised" plus on-chain caps.
Regime: Threat-snapshot evaluation of backbone LLMs; text attacks; API or local inference; laptop is fine for small open models (inferred).
Limits: Scores the LLM at isolated threat snapshots, not full wallet workflows; the abstract does not list a count of threat snapshots or attack categories; authors state they release the benchmark, dataset and evaluation code (v2 Feb 2026), so reuse is feasible but attack strings are not wallet-specific (inferred).
Reqs: R10, R15, R16
Verified: corrected
Origin: c4.md:E5

### E31 | DeFiHackLabs | 2026
Kind: dataset
URL: https://github.com/SunWeb3Sec/DeFiHackLabs
Quote: "Reproduce DeFi hacked incidents using Foundry"
Claim: R16 Foundry attack suite: fork-replay real exploit PoCs (approval drains, reentrancy, price-manipulation call patterns) against the agent wallet's allowlist and spend policy, and report blocked/total; Apache-2.0 so code can be reused directly.
Regime: Foundry (forge test with mainnet/L2 fork RPC); Solidity PoCs; laptop is fine, needs an archive RPC endpoint (inferred).
Limits: Incident count not shown on the fetched page (4,011 commits ≠ incidents); exploits target protocols, not smart wallets, so only patterns like approve/transferFrom drains carry over (inferred); fork RPC rate limits (inferred).
Reqs: R16
Verified: yes
Origin: c4.md:E6

### E32 | bundler-spec-tests | 2026
Kind: repo
URL: https://github.com/eth-infinitism/bundler-spec-tests
Quote: "EIP4337 bundler compatibility tests"
Claim: R16 conformance layer: run the eth-infinitism suite (pdm test against a local node + EntryPoint + bundler) to show our account's validateUserOp stays bundler-compatible after adding policy checks, i.e. the policy does not break ERC-4337 validation rules.
Regime: Python ≥3.8 + PDM ≥2.2.1, local Ethereum node, deployed EntryPoint, running bundler; laptop-feasible.
Limits: Tests bundlers, not account policy logic; ERC-7562 rule coverage not confirmed on the fetched page; license not shown on the page.
Reqs: R16
Verified: yes
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
Verified: yes
Origin: c4.md:E8

### E34 | TRACE: Graph-Aware Anomaly Detection for Trust Routing in Adversarial Decentralized Marketplaces | 2026
Kind: paper
DOI: 10.5281/zenodo.22706499
URL: https://zenodo.org/records/22706499
Quote: "Trust propagation amplifies coordinated attacks: EigenTrust routes 81.7% of jobs to malicious agents under Sybil attack, while reputation-only contains the same attack to 29.0%."
Claim: Non-propagating, uncertainty-aware trust score (TRACE) as an off-chain recipient/merchant risk signal feeding the wallet's recipient policy; EigenTrust-style propagation is the wrong design (81.7% vs 29.0% malicious routing, Sybil attack, N=1,000 agents, 30% adversaries, 10 seeds; replicates at N=5,000 and on Bitcoin OTC / Bitcoin Alpha signed-trust graphs). Greedy (no Thompson sampling) lowers fraud from 10.7/46.5/19.0/83.7 to 4.7/6.4/7.1/31.7 sats across strategic-default/collusion-ring/sybil-cluster/game-theoretic.
Regime: Simulated agent marketplace, N=1,000 (scale N=5,000) agents, 30% adversaries, 4 attack regimes, sats-denominated jobs; plus 2 real signed-trust graphs; CPU simulation.
Limits: Score is off-chain and advisory, so a leaked agent key or a compromised oracle can't be stopped by the score alone; it needs on-chain caps (inferred). Sparse-graph result reverses on dense or partitioned views. Under partitioned local evidence (Table 9) greedy has 32.0 vs 6.4 sats strategic-default fraud against Thompson sampling, i.e. 5.0x. The paper's abstract, contribution (6) and conclusion say "6.8x higher fraud than Thompson sampling"; 6.8x is actually greedy-partitioned vs greedy-centralized (32.0 vs 4.7, section 7.3 text). Cite 5.0x for the Thompson comparison. Fresh recipient addresses have no history (cold start) (inferred).
URLB: https://zenodo.org/records/22706499/files/TRACE_CIKM2026_preprint.pdf (full text, 10 pages, read in Phase C re-run 2026-10-24)
QuoteB: "They need separate tracks with independent budgets, which we leave to future work under the heading of risk-conditioned exploration."
ClaimB: Section 7.1, the fraud-openness trade-off. Two recovery attempts failed: loose round-robin served 104/700 honest providers but fraud rose to 13.0±8.4 sats; tight round-robin kept fraud low but "only gained 4 additional providers". The paper concludes that fraud defense and openness discovery need separate tracks with independent budgets, and leaves that to future work. D3's on-chain exploration budget is that second track.
QuoteC: "Table 9: Partitioned-view fraud (sats). 5 buyers, 60 jobs each, n=5 seeds."
ClaimC: Table 9 (strat / collusion / sybil / GT, sats): TRACE-full 6.4 / 44.6 / 24.2 / 86.8; TRACE-no-bandit 32.0 / 51.6 / 32.8 / 64.4; REPUTATION 18.0 / 55.4 / 20.0 / 85.0; PRICE 5.0 / 46.6 / 25.6 / 68.4; EigenTrust 8.2 / 291.0 / 103.8 / 47.6. A single wallet sees only its own payments, so it sits in the partitioned regime, where pure greedy is unsafe (5.0x the strat fraud of Thompson). That is why D3 keeps a bounded exploration track, and why a shared attestor (a wider view) helps.
QuoteD: "TRACE-no-bandit served only 66 of 700 honest providers versus 125 for full TRACE, a 47% reduction in provider diversity (Table 8)."
ClaimD: Table 8 (strategic-default, n=3 paired seeds): served honest providers 125/700 (full) vs 66/700 (no-bandit), -47%; top-10 share 19.4% vs 30.6%. Section 7.5 calls this a barrier to entry for newcomers. This is the openness cost that pure greedy (or a static allowlist) pays.
QuoteE: "fraud holds at 6.2 sats up to 0.8% density, then jumps 7.5× to 47.1 sats at 1.2%."
ClaimE: Density boundary (collusion-ring, n=5): the greedy advantage disappears between 0.8% and 1.2% edge density, confirmed on synthetic-dense, Bitcoin OTC (1.85%) and Bitcoin Alpha (1.20%).
QuoteF: "Each attack follows a fixed script."
ClaimF: Limitations (section 7.5): outcomes are strictly binary (success or default); each attack follows a fixed script; attacker behavior on Bitcoin OTC/Alpha is simulated. Section 7.6 future work: the edge-to-job ratio fires false positives on real graphs (fix: Louvain or Leiden community baseline), and visibility-conditioned exploration (gating Thompson sampling on the top-two utility gap) is not yet wired in.
QuoteG: "Beta-Binomial posterior over job completion rate (prior Beta(1,3)). The 95% lower confidence bound is the reliability estimate."
ClaimG: Score components: Bayesian LCB (Beta(1,3) prior, 95% LCB; cold-start providers sit near the prior mean); exponentially smoothed default probability plus CUSUM change-point detection; PPR from an honest seed (>=30 jobs, <=10% failure rate); weighted counterparty entropy; Sybil risk from the edge-to-job ratio; clique and contamination penalties. Utility (Eq. 1) = 0.40 trace - 0.30 risk - 0.15 cost + 0.10 net + 0.10 cap - 0.35 sybil - 0.25 clique.
QuoteH: "In Proceedings of the 35th ACM International Conference on Information and Knowledge Management (CIKM ’26), November 07–11, 2026, Rome, Italy."
ClaimH: Setup: N=1,000, 30% malicious, 60 rounds x 5 jobs/round, 5 buyers, 2-round propagation delay, empty synthetic graph, 10 seeds per cell. Table 2 malicious-routing rate: EigenTrust 81.7% on sybil, 41.2% on GT. N=5,000 (Table 7): no-bandit 4.6 / 17.6 / 14.2 / 37.7, EigenTrust collusion 244.4. Native stack: SatsRouter on Lightning with L402 paywalls, 5-20 sats per job, so the EVM port is our work. Venue: CIKM '26, Rome, November 07-11, 2026, ACM DOI 10.1145/3799682.3841014 (Zenodo metadata lists that DOI as the conference version).
Reqs: R7, R13, R16
Verified: pending
Origin: c5.md:E1; extended Phase C re-run 2 (C21, C28, C31)

### E35 | SatsRouter — Lightning Agent Economy | 2026
Kind: repo
URL: https://github.com/NikunjKaushik20/sats_router
Quote: "Buyer can't spend more than `dailyBudgetSats` per day (auto-resets)"
Claim: Prior agent-spend policy design: daily budget cap plus a "Per-Incident Cap" (rolling 10-minute window), and loop detection ("3 identical calls in 60s = blocked"), enforced off-chain in src/lib/budget.ts and src/lib/safety.ts. This is the baseline that W3-02 moves on-chain (daily limit, per-window velocity) in a 4337 validation module; demo setting is a Lightning/L402 agent marketplace with sats-priced API calls.
Regime: Next.js 16 + SQLite via Prisma app, buyer agent "Riya" hiring specialist agents behind L402 paywalls at 5–20 sats per request; caps are DB checks, not cryptographic.
Limits: Caps live in the app server, so a leaked wallet key or anyone paying Lightning/L402 invoices directly bypasses them (inferred). Public README mentions L402 but not x402, and src/lib lists no x402 module; src/lib/x402.ts and new_paper/x402_usenix not in the public repo (raw URL 404 on both).
Reqs: R3, R13, R14
Verified: corrected
Origin: c5.md:E2

### E36 | Five Attacks on x402 Agentic Payment Protocol | 2026
Kind: paper
arXiv: 2605.11781
URL: https://arxiv.org/abs/2605.11781
Quote: "We present five concrete attacks that reveal weaknesses in authorization, binding, replay protection, and web-layer handling, showing that x402 is vulnerable across multiple stages of the payment workflow. We validate these attacks through a reproducible testbed on local chains, Base Sepolia, and live endpoints and further audit three open-source SDKs and endpoints."
Claim: Five concrete x402 attacks on authorization, binding, replay protection and web-layer handling, validated on local chains, Base Sepolia and live endpoints, with three open-source SDKs and endpoints audited; outcomes are unpaid service or paid-but-denied. Supports binding signed payment authorizations to resource, nonce and chain rather than trusting the HTTP layer.
Regime: Formal analysis of x402 design plus testbed (local chains, Base Sepolia, live endpoints); audit of three open-source SDKs and endpoints; signed-transfer scheme (EIP-3009 style, inferred, not stated in abstract); single version v1 of 12 May 2026.
Limits: Covers the x402 protocol and SDKs only, not ERC-4337 session-key validators or wallet-side spend policy (inferred). Attacks mostly harm merchant or payer service outcomes, not unbounded payer drain (inferred from abstract).
Reqs: R11, R12, R16
Verified: corrected
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
Verified: yes
Origin: s2.md:E2

### E38 | Hardening x402: PII-Safe Agentic Payments via Pre-Execution Metadata Filtering | 2026
Kind: paper
arXiv: 2604.11430
URL: https://arxiv.org/abs/2604.11430
Quote: "We present presidio-hardened-x402, the first open-source middleware that intercepts x402 payment requests before transmission to detect and redact personally identifiable information (PII), enforce declarative spending policies, and block duplicate replay attempts."
Claim: presidio-hardened-x402: open-source middleware that intercepts x402 payment requests before transmission, redacts PII, enforces declarative spending policies and blocks duplicate replays. On a synthetic labeled corpus of 2,000 x402 metadata triples (seven use-case categories) and a 42-configuration sweep, the v1 abstract reports NLP mode at min_score=0.4 reaching micro-F1 = 0.894 (precision 0.972) at p99 5.73ms, within a 50ms budget; the v2 comment (30 Jun 2026) revises the recommended threshold to min_score=0.5 with headline micro-F1 0.898. It is a client-side, off-chain policy baseline that on-chain enforcement should beat when the key leaks.
Regime: Synthetic labeled corpus of 2,000 metadata triples; regex vs NLP detection sweep; client middleware.
Limits: Policy runs off-chain in the agent's own process, so a leaked key or compromised host bypasses it (inferred). PII evaluation uses a synthetic corpus only.
Reqs: R12, R14, R5
Verified: corrected
Origin: s2.md:E3

### E39 | The Attacker Moves Second: Stronger Adaptive Attacks Bypass Defenses Against Llm Jailbreaks and Prompt Injections | 2025
Kind: paper
arXiv: 2510.09023
URL: https://arxiv.org/abs/2510.09023
Quote: "By systematically tuning and scaling general optimization techniques-gradient descent, reinforcement learning, random search, and human-guided exploration-we bypass 12 recent defenses (based on a diverse set of techniques) with attack success rate above 90% for most; importantly, the majority of defenses originally reported near-zero attack success rates."
Claim: Negative result: adaptive attacks bypass 12 recent jailbreak and prompt-injection defenses, most at >90% ASR, though most of them had reported near-zero ASR. Model-level injection defenses cannot be the security boundary, so wallet policy must hold even with a fully hijacked agent.
Regime: 12 recent published jailbreak and prompt-injection defenses; adaptive attacks tuned per defense using gradient descent, reinforcement learning, random search and human-guided exploration; v1 10 Oct 2025.
Limits: Measures LLM-layer defenses only, not on-chain policy enforcement (inferred). Attacks spend considerable compute per defense; a weaker attacker may do worse (inferred).
Reqs: R10, R15
Verified: corrected
Origin: s2.md:E4

### E40 | allowance.eth | 2026
Kind: repo
URL: https://ethglobal.com/showcase/allowance-eth-ejosk
Quote: "simulated against three gates: daily cap, contract allowlist, and time window."
Claim: Same-track competitor from ETHGlobal New York 2026 (prize: ENS, Integrate ENS track). Plain-English policy is translated by Claude (claude-sonnet-4-6) to JSON, stored as ENS text record allowance.policy.v1, with its keccak256 hash registered in PolicyGuard.sol (Solidity/Foundry, Sepolia). PolicyGuard is a standalone guard contract, not an ERC-4337 validator or account module: check() and simulate() enforce contract allowlist, UTC time window, daily cap, a per-counterparty (per-target) daily cap, and an approval threshold above which checkWithHumanApproval() needs a day-scoped Ledger signature shown via ERC-7730 clear signing. An optional ERC-4337 v0.7 PolicyPaymaster calls simulate() in validatePaymasterUserOp and recordSpend() in postOp. No selector rules (calldata is reserved for future selector rules), no per-tx cap other than the approval threshold, and only 7 happy/fail demo scripts plus a Foundry test, no attack suite. Code: https://github.com/dankot12/allowance.eth
Regime: Hackathon prototype; Sepolia; Solidity/Foundry; ENS-stored policy.
Limits: Enforcement is advisory: the guard is not bound to the account, so a leaked agent key can call the account directly or pay its own gas and skip the paymaster. In the paymaster path, target and value are caller-supplied in paymasterAndData and not decoded from userOp.callData, and the ParsedPolicy struct is caller-supplied with only the raw JSON hash checked, so a hijacked agent can pass a permissive struct or misreport target and value (inferred from code). Value is native ETH wei only, so ERC-20 transfers are not metered. No prompt-injection demo.
Reqs: R3, R4, R6, R8, R9, R13
Verified: corrected
Origin: s2.md:E5

### E41 | EIP-7702 Phishing Attack | 2025
Kind: paper
arXiv: 2512.12174
URL: https://arxiv.org/abs/2512.12174
Quote: "First, ERC-4337's EntryPoint pipeline enables remote and repeated activation of the delegated code without further victim involvement. Second, the chain-agnostic authorization mode permits replay-like compromises across independent networks."
QuoteB: "Analyzing over 150k authorization and execution events involving 26k addresses and hundreds of delegator contracts, we assess the protocol's real-world footprint."
Claim: EIP-7702 lets one signed authorization give unconditional, persistent execution control of an EOA; the paper finds three trigger pathways (user-driven, attacker-driven, protocol-triggered) and two extended attack surfaces: the ERC-4337 EntryPoint can re-activate delegated code remotely and repeatedly with no further victim action, and chain-agnostic authorizations (chainId 0 under the EIP-7702 spec, inferred; abstract says only chain-agnostic mode) allow cross-network replay (T8). Measurement: over 150k authorization/execution events, 26k addresses, hundreds of delegator contracts on major EVM chains, concentrated in a few contract families linked to criminal activity, with significant ETH, token and NFT theft. Argues for scoped session keys over full 7702 delegation for agents (R14) and for chain-bound signatures (R11).
Regime: Controlled experiments plus empirical measurement across major EVM chains (post-Pectra 2025).
Limits: Attacks need the victim (or a leaked key) to sign the authorization; does not study smart-account session-key validators (inferred). Measurement window ends at the paper's data cutoff, so later attack volumes may differ (inferred).
Reqs: R11, R14, R16
Verified: corrected
Origin: replaced s2.md:E6 (theblock 403)

### E42 | Wallet compatibility | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.x402.org/advanced-concepts/wallet-compatibility.md
Quote: "**Permit2** (`permitWitnessTransferFrom`) code-routes through its internal `SignatureVerification` library, so any Permit2 payment from an address with code calls `isValidSignature` on that address."
Claim: Confirms the signature-based spend path for D1: x402 `exact` (EIP-3009 or Permit2) and `upto` (Permit2 only) settle through code-routing verifiers (USDC v2.2 `SignatureChecker`, Permit2 `SignatureVerification`) that call the account's EIP-1271 `isValidSignature`. A deployed ERC-4337 account is "Type B" and is marked supported in every scheme column. The docs say a permissive account's `isValidSignature` accepts a raw 65-byte ECDSA signature from the controlling key, so a key the account accepts there can authorize payments without a UserOp (inferred). Permit2 flows still need a one-time on-chain `approve(Permit2, max)`, which a smart account must send through its own `execute()` (stated).
Regime: x402 facilitator settlement on EVM; token must code-route (USDC v2.2+, Permit2); older USDC v1/v2.0/2.1 use ecrecover only.
Limits: Describes compatibility, not policy. Does not discuss limiting session keys inside `isValidSignature` (inferred); session keys appear only in footnotes about Kernel and ERC-7579 session-key validator setups. Token-version dependent: if a token's `transferWithAuthorization` only calls `ecrecover`, wallet types B through E "fail on-chain for EIP-3009 flows" (stated); Permit2 flows do not depend on token version (inferred). ERC-6492 counterfactual wallets are not supported on Permit2 flows (stated).
Reqs: R3, R11, R13
Verified: corrected
Origin: nov.md:E1

### E43 | ERC-7598: Use contract signature for signed transfer | 2024
Kind: docs
arXiv:
DOI:
URL: https://eips.ethereum.org/EIPS/eip-7598
Quote: "An ERC to extend ERC-3009 Transfer with Authorization to support ERC-1271 signature validation."
Claim: Standards basis for D1. ERC-7598 replaces ERC-3009's v,r,s parameters with a `bytes signature` "signed by an EOA wallet or a contract wallet" and validates contract-wallet signatures via ERC-1271, so the account's `isValidSignature` is the signature gate on that path. The token still applies the ERC-3009 nonce and validAfter/validBefore checks.
Regime: ERC-3009 tokens that implement the 7598 extension. The EIP names no tokens; that USDC v2.2 (per E42) follows it is inferred (one co-author is @circle-aloychan).
Limits: Draft status (created 2024-01-15). Defines the validation interface only; any spend policy is left to the wallet (inferred).
Reqs: R3, R13
Verified: corrected
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
Verified: yes
Origin: nov.md:E4

### E45 | safe-smart-account/contracts/base/GuardManager.sol | 2026
Kind: repo
arXiv:
DOI:
URL: https://raw.githubusercontent.com/safe-global/safe-smart-account/main/contracts/base/GuardManager.sol
Quote: "function checkAfterExecution(bytes32 hash, bool success) external;"
Claim: Prior art for D2's post-execution hook. Safe guards "perform pre- and post-checks on Safe transactions" via `checkTransaction` (full tx parameters plus msgSender) and `checkAfterExecution(bytes32 hash, bool success)`, which could support pre/post balance snapshots (inferred).
Regime: Safe multisig transactions (execTransaction); a guard is a single installed contract.
Limits: `checkAfterExecution` receives only the tx hash and a success flag. A guard would have to store its own pre-snapshot during `checkTransaction` (inferred). No spend-cap logic ships in this file (inferred).
Reqs: R5, R6
Verified: corrected
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
Verified: yes
Origin: nov.md:E6

### E47 | Phylax SDK - HackQuest | 2026
Kind: product
arXiv:
DOI:
URL: https://hackquest.io/projects/Phylax-SDK
Quote: "By combining ERC-4337 smart accounts, delegated session keys, recipient and contract-level policy guardrails, and centralized gas sponsorship, Phylax allows owners to provision AI agents that can act independently without exposing master keys, bypassing policy limits, or spending capital outside predefined boundaries."
Claim: Competitor hackathon project in our exact problem space: ERC-4337, agent session keys, recipient allowlist guardrails, on Arbitrum.
Regime: Hackathon project listing (HackQuest).
Limits: The listing does not mention ERC-1271, `isValidSignature` or x402 signature paths, or post-execution delta metering (inferred from page text). Page data names the event "Arbitrum Open House London: Online Buildathon" (project record createdAt 2026-06-12, updatedAt 2026-09-24). Current deployment is Arbitrum Sepolia testnet; Arbitrum One mainnet is a roadmap item.
Reqs: R1, R2, R7
Verified: corrected
Origin: nov.md:E7

### E48 | Ramprasad4121/session-policy-wallet | 2026
Kind: repo
arXiv:
DOI:
URL: https://github.com/Ramprasad4121/session-policy-wallet
Quote: "Restricted session keys with on-chain spend limits and contract allowlists. Protects humans and AI agents from drains. Built on Monad."
Claim: Competitor repo (last pushed 2026-09-22): session keys with on-chain spend limits and contract allowlists, aimed at agent drains.
Regime: Monad Testnet (Chain ID 10143); MVP built during "Monad Blitz Bangalore V5" (16 August 2026) per README.
Limits: Repo description and README read; code not inspected. The README does not mention ERC-1271, `isValidSignature`, or balance-delta metering (inferred from README text).
Reqs: R2, R4, R6
Verified: corrected
Origin: nov.md:E8

### E49 | ChainGPT-org/chaingpt-claude-skill | 2026
Kind: repo
arXiv:
DOI:
URL: https://github.com/ChainGPT-org/chaingpt-claude-skill
Quote: "Plus an agent wallet prompt injection can't drain"
Claim: Competitor (last pushed 2026-09-09) that markets per-tx, daily, and on-chain (ERC-4337) spending caps against prompt-injection drains, packaged as an MCP tool bundle for Claude Code.
Regime: MCP tool bundle (154 tools) for Claude Code plus a local agent wallet that is an EOA by default; GitHub description and README read.
Limits: Code not inspected. Per README, per-tx and rolling-24h spend and tx-count caps are enforced in local code (default "0.1‑native per‑tx cap"), while on-chain ERC-4337 session-key caps are beta ("addresses verified on Base Sepolia; full live proof pending"). Its x402 tool builds unsigned EIP-3009 `transferWithAuthorization` typed data. Whether caps cover `isValidSignature` paths is not stated (inferred).
Reqs: R5, R6, R15
Verified: corrected
Origin: nov.md:E9

### E50 | Call Policy | 2025
Kind: docs
arXiv:
DOI:
URL: https://docs.zerodev.app/sdk/permissions/policies/call
Quote: "each corresponding to an argument, in the order that the arguments are laid out"
QuoteB: "putting constraints on the values of the function arguments"
Claim: ZeroDev Kernel's call policy supports per-argument conditions on allowed calls (operators EQUAL, GREATER_THAN, LESS_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL, NOT_EQUAL). So per-parameter rules are table stakes in 4337 session-key engines, not a differentiator (C0).
Regime: ZeroDev Kernel (ERC-7579) session-key permissions; SDK docs page.
Limits: Page lists no ONE_OF / set-membership operator, so "arg in recipient set" needs one rule per recipient or a custom policy (inferred). Docs page year not stated (2025 assumed). Code not inspected.
Reqs: R4, R7, R12
Verified: yes
Origin: phase D re-run (C0)

### E51 | smartsessions/contracts/external/policies/UniActionPolicy.sol | 2025
Kind: repo
arXiv:
DOI:
URL: https://raw.githubusercontent.com/erc7579/smartsessions/main/contracts/external/policies/UniActionPolicy.sol
Quote: "A policy that allows defining custom rules for actions based on function signatures."
QuoteB: "IN_RANGE"
Claim: Smart Sessions ships a universal action policy whose ParamRule (condition, offset, isLimited, ref, usage) checks calldata parameters with EQUAL, GREATER_THAN, LESS_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL, NOT_EQUAL and IN_RANGE, with optional cumulative usage limits. Confirms per-parameter rules exist in Smart Sessions too (C0).
Regime: ERC-7579 Smart Sessions external policy contract, Solidity, beta repo (see E7).
Limits: Source file read, not audited or tested by us. Parameter rules check calldata words at fixed offsets, so they do not see what a call actually moves (inferred). Year from repo activity, not stated in file (inferred).
Reqs: R4, R5, R7, R12
Verified: yes
Origin: phase D re-run (C0)

### E52 | Precompiles | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.base.org/base-chain/specs/protocol/execution/evm/precompiles
Quote: "It's used by Passkeys, Apple Secure Enclave and many other systems."
QuoteB: "performs signature verification for the secp256r1 elliptic curve"
Claim: Base has a P256VERIFY precompile at 0x0000000000000000000000000000000000000100 that verifies secp256r1 signatures (used by passkeys). Added in the Fjord release; gas cost now 6,900 after the Azul update. Makes a passkey (WebAuthn P-256) owner signer feasible on Base (C8 stretch).
Regime: Base mainnet and Base Sepolia execution layer.
Limits: WebAuthn wrapping (authenticatorData, clientDataJSON parsing) still needs a library; the precompile only verifies the raw curve signature (inferred). Gas value as stated on page at fetch time.
Reqs: R9
Verified: yes
Origin: phase D re-run (C8)

### E53 | Fjord | 2024
Kind: docs
arXiv:
DOI:
URL: https://docs.base.org/base-chain/specs/upgrades/fjord/overview
Quote: "RIP-7212: Precompile for secp256r1 Curve Support"
Claim: The Fjord upgrade on Base includes RIP-7212 (secp256r1 precompile), with mainnet activation at timestamp 1720627201 (2024-07-10 16:00:01 UTC).
Regime: Base network upgrade spec.
Limits: Activation date is from the spec table; on-chain behaviour not tested by us.
Reqs: R9
Verified: yes
Origin: phase D re-run (C8)

### E54 | Advanced Permissions (ERC-7715) | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.metamask.io/smart-accounts-kit/concepts/advanced-permissions/
Quote: "requires MetaMask v13.23.0 or later"
QuoteB: "ERC-7715 defines a JSON-RPC method"
Claim: MetaMask ships ERC-7715 Advanced Permissions: a dapp requests fine-grained permissions (ERC-20 token and native token permissions) via wallet_requestExecutionPermissions, granted to a session account that redeems them as specified in ERC-7710; needs MetaMask v13.23.0 or later. This is prior art and a competitor for the request surface (C17), and a possible front end for our enforcement.
Regime: MetaMask extension + Smart Accounts Kit SDK; permissions redeemed through the Delegation Framework (E13).
Limits: Page lists token-allowance permission types only; it does not describe recipient sets, per-parameter rules, effect metering or ERC-1271 handling (inferred from page text). Docs read, not code.
Reqs: R2, R5, R6, R8
Verified: yes
Origin: phase D re-run (C17)

### E55 | Sign data | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.metamask.io/wallet/how-to/sign-data/
Quote: "Use this method to request the most human-readable signatures that are efficient to process onchain."
QuoteB: "We recommend this for most use cases."
Claim: MetaMask recommends eth_signTypedData_v4 (EIP-712) for most signing use cases, as the most human-readable signatures that are efficient to process on-chain. Supports the owner approval being an EIP-712 signTypedData from the owner's MetaMask (C8).
Regime: MetaMask wallet API docs (extension and mobile via SDK/WalletConnect, inferred).
Limits: The page does not state mobile deep-link behaviour; mobile support of the same method via MetaMask SDK/WalletConnect is inferred, check on day 1.
Reqs: R9
Verified: yes
Origin: phase D re-run (C8)

### E56 | ERC-721: Non-Fungible Token Standard | 2018
Kind: docs
arXiv:
DOI:
URL: https://eips.ethereum.org/EIPS/eip-721
Quote: "Enable or disable approval for a third party ("operator") to manage"
QuoteB: "multiple operators per owner"
Claim: ERC-721 setApprovalForAll lets one call grant an operator control of all of the owner's NFTs, and transferFrom/safeTransferFrom move an NFT when called by the owner, an operator or the approved address. So an agent that can call these on held tickets can give them away (C3).
Regime: Final ERC; any ERC-721 ticket contract.
Limits: Non-standard ticket contracts may add other transfer paths (inferred); the account must deny unknown selectors by default.
Reqs: R4, R7
Verified: yes
Origin: phase D re-run (C3)

### E57 | ERC-1155: Multi Token Standard | 2018
Kind: docs
arXiv:
DOI:
URL: https://eips.ethereum.org/EIPS/eip-1155
Quote: "Enable or disable approval for a third party ("operator") to manage all of the caller's tokens."
Claim: ERC-1155 setApprovalForAll grants an operator control of all of the caller's tokens, the same give-away path as ERC-721 (C3).
Regime: Final ERC; multi-token ticket contracts.
Limits: Same as E56 (inferred).
Reqs: R4, R7
Verified: yes
Origin: phase D re-run (C3)

### E58 | TRACE Reproducibility Package | 2026
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

### E59 | ERC-8004: Trustless Agents | 2025
Kind: docs
arXiv:
DOI:
URL: https://eips.ethereum.org/EIPS/eip-8004
Quote: "Reputation Registry - A standard interface for posting and fetching feedback signals. Scoring and aggregation occur both on-chain (for composability) and off-chain (for sophisticated algorithms), enabling an ecosystem of specialized services for agent scoring, auditor networks, and insurance pools. Validation Registry - Generic hooks for requesting and recording independent validators checks (e.g. stakers re-running the job, zkML verifiers, TEE oracles, trusted judges)."
Claim: Outcome/feedback source option for the D3 TRACE attestor. ERC-8004 (created 2025-08-13; requires EIP-155, EIP-712, EIP-721, EIP-1271) defines per-chain singleton registries: the Reputation Registry accepts `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)` from any clientAddress, and the Validation Registry lets agents request verification and validator contracts post responses "that can be tracked on-chain". TRACE can read both as raw inputs, then sign its own EIP-712 score attestation for the wallet.
Regime: ERC-8004 registries deployed per chain (e.g. Base); scoring and aggregation are left to off-chain services; the spec says payments are "orthogonal to this protocol" (x402 appears only as an example of enriching feedback).
Limits: Stated in Security Considerations: "Sybil attacks are possible, inflating the reputation of fake agents."; feedback reads not filtered by clientAddresses "are subject to Sybil/spam attacks". Any address can post feedback, so raw scores are cheap to fake; validator incentives are left to each validator design (inferred).
Reqs: R7, R3
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E60 | Can Trustless Agents Be Trusted? An Empirical Study of the ERC-8004 Decentralized AI Agent Ecosystem | 2026
Kind: paper
arXiv: 2606.26028
DOI:
URL: https://arxiv.org/abs/2606.26028
Quote: "Consistent with these design weaknesses, we find that a substantial fraction of reviewers (73.5%, 59.2%, and 90.6% across Ethereum, BSC, and Base) exhibit coordinated Sybil behavior."
Claim: Xiong et al. (latest version v3, 18 Oct 2026) crawl ERC-8004 on Ethereum, BSC and Base through May 13, 2026: 73.5% / 59.2% / 90.6% of reviewers show coordinated Sybil behavior, and after removing Sybil-flagged feedback 15.8% / 77.9% / 86.8% of rated agents have no valid feedback left. The abstract says the Reputation Registry "cannot function as a trust signal" as deployed, so the TRACE attestor must not ingest raw ERC-8004 feedback unfiltered.
Regime: On-chain Identity and Reputation events, off-chain registration files and x402 payment transactions on three chains, from protocol deployment to May 13, 2026.
Limits: "Sybil" is a heuristic flag (the full text bases it on reviewers sharing a first native-token funder), not ground truth (inferred); figures moved across versions (v1 full text gave 73.6% for Ethereum); snapshot ends May 13, 2026.
Reqs: R3, R7
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E61 | When Should Agent Trust Be Conditional? Characterizing and Attacking Skill-Conditional Reputation in Agent Swarms | 2026
Kind: paper
arXiv: 2606.14200
DOI:
URL: https://arxiv.org/abs/2606.14200
Quote: "We then show that an attacker with cheap evidence in one skill and none in a target skill hijacks the conditional router, driving routing regret from 0 to 0.94 on a pool our zero-cost Conditional Information Value Test (CIVT) rates GREEN--while the ungated trust verdict it contaminates reads -0.06 instead of the honest +0.19."
Claim: Xia & Wang (v1, 12 Jun 2026): in skill-conditional trust R(i | k), the cross-skill borrowing that buys data efficiency "is also a laundering channel"; cheap evidence in one skill plus zero evidence in the target skill drives routing regret from 0 to 0.94, and the ungated trust verdict reads -0.06 instead of +0.19. For D3: a TRACE attestation must be scoped to payee + capability, and a payee with zero evidence in the requested scope gets only the exploration budget, never borrowed trust.
Regime: Controlled phase-diagram simulation plus a public benchmark of 14 heterogeneous AppWorld LLM agents; router with cross-skill coupling strength beta.
Limits: Stated: "A zero-evidence gate bounds the attack but does not eliminate it" and "We do not claim Sybil-resistance". Conditioning only pays off with high agent heterogeneity, sparse per-skill evidence and correlated skills (stated); one benchmark.
Reqs: R7, R3
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E62 | Hacker wins $47,000 by tricking AI chatbot with smart prompting | 2024
Kind: writeup
arXiv:
DOI:
URL: https://the-decoder.com/hacker-wins-47000-by-tricking-ai-chatbot-with-smart-prompting/
Quote: "Because the bot now believed "approveTransfer" managed incoming payments, it activated the function and sent its entire balance of 13.19 ETH (about $47,000) to the hacker."
Claim: Freysa, Nov 2024: an LLM agent guarding a prize pool sent its entire 13.19 ETH (about $47,000) after 482 attempts, once a prompt redefined its `approveTransfer` tool as the handler for incoming payments and announced a fake $100 deposit. Prompt-level rules are not a spend control; D3 keeps payee and budget limits inside the wallet's validateUserOp.
Regime: Public pay-per-message jailbreak game; the agent's own tool call moved the treasury; no on-chain policy sat between the model and the funds.
Limits: A game built to be broken (rising message fees), not a production agent wallet; one incident; USD value at payout time (inferred).
Reqs: R3, R16
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E63 | 0xfreysa/agent | 2024
Kind: writeup
arXiv:
DOI:
URL: https://simonwillison.net/b/8335
Quote: "195 participants sent 482 messages in total, and the eventual prize was valued at around $45,000. Effectively this was a prompt injection challenge with a financial incentive."
Claim: Independent account of Freysa (posted 29 Nov 2024): 195 participants, 482 messages, prize around $45,000; the winning trick convinced the model that the approveTransfer tool is for INCOMING transfers, then offered to contribute $100 to the treasury. Use as the prompt-injection drain scenario in the D3 attack harness.
Regime: Same game; Willison quotes the agent's system prompt (two tools, approveTransfer and rejectTransfer) from the 0xfreysa/agent repo.
Limits: Prize value differs from the-decoder ($45,000 here vs $47,000), so treat USD as approximate and cite the 13.19 ETH figure; commentary post, not a forensic analysis (inferred).
Reqs: R3, R16
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E64 | Hacker breaks into AI crypto bot aixbt’s dashboard to snatch 55 ETH | 2025
Kind: writeup
arXiv:
DOI:
URL: https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth
Quote: "An attacker has breached the dashboard of an artificial intelligence crypto bot and made two prompts for it to transfer 55.5 Ether, worth $106,200, from its wallet, sparking concerns about the security of AI agents in crypto."
Claim: aixbt, 2025-03-18 (1:58 am UTC): an attacker who breached the bot's dashboard queued two prompts and the agent sent 55.5 ETH (about $106,200) from its wallet; the maintainer said core systems were not impacted and the breach "wasn’t the result of manipulating the AI". Control-plane compromise, not model manipulation: wallet-side limits (D3 payee gating, exploration cap) must hold even when the operator channel is hostile.
Regime: Autonomous crypto-commentary agent with a hot wallet on the Simulacrum AI platform, driven by prompts from an admin dashboard.
Limits: Facts come from the maintainer's X posts as relayed by the press; no public post-mortem (inferred); USD value at report time.
Reqs: R3, R16
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E65 | EIP-712: Typed structured data hashing and signing | 2017
Kind: docs
arXiv:
DOI:
URL: https://eips.ethereum.org/EIPS/eip-712
Quote: "uint256 chainId the EIP-155 chain id. The user-agent should refuse signing if it does not match the currently active chain. address verifyingContract the address of the contract that will verify the signature. The user-agent may do contract specific phishing prevention."
Claim: D3 attestation encoding: TRACE signs an EIP-712 struct; the domain's `chainId` (EIP-155 chain id) binds the signature to one chain (Base mainnet) and `verifyingContract` binds it to the contract that verifies it (the agent wallet or a shared verifier), so a score attestation cannot be replayed on another chain or verifier; the spec adds "The domain separator prevents collision of otherwise identical structures."
Regime: Off-chain attestor key signs; validateUserOp recomputes domainSeparator and hashStruct and recovers the signer. EIP-712 created 2017-09-12, requires EIP-155 and EIP-191.
Limits: Stated: "It does not include replay protection." Inside one domain, expiry, nonce and revocation must be fields of the D3 struct; refusing a wrong chainId is a user-agent duty, so the contract must rebuild the domain itself (inferred).
Reqs: R11
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E66 | VerifyingPaymaster.sol | 2026
Kind: repo
arXiv:
DOI:
URL: https://raw.githubusercontent.com/eth-infinitism/account-abstraction/main/contracts/samples/VerifyingPaymaster.sol
Quote: "//don't revert on signature failure: return SIG_VALIDATION_FAILED if (verifyingSigner != ECDSA.recover(hash, signature)) { return ("",_packValidationData(true,validUntil,validAfter)); } //no need for other on-chain validation: entire UserOp should have been checked // by the external service prior to signing it. return ("",_packValidationData(false,validUntil,validAfter));"
Claim: Established ERC-4337 pattern for D3: an external off-chain signer ("The paymaster trusts an external signer to sign the transaction") signs getHash(userOp, validUntil, validAfter), which binds block.chainid and address(this); on-chain validation only recovers `verifyingSigner` and returns `_packValidationData(sigFailed, validUntil, validAfter)`, so the EntryPoint enforces the time window and validation never reads block.timestamp. D3's wallet can verify TRACE attestations the same way.
Regime: eth-infinitism reference sample, main branch (EntryPoint v0.6 `UserOperation`); validity window in paymasterAndData[20:84], signature in [84:]. Undated file; year = access date 2026-10-24.
Limits: Sample code, not production-audited (inferred); one trusted signer key with no rotation or revocation (inferred); the default develop branch no longer contains any VerifyingPaymaster (checked contracts/accounts, core, interfaces, legacy, legacy/v06, test, utils), so this v0.6-era main copy is the newest one; port the pattern to v0.7+ PackedUserOperation.
Reqs: R11, R3
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E67 | Invariant Testing | 2026
Kind: docs
arXiv:
DOI:
URL: https://getfoundry.sh/forge/invariant-testing
Quote: "Invariant testing verifies properties that should always hold true, regardless of the sequence of actions taken. Forge runs random sequences of function calls and checks invariants after each call."
Claim: D3 test plan: Foundry invariant tests run random call sequences and check invariants after every call; the same page's handler pattern ("Handlers wrap target contracts to constrain inputs and track state") lets the harness drive UserOps through a handler with ghost variables, e.g. "exploration spend to unproven payees never exceeds the cap". Example config on the page: runs = 256, depth = 100 calls per run.
Regime: Forge invariant campaigns configured under `[invariant]` in foundry.toml; v1.7.0 adds fuzzing of time and block distance between calls (max_time_delay, max_block_delay). Undated docs page; year = access date 2026-10-24.
Limits: Random sequences give no completeness guarantee; bugs deeper than `depth` or outside handler-constrained inputs are missed (inferred); the example sets fail_on_revert = false, so reverting paths can hide (inferred).
Reqs: R16, R12
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E68 | Halmos | 2026
Kind: repo
arXiv:
DOI:
URL: https://raw.githubusercontent.com/a16z/halmos/main/README.md
Quote: "Halmos is a _symbolic testing_ tool for EVM smart contracts. A Solidity/Foundry frontend is currently offered by default, with plans to provide support for other languages, such as Vyper and Huff, in the future."
Claim: D3 formal check: Halmos runs Foundry-style tests symbolically, so a property like "validateUserOp returns SIG_VALIDATION_FAILED for any attestation not signed by the attestor key" is checked for all inputs, not sampled ones.
Regime: Solidity/Foundry frontend; symbolic inputs created with svm.createUint256 and constrained with vm.assume (per docs/getting-started.md). Undated README; year = access date 2026-10-24.
Limits: Symbolic execution unrolls loops and sizes dynamic arrays only up to fixed bounds, so results hold only within them (inferred: no --loop note on the README, docs/getting-started.md or the FAQ wiki); getting-started states "avoid using `bound()` as it tends to perform poorly".
Reqs: R16, R12
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E69 | 35th ACM International Conference on Information and Knowledge Management (CIKM 2026) | 2026
Kind: docs
arXiv:
DOI:
URL: https://cikm2026.diag.uniroma1.it/
Quote: "35th ACM International Conference on Information and Knowledge Management (CIKM 2026) November 7-11, 2026 | Rome, ITALY"
Claim: Venue fact: the official site names the event "35th ACM International Conference on Information and Knowledge Management (CIKM 2026)", held November 7-11, 2026 in Rome, Italy; its important-dates list puts tutorials on November 7, 2026 and workshops on November 8, 2026.
Regime: Official conference website hosted at Sapienza (uniroma1.it), accessed 2026-10-24; cikm2026.org does not resolve.
Limits: Website facts can change before the event; the Nov 7-11 range includes tutorial and workshop days, so main-track days are narrower (inferred from the dates list); venue/date fact only, supports no technical claim.
Reqs: R7 (context only)
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E70 | HTTP 402 | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.x402.org/core-concepts/http-402.md
Quote: "Contains the Base64-encoded settlement response from the server. This header is returned by the server after attempting settlement, whether successful or failed, providing structured feedback about the payment outcome."
Claim: On-chain outcome signal for TRACE: after attempting settlement the x402 server returns a `PAYMENT-RESPONSE` header carrying a Base64 `SettlementResponse`, on success or failure; with the `exact` and `upto` schemes funds typically settle on-chain in the same HTTP round trip, so each paid call yields a settled/failed payment record per payee. It proves payment settled, not that the delivered result was any good.
Regime: x402 v2 headers (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE); `batch-settlement` redeems on-chain later. Undated docs page; year = access date 2026-10-24.
Limits: Says nothing about delivery quality (inferred); batch-settlement confirms authorization up front and redeems later (stated), so "settled" can lag; the header is server-reported, so TRACE should check the transaction on-chain before counting it (inferred).
Reqs: R13, R7
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E71 | Facilitator | 2026
Kind: docs
arXiv:
DOI:
URL: https://docs.x402.org/core-concepts/facilitator.md
Quote: "The `SettlementResponse` carries the broadcast transaction hash in `transaction` and the network in `network`, so callers can reconcile on chain before deciding whether to retry."
Claim: Tx-hash part of the TRACE outcome signal: the same page says the resource server returns "a `PAYMENT-RESPONSE` header containing the `Settlement Response` as Base64-encoded JSON" (200 OK on success, 402 on failure), and that SettlementResponse carries the transaction hash and network, so TRACE can look up each payment to a payee on Base and count it as a settled on-chain outcome. It shows money moved, not that the work was good.
Regime: x402 facilitator flow for the exact, upto and batch-settlement schemes on EVM and Solana; `settlement_pending` is non-terminal and still carries the broadcast hash. Undated docs page; year = access date 2026-10-24.
Limits: A broadcast hash may still fail to confirm (`settlement_pending` is "non-terminal", stated), so TRACE must confirm on-chain; payment never proves delivery quality (inferred); the hash is reported by server and facilitator, not signed by the payee (inferred).
Reqs: R13, R7
Verified: yes (Phase C re-run 2 sources check, 14 PASS)

### E72 | @x402/core Changelog | 2026
Kind: repo
URL: https://raw.githubusercontent.com/coinbase/x402/main/typescript/packages/core/CHANGELOG.md
Quote: "by default only recognized pegged assets are allowed with a `$1` USD cap"
Claim: The x402 TypeScript SDK added client-side spend controls only in version 2.23.0 (npm publish date of @x402/fetch 2.23.0: 2026-08-18, from the npm registry): by default only recognized pegged assets, with a $1 per-payment cap; `spendControls: false` disables all spend controls. So a per-payment cap in the agent's own client is the ecosystem's default guard, and it lives off-chain in the agent process, which is exactly what an injected agent or a leaked key bypasses.
Regime: x402 v2 TypeScript SDK (@x402/core, @x402/fetch, @x402/axios), client side; changelog on the main branch, fetched 2026-10-24.
Limits: Changelog entry only; it does not say what earlier versions signed (the "signed whatever amount" claim comes from a secondary report). A client-side cap is configuration, so any code holding the key can turn it off (inferred). A per-payment cap does not bound the total across many payments (inferred).
Reqs: R5, R13
Verified: pending

### E73 | What a disclosed x402 SDK flaw looks like on Base, measured | 2026
Kind: writeup
URL: https://dev.to/agenticfinancegraph/what-a-disclosed-x402-sdk-flaw-looks-like-on-base-measured-34nk
Quote: "On 22 October 2026 the security firm V12 reported that the x402 client SDKs, before version 2.23.0, signed whatever amount a 402 response asked for."
Claim: Fresh real-world case for calldata-amount and per-payment-cap weakness. The post says the default client had no spending limit, so a hostile API could ask for a wallet's full balance of a supported token; the fix is a $1 per-payment cap. Its settlement ledger for 12-23 October 2026 on Base (80 x402 sellers with 20+ settlements; 32,605 settlements, $18,950.78) finds 1,126 settlements (3.5%) at least 10x the seller's median and 25 settlements at least 100x and at least $1, worth $1,928.23, from 13 payers to 7 sellers. The author concludes a per-payment cap does not see such payments ("A $1 cap lets a tenfold overcharge of a cheap resource through without a trace").
Regime: Secondary analysis blog (DEV Community, author "AFG", posted 2026-10-24) over Base mainnet stablecoin settlements into x402 Bazaar sellers.
Limits: Secondary source; the V12 report and the cited The Hacker News article (23 Oct 2026) were not found in one search. The author says the outliers are a ceiling for the overcharge vector, not a count of overcharges, because tiered or usage-based pricing looks the same on-chain. None of the 13 payers was an ERC-8004-bound agent wallet (stated). Version facts match the npm registry (2.23.0 on 2026-08-18; 2.28.0 latest).
Reqs: R3, R5, R13
Verified: pending

### E74 | Recurring x402 payments | 2026
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

### E75 | Agent wallet identity, permissions, and compliance | 2026
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

### E76 | SoK: Blockchain Agent-to-Agent Payments | 2026
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

### E77 | Conservative Bandits | 2016
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

### E78 | Reserve-Aware Contrast Certificates for Conservative Bandits with Uncertain Baselines | 2026
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

### E79 | MonoScale: Scaling Multi-Agent System with Monotonic Improvement | 2026
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

### E80 | Changes to online banking | 2026
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

### E81 | keep-starknet-strange/starknet-agentic | 2026
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
