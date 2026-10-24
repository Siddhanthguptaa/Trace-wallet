# Gateway (`@hypnexis/gateway`)

One process, port **8800**, serving every base URL the web frontend calls. Set in `web/.env.local`:

```
VITE_APPROVAL_URL=http://localhost:8800
VITE_ATTESTOR_URL=http://localhost:8800
VITE_AGENT_TOOLS_URL=http://localhost:8800
VITE_RUNNER_URL=http://localhost:8800
```

Start: `pnpm --filter @hypnexis/gateway start` (reads the repo-root `.env.live`; real env vars override).
No mocks: it reads the REAL account on chain, uses the REAL EntryPoint / USDC, and proxies the REAL
attestor (`ATTESTOR_URL`) and approval (`APPROVAL_URL`) services. The owner key is never read.

## Config (`.env.live`)
`CHAIN_ID RPC_URL ENTRYPOINT USDC ACCOUNT (or WALLET_ADDRESS) AGENT_KEY DEPLOYER_KEY (relayer) LENS APPROVAL_URL ATTESTOR_URL`
plus optional `GATEWAY_PORT (8800) GATEWAY_FROM_BLOCK GATEWAY_MAX_FEE_WEI GATEWAY_CORS HARN_FORGE_OUT (out)`.
ABIs come from `contracts/out` (run `forge build` once). `LENS` (PolicyLens) makes `check`/`pay` see bucket exhaustion.

## Routes
| Route | Backed by |
|---|---|
| `GET /health` | chain head, wallet, agent |
| `POST /tools/get_policy {wallet}` | account views: owner, 1271 mode, attestor, epoch, caps, recipients, flags (from `Flagged` logs), session keys (from `PolicySet` logs + the configured agent), rules (`rulesOf`/`ruleOf`) |
| `POST /tools/get_budget {wallet}` | key / global / explore buckets with the refill applied at chain time |
| `POST /tools/check {target,value?,data?,payee?}` | `AgentTools.check` (checkUserOp + policyCheck + PolicyLens) |
| `POST /tools/pay {wallet,to,asset,amount}` | `AgentTools.pay` with the REAL agent key, submitted by the relayer; out-of-policy ops are filed with the approval service (`status: approval_requested`, `approvalId`) |
| `POST /tools/approval_status {id}` | approval service |
| `GET /v1/requests?wallet=&status=` | approval service `GET /v1/requests?account=` mapped to `approvalSummary` |
| `GET /v1/requests/:id` | status object + `/typed-data` (EIP712Domain stripped; the frontend adds it) mapped to `approvalRequest` |
| `POST /v1/requests/:id/signature {signature}` | owner's `eth_signTypedData_v4` signature -> service `signature?wait=1` (verified against `owner()`, then relayed) |
| `POST /v1/requests/:id/decline {signature?}` | with an owner EIP-191 signature: service `reject`; without: local dismissal only (see below) |
| `GET /v1/attest?wallet=&payee=` | attestor `/v1/attest` -> `{tier,validUntil,epoch,signature}`; FLAGGED comes from the on-chain flag; otherwise `{attestation:null}` |
| `/v1/cards /v1/configs /v1/bounty /v1/results /v1/runs /v1/runs/:id/events` | mounted from `services/runner/src/app.ts` (`createRunnerApp({cfg})`); 503 until it exists |

Errors are `{ "error": "<message>" }` (the frontend reads a string). Every response is validated with
`src/wire.ts`, a byte copy of `web/src/api/schemas.ts` (a test fails if they drift).

## Status mapping (approval service -> frontend)
`pending`->`pending`, `approved`->`signed`, `executed`/`reverted`/`expired` unchanged, `rejected`->`declined`.

## Known mismatch
The frontend's `decline` posts `{}`. The real service only rejects with an owner EIP-191 signature of
`Hypnexis approval service: reject request <id>`. Without it the gateway marks the request `declined` in the
UI only; the request is still pending in the service until it expires. Fix on the frontend: sign that message
with `personal_sign` and send `{ signature }`.
