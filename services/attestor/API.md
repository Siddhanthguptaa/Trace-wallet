## 15. TRACE attestor service (ATT, M6): implemented contract

Owner: ATT. Code: `services/attestor` (`@hypnexis/attestor`). Shared types: `packages/shared/src/attestor/`
(`tier.ts`, `typedData.ts`; import the files directly until INT adds an `./attestor` subpath export).
This section is the implemented API and replaces the 12.3 draft where they differ (12.3 is kept
unchanged above). Copy of record: `services/attestor/API.md`.

Start: `pnpm --filter @hypnexis/attestor start`. Default base `http://127.0.0.1:8789/v1`.

### 15.1 Endpoints

| Endpoint | Request | Response |
|---|---|---|
| `GET /health` | | `{ service, ok: true, status: "ready", mode: "trace"\|"scripted", attestor, chainId }` |
| `GET /v1/attest?wallet=&payee=[&chainId=]` | `chainId` optional; must equal the attestor's | **200** `{ tier: "PROVEN", tierCode: 1, validUntil, epoch, signature, attestation, digest, wallet, payee, recipient, chainId, attestor, code: "ROUTE" }`. **404** `{ error: "no_attestation", tier: "UNPROVEN"\|"FLAGGED", code, reason, flag? }`. **400** bad address / `wrong_chain`. **503** `epoch_unavailable` (RPC down) |
| `POST /v1/outcomes` | one of the bodies in 15.3 | **200** `{ accepted: true, status: "accepted", id, payee, success, source, tier, code, flags }`. **202** `{ accepted: false, status: "ignored", reason }` (agent-only). **409** `duplicate`. **400** `rejected` + reason |
| `GET /v1/score?payee=` | | the payee's TRACE profile: `{ payee, totalJobs, successes, failures, lcb95, traceScore, riskTier, defaultProbability, scoreVolatility, cusumScore, cusumSensitive, sybilRisk, networkTrust, hardFilter, utility: {...Eq. 1 breakdown}, code, tier, reason }` |
| `POST /v1/flags/sync` | | `{ results: [{ wallet, payee, status: "sent"\|"already"\|"skipped"\|"error", txHash?, reason? }] }` |

- `attestation` is ready to drop into the agent envelope (section 4.2/4.3):
  `abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes attestorSig)`.
- `validUntil` = now + 24 h (`ATTEST_TTL_SECONDS`), capped at uint48 max. `epoch` is read from the
  wallet's `attestEpoch()` on every request; if it cannot be read the service answers 503 and never
  signs with a guessed epoch.
- Only PROVEN is ever signed (the signer refuses any other tier). Negative information goes on-chain
  through `flag(payee)`, because the agent can always omit a negative attestation.
- **Tools rule (M7):** any non-200 answer, a timeout, or the service being down means the payee is
  UNPROVEN (exploration track). Never treat a missing attestation as PROVEN [A20].

### 15.2 Tier decision (decision code, then IDEA 7.5 map)

| Condition (first match, from the TRACE router hard filters) | Code | Tier | Action |
|---|---|---|---|
| no accepted outcome for the payee (cold start) | `null` | UNPROVEN | none |
| Sybil filter: `sybilRisk > 0.5`, or `> 0.15` with any failure | QUARANTINE | FLAGGED | `flag(payee)` |
| primary CUSUM alarm (`cusumScore > 4.2`) | HOLD | FLAGGED | `flag(payee)` |
| failure rate > 30% after >= 3 jobs | INVESTIGATE | FLAGGED | `flag(payee)` |
| > 3 disputes (unreachable on this rail) | REFER | FLAGGED | `flag(payee)` |
| other router filter: TRACE score < 300, default prob > 0.55, cold_start_high_risk | ROUTE_WITH_CAUTION | UNPROVEN | none |
| `LCB95(s, f \| Beta(1,3)) >= LCB95(3, 0)` (= 0.2505) | ROUTE | PROVEN | sign |
| otherwise | ROUTE_WITH_CAUTION | UNPROVEN | none |

Unknown codes map to FLAGGED (fail closed). PROVEN always implies the pre-registered X4 rule
(`packages/shared/src/attestor/tier.ts`, a copy of `sim/hx/tierRule.ts`, checked against
`sim/hx/tier_vectors.json`). `ATTESTOR_MODE=scripted` is the D3-lite fallback: same signer and API,
fixed tiers from `SCRIPTED_TIERS`, no TRACE scoring.

Scoring: `src/trace/port.ts` ports Trace_CIKM @94c4b9f (LCB, both CUSUMs, TRACE score, default
probability, SCC/spectral/cycle/diversity/dense-subgraph Sybil risk, network trust, PPR, entropy,
contamination, Eq. 1 utility), checked equal to the vendored fork on fixed inputs
(`test/port.test.ts`). EVM adapter: one accepted outcome = one job of the payee and one trust edge
wallet -> payee; 1 volume unit = 0.01 token; round = floor(ts / `ROUND_SECONDS`, default 3600).

