# Slither triage

Tool: Slither 0.11.6 (uv tool, `results/toolchain.json`), 102 detectors, 81 contracts, `contracts/src` only.
Excluded paths: `lib`, `test`, `script`, `mocks`, `baselines` (test fixtures and the R2 baseline are not part of the trust path).

```
cd contracts
FOUNDRY_OUT=out-int2 FOUNDRY_CACHE_PATH=cache-int2 \
  slither . --foundry-out-directory out-int2 --filter-paths "lib|test|script|mocks|baselines" \
  --json ../results/slither_raw.json
```

Raw output: `results/slither_raw.json` (77 results). Per-detector counts: `results/slither_summary.json`.

**Result: 77 findings, 0 real vulnerabilities, 0 fixed in code.** 55 are false positives or intended design
(each explained below), 22 are accepted Low / Informational notes, and three hardening suggestions are listed at
the end. Contract code was not edited (this triage is read-only on `contracts/src`).

Every disposition below was checked against the code, not inferred from the detector name.

## High (1)

| Detector | Where | Disposition |
|---|---|---|
| `arbitrary-send-eth` | `AgentAccount._call` (`AgentAccount.sol:301`) | **False positive.** `_call` has one caller, `_ownerExecute`, reached from `executeUserOp` only for `role == OWNER`. The EntryPoint-only entry point is reached after `validateUserOp` has accepted an **owner** signature for that op (`_validateSignature`: `ROLE_OWNER` -> `_isOwnerSig`). Sending ETH to a target the owner chose is the owner's function. The agent path never uses `_call`: it runs `call.target.call` inside the sandbox after the policy, meter and tripwires. `BaseAccount.execute / executeBatch` are `_requireForExecute` (EntryPoint or owner). Tests: `M1_Account` owner-path cases, `scripts/e2e/core.ts` ("owner-signed op executes", "an owner-shaped op signed by a stranger is rejected"), invariant I11. |

## Medium (21)

| Detector | Count | Where | Disposition |
|---|---|---|---|
| `incorrect-equality` | 3 | `FreezeStorage.bump` (`wh != h`, `wh + 1 == h`), `FreezeTripwires.preCall` (`seen[payee] == h`), `MeterLib._allowances` (`b[x] == a[x]`) | **False positive.** Equality on clock-hour indexes and on two reads taken in the same call, not on a balance an attacker can nudge. The hour comparison is the window roll; the dedupe `seen[payee] == h` only skips double-counting; the allowance snapshot equality means "nothing moved, skip". A near-miss cannot be gamed because no value is compared for exact payment. |
| `uninitialized-local` | 11 | `ctx`, `q`, `t`, `c`, `seen`, `listed`, `total`, `approvalState` in `AgentAccount`, `PolicyLens`, `OneDoorLib`, `MeterLib`, `ApprovalLib` | **False positive / intended.** Solidity zero-initialises locals. They are memory structs filled field by field (`OpContext ctx`, `Query q`, `AgentCall t`), accumulators that start at 0 / false (`total`, `seen`, `listed`, counter `c`) and an empty `bytes approvalState` when no approval is attached. Each was read at its use site. |
| `unused-return` | 7 | `ECDSA.tryRecover` (x5), `ArgRules.word` (x1), `sessionOf` (x1) | **False positive.** The ignored component is the third `tryRecover` value (the error argument); the `RecoverError` and the signer are both used (`err == NoError && signer != 0 && signer == expected`; a malformed signature fails closed). `_meterSpender` ignores the `ok` flag of `ArgRules.word`: a short calldata word yields spender 0, i.e. no extra spender to meter. `PolicyLens._evaluate` ignores the session id from `sessionOf`. |

## Low (26)

