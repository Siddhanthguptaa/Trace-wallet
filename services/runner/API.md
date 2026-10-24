# @hypnexis/runner: attack runner for the demo surface

`createRunnerApp(opts, { cors? }): Hono` from `src/app.ts` (the gateway mounts it at `/`, port 8800; standalone: `pnpm --filter @hypnexis/runner start`, port `RUNNER_PORT`, default 8790). Routes and payloads are exactly what `web/src/api/{endpoints,schemas,clients}.ts` expect. Errors are `{ "error": "message" }`.

| Route | Returns |
|---|---|
| `GET /health` | `{ service, ok, chainId, wallets, busy }` |
| `GET /v1/cards` | the 13 X1 cards: `{ id, title, summary, guard: D1\|D2\|D3\|core }` |
| `GET /v1/configs` | `[{ id: R1..R4, label, wallet }]`, only for wallets that are deployed |
| `GET /v1/bounty` | `{ agentPrivateKey, agentAddress, wallet, chainId }`: the LEAKED agent key (throwaway, testnet) |
| `GET /v1/results` | the `x1Table`: 13 recorded rows (Foundry reader, 49 cells, each with its proving test) + 3 LLM injection rows with `runs {k,n}` + `metric2` (legit stream) |
| `POST /v1/runs` | body `{ cardId, shooter?: "raw"\|"llm", configs? }` -> `{ runId }`; `409` while another run is active |
| `GET /v1/runs/:id/events` | SSE, default `message` events: `attempt`, `log`, `done` (the frontend's `runEvent` union) |

## What a run does

The leaked key signs; the relayer EOA (the attacker's bundler) submits `EntryPoint.handleOps` (R2/R3/R4) or the leaked key sends a plain transaction (R1). There is **no tools pre-check**. What reached the attacker is read from balances after the receipt. Outcome: `lost` (more than the stated bound), `bounded` (something moved, inside the bound), `refused` (nothing moved, with the wallet's own reason code: `RECIPIENT`, `OP_SHAPE`, `EXPLORE_PER_TX`, `SIG_1271`, `ALLOWLIST`, ...), `paid` (an honest payment), `pending` (not run, with the reason in `note`).

| Card | Live? | Notes |
|---|---|---|
| `legit_only` | live | pays the listed merchant and a brand-new payee (0.01 and 0.05 USDC) |
| `x402_side_door` | live | EIP-3009 signed by the leaked key straight at the token (+ the one-door envelope on R3/R4) |
| `approve_max` | live | `approve(attacker, MAX)`, then the pull; the allowance is revoked afterwards on R1/R2 |
| `batch_selfcall_delegatecall` | live | batch, execute, self-call, op kind 2, `withdrawTo`, direct transfer |
| `gas_burn_griefing` | live | the attacker is the bundler beneficiary; ops run out of call gas in execution; bound = gas credit read before |
| `sybil_payee` | live | forged attestations (attacker-signed, expired, other wallet, other chain), then a spray of fresh payees; bound = exploration cap |
| `attestor_compromise` | live (R4) | attacker payee forged PROVEN with the attestor key; bound = daily limit |
| `ticket_to_attacker`, `set_approval_for_all` | recorded only | need a shop / NFT the live policy does not list |
| `replay_wrong_chain` | recorded only | needs an owner-signed UserOp; the owner key stays in MetaMask |
| `greedy_merchant` | recorded only | needs a merchant the owner listed plus a standing allowance |
| `midnight_double_spend`, `multi_key_cap` | recorded only | need a clock (UTC midnight, 24 h refill) and three session keys |

Recorded-only cards, and `shooter: "llm"`, emit one `pending` attempt per wallet whose `note` says the result is recorded and cannot be replayed live, plus a `log` line with the recorded cell. They never fake a live result. A frozen agent key (tripwires) or an exhausted gas credit also yields `pending` with the reason: the owner must unfreeze or refill in MetaMask.

## Safety

Refuses to start unless `chainId` is 84532 or 31337 (8453 only with `ALLOW_MAINNET=1`, with a warning). One run at a time. Each attack is capped at `maxAttack` (default 1 USDC) and at the wallet's balance.

## Configuration (`loadRunnerOptions`)

From `.env.live` (override the file name with `RUNNER_ENV_FILE`) and the process env: `CHAIN_ID`, `RPC_URL`, `USDC`, `ENTRYPOINT`, `AGENT_KEY` (leaked), `DEPLOYER_KEY` (relayer), `ATTACKER_KEY` or `ATTACKER_ADDRESS` (receiver; falls back to the relayer), `ATTESTOR_KEY`, `MERCHANT_ADDRESS`, `ACCOUNT` (-> R4 when no `live.wallets`), `ALLOW_MAINNET`.

`deployments/<chainId>.json`:

```json
{ "live": { "wallets": { "R1": {"address": "0x..", "kind": "eoa"}, "R2": {"address": "0x..", "kind": "naive"},
                         "R3": {"address": "0x..", "kind": "agent"}, "R4": {"address": "0x..", "kind": "agent"} },
            "merchant": "0x.." } }
```

R1 is the agent EOA itself (it holds USDC and a little ETH); R2 a `NaiveAccount`; R3 an `AgentAccount` with exploration off and no attestor; R4 an `AgentAccount` with the attestor and exploration on. All four are driven by the same leaked key. Artifacts (EntryPoint, AgentAccount, AgentAccountAdmin ABIs) are read from `contracts/out`.
