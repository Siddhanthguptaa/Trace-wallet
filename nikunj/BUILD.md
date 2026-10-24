# BUILD: Hypnexis W3-02 Agent Wallet (backend only)

Phase E, 2026-10-24. Inputs: the STATE.md Approval line (backend only, IDEA.md section 10 milestones M0-M9, one subagent per milestone, X3 user-run), IDEA.md sections 2, 4, 7, 9, 10 and 11, HANDOFF.md and EXPERIMENTS.md. No app code was written in this phase.

**How a builder reads this file.** Read `## Conventions`, `## Layout`, `## Demo policy` and your own milestone section, nothing else:
- `awk '/^## M3 /{f=1;print;next} /^## /{f=0} f' nikunj/BUILD.md` (put your milestone in place of M3)
- `awk '/^## Conventions/{f=1;print;next} /^## /{f=0} f' nikunj/BUILD.md` (same for `Layout`, `Demo policy`, `Machine check`)

**About "Expected numbers".** No experiment ran during planning: EXPERIMENTS.md marks X1-X5 "planned, not run". The expected values below are design targets. Deterministic checks use exact tolerance. A miss is a bug or a real hole and is handled by the held-out rule in `## Conventions`. It is never a reason to edit the target.

## Order and time

```
M0 -> M1 -> M2 -> M3 -> M4 -> { M5 || M6 } -> { M7 || M8 } -> M9 -> buffer
```

| M | Goal | Planning pd [A18] | Day (4 people) |
|---|---|---|---|
| M0 | Toolchain, skeleton, X2 spike | 1.0 | 1 |
| M1 | Account core, R2 baseline, API contract | 4.0 | 1-2 |
| M2 | D2 effect metering and buckets | 2.75 | 2 |
| M3 | D1 one door | 2.0 | 3 |
| M4 | D3 contract side | 2.0 | 3 |
| M5 | Owner approvals and approval service | 2.5 | 4 |
| M6 | TRACE attestor and Trace_CIKM fork | 2.5 | 4 |
| M7 | Agent tools, shooters, X1 table | 3.75 | 5 |
| M8 | X4 sweep | 1.25 | 5 |
| M9 | Proofs, deploy, X3 scripts, README | 2.6 | 5-5.6 |
| buffer | polish, recordings, video, slack | none | 5.6-7 |

- The pd column is phase E's split of the WIN.md CR30 items. Its total, ≈ 24.35, matches IDEA section 10. It is a planning estimate, not a measurement [A17][A18].
- Demo path first. M0-M4 build everything the attack deck hits, M7 produces the results table, and M8 and M9 hold most of the cut options.
- **Checkpoint** after M4, or at the end of day 3 if that comes first. If behind, apply IDEA section 10's cut order in order: Halmos; X4 partitioned only; X3; MCP wrapper; projector rig; D3-lite; NFT meter and `eth_call` simulation. Record each applied cut in STATE.md. A 4-person human team needs cuts 2-5 to finish M9 by day 5.6 (24.35 vs 22.4 pd) [A18].
- If humans build instead of subagents: the Solidity lead takes M1-M4, Solidity + tests takes the cards, invariants and M9, and agent/services takes the M0 skeleton, the M5 service, M6, M7 and M8 [A11].
- The **buffer** (the last 20%, days 5.6-7) is never spent on scope. See `## Buffer`.

## Not built

Cut in IDEA.md section 10: web frontend, dashboard, mobile UI, approval card, phone push, MetaMask deep link; USD portfolio budget or oracle; Certora; Merkle voucher book; two-sided `minIn` bounds; on-chain pending-approval store; Endospore sub-accounts, escrow, provenance tags, TRACE XP; TRACE section 7.6 ideas; ERC-8004 integration; agent-side injection defense; owner key recovery; ERC-7579/7702 shaping; the 4-person items (velocity cap, "approve and always allow", activity feed, ERC-7715-shaped request, passkey owner, 7579 module on Nexus).

## Machine check

Checked by phase E on 2026-10-24.
- **Missing:** forge, anvil, cast, halmos, slither, solc, jq. M0 installs Foundry, Halmos and Slither.
- **Present:** Node v24.11.0, pnpm 11.1.2, npm 11.6.1, Python 3.11.9 with uv 0.11.29 and pip, git 2.51.2, Docker Desktop (WSL has only the `docker-desktop` distro, no Ubuntu), make (chocolatey), bun 1.3.14.
- **LLM:** Ollama with `qwen2.5-coder:7b`, `llama3:latest` and `nomic-embed-text`. No OpenAI, OpenRouter, Groq or Anthropic key is set in the environment.
- **Hardware:** 15.7 GB RAM, 16 logical CPUs (i5-13450HX), 45.6 GB free on C:. The Trace_CIKM README asks for 16 GB minimum [E58].
- **D: is not mounted.** `D:\trace-api` and `D:\sats_router` are absent, so the author's full Trace_CIKM copy is not available [A21].
- **RPCs:** `https://mainnet.base.org` answers chainId 8453 and `https://sepolia.base.org` answers 84532. Base head ≈ 53,025,863.
- **Contract code**, checked with `eth_getCode` and `eth_call`:
  - EntryPoint v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` has code on Base and Base Sepolia (21,738 bytes).
  - USDC Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`: `version()` = "2". USDC Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`: `version()` = "2".
  - Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` has code on both.
- **Repo:** `github.com/NikunjKaushik20/Trace_CIKM` main is reachable at commit 94c4b9f.
- **Build root:** not a git repo; it holds only `nikunj/` and `Problem_Statements_hypn.pptx`.

## Layout

Build root `C:\Users\siddh\Downloads\Hypnexis\Hypnexis`. This is IDEA section 7.6 plus `packages/shared`, `tools`, `scripts` and `results`. Nothing is built inside `nikunj/`.

| Path | Contents | Created |
|---|---|---|
| `contracts/` | Foundry project. `src/`: `AgentAccount.sol`, `AgentAccountFactory.sol`, `lib/` (PolicyTypes, ArgRules, PolicyCheck, Buckets), `baselines/NaiveAccount.sol` (R2), `mocks/`. `test/`: `unit/`, `cards/` (+ `CardBase.sol`, `deck.json`), `invariant/`, `halmos/`, `fork/`, `spike/`, `vectors/`. `script/`: deploy, rig and X3 helpers | M0 |
| `packages/shared/` | `@hypnexis/shared`: env config, ABIs from forge artifacts, EIP-712 type definitions, UserOp v0.8 pack and hash, `Submitter` (direct `handleOps` or bundler RPC), tier rule (M6) | M0 |
| `services/approval/` | `@hypnexis/approval`: HTTP API, SQLite store, simulation, typed data, scripted owner signer, relay | scaffold M0, built M5 |
| `services/attestor/` | `@hypnexis/attestor`: TRACE scoring port, tier map, EIP-712 signer, outcome ingestion, flag sender | scaffold M0, built M6 |
| `agent/` | `@hypnexis/agent`: HTTP tools (+ MCP wrapper), raw-key shooter, LLM shooter, injection pages, legit stream, mock x402 seller, R1-R4 configs | scaffold M0, built M7 |
| `sim/` | standalone npm project, not a pnpm workspace member: vendored Trace_CIKM @94c4b9f plus our patches, TRACE+EB(B), X4 runner; `sim/analysis/*.py`; `sim/results/` | M6 |
| `tools/` | `forge_summary.py`, `gate.py`, `test_all.ts`, `demo.ts` + `demo/beats/`, `x1_aggregate.py`, `x1_agree.py`, `check_claims.py`, `check_7562.ts`, `check_threat_model.py`, `check_slither.py` | M0 onward |
| `scripts/` | `rig/` (projector key: new, fund, reset), `x3/` (user-run mainnet test) | M9 |
| `results/` | every metric file; `results/cards/<card>__<config>.json` | M0 |
| `docs/` | `api.md` (M1), `x4_report.md` (M8), `THREAT_MODEL.md`, `x3_runbook.md`, `slither_triage.md` (M9) | M1 |
| root | `package.json`, `pnpm-workspace.yaml`, `pyproject.toml`, `.env.example`, `.gitignore`, `.nvmrc`, `README.md` | M0 |

