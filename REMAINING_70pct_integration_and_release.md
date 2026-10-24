# REMAINING WORK, PART 1 of 2 (about 70%): integration, demo, deploy, security review, final gate

Build root: `C:\Users\siddh\Downloads\Hypnexis\Hypnexis`. Effort is in rough working minutes (about 255 min of the ~370 min left, so about 69%). Part 2 is `REMAINING_30pct_results_and_docs.md`.

**Already DONE and verified (do not redo):** all contract modules and invariants I1-I14 (I11 authorization fuzz: `contracts/test/invariant/I11_Authorization.t.sol`, `results/i11.json`); full contract suite 340 passed incl. fork; JS suites green; scored X6 hijack run; X1 attack table, TS reader 49 cells and Foundry reader 49 cells, **0 disagreements** (`tools/x1_agree.py`); recovery flow 25/25 (`results/x6_recovery.json`).

**Currently running in the background (an "INT" fork owns items 1-6; do not duplicate; stop or wait for it first):** items 1, 2, 3, 4, 5 and 6 below were handed to it. Check `DECISIONS.md` for `[INT2]` lines before starting anything.

## Tasks

| # | Task | Min | Done when |
|---|---|---|---|
| 1 | **Run the services against the real `AgentAccount`**: attestor e2e with `E2E_TARGET_MODULE` -> `results/m6_attestor_e2e.json` (`realAccount:true`); approval service e2e incl. over-`maxOutflow`, wrong-chain, replay and tampered approvals (ApprovalLib linked) -> `results/m5_approval_e2e.json`; paymaster e2e (`setAgentPaymaster`, session gas caps cover pm verification 80k + postOp 50k, quota spam refused) -> `results/m12_paymaster_e2e.json`; watcher freeze -> owner unfreeze -> agent works again | 50 | the three result files exist and say real account |
| 2 | **Demo beats** in `tools/demo/beats/`: 10_core, 20_meter, 30_one_door, 50_approval, 55_freeze, 56_recovery (3-of-5, 48 h warp, owner veto), 57_paymaster, 58_authorization_fuzz (reads `results/i11.json`), 60_x1 and 65_x6 (read `results/x1_table.json`, `results/x6_detection.json`); `pnpm run demo` writes `results/demo_run.json` with `ok:true` | 45 | `python tools/gate.py` prints `gate ok` |
| 3 | **Deploy scripts**: `contracts/script/*.s.sol` (libs MeterLib, OneDoorLib, FreezeTripwires, ApprovalLib linked; Admin, impl, Factory, PolicyLens, AgentPaymaster) and `scripts/deploy.ts` (viem, links library placeholders, writes `deployments/<chain>.json`), tested on anvil | 35 | deploy to a fresh anvil, then a smoke op through the deployed factory |
| 4 | **X3 scripts + runbook + rig stub**: `docs/x3_runbook.md` (Base mainnet x402 payment with a contract signature, user-run, no transaction sent by the build), `scripts/rig/` stub (new key, fund, reset) | 20 | runbook reviewed; scripts dry-run on anvil |
| 5 | **Slither** over `contracts/src` -> `docs/slither_triage.md` (every finding fixed / false positive with reason / accepted). Any real finding: patch `contracts/src`, re-run the full suite, re-check core size under 24,576 B (`forge build --sizes`) | 40 | triage file complete; suite still green |
| 6 | **`docs/api.md` merges** (append only): freeze + watcher (from `services/watcher/API.md`), RecoveryModule ABI/events/errors (DECISIONS `[REC]`), AgentPaymaster, PolicyLens, ApprovalLib linking, x402 voucher TTL 600 s rule | 25 | sections present, ABI names match the contracts |
| 7 | **Final Gate G** after Part 2 re-renders: `forge test --json` (incl. fork) -> `tools/forge_summary.py`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm run demo`, `python tools/gate.py`, `python tools/check_claims.py` | 30 | everything green in one run |
| 8 | **Final log and handoff**: update the `## M...` lines in `nikunj/STATE.md`, append closing decisions to `DECISIONS.md`, write the short final summary (what passes, numbers, honest limits, what is user-run) | 10 | files updated |

Total about 255 min.

## Rules that kept the tree safe
- Default Foundry output `contracts/out` is what the services and harness read: rebuild it only once, at the end, then re-run the harness. Use `FOUNDRY_OUT=out-<name> FOUNDRY_CACHE_PATH=cache-<name>` for everything else.
- `pnpm` is not on the bash PATH; use PowerShell for pnpm commands.
- No `rm` with globs (the safety check blocks them).
- Task 7 must run after Part 2's `python tools/render_reports.py` and after the final X6 rerun finishes (see Part 2 item 1).

## User-run (not part of the build)
X3 mainnet payment (needs Base ETH and a MetaMask owner key); the projector rig on Base Sepolia.