| Detector | Count | Where | Disposition |
|---|---|---|---|
| `calls-loop` | 12 | `MeterLib._read` (balanceOf / allowance per tracked asset x spender), `PolicyLens._checkCaps` | **Accepted.** The loop bounds are the owner-set `trackedAssets` / `trackedSpenders`; the cost is paid by the owner's own account. See hardening 1. |
| `timestamp` | 10 | `PolicyLens`, `RecoveryModule` (48 h delay), `FreezeStorage.bump`, `FreezeTripwires`, `OneDoorLib` (voucher TTL, reclaim, envelope), `AgentPaymaster.available` | **Intended.** Time is read only in **execution**, never in validation (ERC-7562 bans TIMESTAMP there; E2). Verified by grep: `AgentAccount.sol`, `AgentAccountBase.sol`, `lib/PolicyCheck.sol`, `lib/ArgRules.sol`, `PayeeTierModule.sol` and `ApprovalModule.sol` contain no `block.timestamp`. Validation expresses time as `validUntil/validAfter` in `validationData`, enforced by the EntryPoint; the paymaster admits with `validAfter` and debits in `postOp`. Block-timestamp skew of seconds does not matter against 24 h buckets and a 48 h delay. `OneDoorLib.envelopeSigner` runs inside the **token's** `isValidSignature` call (execution of the token transfer), not in UserOp validation. `PolicyLens` is an off-chain view. |
| `reentrancy-events` | 3 | `executeUserOp`, `agentInnerExecute`, `AgentAccountFactory.createAccount` | **False positive.** Only the ordering of an event relative to an external call; no state is written after the call that could be reentered. The sandbox is armed with a one-shot transient flag and the inner frame is `onlySelf`. Factory: the event follows `initialize`, which the clone alone can call once. Tests: `M1_Sandbox` (`test_sandbox_innerOnlySelfAndArmed`, tripwire undo cases). |
| `missing-zero-check` | 1 | `AgentAccount` constructor `admin_` | **Accepted.** Implementation immutable; `AgentAccountFactory` reverts `ImplementationMismatch` unless the implementation's admin and EntryPoint have code. See hardening 3. |

## Informational (29)

| Detector | Count | Disposition |
|---|---|---|
| `assembly` | 18 | **Reviewed, all intended.** (a) ERC-7201 slot access (`FreezeStorage.layout`, `RecoveryStorage.layout`, `MeterLib.meterStorage`, `ApprovalLib.store`, `_payeeTierStorage`): constant slots, `memory-safe`. (b) Transient-storage flags (`_isAgentExecuting`, `_setAgentExecuting`, `_isInnerArmed`, `_setInnerArmed`): `tstore/tload` on fixed slots, the execution lock for ERC-1271 (I3). (c) Revert-data bubbling (`_call`, `executeUserOp` re-revert of a failed target). (d) The admin `fallback` DELEGATECALL (immutable admin address; each state-changing admin function carries its own `onlyOwner` or documented role check, exercised in `M1_Account` / `M10` / `M11` and by I11's outsider-call handler, which calls 16 admin selectors from non-owner senders and asserts nothing moves and the owner never changes). (e) Calldata/memory slicing in `PolicyLens` (`_tail4`, `_word`, `_decoded`, `_sumPerAsset`; off-chain view), `PayeeTierModule._attestedUntil` (strict length and range decoding, never reverts; `M4_PayeeTier` malformed-slot cases), `MeterLib.settle` (shrinks the outflow array length after filling). |
| `dead-code` | 3 | **Accepted.** Unused storage helpers `_payeeTierStorage`, `_approvalStorage`, `_meterStorage` (namespaces reserved for later fields). Removing them is cosmetic. See hardening 2. |
| `unused-state` | 4 | **Accepted.** Namespace constants `APPROVAL_SLOT`, `ONEDOOR_SLOT`, `METER_SLOT` (documented reserved ERC-7201 slots) and `PolicyLens.EXECUTE_USER_OP`. |
| `low-level-calls` | 2 | **Intended.** The two places that must call arbitrary targets: the owner `_call` and the sandboxed agent call. |
| `cyclomatic-complexity` | 1 | **Accepted.** `ApprovalLib.settle` (nested loops over outflows x maxOutflow entries, bounded by the op's own outflow list and the owner-signed list). Covered by `M5_Approval` incl. duplicate asset entries. |
| `naming-convention` | 1 | **Accepted.** `IERC3009Token.DOMAIN_SEPARATOR()` mirrors the token's own function name. |

## Hardening suggestions (not applied: `contracts/src` is not editable from this lane)

1. **Bound the owner-set tracked arrays** (`setTrackedSpenders`, `setTrackedNFTs`, and the asset list that
   `setGlobalCap` appends to): e.g. `require(spenders.length <= 16)`. Today the arrays are unbounded, and the
   meter reads `assets x spenders` per agent op, so an owner (or an owner key thief) can make their own agent
   ops too expensive. No third party can: only the owner writes these arrays. Severity: Low, self-inflicted.
2. Drop the three unused `_...Storage()` helpers and the four unused constants, or reference them in the
   storage layout doc.
3. Add `require(admin_ != address(0))` to the `AgentAccount` constructor (the factory already rejects it).

No finding changes a security claim: the loss bounds I1 (key window), I5 (global window), I7 (exploration)
and the authorization invariant I11 are unaffected.