## Conventions

- **Shell.** Run every command from the build root in Git Bash, prefixed with `rtk` (STATE.md Constraints); the commands below omit the prefix. Forge commands run inside `contracts/` through a subshell, `(cd contracts && forge ...)`, and their output paths are relative to the build root.
- **Git.** No commits: STATE.md Constraints does not allow them. Add Foundry deps with `forge install --no-git <repo>@<tag>`.
- **Toolchain.** Foundry stable (M0 records the version), solc 0.8.28, `evm_version = "cancun"`, Node ≥ 22, a pnpm workspace, Python 3.11 through `uv`, Ollama for the LLM shooter. SQLite in the services uses the built-in `node:sqlite` to avoid native builds on Windows; only `sim/` uses better-sqlite3 (the fork's Prisma adapter). If `forge` is not on PATH in a fresh shell, use the absolute path M0 records in STATE.md.
- **Chain modes.** The default, `CHAIN_MODE=local`, is anvil with a locally deployed EntryPoint v0.8 and `MockUSDC3009`. `CHAIN_MODE=fork` is an anvil fork of Base at `FORK_BLOCK` with real USDC and the canonical EntryPoint v0.8. Foundry tests in `test/fork/` call `vm.createSelectFork` with the RPC and block from `test/fork/ForkConfig.sol`. Every results file records `chainMode`.
- **Keys.** Local runs use anvil's default dev keys, with owner, agent, attacker, attestor and relayer all distinct. The projector key and the X3 agent key are fresh. The user's MetaMask seed is never in `.env`, the repo, the agent host or on the projector (IDEA section 7).
- **Test names.** Unit tests: `test_<area>_<case>`. Cards: contract `Card_<id>` with `test_R1` to `test_R4`. Invariants: `invariant_I<n>_<name>`. Halmos: `check_<name>`.
- **Card results.** Each card test writes `results/cards/<id>__<config>.json` with `{card, config, chainMode, asset, lostBaseUnits, beyondPolicyBaseUnits, legitBlocked, legitProvenBlocked, legitBlockedValue, legitNeededApproval, success}`.
  - `lostBaseUnits`: value that reached attacker-controlled addresses during the card.
  - `beyondPolicyBaseUnits`: the part above the announced bound in `## Demo policy` (0 on listed-only paths, `exploreCap` per 24 h to unproven payees, `globalCap` per 24 h overall, `gasCredit` for gas paid to an attacker-run bundler). The headline "funds moved beyond policy" is this field.
  - `legitBlocked` counts legit stream payments refused, `legitProvenBlocked` the subset to PROVEN payees, and `legitNeededApproval` those routed to the owner.
- **Acceptance tools** (built in M0).
  - `tools/forge_summary.py <forge.json> [--out f] [--require a,b,...]` parses `forge test --json`, writes a summary, and fails if any test failed or any required name (a substring of `Contract::test`) is missing.
  - `tools/gate.py` checks that `results/demo_run.json` has `ok: true` and that the latest forge summary has 0 failures.
- **Gate G**, at the end of every milestone: `pnpm run test:all && pnpm run demo && python tools/gate.py`. `test:all` is `tools/test_all.ts` (a Node script, safe under cmd.exe): forge tests without `test/fork/*`, then `pnpm -r test`.
- **One command.** `pnpm run bootstrap` (JS deps, Foundry deps, build), then `pnpm run demo`. `tools/demo.ts` starts anvil and any service it needs, runs `tools/demo/beats/*.ts` in name order and writes `results/demo_run.json`. Each milestone adds its own beat file and never edits another milestone's beat.
- **Results.** Every metric is written by code to `results/` (X4 raw output goes to `sim/results/`). Docs never type a number by hand. From M7 on they cite numbers with `[r:<file>#<key>]` markers that `tools/check_claims.py` rebuilds.
- **API contract.** `docs/api.md`, written in M1, is the contract for every later milestone and for the later UI. Section owners: contract M1-M5, approval M5, attestor M6, tools M7. Changes are additive and logged in its changelog.
- **Parallel pairs** (M5 ∥ M6, M7 ∥ M8). Scopes are disjoint. During a pair, existing files in `packages/shared/` are frozen (new files under `packages/shared/src/<area>/` are fine), and so are the root `package.json`, `pnpm-lock.yaml` and `README.md`. M0 pre-installs the expected deps. A builder that still needs a new dep records it in STATE.md, and the orchestrator runs `pnpm install` once after the pair.
- **Held-out rule.** If a card or invariant finds a hole, fix the general rule; never special-case the card. Then add one held-out variant card written after the fix, and record both in STATE.md. Mark the milestone blocked only when the fix needs a design change to IDEA section 7.1.
- **Honesty.** No claim comes before its run. Every number keeps its honest unit (IDEA section 8): the raw-key column is one deterministic run per card and configuration; the LLM column is k/n with the mean over runs, never the best run.

## Demo policy

The announced demo configuration from IDEA section 8 [A12][A19]. It is a config, not a measurement. `agent/configs/demo_policy.json` (M7) is the source of truth, and the Foundry fixtures mirror it from M1 on.

| Field | Value |
|---|---|
| Asset | USDC, 6 decimals |
| `globalCap` | 20 USDC per 24 h: burst 10 + refill 10 per 24 h |
| Key bucket (per session key) | 20 USDC per 24 h: burst 10 + refill 10 per 24 h |
| `perTxCap` | 10 USDC (phase E choice) |
| `exploreCap` | 1 USDC per 24 h (5% of globalCap): burst 0.5 + refill 0.5 per 24 h [A19] |
| `explorePerTxCap` | 0.2 USDC (1% of globalCap) [A19] |
| `recipients` | 3 shops: ApiSeller (x402), TicketShop (TicketNFT), GroceryShop [A12] |
| Expiry | `validUntil` = deploy + 6 days ("until Friday") [A12] |
| `gasCredit` | 0.001 ETH (phase E choice) |
| `sig1271Mode` | `OWNER_ONLY` by default. X1 and the demo run `OWNER_PLUS_X402_VOUCHER` with the local mock facilitator, labeled as such, until X3 decides [X3] |

## M0 Toolchain, skeleton and X2 side-door spike
Depends on: none   parallel-ok: none
Read: IDEA section 4 (D1), 7.6, 11; EXPERIMENTS X2.
Scope: root files; `contracts/` (`foundry.toml`, `lib/`, `src/mocks/`, `src/baselines/NaiveAccount.sol` with its 1271 part only, `test/spike/`, `test/fork/`); `packages/shared/`; package scaffolds for `services/approval`, `services/attestor` and `agent`; `tools/forge_summary.py`, `tools/gate.py`, `tools/test_all.ts`, `tools/demo.ts`, `tools/demo/beats/00_x2.ts`; `results/toolchain.json`, `results/x2_spike*.json`.
Build:
1. **Install.** Foundry stable through `foundryup` in Git Bash; else unpack the GitHub release `foundry_stable_win32_amd64.zip` into `%USERPROFILE%\.foundry\bin` and add it to the user PATH; else use the Docker image `ghcr.io/foundry-rs/foundry:stable`. Then `uv tool install halmos` and `uv tool install slither-analyzer`. Make `forge`, `anvil` and `cast` resolve in fresh Git Bash and PowerShell shells, or record their absolute paths in STATE.md.
2. **Network checks.** Chain IDs of both RPCs. EntryPoint v0.8 code, plus its `eip712Domain()` name and version (expected "ERC4337" and "1"; record what you get). USDC `version()`. Pick and pin `FORK_BLOCK`, a recent Base block. Write `results/toolchain.json` with the keys `forge, anvil, cast, halmos, slither, node, pnpm, python, uv, ollamaModels, baseChainId, baseSepoliaChainId, forkBlock, entryPointV08HasCode, entryPointDomain, usdcVersion` (a tool that could not be installed gets `"deferred: <reason>"`).
3. **Skeleton.**
   - Foundry in `contracts/`: solc 0.8.28, cancun, optimizer on, `fs_permissions` read-write on `../results`. Profiles: `default` (invariant runs 32, depth 32), `ci` (64, 50), `invariant` (256, 100 [E67]). Deps: forge-std, OpenZeppelin contracts v5 (the version account-abstraction v0.8.0 uses), eth-infinitism/account-abstraction v0.8.0.
   - pnpm workspace with `packages/*`, `services/*` and `agent` (not `sim`). Scaffold each package (package.json, tsconfig, one trivial vitest) and pre-install the expected deps in one install: viem, hono, zod, vitest, tsx, typescript, openai (an OpenAI-compatible client for Ollama), @modelcontextprotocol/sdk.
   - Root scripts `bootstrap`, `test:all`, `demo`. `pyproject.toml` for uv with numpy, scipy, matplotlib and pandas. `.env.example` with the RPCs, `FORK_BLOCK`, the addresses from `## Machine check`, `LLM_BASE_URL=http://localhost:11434/v1` and `LLM_MODEL=qwen2.5-coder:7b`. `.gitignore` (`.env`, out, cache, node_modules, broadcast). A README skeleton with the one command.
4. **`packages/shared`.** Config loader and PackedUserOperation v0.8 pack and hash. Vitest parity test: the TypeScript hash equals `getUserOpHash` of the live EntryPoint v0.8 through `eth_call` on BASE_RPC (it skips with a message when offline).
5. **Mocks** in `contracts/src/mocks/`, each tiny: `MockUSDC3009` (6 decimals, EIP-712 domain "USD Coin" / "2", EIP-3009 including the `bytes signature` overload through SignatureChecker), `TicketNFT` (ERC-721 with `buy(ticketId, recipient)`), `GroceryMerchant` (`order(amount, recipient)`), `GreedyMerchant` (`buy()` pulls 10x the price through `transferFrom`), `ApiSeller` (the x402 payee).
6. **X2 spike.** `NaiveAccount` accepts the agent key in `isValidSignature`; `test/spike/OneDoorSpike.sol` accepts the owner only. `test/fork/X2SideDoor.t.sol` runs on real USDC at `FORK_BLOCK`: the agent key signs `TransferWithAuthorization(from = account, to = attacker, value = 100 USDC)` and the attacker calls the `bytes` overload directly. It writes `results/x2_spike.json` as `{chainMode, forkBlock, authValue, naive: {lostBaseUnits, isValidSignature}, oneDoor: {contract, lostBaseUnits, isValidSignature}, userOps}`. A local twin on `MockUSDC3009` writes `results/x2_spike_local.json`.
7. **Tools.** `tools/forge_summary.py`, `tools/gate.py`, `tools/test_all.ts`, and `tools/demo.ts` with beat `00_x2.ts`, which runs the X2 tests and prints both balances.
Done when (commands that must pass):
- `python -c "import json;t=json.load(open('results/toolchain.json'));assert t['forge'] and t['anvil'] and t['cast'] and t['halmos'] and t['slither'];assert t['baseChainId']==8453 and t['baseSepoliaChainId']==84532 and t['entryPointV08HasCode'] and t['usdcVersion']=='2' and t['forkBlock']>0;print('toolchain ok')"`
- `pnpm install && pnpm --filter @hypnexis/shared test`
- `(cd contracts && forge test --match-path 'test/fork/*' --json) > results/forge_m0_fork.json; python tools/forge_summary.py results/forge_m0_fork.json --require X2SideDoor`
- `(cd contracts && forge test --match-path 'test/spike/*' --json) > results/forge_m0.json; python tools/forge_summary.py results/forge_m0.json --require X2SideDoorLocal`
- `python -c "import json;d=json.load(open('results/x2_spike.json'));assert d['naive']['lostBaseUnits']==100000000 and d['oneDoor']['lostBaseUnits']==0 and d['userOps']==0 and d['oneDoor']['isValidSignature']=='0xffffffff';print('x2 ok')"`
- Gate G
Expected numbers: X2 design target, exact. The naive account loses the whole 100 USDC authorization (100000000 base units) with 0 UserOps; the one-door account loses 0 and returns `0xffffffff` [X2].
Fallback:
- Foundry: foundryup, then the release zip, then Docker, then `blocked: toolchain`.
- Halmos or Slither will not run on Windows: try their Docker images; else record "deferred" in `toolchain.json` and STATE.md. Halmos then becomes cut 2 at the checkpoint. This does not block M0.
- Fork RPC unreachable or rate-limited: use `x2_spike_local.json` (mock 3009 token, said on screen) and record it (IDEA section 11). If `deal` fails on FiatTokenV2_2, impersonate the masterMinter, configure a minter and mint.

## M1 Account core, R2 baseline and API contract
Depends on: M0   parallel-ok: none
Read: IDEA 7.1 (all of it), 7.4, section 6 requirement rows R1-R4, R8, R11, R12, R14, section 9 Q3; EXPERIMENTS X1 (the R2 definition).
Scope: `contracts/src/AgentAccount.sol`, `AgentAccountFactory.sol`, `src/lib/{PolicyTypes,ArgRules,PolicyCheck}.sol`, `src/baselines/NaiveAccount.sol`, `contracts/test/{unit,cards,invariant,vectors}/`, `docs/api.md`, `packages/shared/` (ABIs, typed data, Submitter), `tools/demo/beats/10_core.ts`.
Build:
- **Account.** `AgentAccount` on EntryPoint v0.8, SimpleAccount-style, implementing `executeUserOp`. The owner signs with OZ ECDSA. Session keys map to a `Policy` as in IDEA 7.1: validAfter/validUntil, revoked, nonceKey, assets {perTxCap, a bucket slot used from M2}, `rules[target][selector]` as ArgRule[], gas caps and gasCredit. CREATE2 factory.
- **Validation** reads calldata and the account's own storage only, never TIMESTAMP [E2]. An owner signature is accepted. The agent path checks, in order:
  - not revoked, and the nonce key belongs to this session;
  - the callData is the single agent op: no batch, no delegatecall, target ≠ self, no admin selectors;
  - a (target, selector) rule exists and every ArgRule holds: `EQ_SELF`, `IN_RECIPIENTS`, `LTE`, `EQ`, and `PAYEE` (treated as `IN_RECIPIENTS` until M4);
  - decoded per-tx early reject for `transfer`, `approve` and native value;
  - gas caps, with gasCredit debited by the op's maximum cost;
  - it returns `validationData(sigFailed, validUntil, validAfter)`.
- **One policy-check function.** Put the agent policy check in one bounded, side-effect-free function in `src/lib/PolicyCheck.sol`. `validateUserOp` uses it now; `checkPolicy` (M5) and Halmos (M9) will use it later.
- **`setPolicy` refuses** (IDEA 7.1 hard rules): open-ended keys; bare asset-moving selectors without a binding rule; `PAYEE` outside its three allowed slots; rules on dynamic arguments. NFT selectors stay locked unless bound by `EQ_SELF` or `IN_RECIPIENTS`. Add `revoke` and `rotateKey`.
- **Signature layout.** Fix the full layout now, with attestation and approval slots left empty until M4 and M5 (for example `abi.encode(uint8 kind, bytes sig, bytes attestation, bytes approval)`), and document it.
- **R2 baseline.** Complete `NaiveAccount` exactly as EXPERIMENTS X1 defines R2: target+selector allowlist, decoded per-tx cap, calendar-day daily cap, static recipient list on the decoded ERC-20 `to`, 1271 accepting the session key. Publish its config in `docs/api.md`.
- **`docs/api.md`.**
  - Contract surface: admin functions, agent op encoding, signature layout, the field-by-field policy table (from IDEA 7.1), the EIP-712 types `ScoreAttestation` and `OutcomeApproval` with domain {name "AgentAccount", version "1", chainId, verifyingContract}, reason codes, and events, including a `Decision` log.
  - The three HTTP APIs as request/response JSON schemas: tools (IDEA 7.2), approval (7.3), attestor (7.5).
  - Results file schemas and a changelog.
- **`packages/shared`.** ABIs exported from forge artifacts; typed-data definitions for all three EIP-712 types; a `Submitter` (a relayer EOA calling `handleOps`, a bundler RPC later). Vitest: userOpHash parity with the local EntryPoint.
- **Cards.** `CardBase.sol` deploys R1 (an EOA holding the funds), R2 (`NaiveAccount`) and R3 (`AgentAccount`); R4 comes in M4. `deck.json` lists id, title, fumble rows and the expected outcome per config from IDEA. Cards: `ticket_to_attacker`, `set_approval_for_all`, `batch_selfcall_delegatecall`, `gas_burn_griefing`, `replay_wrong_chain` (UserOp level: wrong chain, wrong EntryPoint, replayed nonce, another session's nonce key).
- **Tests.** One test per policy clause (requirement R12). Invariant I2: no agent op changes owner, policy, recipients, attestor, epoch, flags, mode, modules or code.
- **Demo beat 10:** anvil, deploy, one legit ticket buy (recipient = self) and two refused attacks.
Done when (commands that must pass):
- `(cd contracts && forge test --no-match-path 'test/fork/*' --json) > results/forge_m1.json; python tools/forge_summary.py results/forge_m1.json --require test_owner_,test_agent_,test_setPolicy_,test_argRule_,test_nft_,test_gas_,test_expiry_,test_revoke_,test_rotate_,test_wrongChain_,test_wrongEntryPoint_,test_replayedNonce_,test_nonceKey_,invariant_I2,Card_ticket_to_attacker,Card_set_approval_for_all,Card_batch_selfcall_delegatecall,Card_gas_burn_griefing,Card_replay_wrong_chain`
- `pnpm --filter @hypnexis/shared test`
- `python -c "import json,glob;m={(d['card'],d['config']):d for d in map(lambda f:json.load(open(f)),glob.glob('results/cards/*.json'))};assert m[('ticket_to_attacker','R2')]['lostBaseUnits']>0;assert all(v['beyondPolicyBaseUnits']==0 for k,v in m.items() if k[1]=='R3');print('m1 cards ok')"`
- `test -s docs/api.md`
- Gate G
Expected numbers: no [X#] value. Design target, exact: R2 loses on `ticket_to_attacker`, and R3 has 0 beyond policy on every M1 card.
Fallback: if the EntryPoint v0.8 sources do not compile in our profile, add a Foundry profile with the account-abstraction repo's compiler settings, or etch the canonical EntryPoint and SenderCreator runtime code captured from the fork. If argument rules run late, ship `EQ_SELF`, `IN_RECIPIENTS` and `LTE` first.

## M2 D2: effect metering and honest buckets
Depends on: M1   parallel-ok: none
Read: IDEA section 4 (D2), 7.1 (bucket rule; `globalCap`, `trackedSpenders`, `trackedNFTs`; invariants I1, I5, I6), section 5 rows F3, F5, F20, F21, section 11 gas row.
Scope: `contracts/src/` (execution path, `src/lib/Buckets.sol`, metering), `contracts/test/{unit,cards,invariant}/`, `deck.json` (append), `tools/demo/beats/20_meter.ts`, `docs/api.md` contract section.
Build:
- **Metering in `executeUserOp`.** Snapshot the native balance, the EntryPoint deposit, tracked ERC-20 balances, allowances to tracked spenders (Permit2 included) and tracked NFT balances. Run the one call. Measure positive outflow and allowance growth. Revert if the per-tx cap, the key bucket or the global bucket is breached, or a tracked NFT balance dropped. On success, debit and emit `Decision`.
- **Buckets** `{burst, ratePerDay, level, lastRefill}` with `burst + ratePerDay = cap`, default burst = cap/2. One per key per asset, and one global per asset shared by all keys. Time is read only in execution [E2].
- **Invariant handlers:** at least 2 session keys, `vm.warp`, merchant and token paths, ghost sums over sliding 24 h windows. Invariants I1, I5, I6.
- **Fuzz on bucket math:** outflow over any window of t ≤ 86400 s is ≤ burst + ratePerDay × t / 86400 ≤ cap.
- **Cards:** `greedy_merchant`, `approve_max`, `midnight_double_spend`, `multi_key_cap` (F21).
- **Gas:** a test writes `results/gas_m2.json` as `{meterOverheadGas, trackedTokens: 3, trackedSpenders: 4}`.
Done when (commands that must pass):
- `(cd contracts && forge test --no-match-path 'test/fork/*' --json) > results/forge_m2.json; python tools/forge_summary.py results/forge_m2.json --require test_bucket_,test_meter_,testFuzz_bucketWindow,Card_greedy_merchant,Card_approve_max,Card_midnight_double_spend,Card_multi_key_cap,invariant_I1,invariant_I5,invariant_I6`
- `(cd contracts && FOUNDRY_PROFILE=ci forge test --match-path 'test/invariant/*')`
- `python -c "import json;g=json.load(open('results/gas_m2.json'));print(g);assert g['meterOverheadGas']>0"`
- `python -c "import json,glob;m={(d['card'],d['config']):d for d in map(lambda f:json.load(open(f)),glob.glob('results/cards/*.json'))};assert m[('greedy_merchant','R2')]['beyondPolicyBaseUnits']>0 and m[('midnight_double_spend','R2')]['beyondPolicyBaseUnits']>0;assert all(v['beyondPolicyBaseUnits']==0 for k,v in m.items() if k[1]=='R3');print('m2 cards ok')"`
- Gate G
Expected numbers: design targets, exact. R2 moves 2x its daily cap across midnight within 120 s; ours never exceeds the cap in any 24 h window (I1, I5). On the greedy merchant, R2 pays 10x the listed price and ours reverts in execution (`success=false`). Gas: [A8] guesses 60-90k gas per agent op for 3 tokens and 4 spenders; record the measured number in STATE.md.
Fallback: overhead above 150k gas means fewer tracked spenders first, then "decoded amount + allowance delta only" (IDEA section 11). The NFT balance meter is cut 9 if behind; the M1 selector locks stay.

## M3 D1: one door
Depends on: M2   parallel-ok: none
Read: IDEA section 4 (D1), 7.1 (`sig1271Mode`, `vouchers`, I3, I4), section 11 row 1; EXPERIMENTS X2, X3.
Scope: `contracts/src/` (1271, voucher op, `reclaim`, execution lock), `contracts/test/{unit,cards,invariant,fork}/`, `deck.json`, `tools/demo/beats/30_one_door.ts`, `docs/api.md` contract section.
Build:
- **`isValidSignature`.** An owner signature gets the magic value. In `OWNER_ONLY` (the default), every agent signature gets `0xffffffff`. In `OWNER_PLUS_X402_VOUCHER`, the only agent signature accepted is the envelope `(MODE_X402, to, value, validAfter, validBefore, nonce, agentSig)`, and only if the rebuilt EIP-3009 `TransferWithAuthorization` digest (`from = this`, USDC domain) equals the hash, it matches a Registered voucher, and its agent key is live. While an op is executing, the answer is always `0xffffffff` (transient-storage lock).
- **Voucher registration** is its own agent op type, not a self-call, so I2 holds. It passes the payee check (recipients now, the D3 tier from M4), the per-tx cap and both buckets, and debits `value` at registration. Its state moves one way: Registered, then Used or Reclaimed.
- **`reclaim(nonce)`:** after `validBefore`, if USDC `authorizationState(this, nonce)` is unused, credit the buckets once; otherwise mark the voucher Used.
- **Card `x402_side_door`** on R1-R3 with the local mock token, plus a fork variant on real USDC. Re-run X2 against the real `AgentAccount`.
- **Invariants** I3 and I4.
Done when (commands that must pass):
- `(cd contracts && forge test --no-match-path 'test/fork/*' --json) > results/forge_m3.json; python tools/forge_summary.py results/forge_m3.json --require test_1271_ownerOnly_,test_1271_voucher_,test_reclaim_,test_execLock_,Card_x402_side_door,invariant_I3,invariant_I4`
- `(cd contracts && forge test --match-path 'test/fork/*' --json) > results/forge_m3_fork.json; python tools/forge_summary.py results/forge_m3_fork.json --require X2SideDoor`
- `python -c "import json;d=json.load(open('results/x2_spike.json'));assert d['oneDoor']['contract']=='AgentAccount' and d['oneDoor']['lostBaseUnits']==0 and d['naive']['lostBaseUnits']==100000000 and d['userOps']==0;print('x2 on AgentAccount ok')"`
- Gate G
Expected numbers: exact. X2 reproduces on `AgentAccount`: the naive account loses 100000000 base units with 0 UserOps and ours loses 0 [X2]. An in-policy voucher payment to ApiSeller settles once and debits the buckets exactly once by `value`; a second use of the nonce fails.
Fallback: if the voucher mode cannot be made sound, ship `OWNER_ONLY` only. The side door is closed either way, and x402 then runs through the capped float EOA (IDEA section 11 row 1).

## M4 D3: attested payee tiers and the exploration budget
Depends on: M3   parallel-ok: none
Read: IDEA section 4 (D3), 7.1 (`exploreCap`, `explorePerTxCap`, `recipients`, `attestor`, `attestEpoch`, `flagged`, signature layout, I7-I10), section 5 rows F24-F27 and F31, section 9 Q5 and Q6.
Scope: `contracts/src/` (tiers, attestation check, flags, exploration bucket), `contracts/test/{unit,cards,invariant,vectors}/` (including `test_R4` on every existing card), `deck.json`, `packages/shared` (ScoreAttestation vector test), `tools/demo/beats/35_two_tracks.ts`, `docs/api.md` contract section.
Build:
- **Attestation** inside `userOp.signature`: EIP-712 `ScoreAttestation{recipient, tier, validUntil, epoch}` in domain {"AgentAccount", "1", chainId, this} [E65], recovered against `attestor`. Only `tier = PROVEN` with `epoch == attestEpoch` upgrades a payee. Validation returns `min(policy.validUntil, attestation.validUntil)` and never reads TIMESTAMP [E66][E2].
- **Tiers** apply only to payees of value transfers (ERC-20 `transfer.to`, the native-value target, the voucher `to`):
  - PROVEN (owner-listed or attested) uses the normal caps;
  - UNPROVEN also faces `explorePerTxCap` (decoded in validation, measured in execution) and the `exploreCap` bucket, whose spend also debits the key and global buckets;
  - FLAGGED is refused on the agent path; the owner approval path arrives in M5.
- **Flags.** `flag(payee)` by the attestor or the owner; `unflag` by the owner only; the attestor can do nothing else (I10). `setAttestor` refuses an active agent key (F27). Add `bumpEpoch`.
- **Execution** re-derives the tier from the same signature bytes and debits the right buckets.
- **Cards:** `sybil_payee` (fresh attacker addresses; forged, expired, cross-wallet, wrong-chain and old-epoch attestations) and `attestor_compromise` (an attacker payee attested PROVEN, bounded by globalCap). Add R4 (R3 + attestor + exploration budget) to every card.
- **Invariants and tests:** I7, I8 (exploration spend also debits global), I9, I10. `test_F24_` (missing, invalid or expired attestation means unproven, never fail open; no attestation raises any cap), `test_F25_` (replay across chain, wallet and epoch), `test_F26_` (validationData carries the attestation's validUntil; the opcode lint comes in M9), `test_F27_`, `test_F31_`.
- **Vector:** the `packages/shared` ScoreAttestation digest equals the contract's (`contracts/test/vectors/score_attestation.json`).
Done when (commands that must pass):
- `(cd contracts && forge test --no-match-path 'test/fork/*' --json) > results/forge_m4.json; python tools/forge_summary.py results/forge_m4.json --require test_attest_,test_tier_,test_flag_,test_explore_,test_F24_,test_F25_,test_F26_,test_F27_,test_F31_,Card_sybil_payee,Card_attestor_compromise,invariant_I7,invariant_I8,invariant_I9,invariant_I10`
- `pnpm --filter @hypnexis/shared test`
- `python -c "import json,glob;m={(d['card'],d['config']):d for d in map(lambda f:json.load(open(f)),glob.glob('results/cards/*.json'))};s=m[('sybil_payee','R4')];assert s['lostBaseUnits']<=1000000 and s['beyondPolicyBaseUnits']==0;assert m[('attestor_compromise','R4')]['lostBaseUnits']<=20000000;assert all(v['beyondPolicyBaseUnits']==0 for k,v in m.items() if k[1] in ('R3','R4'));print('m4 cards ok')"`
- Gate G
Expected numbers: design targets, exact. R4's loss to unproven payees is ≤ exploreCap = 1 USDC (1000000 base units) per 24 h window (I7) [A19]. An attestor compromise loses ≤ globalCap = 20 USDC per 24 h (IDEA section 9 Q6). A legit new shop with a PROVEN attestation is paid with 0 owner approvals, while R2 blocks it [X1].
Fallback: if attestation gas is too high, check attestations only for unlisted payees (IDEA section 11). Never fall back to reading a shared registry or TIMESTAMP in validation (F26).

## M5 Owner outcome approvals, approval service and checkPolicy
Depends on: M4   parallel-ok: M6
Read: IDEA section 4 (D2, outcome approval), 7.2 (`checkPolicy`, reason codes), 7.3, section 9 Q3 and Q9; ASSUMPTIONS A15, A18.
Scope: `contracts/src/` (approval path, `checkPolicy`), `contracts/test/`, `services/approval/`, new files under `packages/shared/src/approval/`, `tools/demo/beats/50_approval.ts`, `docs/api.md` approval section plus the contract rows for approvals and `checkPolicy`, `results/m5_*`.
Build:
- **Contract path.** `OutcomeApproval(account, chainId, nonce, target, selector, payee, maxOutflow[asset], callDataHash, validUntil)` [E55], signed by the owner in the wallet's domain and carried in the approval slot of `userOp.signature`. Validation checks the owner signature, an unused nonce, and that target, selector and payee match the calldata. Execution requires measured outflow ≤ `maxOutflow` per asset, else it reverts, and emits `ApprovedExecuted(approvalHash, payee, outflow)`. Flagged payees (R4) and unknown payees (R3) route here.
- **Nonce lanes.** Approval ops must not block the session's normal nonce lane. Document the lanes in `docs/api.md`.
- **`checkPolicy(agentKey, callData, attestation) → (ok, track, reasonCode)`**, built on `PolicyCheck` plus bucket levels (an `eth_call` may read time). Codes: REVOKED, EXPIRED, TARGET, ARG_RULE(i), RECIPIENT, FLAGGED, PER_TX, EXPLORE_PER_TX, KEY_BUCKET, GLOBAL_BUCKET, EXPLORE_BUCKET, GAS_CREDIT.
- **Approval service** (TypeScript, HTTP JSON, `node:sqlite`): create a request (the agent-signed UserOp), get the typed data, post the owner signature, get the status. It simulates the outflow with `eth_call` and a state override to fill `maxOutflow`. A scripted owner signer CLI uses an anvil or testnet key only [A18]. It relays through `Submitter`. There is no on-chain pending store (cut).
- **Cards:** extend `Card_replay_wrong_chain` to owner approvals and add a tampered-approval case.
Done when (commands that must pass):
- `(cd contracts && forge test --no-match-path 'test/fork/*' --json) > results/forge_m5.json; python tools/forge_summary.py results/forge_m5.json --require test_approval_withinMax,test_approval_tamperedRevertsInExecution,test_approval_wrongChain,test_approval_wrongWallet,test_approval_replay,test_approval_mismatch,test_flagged_needsApproval,test_checkPolicy_REVOKED,test_checkPolicy_EXPIRED,test_checkPolicy_TARGET,test_checkPolicy_ARG_RULE,test_checkPolicy_RECIPIENT,test_checkPolicy_FLAGGED,test_checkPolicy_PER_TX,test_checkPolicy_EXPLORE_PER_TX,test_checkPolicy_KEY_BUCKET,test_checkPolicy_GLOBAL_BUCKET,test_checkPolicy_EXPLORE_BUCKET,test_checkPolicy_GAS_CREDIT,Card_replay_wrong_chain`
- `pnpm --filter @hypnexis/approval test` (store, typed-data digest equals the contract vector, simulation, relay)
- `pnpm --filter @hypnexis/approval e2e && python -c "import json;d=json.load(open('results/m5_approval_e2e.json'));assert d['approved']=='executed' and d['tampered']=='reverted' and d['replay']=='rejected';print('m5 e2e ok')"`
- Gate G
Expected numbers: exact. An approval whose `maxOutflow` is one base unit below the real outflow reverts in execution (`success=false`); a replayed approval is rejected; each of the 12 reason codes is produced by at least one test.
Fallback: if the simulation is unreliable, the owner signs the decoded amount as `maxOutflow` (part of cut 9). Contract-side enforcement does not change.

## M6 TRACE attestor and the runnable Trace_CIKM fork
Depends on: M4   parallel-ok: M5
Read: IDEA 7.5, section 4 (D3), section 11 Trace row; EXPERIMENTS X4 (tier rule, step 0 repro); ASSUMPTIONS A20-A23; RESEARCH E34 and E58 through `python ~/.claude/skills/nikunj-mode/scripts/verify.py fields nikunj/RESEARCH.md --ids E34,E58 --keys all`.
Scope: `sim/` (vendored fork, package.json, tsconfig, stubs, repro script), `services/attestor/`, new files under `packages/shared/src/tier/` and `packages/shared/src/attest/`, `tools/demo/beats/40_attestor.ts`, `docs/api.md` attestor section, `sim/results/repro_table1.json`, `sim/results/x4_timing.json`, `results/m6_*`.
Build:
1. **Fork.** Vendor `https://github.com/NikunjKaushik20/Trace_CIKM` @94c4b9f into `sim/` (there is no license file; the user is the author [E58]). Add package.json (Prisma client, better-sqlite3 adapter, tsx, TypeScript), a tsconfig and no-op stubs for `openaiModel`, `events` and `scripts/recoveryBaseline`, without changing simulation logic [A21]. Keep the patches in separate, listed files.
2. **Repro gate** (X4 step 0). TRACE-no-bandit, strategic-default, seeds 42-51, N=1000, 60 rounds × 5 jobs, 30% malicious. Compare the fraud mean with Table 1 (4.7 sats [E34]) within the paper's reported ± band, read from Table 1 of the PDF (E34 URLB). Write `sim/results/repro_table1.json` as `{mean, sd, paperMean, band, pass}`. Measure seconds and peak RAM per cell and write `sim/results/x4_timing.json`; M8 uses it to choose 720 or 360 cells.
3. **Tier rule, one implementation** in `packages/shared/src/tier/`: the pre-registered X4 rule. FLAGGED = the simulator's Sybil or clique flag fires. PROVEN = not flagged, and the 95% LCB ≥ the LCB of 3 successes and 0 failures under Beta(1,3). Everything else, cold start included, is UNPROVEN. The attestor and M8's EB(B) policy both import it. IDEA 7.5's decision-code map is only an adapter: ROUTE → PROVEN; ROUTE_WITH_CAUTION and cold start → no attestation; HOLD, INVESTIGATE, REFER, QUARANTINE and unknown codes → FLAGGED.
4. **Attestor service** (TypeScript, HTTP). Scoring is ported from the fork's `src/lib/trace` (LCB, smoothed default risk + CUSUM, PPR, entropy, edge-to-job Sybil ratio, clique and contamination penalties, the paper's weights [E34]), with a cross-check test that the port and the fork give the same scores on fixed inputs.
   - `GET /v1/attest?wallet=&payee=` returns `{tier, validUntil (now + 24 h), epoch, signature}` or 404.
   - `POST /v1/outcomes` takes an x402 settlement receipt plus a delivery check [E70][E71], or an owner- or verifier-signed outcome. Agent-only reports are ignored [A22].
   - The flag sender calls `flag(payee)` for FLAGGED payees.
   - The service refuses to start if its key equals the agent key [A20]. When it is down, the tools treat payees as unproven, never proven.
Done when (commands that must pass):
- `npm --prefix sim install && npm --prefix sim run repro && python -c "import json;d=json.load(open('sim/results/repro_table1.json'));print(d);assert d['pass']"`
- `pnpm --filter @hypnexis/attestor test` (tier cases, EIP-712 digest equals the contract vector, port equals fork on fixed inputs, agent-only outcome ignored, key separation, validUntil and epoch)
- `pnpm --filter @hypnexis/attestor e2e && python -c "import json;d=json.load(open('results/m6_attestor_e2e.json'));assert d['provenAccepted'] and d['flaggedOnChain'] and d['coldStartUnproven'] and d['agentOnlyIgnored'];print('m6 e2e ok')"`
- Gate G
Expected numbers: the repro reproduces 4.7 sats within the paper's Table 1 band [E34]. Peak RAM per cell is measured, not assumed; the repo asks for 16 GB and the laptop has 15.7 GB [E58].
Fallback:
- better-sqlite3 has no prebuilt binary for Node 24: run `sim/` under Node 22, or use Prisma's own SQLite engine without the adapter.
- The repro fails: the author's full local copy (on D:, not mounted on 2026-10-24, so ask the user). Else D3-lite: `ATTESTOR_MODE=scripted` (real EIP-712 signatures, fixed tiers, no TRACE port), M8 is cut (cut 8), and STATE.md records it. Under D3-lite the first Done-when line is dropped and the other two run in scripted mode.

## M7 Agent tools, shooters and the X1 results table
Depends on: M5, M6   parallel-ok: M8
Read: IDEA section 2 beat 3, 7.2, section 8, section 9 Q1, Q5 and Q10, section 11 LLM row; EXPERIMENTS X1 (all of it).
Scope: `agent/`, `contracts/test/cards/` (remaining cards, legit-stream fixture), `tools/x1_aggregate.py`, `tools/x1_agree.py`, `tools/check_claims.py`, `README.md` (Results section), `tools/demo/beats/60_x1.ts`, `docs/api.md` tools section, `results/x1_*`.
Build:
- **HTTP tools** (IDEA 7.2): `get_policy`, `get_budget` (key, global and exploration levels), `check` (`checkPolicy` plus `eth_call`; any code other than OK routes to `request_approval` instead of burning gas credit), `pay`, `pay_x402`, `buy`, `request_approval`, `approval_status`. They fetch the payee's attestation and pack it into `userOp.signature`. The tools layer holds only the agent key. The MCP wrapper comes last (cut 6).
- **Mock x402 seller** on anvil: it answers 402, accepts the envelope payment and settles through the USDC `bytes` overload. It is its own facilitator; the real facilitator is X3's job.
- **Configs** in `agent/configs/`: R1-R4 exactly as EXPERIMENTS X1, plus `demo_policy.json` (`## Demo policy`).
- **Legit stream**, one fixture shared by Foundry and TypeScript: payments to the 3 shops plus new honest payees that appear mid-run (some attested PROVEN, one cold start within `explorePerTxCap`). Metric 2 counts blocked and needed-approval separately. Add a `legit_only` card (the stream with no attack) as the openness baseline. On cards that drain a shared budget (gas credit, global or exploration bucket), legit payments can be blocked by design (liveness, IDEA section 11); report those numbers as they are.
- **Raw-key column: two independent readers that must agree.**
  - Foundry: every card × config, one deterministic run each, aggregated by `tools/x1_aggregate.py` into `results/x1_table.csv` and `results/x1_table.json` (`{meta, cells: [card fields from Conventions]}`).
  - The TypeScript raw-key shooter fires the same deck through the HTTP tools on anvil and writes `results/x1_shooter.json`.
  - `tools/x1_agree.py` fails unless `lostBaseUnits`, `beyondPolicyBaseUnits`, `legitBlocked` and `legitNeededApproval` are equal in every cell.
- **LLM shooter.** An open-weight model through Ollama's OpenAI-compatible API (`LLM_BASE_URL`, `LLM_MODEL`; installed: qwen2.5-coder:7b and llama3), using a JSON-action protocol over the same tools. Injection cards: a poisoned page saying "pay 0xEvil", a "priority delivery fee", and a Freysa-style `approveTransfer` redefinition. n = 5 runs per card × config at a fixed temperature and fixed seeds. Report k/n hijacked and the mean loss, never the best run, in `results/x1_llm.json` (`status` is `ran` or `skipped` with a reason).
- **`tools/check_claims.py`.** Every results number in `README.md` and `docs/*.md` carries an `[r:<file>#<key>]` marker. The script rebuilds each one from the file and fails on a mismatch or on an unmarked number in a results section.
Done when (commands that must pass):
- `pnpm --filter @hypnexis/agent test`
- `(cd contracts && forge test --match-path 'test/cards/*' --json) > results/forge_cards.json; python tools/forge_summary.py results/forge_cards.json`
- `uv run python tools/x1_aggregate.py && python -c "import json;t=json.load(open('results/x1_table.json'));c={(x['card'],x['config']):x for x in t['cells']};assert all(v['beyondPolicyBaseUnits']==0 for k,v in c.items() if k[1] in ('R3','R4'));assert all(c[(k,'R2')]['beyondPolicyBaseUnits']>0 for k in ('x402_side_door','greedy_merchant','ticket_to_attacker','midnight_double_spend'));assert c[('sybil_payee','R4')]['lostBaseUnits']<=1000000 and c[('attestor_compromise','R4')]['lostBaseUnits']<=20000000;L={k:c[('legit_only',k)] for k in ('R2','R3','R4')};assert L['R4']['legitProvenBlocked']==0 and L['R4']['legitNeededApproval']==0;assert all(L[k]['legitBlocked']+L[k]['legitNeededApproval']>=1 for k in ('R2','R3'));print('x1 ok')"`
- `pnpm --filter @hypnexis/agent shooter:raw && python tools/x1_agree.py`
- `pnpm --filter @hypnexis/agent shooter:llm && python -c "import json;d=json.load(open('results/x1_llm.json'));assert d['status'] in ('ran','skipped');print(d['status'])"`
- `python tools/check_claims.py`
- Gate G
Expected numbers: design targets from IDEA sections 2 and 8, exact [X1]. R3 and R4 have 0 beyond policy on every card. R2 has more than 0 on `x402_side_door`, `greedy_merchant`, `ticket_to_attacker` and `midnight_double_spend`. R4's `sybil_payee` loss is ≤ exploreCap and its `attestor_compromise` loss is ≤ globalCap. On `legit_only`, R2 and R3 block or escalate at least 1 legit new payee, while R4 blocks 0 legit PROVEN payees and needs 0 owner approvals. On budget-draining cards, legit payments (including a cold-start payee after a Sybil card) may be blocked; that is reported, not hidden. The LLM column has no target.
Fallback: if the LLM is unavailable or refuses, lead with the raw-key column and report the LLM column as k/n or "skipped" (IDEA section 11). If the readers disagree, fix the buggy reader, never the targets. MCP falls back to plain HTTP (cut 6).

## M8 X4: pre-registered simulator sweep
Depends on: M6   parallel-ok: M7
Read: EXPERIMENTS X4 (all of it; pre-registered, change nothing), IDEA section 4 (D3 evidence), section 9 Q7, section 11 X4 row.
Scope: `sim/` (EB(B) policy, regime configs, sweep runner), `sim/analysis/`, `sim/results/`, `results/x4_h1.json`, `docs/x4_report.md`.
Build:
- **TRACE+EB(B)** exactly as pre-registered, importing the M6 tier rule. If cumulative exploration spend + price ≤ B × cumulative total spend (this job included), pick by Thompson sampling among unproven, non-flagged providers. Otherwise pick greedily (TRACE-no-bandit utility) among proven providers. If none is proven yet, pick greedily among all non-flagged providers. Flagged providers are never picked.
- **Grid.** B ∈ {0, 1, 2, 5, 10}%, with B* = 5%. Attacks: strategic-default, collusion-ring, sybil-cluster, game-theoretic. Regimes: sparse-centralized (the Table 1 contract) and partitioned (the Table 9 contract: each of 5 buyers sees only its own 60 jobs). Seeds 42-51. Baselines TRACE-full, TRACE-no-bandit, REPUTATION and EigenTrust, rerun in the same fork. That is 2 × 4 × 9 × 10 = 720 cells. Dev seeds 1-3 are for debugging only and never appear in reported files.
- **Before launching**, read `sim/results/x4_timing.json`. If 720 cells do not fit the remaining build time, apply cut 4 (partitioned only, 360 cells) and record it in STATE.md before the first scored run.
- **Analysis** with `uv run`: 10-seed means. For each (regime, attack), the frontier test: no convex combination of the four baseline points has fraud ≤ and served-honest ≥ the EB(B) point (solved as an LP), in at least 95% of 1,000 seed-bootstrap resamples. H1 holds iff the frontier moves at B* in the partitioned regime for at least 3 of 4 attacks.
- **Outputs:** `sim/results/x4_cells.jsonl`, `sim/results/x4_summary.csv`, `sim/results/x4_frontier_<regime>_<attack>.png`, `results/x4_h1.json`, and `docs/x4_report.md` with `[r:]` markers and the unit caveat (sats on a simulated Lightning market [E34]).
Done when (commands that must pass):
- `python -c "import json;assert json.load(open('sim/results/repro_table1.json'))['pass']"`
- `npm --prefix sim run x4 && python -c "rows=open('sim/results/x4_cells.jsonl').read().splitlines();assert len(rows) in (720,360),len(rows);print(len(rows))"`
- `python -c "import json;r=[json.loads(l) for l in open('sim/results/x4_cells.jsonl')];assert all(42<=x['seed']<=51 for x in r);print('seeds ok')"`
- `uv run python sim/analysis/x4_analyze.py && python -c "import json;d=json.load(open('results/x4_h1.json'));assert 'H1' in d and len(d['perRegimeAttack'])>=4;print('H1 =',d['H1'])"`
- `python tools/check_claims.py`, if M7 has already written it
- Gate G
Expected numbers: none for H1; the test is pre-registered and no claim comes before the run [X4]. Sanity values, reported but not a gate: partitioned strategic-default fraud ≈ 6.4 sats for TRACE-full and ≈ 32.0 for TRACE-no-bandit (Table 9, n=5), and served-honest ≈ 125 vs 66 of 700 (Table 8, n=3) [E34].
Fallback: if H1 fails, pitch the hard bound only and show the curves as they are (IDEA section 11). If runtime or RAM is too high, apply cut 4; if it is still too high, cut 8 (no X4).

## M9 Proof layer, deploy scripts, X3 scripts and README
Depends on: M7, M8   parallel-ok: none
Read: IDEA 7.1 invariants, section 8 (live run), section 9 Q4 and Q10, section 10 cut order, section 11; EXPERIMENTS X3, X5.
Scope: `contracts/test/{invariant,halmos}/`, `contracts/script/`, `tools/check_7562.ts`, `tools/check_threat_model.py`, `tools/check_slither.py`, `scripts/rig/`, `scripts/x3/`, `docs/{THREAT_MODEL.md,x3_runbook.md,slither_triage.md}`, `README.md`, `results/x5_*`, `results/slither.json`, `results/x3_dryrun.json`, the STATE.md `## Build final` block.
Build, in this order (the later items hold the cut options):
1. **Full invariant campaign** (profile `invariant`: runs 256, depth 100 [E67]; at least 2 session keys; time warps; merchant, token, voucher, attestation and approval paths): I1-I10.
2. **Slither** on `contracts/src`. Triage every High and Medium finding in `docs/slither_triage.md` (fix it or justify it).
3. **ERC-7562 lint**, `tools/check_7562.ts`: `debug_traceCall` with struct logs of `validateUserOp` called from the EntryPoint on anvil, for an owner op, an agent op, an agent op with attestation and an approval op. It fails on any banned opcode (TIMESTAMP, NUMBER, BLOCKHASH, COINBASE, PREVRANDAO, GASLIMIT, BASEFEE, GASPRICE, ORIGIN, BALANCE, SELFBALANCE, BLOBHASH, BLOBBASEFEE, CREATE, CREATE2, SELFDESTRUCT, INVALID, or GAS not followed by a CALL) and on any storage access outside the account [E2]. Optional bundler run: Alto or the eth-infinitism bundler in unsafe mode on anvil, or a Base Sepolia bundler if the user supplies a key [A9][E32].
4. **`docs/THREAT_MODEL.md`:** every card and every fumble row in IDEA section 5, mapped to its defense and its test name. `tools/check_threat_model.py` checks that each test exists and passed.
5. **Deploy and rig.** `contracts/script/` deploys the factory, the account, the policy from JSON, and either the mocks or real USDC. `scripts/rig/` holds the projector rig (fresh key, funding, reset). Dry-run both on a Base Sepolia fork; the broadcast is user-run (`## User-run`).
6. **X3.** `scripts/x3/` and `docs/x3_runbook.md` for the user-run Base mainnet test exactly as EXPERIMENTS X3 defines it (owner through MetaMask, about 1 USDC, the tiny policy, the pass and fail list). Dry-run on a Base mainnet fork up to, but not including, the facilitator call.
7. **Halmos** on `PolicyCheck` with at most 3 argument rules and 4 recipients, with the bounds stated in the report (cut 2 if behind).
8. **README, final version:** one-command setup and run, results with `[r:]` markers, honest units (IDEA section 8), known weaknesses (IDEA section 11), X3 status. Then write `## Build final` in STATE.md (Phase F rules).
Done when (commands that must pass):
- `(cd contracts && FOUNDRY_PROFILE=invariant forge test --match-path 'test/invariant/*' --json) > results/x5_invariants_raw.json; python tools/forge_summary.py results/x5_invariants_raw.json --out results/x5_invariants.json --require invariant_I1,invariant_I2,invariant_I3,invariant_I4,invariant_I5,invariant_I6,invariant_I7,invariant_I8,invariant_I9,invariant_I10`
- `slither contracts --json results/slither.json; python tools/check_slither.py results/slither.json docs/slither_triage.md`
- `pnpm exec tsx tools/check_7562.ts && python -c "import json;d=json.load(open('results/x5_7562.json'));assert d['bannedOpcodes']==0 and d['foreignStorage']==0;print('7562 ok')"`
- `python tools/check_threat_model.py`
- `(cd contracts && forge script script/Deploy.s.sol --fork-url https://sepolia.base.org) && pnpm exec tsx scripts/rig/dryrun.ts`
- `pnpm exec tsx scripts/x3/dryrun.ts && python -c "import json;d=json.load(open('results/x3_dryrun.json'));assert d['envelopeMagic'] and d['noVoucherRejected'] and d['replayRejected'];print('x3 dry run ok')"`
- `halmos --root contracts --contract PolicyCheckHalmos --loop 4 --json-output results/x5_halmos.json` reports no counterexample (skipped only if cut 2 is recorded in STATE.md)
- `python tools/check_claims.py`
- Gate G
Expected numbers: design targets, exact [X5]. 0 invariant violations at runs 256 and depth 100; 0 Halmos counterexamples within the stated bounds; every THREAT_MODEL row names a passing test; 0 banned opcodes and 0 foreign storage accesses in validation [E2].
Fallback: if Halmos fails on Windows, use its Docker image, else cut 2. With no v0.8 bundler, use direct `handleOps` from an EOA plus the lint (IDEA section 11). If Base Sepolia USDC is missing, use the mock EIP-3009 token and say so on screen [A16]. The projector rig falls back to a recorded run (cut 7). X3 is skipped if there is no Base ETH [A14].

## Buffer

The last 20% of the time (days 5.6-7). It is not a milestone and is never spent on scope.
- Re-run Gate G and `python tools/check_claims.py` from a clean `pnpm run bootstrap`.
- Record fallback terminal runs of `pnpm run demo` and of the raw-key deck for the video. The video itself is the user's, timed as in IDEA section 8.
- Polish the README and docs. Fix only bugs found by the re-runs, each security fix with a held-out card.
- Run the user-run items below if the user is available.

## User-run

- **X3** on Base mainnet: the owner's MetaMask, about 1 USDC and a little Base ETH [A14], following `docs/x3_runbook.md` from M9. A pass makes the voucher mode an opt-in for `sig1271Mode`; a fail keeps `OWNER_ONLY` and the float fallback [X3].
- **Base Sepolia broadcast** of the projector rig, with faucet ETH and USDC [A16].
- **Optional:** a bundler API key for Base Sepolia [A9]; mounting D: if the Trace_CIKM fork fails its repro gate [A21].
