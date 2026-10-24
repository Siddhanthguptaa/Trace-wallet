# Hypnexis W3-02 Agent Wallet (backend)

**Hypnotize the agent; the wallet stays awake.**

An ERC-4337 account whose agent key can only spend inside the owner's policy, even if the key leaks
or the agent is prompt-injected. Backend only: contracts, services, agent/attack harness, simulator.

The security story does not lean on the model. We assume the agent is fully hijacked and ask what the
wallet still guarantees: **contain** it with caps that hold with no detector at all, **detect** it with
on-chain tripwires and an escalate-only watcher, **recover** with three of five guardians after a delay
the owner can veto. "Limits bound how much; the payee tiers bound who."

## What it is

- **One door.** `isValidSignature` refuses the agent key, so EIP-3009 / EIP-2612 / Permit2 side doors do
  not open; x402 payments go through pre-registered, already-debited vouchers.
- **Meter the effect, sign the outcome.** Execution measures balance and allowance deltas and debits
  token buckets (burst plus 24 h refill equal the cap, so any 24 h window is at most the cap). Out-of-policy
  requests need an owner signature over target, payee and maximum outflow, not over the agent's words.
- **Two payee tracks.** Owner-listed and attested payees use the normal caps; everyone else shares one
  small account-wide exploration budget. A static allowlist blocks every legit newcomer; this does not.
- **Contain, detect, recover.** Execution runs in a sandbox so a freeze persists while the breaching spend
  is undone; a watcher can only freeze, never unfreeze; recovery needs three of five guardians, 48 hours,
  and no owner veto, and never moves funds.
- **Sponsored gas that spam cannot drain.** A staked paymaster gives each registered agent its own quota.

## Architecture

```
 owner key ---- signs ---> UserOp (owner role)      agent key (may be leaked) ---> UserOp (agent role)
                               \                          /          [tools pre-check is optional]
                                v                        v
                         EntryPoint v0.8  ---- validateUserOp / executeUserOp ---->  AgentAccount
                                                                                    (EIP-1167 clone)
   validation (no clock)                         execution sandbox (inner frame, block.timestamp)
   +--------------------------------+            +----------------------------------------------+
   | PolicyCheck: target, selector, |            | Meter (D2): snapshot -> call -> measured     |
   |   argument rules, expiry,      |  ------>   |   balance + allowance deltas -> buckets      |
   |   nonce lanes, gas caps        |            | Approval: owner OutcomeApproval, maxOutflow  |
   | PayeeTier (D3): listed |       |            | Freeze: tripwires T1-T4, strikes -> freeze   |
   |   attested PROVEN | unproven   |            |   (breach reverts the inner frame; the       |
   | OneDoor (D1): 1271 owner-only, |            |    outer frame records it and returns)       |
   |   x402 vouchers                |            +----------------------------------------------+
   +--------------------------------+
   admin side (delegatecall): policy setters, RecoveryModule (3-of-5, 48 h, owner veto), freeze admin

 services:  attestor (signs payee tiers, flags)   approval (simulates, relays owner-signed approvals)
            watcher (CUSUM, revert streak, approval rate -> freeze only)   AgentPaymaster (per-agent quota)
 agent:     HTTP tools, scripted raw-key shooter, LLM shooter (Ollama), hijack scenarios H1-H9, workloads L1-L4
 sim:       TRACE simulator fork, X4 exploration-budget sweep
```

## Requirement checklist

Names in backticks are real tests, checked by `tools/check_claims.py`. The full attack-by-attack map is in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

