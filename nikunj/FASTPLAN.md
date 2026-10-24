# FASTPLAN: parallel lanes + cuts (user decision 2026-10-24)

The user said: "parallel + cuts but dont commit anything, keep everything in root, also log all key decisions and do as fast as possible".

Precedence:
- This file overrides BUILD.md's milestone **order** and the **cut items** listed below.
- Everything else in BUILD.md still applies: layout, conventions, acceptance commands, card result format and honesty rules.

## Hard rules for every lane

1. **No git.** No `git init`, no commits. Everything is built in place in the build root `C:\Users\siddh\Downloads\Hypnexis\Hypnexis`, never inside `nikunj/`.
2. **Stay in your files.** Edit only the files your lane owns (table below). If you need a change in another lane's file, append the request to DECISIONS.md and to your STATE line. Don't make the edit.
3. **Shared files are frozen during waves:** root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `README.md`, and the existing files in `packages/shared/`.
   - New files under `packages/shared/src/<your-area>/` are fine.
   - For a new dependency, append `DEP: <pkg>@<ver> for <lane>` to DECISIONS.md. The orchestrator installs it between waves.
4. **Keep the tree compiling.** Write complete, compilable file versions. Never leave a half-written Solidity file.
   - Run your own tests only: `forge test --match-path 'test/unit/M<k>_*'` or your own paths.
   - Before you mark done, a whole-tree `forge build` must pass.
   - If it fails because of another lane's file, wait about 2 minutes and retry, up to 3 times. Don't edit their file. If it still fails, report `blocked: <file>`.
5. **Separate Foundry output per lane:** prefix forge commands with `FOUNDRY_OUT=out-<lane> FOUNDRY_CACHE_PATH=cache-<lane>`.
6. **Gate G** (the full suite plus the demo) is NOT run per milestone during waves. INT runs it after the contract wave, and again at the end.
7. **STATE.md.** Edit only your own `## M...` line, using Edit. Never Write the whole file. Keep the line to 1-2 sentences.
8. **DECISIONS.md** (build root). Append every key decision as one line, using one shell append per line:

   `echo "- [$(date '+%Y-%m-%d %H:%M')] [<lane>] <decision> -- <why>" >> DECISIONS.md`

   Key decisions include: design choices, deviations from BUILD.md/IDEA.md, cuts, fallbacks taken, holes found and fixed, deps, and anything a judge or teammate would ask about.
9. Shell commands are prefixed with `rtk`.

## Cuts (from the IDEA.md section 10 cut order; logged in DECISIONS.md)

- **Halmos:** drop `x5_halmos`. The Foundry invariants carry the proof claim.
- **MCP wrapper:** plain HTTP tools only.
- **Projector rig:** `scripts/rig/` is one minimal script stub (new key, fund, reset), with no dry-run gate.
- **NFT balance meter:** dropped. NFT selector locks (argument rules) stay. I6 becomes a unit test plus an invariant that no agent op moves or approves an NFT under the demo rules.
- **X4 sparse-centralized regime:** dropped. X4 runs the partitioned regime only (4 attacks x 9 policies x 10 seeds = 360 cells). The rest of the pre-registration is unchanged.
- **Already user-run or out of scope:** X3 (scripts only), the mainnet bounty, ERC-7579/7702 shaping, frontend.

## Module architecture (M1 must create this so contract lanes can run in parallel)

`AgentAccount.sol` inherits four abstract modules. Each module:
- lives in its own file under `contracts/src/modules/`;
- uses its own ERC-7201 namespaced storage;
- ships from M1 as a compiling stub with safe defaults: proven track, no-op debits, 1271 owner-only, no approvals.

The account calls the module hooks at fixed points in `validateUserOp`, `executeUserOp` and `isValidSignature`. The modules:
- `MeterModule.sol` (M2): snapshot / measured deltas / per-tx + key + global bucket debits.
- `OneDoorModule.sol` (M3): 1271 + vouchers + the `registerVoucher` agent-path exception.
- `PayeeTierModule.sol` (M4): attestation verification, flags, the exploration bucket, tier re-derivation.
- `ApprovalModule.sol` (M5c): OutcomeApproval validation + maxOutflow post-check.

M1 implements the `lib/Buckets` math in full (burst + 24 h refill = cap), because M2-M4 all use it. M1 also writes `docs/api.md` with every interface, hook signature, event, error, reason code, the typed-data structs, and this ownership table.

## Lanes, ownership, waves