### 15.3 Outcome bodies (`POST /v1/outcomes`) [A22]

Off-chain EIP-712 domain: `{ name: "HypnexisAttestor", version: "1", chainId }` (no verifyingContract).

```
Outcome(address wallet,address payee,bool success,bytes32 ref,address asset,uint256 amount)
DeliveryCheck(address wallet,address payee,bytes32 txHash,uint16 httpStatus,bool schemaOk)
```

| `source` | Body | Accepted when |
|---|---|---|
| `"x402"` | `{ source, wallet, payee, asset, amount, decimals?=6, receipt: { success, transaction, network, payer }, delivery: { httpStatus, schemaOk, signature } }` | `receipt` is the facilitator's settlement response; the tx is checked on-chain (status success and an `asset` `Transfer(wallet -> payee, value >= amount)`); `payer == wallet`; the `DeliveryCheck` is signed by a key in `VERIFIER_ADDRESSES`. success = `httpStatus == 200 && schemaOk` |
| `"owner"` | `{ source, outcome: Outcome, decimals?, signature }` | signer == the wallet's on-chain `owner()` |
| `"verifier"` | `{ source, outcome: Outcome, decimals?, signature }` | signer is in `VERIFIER_ADDRESSES` |
| `"agent"` or any other signer | anything | never: **202 ignored** (`agent_only_ignored`) |

- A signature by an agent key is ignored even if that key were listed as a verifier; startup
  refuses that configuration.
- Dedup id = `ref:<wallet>:<payee>:<ref or txHash>`, so the same job reported twice (or by two
  sources using the same ref) counts once (409).
- `wallet == payee` is rejected. Without `RPC_URL`, x402 bodies are rejected (`receipt_unverifiable`).

### 15.4 Flag sender

When a payee is FLAGGED (after an accepted outcome, on `/v1/attest`, or `/v1/flags/sync`), the
service calls `flag(payee)` from the attestor key on every wallet it serves (wallets seen in
`/v1/attest` and outcomes, plus `WALLETS`). It first reads `attestor()` (skips wallets whose attestor
is someone else) and `isFlagged(payee)` (no duplicate tx), and records sent flags in SQLite. Flags
are escalate-only on-chain (only the owner can `unflag`, I10), so retries are safe.

### 15.5 Keys and config (env)

| Var | Default | Meaning |
|---|---|---|
| `ATTESTOR_PRIVATE_KEY` | required | attestor signer and `flag` sender. Must differ from every agent key: the service refuses to start otherwise [A20] |
| `AGENT_ADDRESSES`, `AGENT_PRIVATE_KEY` | empty | agent keys, for key separation and to ignore agent-signed reports |
| `VERIFIER_ADDRESSES` | empty | delivery checkers / outcome verifiers |
| `CHAIN_ID`, `RPC_URL` | 31337, none | without RPC: no epoch reads (uses `DEFAULT_EPOCH`), owners from `OWNERS` JSON, no x402, no flag txs |
| `ATTESTOR_PORT`, `ATTESTOR_DB` | 8789, `:memory:` | HTTP port; `node:sqlite` file |
| `ATTESTOR_MODE`, `SCRIPTED_TIERS` | `trace`, `{}` | `scripted` = D3-lite |
| `ATTEST_TTL_SECONDS`, `ROUND_SECONDS`, `WALLETS` | 86400, 3600, empty | |

### 15.6 Test vectors and results

- `contracts/test/vectors/score_attestation.json` (for D3): 8 signed cases (PROVEN on 31337 and 8453,
  epoch 2, a second wallet, uint48/uint64 maxima, tier-2 and tier-3 signatures that must not upgrade,
  an agent-key signature) and 4 replays (wrong chain, wrong wallet, old epoch, wrong recipient), each
  with domainSeparator, structHash, digest, signer, signature, the encoded `attestation` and
  `expectProven`. Wallets `0x5FbD...0aa3` / `0xe7f1...0512` are anvil deployer nonces 0 / 1; attestor
  = anvil key #4, agent = #1. Regenerate: `pnpm --filter @hypnexis/attestor vectors`. Every digest
  was checked against `TypedData.sol` on anvil, and the signer agrees with
  `results/m1_typed_data_vectors.json`.
- `pnpm --filter @hypnexis/attestor e2e` writes `results/m6_attestor_e2e_stub.json`
  `{target, realAccount: false, chainMode, provenAccepted, flaggedOnChain, coldStartUnproven,
  agentOnlyIgnored, ok, details}` against the TypedData.sol stub. With `E2E_TARGET_MODULE` (an
  `E2ETarget` for the real AgentAccount, INT) it writes `results/m6_attestor_e2e.json` with the same
  schema and `realAccount: true`.

Changelog: 2026-10-24 ATT (M6): first version of section 15.
