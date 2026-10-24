
## 16. Owner approval service (APPS, M5): implemented contract

Owner: APPS. Code: `services/approval` (`@hypnexis/approval`). Shared code: `packages/shared/src/approval/`
(`typedData.ts`, `agentOp.ts`, `abi.ts`, `submitter.ts`, `agentClient.ts`; import the files directly until
INT adds an `./approval` subpath export). This section is the implemented API and replaces the 12.2 draft
where they differ (12.2 is kept unchanged above). Copy of record: `services/approval/API.md`.

Start: `pnpm --filter @hypnexis/approval start`. Default base `http://127.0.0.1:8788`. Errors follow
section 12: `{ "error": { "code", "message", ...extra } }`. Amounts are decimal strings in base units.

### 16.1 Endpoints

| Endpoint | Request | Response |
|---|---|---|
| `GET /health` | | `{ service, ok: true, status: "ready", chainId, simulationMode }` |
| `POST /v1/requests` | `{ account, chainId, userOp, note? }`. `userOp` = PackedUserOperation JSON (or the unpacked RPC shape), agent role, nonce lane 1, approval slot EMPTY, `signature = abi.encode(1, agentSig, attestation, 0x)` | **201** `{ id, status: "pending", userOpHash, approvalHash, agentKey, payee, validUntil, simulation: { mode, ok, outflows: [{asset, amount}], declared, gasUsed, tracked, warnings }, preflight: { reasonCode, reason, tier } \| "unavailable" }` |
| `GET /v1/requests/:id/typed-data` | | eth_signTypedData_v4 JSON `{ domain, types (with EIP712Domain), primaryType: "OutcomeApproval", message }` + `status`, `approvalHash`, `display { account, target, selector, payee, maxOutflow, validUntil, validUntilIso, agentKey, noteUntrusted, simulation }` |
| `POST /v1/requests/:id/signature[?wait=1]` | `{ signature }` = owner EIP-712 signature over the typed data | `{ id, status: "approved" }`; with `wait=1` the final status object after the relay |
| `POST /v1/requests/:id/reject` | `{ signature }` = owner EIP-191 `personal_sign` of `Hypnexis approval service: reject request <id>` | `{ id, status: "rejected" }` |
| `GET /v1/requests/:id` | | `{ id, status, account, chainId, agentKey, userOpHash, approvalHash, nonce, target, selector, payee, maxOutflow, validUntil, note, simulation, txHash?, success?, blocked?, reason?, outflows?, createdAt, updatedAt }` |
| `GET /v1/requests/:id/userop` | | the relay-ready op with the final signature (anyone may relay it); 409 before the owner signed |
| `GET /v1/requests?account=&agentKey=&status=&limit=` | | `{ requests: [status objects] }` |
| `GET /v1/keys/:agentKey?account=` | | rate-limit view `{ windowSeconds, limit, maxPending, attempts, accepted, refused, rateLimited, pending }` (for the FRZ watcher's approval-spam signal) |

Status values (same as the 12.1 `approval_status` tool): `pending` -> `approved` -> `executed` |
`reverted` | `rejected`; `pending` -> `expired` | `rejected`.
- `executed`: UserOperationEvent success and no `PolicyBlocked` for this userOpHash; `outflows` = the
  account's `Decision` outflows.
- `reverted`: nothing moved. Either the target reverted (`success: false`, reason `target_reverted`) or the
  sandbox blocked it (`success: true, blocked: true`, reason `PolicyBlocked: <decoded error>`, e.g. the
  measured outflow above maxOutflow). Section 3.2: a policy block is a successful UserOp with `PolicyBlocked`.
- `rejected`: never included: preflight `checkUserOp` failed, the EntryPoint refused it (`AA24`, `AA25`...),
  the owner rejected it, or another request with the same EntryPoint nonce executed (`nonce_consumed`).
- `expired`: chain time passed `validUntil` before execution.

### 16.2 Request checks (`POST /v1/requests`, in order)

1. Body shape, `note` <= 280 chars, `chainId` == the service's, `userOp.sender == account`, callData <= 16 KiB.
2. Signature envelope: role 1 (AGENT), approval slot empty, 65-byte agent signature.
3. Attribution: `agentKey = ecrecover(userOpHash, agentSig)` with the v0.8 userOpHash
   (EntryPoint = `account.entryPoint()`, else `ENTRYPOINT`). The signature covers the whole op, so the
   request is attributable; a changed op recovers a different key (refused below). `note` is not signed:
   agent text, shown to the owner as untrusted.
4. Rate limit per (account, agentKey): attempts in the window (accepted + refused, every attributed
   request counts) >= `RATE_LIMIT_MAX` -> 429 `RATE_LIMITED`; pending >= `MAX_PENDING_PER_KEY` -> 429
   `TOO_MANY_PENDING`. RPC failures (503) do not count.
5. Nonce: key belongs to agentKey (`NONCE_KEY_MISMATCH`), lane 1 (`WRONG_LANE`), equals
   `nonceKeyOf(agentKey, 1)` (0 -> 403 `NO_SESSION`; other -> `STALE_NONCE_KEY`); `sessionOf` not revoked
   (403 `REVOKED`); sequence == `EntryPoint.getNonce(account, key)` (`STALE_NONCE` 409 / `NONCE_GAP` 400).
   Several pending requests may share one nonce; only one can execute, the rest become `nonce_consumed`.
6. Op: `executeUserOp` agent op, kind CALL only (`UNSUPPORTED_OP` for voucher ops in this build); same
   userOpHash already filed -> 409 `DUPLICATE` with its id.
7. Payee exactly as the account derives `call.payee`: the PAYEE argument rule from
   `ruleOf(agentKey, target, selector)` (the `ANY_TARGET` entry for plain value sends), else `0x0`. No rule
   -> 422 `POLICY_REFUSED` / `TARGET`. If `ruleOf` is unreadable: transfer arg 0, value-send target, else 0.
8. Preflight: `policyCheck(agentKey, callData, attestation, draftApprovalWithZeroSig)`; any reason other
   than OK / APPROVAL (TARGET, ARG_RULE(i), RECIPIENT, FLAGGED, FROZEN, OP_SHAPE, ...) -> 422
   `POLICY_REFUSED` with `reason`, because an owner approval cannot waive it (section 9 APPC).
9. Simulation (16.3); a reverting call -> 422 `SIMULATION_REVERTED`; RPC failure -> 503.
10. OutcomeApproval: `account`, `chainId`, `nonce = userOp.nonce`, `target`, `selector` (0x00000000 for a
    value send), `payee`, `maxOutflow` = simulated outflows (assets with 0 omitted, sorted by address,
    native = `0x0`), `callDataHash = keccak256(userOp.callData)`, `validUntil = min(now + APPROVAL_TTL_SECONDS,
    session validUntil)` (chain time, never 0).

### 16.3 Simulation (IDEA 7.3)

`eth_call` against the latest state with a state override that puts the `ApprovalSimulator` runtime
(`services/approval/contracts/ApprovalSimulator.sol`, checked-in bytecode in `src/simulatorArtifact.ts`,
drift-tested against a fresh solc build) at the account address, then `simulate(target, value, data, ...)`.
The call runs as the account (same address, balances, allowances; msg.sender of the target = account);
callbacks get the account's agent-path answers (token receivers accept, `isValidSignature` = 0xffffffff).
Outflow per asset is the D2 meter formula: native = drop of (balance + EntryPoint deposit); ERC-20 =
balance drop + allowance growth over the tracked spenders; ERC-721 = balance drop. Inputs: the account's
`trackedAssets / trackedSpenders / trackedNFTs`, plus `EXTRA_TRACKED_ASSETS`, the decoded token and the
decoded `approve` spender (warning `untracked_spender` if the account does not meter it). The owner signs
maxOutflow = this result; the account enforces it in execution, so a wrong simulation can only block the
op. `SIMULATION_MODE=declared` is the BUILD M5 fallback: maxOutflow = the decoded transfer / approve
amount or native value.

### 16.4 Owner signature, relay

- The signature must recover (EIP-712, account domain, section 5) to the account's on-chain `owner()`,
  read at submit time; otherwise 401 `NOT_OWNER` and the request stays pending.
- Final signature = `abi.encode(1, agentSig, attestation, abi.encode(OutcomeApproval, ownerSig))`
  (sections 4.2 / 4.4). The agent's signature stays valid because the v0.8 userOpHash excludes `signature`.
- Preflight `checkUserOp(finalOp, userOpHash)`; non-OK -> `rejected` (`preflight checkUserOp: <REASON>`), no relay.
- Relay through a `Submitter`: `DirectSubmitter` (simulates `handleOps([op])` by eth_call, so a
  validation failure is reported as `FailedOp` without spending gas, then sends it from `RELAYER_PRIVATE_KEY`)
  or `BundlerSubmitter` (`eth_sendUserOperation` + `eth_getUserOperationReceipt`, when `BUNDLER_URL` is set).
  Without either, the request stays `approved` and `GET /v1/requests/:id/userop` serves the op.
- `approvalHash` = the EIP-712 digest = APPC's `ApprovedExecuted.approvalHash`.
- APPC semantics (ApprovalModule): the approval nonce is spent only when the approved op executes (or by
  owner `cancelApproval(nonce)`); a blocked attempt leaves it unspent, so the same signed outcome may be
  retried until `validUntil` and can execute at most once, never above maxOutflow. Owner kill switches:
  `cancelApproval(nonce)` (the nonce is shown as `nonce` in the status object) and `revoke(agentKey)`.

### 16.5 Scripted owner signer and vectors [A18]

- CLI: `pnpm --filter @hypnexis/approval sign -- --id <id> [--url] [--wait] [--reject] [--max <baseUnits>]
  [--account 0x..] [--chain-id N]`, key from `OWNER_PRIVATE_KEY` or `--dev-key 0-9`. It checks the typed
  data (primaryType, domain bound to `message.account` / `message.chainId`, `approvalHash` recomputed
  locally), prints what a wallet would show, signs locally and posts. Key policy: the 10 public anvil dev
  keys on any chain (fork mode runs chainId 8453 locally); any other key only on 31337 / 1337 / 84532 /
  11155111. MetaMask `eth_signTypedData_v4` replaces it once the UI exists [A15].
- Vectors: `services/approval/vectors/outcome_approval.json` (`pnpm --filter @hypnexis/approval vectors`),
  owner = anvil #0, agent = #1. 11 cases: `m1_vector` (fields and contract digest of
  `results/m1_typed_data_vectors.json`), Base 8453 lane-1 transfer, empty maxOutflow, native send, uint
  maxima, agent-signed, and 5 replay / tamper cases (wrong chain, wrong account, other callData,
  maxOutflow +1, other payee) whose owner signature must not verify. Each has domainSeparator, structHash,
  digest, signature, recovered signer, `valid` and the encoded `approvalSlot`; every digest is checked
  against `contracts/src/lib/TypedData.sol` on anvil (`test/anvil.test.ts`).

