# FreezeModule + watcher (lane FRZ, M10): implemented contract

Owner: FRZ. On-chain code: `contracts/src/modules/FreezeModule.sol`. Service: `services/watcher` (`@hypnexis/watcher`).
INT: merge this file into `docs/api.md` as a new section, the way section 15 came from `services/attestor/API.md`.
The thresholds here are configuration placeholders. Lane X1 fixes them on dev seeds 1-3 before the scored X6 seeds run.

## 1. On-chain: FreezeModule

Contracts in `FreezeModule.sol`:
- `FreezeStorage` (ERC-7201 `hypnexis.AgentAccount.freeze`, append-only).
- `FreezeTripwires`: an **external linked library**. Its functions run by DELEGATECALL on the account's storage.
  - `forge test` and `forge script` link it automatically.
  - A TS/viem deployer must deploy `FreezeTripwires` first, then put its address into `AgentAccount`'s bytecode at the `linkReferences` offsets. `services/watcher/test/anvil.test.ts` shows how (`link()`).
- `FreezeModule`: the core hooks.
- `FreezeAdmin`: compiled into `AgentAccountAdmin`.

### 1.1 Tripwires

Every window is a "clock-hour pair": the current clock hour (`timestamp / 3600`) plus the previous one.
- Every rolling 1 h window that ends now lies inside the pair, so no rolling-1 h breach escapes.
- The pair can over-count, by up to a 2 h span.

| Id | Where | Trips when | Default |
|---|---|---|---|
| T4 canary | inner frame, before the call | the op's target, its payee (if any) or its selector is an owner-set canary | none set |
| T2 new-payee spray | inner frame, before the call | distinct unproven payees (`Track.EXPLORE`) in the pair > `sprayMax`. A payee is counted at most once per clock hour. | 5 (the 6th trips) |
| T1 velocity | inner frame, after metering | one asset's measured outflow in the pair > `velocityBps` x (`burst + ratePerDay` of its global cap) / 10,000 | 4000 bps. Under the demo cap: above 8 USDC. |
| T3 strike streak | outer frame | blocked ops (any policy breach or tripwire) in the pair, counting only those since the last unfreeze, >= `strikeMax` | 3 (the 3rd freezes) |

How a trip plays out:
- A tripped T1, T2 or T4 reverts the inner frame with `TripwireTripped(stage)`, where stage 0 = before the call and 1 = after. The spend is undone.
- The outer frame then freezes the key and emits `AgentFrozen(key, account, userOpHash)` and `PolicyBlocked`.

Scope rules:
- T1 and T2 ignore `Track.APPROVAL` ops, because the owner signed their outflow.
- T1 ignores assets that have no global cap.
- A `velocityBps` >= 10,000 never trips.

### 1.2 Validation

- A frozen key gets reason `FROZEN` (19) in `validateUserOp`, `checkUserOp`, `policyCheck` and the execution re-check. A second op from the same key in the same bundle is therefore blocked in execution.
- Invariant I13 (`contracts/test/unit/M10_I13.t.sol`): while a key is frozen, no agent op from it validates until the owner unfreezes it.

### 1.3 Admin functions (called on the account address)

| Function | Who | Notes |
|---|---|---|
| `freeze(address agentKey)` | owner or watcher | escalate-only; emits `AgentFrozen(key, msg.sender, 0)` |
| `unfreeze(address agentKey)` | owner (or an owner op) | clears the freeze and the strikes, which also resets the T3 streak; emits `AgentUnfrozen` |
| `setWatcher(address w)` | owner | refuses a live agent key; `setPolicy` refuses the watcher as a key |
| `setFreezeParam(bytes32 key, uint256 value)` | owner | T4 canaries and the T1-T3 thresholds; emits `FreezeParamSet(bytes32 indexed key, uint256 value)` |
| `freezeParam(bytes32 key) view returns (uint256)` | anyone | the raw value (0 = unset) |
| `isFrozen(key)`, `strikes(key)`, `watcher()` | anyone | `strikes` = blocked ops since the last unfreeze |

Parameter keys for `setFreezeParam` (one setter keeps `AgentAccountAdmin` under EIP-170):