| Lane | Scope | Owns | Wave |
|---|---|---|---|
| SIM | M6 sim part (vendored Trace_CIKM fork + repro gate), then M8 (X4, partitioned only) | `sim/**`, `docs/x4_report.md` | W0, starts now |
| CORE | M1 + module stubs + docs/api.md | `contracts/src/AgentAccount*.sol`, `contracts/src/lib/**`, `contracts/src/modules/*` (stubs), `contracts/src/baselines/**`, `contracts/src/mocks/**`, `contracts/test/unit/M1_*`, `docs/api.md`, new files in `packages/shared/src/` | W1 (after M0) |
| ATT | M6 attestor part | `services/attestor/**`, `contracts/test/vectors/score_attestation.json`, `docs/api.md` attestor section (append), `packages/shared/src/attestor/**` | W1 |
| D2 | M2 | `contracts/src/modules/MeterModule.sol`, `contracts/test/unit/M2_*`, `contracts/test/invariant/M2_*` | W2 (after M1) |
| D1 | M3 | `contracts/src/modules/OneDoorModule.sol`, `contracts/test/unit/M3_*`, `contracts/test/fork/M3_*` | W2 |
| D3 | M4 | `contracts/src/modules/PayeeTierModule.sol`, `contracts/test/unit/M4_*` | W2 |
| APPC | M5 contract part (+ `checkPolicy` lens) | `contracts/src/modules/ApprovalModule.sol`, `contracts/src/lens/**`, `contracts/test/unit/M5_*` | W2 |
| APPS | M5 service part | `services/approval/**`, `docs/api.md` approval section (append), `packages/shared/src/approval/**` | W2 |
| HARN | M7 scaffold: tools, shooters, injection pages, legit stream, mock x402 seller, R1-R4 configs, X1 aggregation | `agent/**`, `tools/x1_*` | W2 |
| INT | integrate all modules; Gate G; full invariant campaign I1-I10 (I6 as above); cross-module fixes; approval + attestor end-to-end against the real account | any file (log every cross-lane edit) | W3 |
| X1 | M7 finish: run the R1-R4 results table (raw-key + LLM shooter) | `agent/**`, `results/x1_*`, `contracts/test/cards/**`, `tools/x1_*` | W4 |
| M9 | M9 minus cuts: THREAT_MODEL, Slither triage, deploy scripts, X3 scripts, rig stub, README | `docs/THREAT_MODEL.md`, `docs/x3_runbook.md`, `docs/slither_triage.md`, `scripts/**`, `contracts/script/**`, `README.md` | W4 |

The orchestrator runs `pnpm install` between waves if anything was requested, then the final Gate G and `check_claims` after W4.

## Phase 2 additions (user 2026-10-24; spec: IDEA.md section 13, EXPERIMENTS.md X6 + X5 additions, REQUIREMENTS.md P17-P22)

M1 adds the FreezeModule and RecoveryModule stubs, the execution sandbox (an inner self-call in try/catch) and the paymaster allow-check. Three new W2 lanes run in parallel with D2/D1/D3/APPC/APPS/HARN:

| Lane | Scope | Owns | Wave |
|---|---|---|---|
| FRZ (M10) | FreezeModule: tripwires T1-T4, freeze/unfreeze, watcher role; `services/watcher` (CUSUM on the spend stream + revert streak + approval spam -> freeze tx); unit tests; I13 | `contracts/src/modules/FreezeModule.sol`, `contracts/test/unit/M10_*`, `services/watcher/**` | W2 |
| REC (M11) | RecoveryModule: 5 guardians, 3-of-5, 48 h delay, owner veto, executeRecovery (revoke keys + bump epoch); unit tests; I12 | `contracts/src/modules/RecoveryModule.sol`, `contracts/test/unit/M11_*` | W2 |
| PM (M12) | AgentPaymaster: staked, per-agent quota bucket, gas-field caps, reserve in validation, refund in postOp, owner registration; spam tests; I14 | `contracts/src/paymaster/**`, `contracts/test/unit/M12_*`, `packages/shared/src/paymaster/**` | W2 |

Scope added to existing lanes:
- **HARN:** hijack scenarios H1-H8, legit workloads L1-L4, and the X6 runner skeleton (`agent/hijack/**`, `tools/x6_*`).
- **INT:** invariants I11-I14 plus Phase 2 end-to-end.
- **X1 (W4):** also runs X6 with the pre-registered thresholds and seeds.
- **M9:** THREAT_MODEL rows and README sections for Phase 2.