| Requirement | Where it is proven |
|---|---|
| **Phase 1** ERC-4337 smart-contract wallet | `test_owner_userOpExecutes`, `test_owner_adminViaUserOp` |
| Agent key spends only within an owner-defined policy | `test_agent_legitTicketBuy`, `test_agent_payListedRecipient` |
| Allowed contracts and functions | `test_agent_noRuleIsTarget`, `test_agent_executeSelectorRefused` |
| Per-transaction limits | `test_agent_perTxEarlyReject`, `test_checkPolicy_PER_TX` |
| Daily limits | `testFuzz_bucketWindow`, `invariant_I1_keyOutflowWindow`, `invariant_I5_globalOutflowWindow` |
| Allowed recipients | `test_argRule_inRecipients`, `test_agent_unlistedPayeeRefused` |
| Permission expiry | `test_expiry_validationDataWindow`, `test_expiry_notYetValid` |
| Owner approval outside the policy | `test_approval_withinMax`, `test_approval_overMaxOutflowByOneUnit`, `test_approval_tamperedRevertsInExecution` |
| Correct signatures, nonces and chain ids | `test_wrongChain_agentOpRefused`, `test_replayedNonce_refused`, `test_nonceKey_otherSessionAndLane`, `test_wrongEntryPoint_hashAndCaller` |
| Policies expressed precisely | `test_setPolicy_bareMovingSelectorRefused`, `test_setPolicy_payeeSlotsOnly`, `test_checkPolicy_OK` |
| Holds if the key leaks or the agent is manipulated | the attack cards (`Card_x402_side_door`, `Card_approve_max`, `Card_greedy_merchant`) and the hijack scenarios, results below |
| Any open model or a scripted bot | scripted raw-key shooter and an Ollama LLM shooter drive the same HTTP tools |
| **Phase 2** Script 5+ hijack attacks; losses never exceed the daily limit | nine scenarios H1-H9 in [docs/x6_report.md](docs/x6_report.md); `invariant_I11_agentMovesStayInPolicy` |
| Freeze automatically on unusual spending; report detection rate and false freezes | `test_T3_thirdStrikeFreezes`, `test_T2_sprayTripsOnSixthDistinctUnprovenPayee`, the watcher service; rates in [docs/x6_report.md](docs/x6_report.md) |
| Recover with 3 of 5 guardians after 48 hours, with an owner veto | `test_execute_threeOfFiveAfterDelay`, `test_execute_twoOfFiveFails`, `test_veto_cancelsPending`, `invariant_I12_recoveryMovesNoFunds` |
| Sponsor gas with a per-agent quota that spam cannot drain | `test_spam_reverting_ops_exhaust_only_own_quota`, `test_second_agent_quota_unaffected`, `invariant_I14_isolation` |
| Fuzz the invariant: funds move only with a valid owner, an in-policy agent or a recovery approval | `invariant_I11_fundsMoveOnlyWithAuthority`, `invariant_I11_agentMovesStayInPolicy`, `invariant_I11_ownerChangesOnlyByRecovery` |

## Results

All figures below are read from files in `results/` by `tools/render_reports.py`; `tools/check_claims.py`
fails if any number drifts from its file. The evidence is self-graded (our own deck, scenarios and legit
workloads) and synthetic; see the limits that follow.

<!-- results:start -->
_Generated by `tools/render_reports.py`; every number below has a source marker that `tools/check_claims.py` verifies. Do not edit between the markers._