### 16.6 Config (env)

| Var | Default | Meaning |
|---|---|---|
| `RPC_URL`, `CHAIN_ID` | required, 31337 | chain access; requests for another chain are refused |
| `ENTRYPOINT` | canonical v0.8 | used when `account.entryPoint()` is unreadable |
| `RELAYER_PRIVATE_KEY` / `BUNDLER_URL` | none | relay mode (direct handleOps / bundler RPC); the relayer is never the owner |
| `APPROVAL_PORT`, `APPROVAL_DB` | 8788, `:memory:` | HTTP port; `node:sqlite` file |
| `APPROVAL_TTL_SECONDS` | 3600 | approval validUntil = now + TTL, capped by the session |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`, `MAX_PENDING_PER_KEY` | 20, 3600, 5 | per (account, agentKey) |
| `SIMULATION_MODE`, `EXTRA_TRACKED_ASSETS` | `eth_call`, empty | 16.3 |
| `MAX_NOTE_CHARS` | 280 | |

The service never holds the owner key. It holds no agent key either: requests arrive signed.

### 16.7 Tests and results

- `pnpm --filter @hypnexis/approval test`: store, typed-data digest == the M1 contract vector, vectors,
  agent-op encodings, service checks (attribution, lanes, nonces, preflight, rate limit, expiry,
  owner-only signatures, replayed signatures, relay outcomes), signer key policy, ABI subset == forge
  artifacts, and on anvil: simulator bytecode drift, vector digests == TypedData.sol, simulation of pulls /
  transfers / approve growth / native value, and the relay with executed and blocked outcomes.
- `pnpm --filter @hypnexis/approval e2e` (real HTTP service, spawned owner CLI, EntryPoint v0.8 on anvil)
  writes `results/m5_approval_e2e_stub.json` `{target, realAccount: false, chainMode, chainId, approved,
  tampered, replay, payeeTransfer, foreignKeyRefused, ok, details}` against
  `services/approval/test/anvil/ApprovalStub.sol` (a test-only account that verifies approvals with
  TypedData.sol). `tampered` = the shop raises its price 1 base unit after the owner signed, so the
  measured outflow is maxOutflow + 1. With `E2E_TARGET_MODULE` (default export: an `E2ETarget` from
  `scripts/lib/stubTarget.ts` for the real AgentAccount; INT) it writes `results/m5_approval_e2e.json`
  with the same schema and `realAccount: true`, the BUILD M5 Done-when file.

Changelog: 2026-10-24 APPS (M5): first version of section 16.
