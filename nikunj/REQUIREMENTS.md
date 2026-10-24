# Requirements (facts from statement only)

## P1 Build an ERC-4337 account-abstraction smart-contract wallet.
## P2 The wallet gives an AI agent a key that can spend only within an owner-defined policy.
## P3 Threat model: the agent key may leak; a malicious webpage may manipulate the agent. Policies must hold even if the agent misbehaves.
## P4 Policy must cover allowed contracts and functions.
## P5 Policy must cover per-transaction limits.
## P6 Policy must cover daily limits.
## P7 Policy must cover allowed recipients.
## P8 Policy must cover permission expiry.
## P9 Out-of-policy transactions require owner approval.
## P10 The agent can be any open model or a scripted bot.
## P11 Key challenge: correctly validating signatures, nonces and chain IDs.
## P12 Key challenge: expressing policies precisely.
## P13 Key challenge: requiring owner approval for out-of-policy requests.
## P14 Use cases named: API credits, tickets, groceries.
## P15 Event: Hypnexis; Track 02 Web3 & Blockchain; PS id W3-02. Deck: "6 tracks · 15 problem statements". No rubric published. No dataset supplied.
## P16 Duration 1 week+ (user). Team 2-4 with strong Solidity (user).

---

# Phase A: Requirement map

Tags: [P#] = statement fact above, [A#] = assumption (ASSUMPTIONS.md). Items marked "verify in B" are domain knowledge that Phase B must confirm with a source before IDEA.md relies on them.

## Requirements

| R | Type | Source line (verbatim) | Simplest solution |
|---|---|---|---|
| R1 | explicit | "Build an ERC-4337 account-abstraction smart-contract wallet" [P1] | Fork the reference SimpleAccount, or use an existing modular account with one custom validator module. |
| R2 | explicit | "gives an AI agent a key able to spend only within an owner-defined policy" [P2] | Two signer roles. The owner key has full power. The agent key is a session key mapped to one Policy struct. |
| R3 | explicit | "The wallet's policies must hold even if the agent misbehaves" [P3] | Enforce every rule on-chain, inside the account. Nothing the agent says off-chain is trusted. |
| R4 | explicit | "allowed contracts and functions" [P4] | Allowlist of (target address, 4-byte selector) pairs. Decode `execute(target, value, data)` and check both. |
| R5 | explicit | "per-transaction limits" [P5] | Cap on native `value` plus the decoded amount argument of known token functions (`transfer`, `approve`). |
| R6 | explicit | "daily limits" [P6] | Spent-amount counter over a time window, checked and updated in the execution phase (see trap T1). |
| R7 | explicit | "allowed recipients" [P7] | Recipient allowlist, applied both to the call target of native transfers and to the decoded `to` argument inside token calldata. |
| R8 | explicit | "permission expiry" [P8] | Store `validUntil` per session key and return it in the packed validation data so the EntryPoint enforces it (verify in B). |
| R9 | explicit | "owner approval for transactions outside the policy" [P9][P13] | An out-of-policy op fails the agent path. The agent posts it to an approval queue; the owner signs that exact operation, and it executes through the owner path. |
| R10 | explicit | "The agent can be any open model or a scripted bot" [P10] | Scripted bot first for tests; then an open-weight LLM agent for the demo [A3]. |
| R11 | explicit (challenge) | "Correctly validating signatures, nonces and chain IDs" [P11] | Sign the EntryPoint userOpHash (which binds chain ID and EntryPoint address, verify in B). Use a vetted ECDSA library with malleability checks. Owner approvals use EIP-712 with chain ID and wallet address in the domain. Use the EntryPoint nonce, with a separate nonce key per session key. |
| R12 | explicit (challenge) | "Expressing policies precisely" [P12] | One declarative Policy struct with a written meaning for each field, plus one test per clause and per clause combination. |
| R13 | implicit | use cases "API credits, tickets, groceries" [P14] | Demo three purchase types: x402 API credits (the user already runs x402 [A5]), a mock ticket contract, and a mock grocery merchant. |
| R14 | implicit | "key might leak" [P3] | Owner kill switch: revoke a session key in one transaction. Optional key rotation. |
| R15 | implicit | "malicious webpage might manipulate the agent" [P3] | A live attack demo: an injected page tells the agent to pay an attacker. The wallet rejects on-chain. |
| R16 | implicit | no dataset [P15]; eval by attack suite [A4] | Foundry unit, fuzz and invariant tests, plus a scripted attack simulator (reuse the buildathon attack_sim idea [A5]). |
| R17 | judging (assumed) | no rubric published [P15]; assumed demo, code quality, security, presentation [A1] | See the ambition check below. |

## Baseline v0 (simplest end-to-end system meeting every R)

1. **Account:** SimpleAccount-style ERC-4337 account on the canonical EntryPoint, deployed on Base Sepolia [A2].
2. **Validation (`validateUserOp`):** recover the signer from the userOpHash.
   - Owner signer: accept.
   - Agent signer: look up its Policy. Check that it is not revoked. Decode the callData as `execute(target, value, data)` only (batch execution is rejected for the agent). Check the target and selector against the allowlist, the recipient against the recipient allowlist, and the amount against the per-tx cap. Return `validUntil = expiry`.
3. **Execution:** a modifier on the agent path updates the rolling daily spent counter and reverts if it goes over the cap.
4. **Out of policy:** the agent cannot get it through. The agent backend writes the request to an approval queue (a simple web page). The owner reviews the decoded intent and signs the UserOp with the owner key.
5. **Agent:** a scripted bot that buys API credits through x402 and a ticket from a mock contract.
6. **Tests:** Foundry tests, one per policy clause, plus replay, wrong-chain and expired-key tests.

Baseline v0 score: no dataset. The score will be the pass rate of the attack suite (R16). Phase C/D defines it as X1 once the suite exists.

## Traps

- **T1 Validation-phase rules (verify in B).** ERC-7562 restricts what `validateUserOp` may do: reading `block.timestamp` is banned, and storage access is limited to the account's own associated storage. Consequences: expiry must go through `validUntil`; a daily-limit check that reads time must run in the execution phase or rely on validAfter/validUntil windows; oracle price reads (for USD-denominated limits) cannot happen during validation.
- **T2 Off-UserOp spend paths (orchestrator hint, verify in B).** If the account implements ERC-1271 `isValidSignature` and accepts the agent key there, then permits (EIP-2612, Permit2) and EIP-3009 authorizations (used by x402) can move funds without any UserOp. That bypasses the whole policy. ERC-1271 must apply the same policy, or refuse the agent key.
- **T3 Allowance laundering.** `approve(spender, MAX)` to an allowed contract lets that spender pull funds later, outside the daily counter. Count approvals as spends, cap them, or forbid `approve` for the agent.
- **T4 Recipient hidden in calldata.** For a token `transfer(to, amt)` the target is the token, not the recipient. Router and marketplace calls carry `recipient` arguments too. A target-only allowlist is bypassed.
- **T5 Gas as a spend channel.** The agent sets `maxFeePerGas`, `callGasLimit` and the paymaster fields. With no paymaster, the account prefunds gas, so a leaked key can burn the balance through fees. Cap the gas fields per op and count the prefund toward the daily limit.
- **T6 Batching and splitting.** `executeBatch` or many small ops can dodge per-tx caps. The daily cap must be the binding limit. Reject batch, delegatecall and self-calls (calls to the account itself, e.g. to change owner or policy) on the agent path.
- **T7 Window boundary.** A calendar-day reset lets an attacker spend 2x around midnight. Use a rolling window or a token bucket.
- **T8 Replay.** Cross-chain replay (same account address on several chains), replay of owner approvals, and nonce-key collisions between agent and owner. Bind every signature to chain ID, account, EntryPoint and nonce.
- **T9 Unit confusion.** Mixed assets: ETH and tokens with different decimals, fee-on-transfer tokens, and non-standard ERC-20s (no return value). Limits must be per asset, or need a price source, which hits T1.
- **T10 In-policy loss is still possible.** An injected agent can still overpay an allowed merchant up to the caps. Report this honestly: the guarantee is bounded loss, not zero loss.
- **T11 Approval fatigue and spam.** A compromised agent can flood the owner with requests, or word a malicious request to look benign. The approval UI must show the decoded calldata, not the agent's description, and must rate-limit requests.
- **T12 Upgrade/module admin path.** If the agent can call `upgradeTo`, `installModule` or the policy setters on its own account, it can rewrite the policy. Every self-call is owner-only.
- Shift / leakage / metric quirks: not applicable (no dataset, no rubric [P15]). Compute: laptop is enough [A6].

## Ambition check (criteria assumed per A1; weights unknown, treated as equal)

| Criterion | What a top-3 entry would show |
|---|---|
| Security correctness | Invariant tests of the form "for any sequence of agent ops, spent in any window ≤ dailyCap", fuzzed calldata, explicit closure of T2-T6 and T12 with one test each, a Slither run, and a written bounded-loss claim. |
| Demo | Live on testnet with explorer links. An open-model agent reads a poisoned page, tries to pay the attacker, and the wallet refuses on-chain. A leaked-key script fails to drain. A legitimate out-of-policy purchase pops up on the owner's phone and executes after one tap. |
| UX / product | An owner dashboard with a policy editor in plain words ("$20/day, only these merchants, until Friday"), an approval inbox with decoded intent, and a one-click revoke. Judges outside crypto must understand it in 30 seconds. |
| Code quality | Modular (validator as a module of a standard modular account), Foundry tests with high coverage, and a clean README with a threat-model table. |
| Novelty / presentation | One idea beyond allowlists, grounded in a failure of existing session-key systems (Phase C). Candidates: closing the ERC-1271/x402 bypass; intent-bound approvals; recipient trust from the user's TRACE work [A5]. Plus a comparison table against existing permission products (to be built in Phase B). |

## Event-name hint

"Hypnexis" reads as hypnosis plus nexus. The PS's core threat is a hypnotized agent: a malicious webpage that manipulates it [P3]. Frame the demo as "hypnotize the agent; the wallet stays awake". Show the agent being successfully manipulated, and the wallet still holding. The deck spans 6 tracks and 15 problem statements [P15], so judges are likely generalists. The demo and UX must read clearly to non-crypto judges, and security depth must still satisfy any protocol-literate judge [A1].

## Phase 2 (extension of W3-02, user-supplied 2026-10-24)
## P17 Phase 2 framing: assume the agent is hijacked; contain it, detect it, and let the owner recover.
## P18 Script 5+ hijack attacks; losses must never exceed the daily limit.
## P19 Freeze the agent automatically on unusual spending; report detection rate and false freezes.
## P20 Recover with 3 of 5 guardians after a 48-hour delay, with an owner veto.
## P21 Sponsor gas with a per-agent quota that spam cannot drain.
## P22 Fuzz the invariant: funds move only with valid owner, in-policy agent or recovery approval.

Phase 2 requirements:
- R18 >= 5 scripted hijack attacks; attacker gain per 24 h <= daily limit in every run [P18].
- R19 automatic freeze on unusual spending; detection rate and false-freeze rate reported [P19].
- R20 social recovery: 3 of 5 guardians, 48 h delay, owner veto [P20].
- R21 sponsored gas: per-agent quota a spammer cannot drain [P21].
- R22 fuzzed authorization invariant: owner, in-policy agent, or recovery only [P22].