- **Contract suite:** 340 [r:results/forge_summary.json#passed] of 340 [r:results/forge_summary.json#total] Foundry tests pass, 0 [r:results/forge_summary.json#failed] fail, fork tests included. Attack cards: 50 [r:results/forge_summary_cards.json#passed] of 50 [r:results/forge_summary_cards.json#total] pass.

**X1, attack cards (13 [r:results/x1_table.json#meta.cardCount] cards on four configurations, 49 [r:results/x1_table.json#meta.cellCount] cells; full grid in `docs/x1_report.md`).** Lost to the attacker, in USDC:

| Card | R1 raw key | R2 static allowlist | R3 ours | R4 ours + payee tiers |
|---|---|---|---|---|
| `ticket_to_attacker` | 2.00 [r:results/x1_table.json#cells.41.lostBaseUnits/1000000] | 2.00 [r:results/x1_table.json#cells.42.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.43.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.44.lostBaseUnits/1000000] |
| `x402_side_door` | 10.00 [r:results/x1_table.json#cells.45.lostBaseUnits/1000000] | 10.00 [r:results/x1_table.json#cells.46.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.47.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.48.lostBaseUnits/1000000] |
| `approve_max` | 90.75 [r:results/x1_table.json#cells.0.lostBaseUnits/1000000] | 94.90 [r:results/x1_table.json#cells.1.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.2.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.3.lostBaseUnits/1000000] |
| `greedy_merchant` | 20.00 [r:results/x1_table.json#cells.13.lostBaseUnits/1000000] | 20.00 [r:results/x1_table.json#cells.14.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.15.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.16.lostBaseUnits/1000000] |
| `midnight_double_spend` | 57.25 [r:results/x1_table.json#cells.21.lostBaseUnits/1000000] | 45.10 [r:results/x1_table.json#cells.22.lostBaseUnits/1000000] | 15.10 [r:results/x1_table.json#cells.23.lostBaseUnits/1000000] | 15.25 [r:results/x1_table.json#cells.24.lostBaseUnits/1000000] |
| `multi_key_cap` | 24.00 [r:results/x1_table.json#cells.25.lostBaseUnits/1000000] | 20.00 [r:results/x1_table.json#cells.26.lostBaseUnits/1000000] | 10.00 [r:results/x1_table.json#cells.27.lostBaseUnits/1000000] | 10.00 [r:results/x1_table.json#cells.28.lostBaseUnits/1000000] |
| `sybil_payee` | 7.00 [r:results/x1_table.json#cells.37.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.38.lostBaseUnits/1000000] | 0.00 [r:results/x1_table.json#cells.39.lostBaseUnits/1000000] | 0.40 [r:results/x1_table.json#cells.40.lostBaseUnits/1000000] |
| `attestor_compromise` | n/a | n/a | n/a | 10.00 [r:results/x1_table.json#cells.4.lostBaseUnits/1000000] |

Stays inside the stated bound on every card in R3 and R4: yes. R4 blocks no legit proven payee and needs no owner approval: yes; R2 blocks 3 [r:results/x1_table.json#cells.18.legitBlocked] legit payments and R3 escalates 3 [r:results/x1_table.json#cells.19.legitNeededApproval] to the owner.
The two readers (Foundry and TypeScript) agree on 49 [r:results/x1_agreement.json#cellsCompared] cells with 0 [r:results/x1_agreement.json#disagreements] disagreements.

**X6, nine hijack scenarios against the leaked key (full report in `docs/x6_report.md`).**

- Containment: 180 [r:results/x6_detection.json#byMode.combined.overall.containment.hit] / 180 [r:results/x6_detection.json#byMode.combined.overall.containment.runs] (100.0% [r:results/x6_detection.json#byMode.combined.overall.containment.rate]; CI 97.9% [r:results/x6_detection.json#byMode.combined.overall.containment.ci95.0] to 100.0% [r:results/x6_detection.json#byMode.combined.overall.containment.ci95.1]) of runs stayed inside the stated bound; largest attacker gain 17.96 [r:results/x6_detection.json#byMode.combined.overall.maxAttackerGainBaseUnits/1000000] USDC against a daily limit of 20.00 [r:results/x6_detection.json#byMode.combined.overall.globalCap/1000000] USDC.
- With no detector at all containment is 180 [r:results/x6_detection.json#byMode.none.overall.containment.hit] / 180 [r:results/x6_detection.json#byMode.none.overall.containment.runs] (100.0% [r:results/x6_detection.json#byMode.none.overall.containment.rate]; CI 97.9% [r:results/x6_detection.json#byMode.none.overall.containment.ci95.0] to 100.0% [r:results/x6_detection.json#byMode.none.overall.containment.ci95.1]): the caps bound the loss, the detectors end the attack sooner.
- Detection (runs that reached the wallet): 116 [r:results/x6_detection.json#byMode.combined.overall.detection.hit] / 120 [r:results/x6_detection.json#byMode.combined.overall.detection.runs] (96.7% [r:results/x6_detection.json#byMode.combined.overall.detection.rate]; CI 91.7% [r:results/x6_detection.json#byMode.combined.overall.detection.ci95.0] to 98.7% [r:results/x6_detection.json#byMode.combined.overall.detection.ci95.1]). The misses are the threshold-aware slow drain.
- False freezes on legit workloads: 0 [r:results/x6_detection.json#byMode.combined.overall.falseFreeze.hit] / 80 [r:results/x6_detection.json#byMode.combined.overall.falseFreeze.runs] (0.0% [r:results/x6_detection.json#byMode.combined.overall.falseFreeze.rate]; CI 0.0% [r:results/x6_detection.json#byMode.combined.overall.falseFreeze.ci95.0] to 4.6% [r:results/x6_detection.json#byMode.combined.overall.falseFreeze.ci95.1]).
- Thresholds were fixed on dev seeds before the scored seeds ran: S2 [r:results/dev/x6_threshold_sweep.json#chosen] was pinned.

**I11, funds move only with a valid owner, an in-policy agent or a recovery approval.** 3 [r:results/forge_summary_i11.json#passed] fuzz campaigns pass; the authority campaign logged 258 [r:results/i11.json#campaigns.authority.fuzzRuns] fuzz runs: 1,379 [r:results/i11.json#campaigns.authority.ownerMoves] owner moves, 926 [r:results/i11.json#campaigns.authority.agentMoves] agent moves, 9,123 [r:results/i11.json#campaigns.authority.unauthorizedAttempts] attempts with no authority, 16 [r:results/i11.json#campaigns.authority.recoveriesExecuted] executed recoveries; forged, tampered, replayed or wrong-chain ops accepted: 0 [r:results/i11.json#campaigns.authority.forgedOrReplayedOpsAccepted].

**Recovery:** 25 [r:results/x6_recovery.json#passed] of 25 [r:results/x6_recovery.json#total] checks pass on the integrated account (three of five guardians, 172,800 [r:results/x6_recovery.json#meta.delaySeconds] second delay, owner veto, replay, funds untouched).

**Gas:** the effect meter adds 155,808 [r:results/gas_m2.json#meterOverheadGas] gas per agent op with 3 [r:results/gas_m2.json#trackedTokens] tracked tokens and 4 [r:results/gas_m2.json#trackedSpenders] tracked spenders (cold, first op).

**Paymaster quota:** 3 [r:results/m12_paymaster.json#agents] spamming agents plus a Sybil drained 0.0513 [r:results/m12_paymaster.json#depositDrainedWei/1000000000000000000] ETH from the deposit against a sum-of-quotas bound of 0.0600 [r:results/m12_paymaster.json#sumOfQuotasBoundWei/1000000000000000000] ETH; the Sybil was sponsored 0 [r:results/m12_paymaster.json#sybilSponsored] times.

**X4, simulator sweep (TRACE plus an exploration budget).** The pre-registered headline did not hold: the frontier moved for 0 [r:results/x4_h1.json#attacksMovedAtBstar] attacks, H1 = no [r:results/x4_h1.json#H1]. The pitch leads with the hard bound, not the simulator.

**End-to-end against the real account (anvil):** approval service yes [r:results/m5_approval_e2e.json#ok]; attestor service yes [r:results/m6_attestor_e2e.json#ok]; freeze and watcher yes [r:results/m10_freeze_e2e.json#ok]; paymaster yes [r:results/m12_paymaster_e2e.json#ok].
<!-- results:end -->

## Honest limits

- **Self-graded and synthetic.** The attack deck, the legit stream, R2's configuration, the hijack scenarios and
  the legit workloads are ours, published so judges can add their own. Payees and Sybils are synthetic.
- **Containment is the guarantee; detection is best effort.** With every detector off the loss bound still
  holds. A threshold-aware slow drain evades detection in some runs and is still bounded by the daily limit.
- **A compromised attestor costs up to the daily limit,** not zero, until the owner rotates it.
- **Three colluding guardians take over after the delay if the owner never vetoes,** and a thief holding the
  owner key can veto a recovery. Registered x402 vouchers survive a recovery (bounded by their caps and a
  ten-minute lifetime).
- **The velocity tripwire never fires at the pinned threshold;** on-chain freezes come from the strike streak,
  the watcher covers what the chain cannot see.
- **The effect meter costs gas** (figure above), more than the planning target; trimming tracked spenders would
  reopen approval laundering.
- **The simulator hypothesis did not hold** (X4): a budgeted exploration track did not move the frontier. The
  pitch leads with the hard bound, not the simulator.
- **The x402 facilitator is a local mock** until the user-run mainnet check (X3); the LLM shooter is a small
  open-weight model, so its hijack counts are a floor.

Details and the full list: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), [DECISIONS.md](DECISIONS.md).

## Reproduce

Everything below runs on a laptop with Node, pnpm, Foundry, Python and (for the LLM column) Ollama.

```
pnpm run bootstrap                                   # JS deps, Foundry deps, forge build
pnpm run test:all                                    # forge (no fork) + every package's tests
(cd contracts && forge test)                         # whole contract suite, fork tests included
python tools/forge_summary.py results/forge_all.json # after: forge test --json > results/forge_all.json
```

| Result | Command |
|---|---|
| I1-I14 long invariant campaigns | `cd contracts && FOUNDRY_PROFILE=invariant forge test --match-path 'test/invariant/*'`; I11 coverage: `python tools/i11_summary.py` |
| X1 attack cards, Foundry reader | `cd contracts && forge test --match-path 'test/cards/*' --json > ../results/forge_cards.json` then `python tools/x1_aggregate.py` |
| X1 attack cards, TypeScript reader | `cd agent && pnpm exec tsx src/shooter/rawkey.ts` (writes `results/x1_shooter.json`), then `python tools/x1_agree.py` |
| X1 LLM column | `cd agent && pnpm exec tsx src/shooter/llm.ts` (writes `results/x1_llm.json`; needs Ollama and the model in `.env`) |
| X6 threshold fixing (dev seeds only) | `pnpm exec tsx tools/x6_sweep.ts --apply` |
| X6 scored run, all detector modes | `pnpm exec tsx tools/x6_run.ts --seeds 42-61` (runs the four modes in parallel, then `python tools/x6_aggregate.py`) |
| X6 recovery success path | `cd agent && pnpm exec tsx hijack/recoveryFlow.ts` |
| X4 simulator sweep | `cd sim && npm run repro && npm run x4`, then `python sim/analysis/x4_analyze.py && python sim/analysis/x4_report.py` |
| Reports, README results and the claim check | `python tools/render_reports.py && python tools/check_claims.py` |
| Everything, end to end | `pnpm run demo && python tools/gate.py` |

## One command

```
pnpm run bootstrap   # JS deps, Foundry deps (contracts/lib), forge build
pnpm run demo        # starts anvil, runs tools/demo/beats/*.ts, writes results/demo_run.json
```

Checks: `pnpm run test:all && pnpm run demo && python tools/gate.py` (Gate G).

## Requirements

Node >= 22, pnpm 11, Foundry (`foundryup`; forge/anvil/cast on PATH or in `~/.foundry/bin`),
Python 3.11 (`uv sync` for the analysis deps), Ollama for the LLM shooter. Copy `.env.example` to `.env`.

## Layout

`contracts/` Foundry project, `packages/shared` config + UserOp v0.8 helpers, `services/approval`,
`services/attestor`, `services/watcher`, `agent/` (tools, shooters, hijack harness), `sim/` (standalone),
`tools/` acceptance scripts, `docs/` API, threat model and reports, `results/` every metric file (written by
code only). `python tools/toolchain.py` re-probes the toolchain and Base.
