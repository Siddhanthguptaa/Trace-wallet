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