| Key | Meaning |
|---|---|
| `bytes32(uint256(uint160(addr)))` (right-aligned) | canary target or payee; value != 0 = on |
| `bytes32(bytes4 selector)` (left-aligned) | canary selector. Key `0x00..00` = selector `0x00000000`, i.e. any plain native-value send. |
| `keccak256("hypnexis.freeze.velocityBps")` | T1 threshold in bps (0 = 4000) |
| `keccak256("hypnexis.freeze.sprayMax")` | T2 threshold (0 = 5) |
| `keccak256("hypnexis.freeze.strikeMax")` | T3 threshold (0 = 3) |

A canary fires only on ops that pass validation. So plant canary payees that the policy can reach through a PAYEE rule (for example, a fake "refund wallet" in the agent's context), or canary selectors that the policy allows but legit flows never use.

### 1.4 Bytes

The fill minus the M1 stub, measured in the same private tree copy:
- core: +422 B;
- admin: +309 B;
- `FreezeTripwires`: 2,276 B runtime, deployed on its own.

## 2. Watcher service

Run it with `pnpm --filter @hypnexis/watcher start`. Run the tests with `pnpm --filter @hypnexis/watcher test` (node:test + tsx; no new dependencies).

### 2.1 Detectors (`src/detectors.ts`, `DEFAULT_CONFIG`)

| Detector | Input | Alarm | Default |
|---|---|---|---|
| `spend_cusum` | Spend comes from `Decision` outflows (not `Track.APPROVAL`). Per (key, asset), binned. Each bin's x = spend / (`burst + ratePerDay`). | One-sided Page CUSUM: S = max(0, S + x - k * bin / 86400) > h | bin 300 s, k 4 (drains 4x the cap's sustainable rate), h 0.3 of the daily cap. Demo: 6.3 USDC within 5 minutes, 7.7 within 30 minutes. |
| `revert_streak` | Outcome stream: `Decision` = ok. `PolicyBlocked` = failure. `UserOperationEvent.success = false` = failure, with the key taken from the nonce. | consecutive failures >= `streakMax` | 4 |
| `revert_cusum` | same outcome stream | TRACE's default-risk Bernoulli CUSUM, ported verbatim (K 0.625), > `cusumH` | 4.2. Fires after 7 straight failures, or on a sustained failure rate of 37.5% or more. |
| `approval_rate` | `POST /v1/approval-requests` | more than `max` requests in `windowSeconds` | 6 per 3600 s (the 7th alarms) |

Alarm behaviour:
- Each detector alarms once per key until `AgentUnfrozen`, which resets every detector of that key.
- Alarms keep being reported after a freeze, so that X6 can time each detector separately.

Offline use (the X6 runner): `replay(events, capOf, overrides) -> alarms with event indices`.

### 2.2 Freeze path

When a key alarms and is not yet frozen, `FreezeSender.ensureFrozen` does the following:
1. Checks that `watcher()` on that account is this key. If not, the result is `skipped`.
2. Checks `isFrozen`. If the key is already frozen, the result is `already`.
3. Sends `freeze(agentKey)` and waits for the receipt.

Other behaviour:
- Only one send is in flight per (account, key).
- Errors are retried on the next poll.
- There is no unfreeze code path anywhere in the service.

### 2.3 HTTP (default port 8790)

| Endpoint | Request | Response |
|---|---|---|
| `GET /health` | | `{ ok, service: "watcher", watcher, chainId }` |
| `GET /v1/state` | | `{ accounts: {account: {key: {spend, streak, traceCusum, approvals, alarmed, frozen}}}, watched, alarms: [...] }` |
| `POST /v1/approval-requests` | `{ account, agentKey, ts? }` | `{ accepted: true, alarms: [{agentKey, detector, ts, value, threshold, detail, freeze}] }` |

### 2.4 Env

| Variable | Meaning |
|---|---|
| `WATCHER_PRIVATE_KEY` | the watcher key; it must not be an agent key (checked against `AGENT_ADDRESSES`) |
| `RPC_URL`, `CHAIN_ID` | chain; `CHAIN_ID` defaults to 31337 |
| `WATCHER_ACCOUNTS` | comma list of accounts to watch |
| `ENTRYPOINT` | defaults to v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` |
| `WATCHER_PORT` | HTTP port |
| `POLL_MS` | poll interval |
| `FROM_BLOCK` | first block to read |
| `WATCHER_CONFIG` | JSON override of `DEFAULT_CONFIG` |
| `WATCHER_CAPS` | JSON `{asset: cap}`; without it the cap is read from `globalBucket` |
