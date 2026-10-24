# Threat model: an ERC-4337 wallet for an agent that may already be hijacked

The wallet assumes the worst about the agent: its key may leak, a web page may rewrite its instructions, the model may be fooled. The policy has to hold anyway, and when it cannot prevent a loss it has to bound it, notice it, and let the owner recover. This document says what is defended, by which mechanism, and which test proves it. Every `test_*`, `invariant_*` and `Card_*` name below is checked by `python tools/check_claims.py` against the repository, and every quoted result carries a marker into a results file.

## 1. Assets and the stated bounds

| Asset | Bound when the agent is fully hijacked | Mechanism | Proven by |
|---|---|---|---|
| Funds in the account (per asset) | Total agent outflow in any 24 h window is at most the daily limit (the global cap: burst 10 plus 10 per day for the demo USDC policy). All keys together, both payee tracks. | Token buckets with burst plus 24 h refill equal to the cap, debited from measured balance and allowance deltas | `invariant_I5_globalOutflowWindow`, `invariant_I1_keyOutflowWindow`, `testFuzz_bucketWindow`, `invariant_I11_agentMovesStayInPolicy` |
| Funds sent to payees nobody vouched for | At most the exploration cap in any 24 h window (5% of the daily limit), at most 1% per transaction | Account-wide exploration bucket on a separate payee track | `invariant_I7`, `test_explore_perTxCapDecodedInValidation`, `test_explore_zeroCapDisablesExploration` |
| Gas / ETH | The per-agent gas credit; ops that fail validation cost nothing | Gas credit debited in validation from own storage; caps on every gas field | `test_gas_creditDebitedByMaxCost`, `test_gas_failingOpsStillCostCreditThenStop`, `test_F31_blockedAfterValidationBoundedByGasCredit` |
| Sponsored gas (paymaster deposit) | Per agent: burst plus refill quota in wei; the deposit drain is at most the sum of the quotas; an unregistered account gets nothing | Per-agent quota bucket reserved in validation, charged in postOp, owner-registered accounts only | `invariant_I14_window_bound_per_agent`, `invariant_I14_deposit_drain_le_sum_of_quotas`, `invariant_I14_sybil_never_sponsored` |
| Account control (owner key) | Changes only by the owner, or by an executed recovery with 3 of 5 distinct guardians, 48 h after the proposal, not vetoed. Recovery never moves funds. | RecoveryModule | `invariant_I12_ownerChangesOnlyByOwnerOrRecovery`, `invariant_I12_recoveryMovesNoFunds`, `invariant_I11_ownerChangesOnlyByRecovery` |
| NFTs held by the account | An agent op never lowers a tracked NFT balance or grants an operator | Selector locks plus a measured NFT balance check | `invariant_I6_noAgentNftMoveOrApprove`, `test_nft_setApprovalForAllLocked`, `test_nft_transferNeedsRule` |

Measured, not just argued: the largest attacker gain in the scored hijack runs was 17.96 [r:results/x6_detection.json#byMode.combined.overall.maxAttackerGainBaseUnits/1000000] USDC against a daily limit of 20.00 [r:results/x6_detection.json#byMode.combined.overall.globalCap/1000000] USDC, and 0.50 [r:results/x6_detection.json#byMode.combined.overall.maxUnprovenGainBaseUnits/1000000] USDC at unproven payees against an exploration cap of 1.00 [r:results/x6_detection.json#byMode.combined.overall.exploreCap/1000000] USDC (`docs/x6_report.md`).

## 2. Actors and what each can do

| Actor | Holds | Can do | Cannot do (and why) |
|---|---|---|---|
| **Leaked agent key / hijacked agent** | One session key under the owner's policy | Pay owner-listed recipients inside the per-transaction and bucket caps; pay unproven payees up to the exploration budget; waste its own gas credit | Move funds outside the caps; touch policy, owner, recipients, attestor, flags or modules (`invariant_I2_agentCannotChangeGovernance`); batch, delegatecall or call the account or the EntryPoint (`test_agent_selfAndEntryPointTargetRefused`); sign through ERC-1271 for the token's side doors (`test_1271_ownerOnly_agentAndStrangerRefused`); use another session's nonce key (`test_nonceKey_otherSessionAndLane`) |
| **Prompt-injected agent that acts through the tools** | Same key, plus the tools' pre-check | Same as above; asks the owner for approvals | Anything the leaked key cannot do. The wallet does not depend on the tools or the model: the X6 hijacks bypass the tools entirely |
| **Malicious merchant / payee** | An address the agent pays | Receive what the caps allow; pull more than advertised through an allowance | Pull beyond the cap: allowance growth is metered when granted and a pull is counted once (`test_meter_approveGrowthDebitedPullCountedOnce`, `Card_greedy_merchant`) |
| **Attestor key compromised** | The key that signs payee tiers | Upgrade an attacker payee to PROVEN, so the normal caps apply instead of the exploration budget | Raise any cap; sign UserOps; change policy; do anything after the owner rotates it (`test_F24_noAttestationRaisesAnyCap`, `test_F27_rotatedAttestorLosesAllPower`, `test_F27_attestorKeyCannotSignUserOps`). Bound: the daily limit (`Card_attestor_compromise`, scenario H9) |
| **Watcher key compromised** | The escalate-only freeze role | Freeze an agent key (a denial of service against the agent) | Unfreeze, move funds, change anything (`test_watcher_escalateOnly`, `test_unfreeze_ownerOpAndAgentCannot`; the service has no unfreeze path by construction) |
| **Thief with the owner key** | Everything the owner can do | Everything, including vetoing a recovery and resetting the guardians | Nothing is defended here; this is the assumption the guardians exist to recover from while the owner key is merely lost, not stolen (section 4) |
| **One or two guardian keys** | Guardian role | Propose a recovery and approve it | Reach the 3-of-5 quorum; execute before 48 h; override the owner's veto (`test_execute_twoOfFiveFails`, `test_execute_beforeDelayFails`, `test_veto_afterDelayBeforeExecution`, `test_propose_nonGuardianRefused`) |
| **Three or more colluding guardians** | A recovery quorum | Install a new owner 48 h after proposing, if the owner never vetoes | Execute sooner; move funds directly; avoid the veto if the owner is watching (section 4) |
| **Attacker-run bundler / gas griefer** | Can include ops and collect fees | Collect fees for ops that pass validation and revert in execution | Collect more than the gas credit (`Card_gas_burn_griefing`); drain another agent's paymaster quota (`test_second_agent_quota_unaffected`, `invariant_I14_isolation`) |
| **Sybil accounts against the paymaster** | Fresh accounts | Ask for sponsorship | Get any: only owner-registered accounts have a quota (`test_sybil_unregistered_rejected`) |
| **Anyone, with a stolen agent signature** | An EIP-3009 / EIP-2612 / Permit2 signature from the leaked key | Submit it to the token with no UserOp | Succeed: ERC-1271 refuses the agent key except for a pre-registered, already-debited voucher envelope (`test_1271_ownerOnly_sideDoorRefused`, `test_1271_ownerOnly_permitRefused`, `Card_x402_side_door`, `test_x2_sideDoor`) |

## 3. Trust assumptions

1. The owner key is held safely. Recovery covers a lost key, not a stolen one used by a thief who keeps vetoing.
2. The EntryPoint is the canonical v0.8 contract; the account binds to it and the typed UserOp hash includes chain id and EntryPoint (`test_wrongEntryPoint_hashAndCaller`).
3. The guardians are independent. Three of five collude means the account is theirs after the delay unless the owner vetoes.
4. The attestor key sits on a separate host from the agent. If it leaks, the loss is bounded by the daily limit, not zero.
5. Tokens behave like standard ERC-20 and EIP-3009 tokens; the wallet meters balance and allowance deltas, so a token that moves funds without either is out of scope.
6. Block time is honest within the bundler tolerance. Validation never reads the clock (`test_F26_validationNeverReadsTheClock`); time is read only in execution.
7. The x402 facilitator is a local mock until the user-run mainnet check (X3). No claim here depends on a real facilitator accepting a contract signature.

## 4. Known trade-offs and honest limits

- **Three colluding guardians win after 48 h if the owner never vetoes.** That is the 3-of-5 rule working as specified. The owner's veto is open at any time before execution (`test_veto_afterDelayBeforeExecution`) and a stale or bogus proposal cannot block recovery forever (`test_propose_staleReplacedAndProposerBarred`).
- **A thief holding the owner key can veto a recovery and reset the guardians.** The owner key is the root of trust; recovery does not defend against its theft while the thief keeps using it.
- **Registered x402 vouchers are not cancelled by recovery.** They are bounded by the caps they were debited from and by the 600 s voucher lifetime (`test_1271_voucher_ttlBound`), and the owner can switch the mode off (`test_1271_ownerOnly_modeOffKillsRegisteredVoucher`).
- **The velocity tripwire (T1) never fires at the pinned threshold.** The thresholds were pinned on dev seeds: the velocity trigger is 60% of the daily cap per clock-hour pair, 12 USDC, and the burst bucket is 10 USDC, so one hour cannot reach it. Every on-chain freeze in the scored runs comes from the strike streak (T3), and the watcher freezes the cases the chain cannot see. The tighter T1 settings freeze the forged-PROVEN drain after a smaller loss but false-freeze the legit onboarding stream (`docs/x6_report.md`, threshold table). The caps bound the loss; the detectors end the attack.
- **Containment needs no detector.** With every detector off, containment held in 180 [r:results/x6_detection.json#byMode.none.overall.containment.hit] of 180 [r:results/x6_detection.json#byMode.none.overall.containment.runs] hijack runs.
- **Detection is not containment.** The threshold-aware slow drain (H2) was detected in 16 [r:results/x6_detection.json#byMode.combined.detectionByScenario.H2.detection.hit] of 20 [r:results/x6_detection.json#byMode.combined.detectionByScenario.H2.detection.runs] runs by the combined detectors, and its loss stayed bounded at no more than 17.96 [r:results/x6_detection.json#byMode.combined.detectionByScenario.H2.maxLossBaseUnits/1000000] USDC. Detection by the strike streak happens only once the buckets run dry.
- **A compromised attestor costs up to the daily limit,** not the exploration cap, until the owner rotates it. The sybil spray against the honest attestor costs at most the exploration cap.
- **Gas overhead.** The effect meter adds 155,808 [r:results/gas_m2.json#meterOverheadGas] gas to an agent op with 3 tracked tokens and 4 tracked spenders (cold, first op, includes the key and global bucket debits). That is above the 150k fallback line set at planning; trimming tracked spenders would reopen approval laundering, so it was kept.
- **Self-graded, synthetic evidence.** The attack deck, the legit stream, R2's configuration and the hijack scenarios are ours and are published so judges can add cards. Payees and Sybils are synthetic. The LLM shooter uses a small open-weight model, so its hijack counts are a floor, not an estimate for frontier models.
- **The mock facilitator.** The x402 settlement in every card and workload goes through a local mock seller that is its own facilitator. The real-facilitator check is a user-run script (X3).
- **The simulator result did not hold.** The pre-registered claim that an exploration budget moves the TRACE fraud-versus-coverage frontier failed: it moved for 0 [r:results/x4_h1.json#attacksMovedAtBstar] of 4 attacks. The wallet's hard bound does not depend on it (`docs/x4_report.md`).
- **Not covered:** a token that moves funds without changing balance or allowance; a malicious EntryPoint; compromise of the owner's signing device; denial of service by a watcher key (it can freeze the agent, which the owner then unfreezes).

## 5. Attack cards (X1): defense and proof

Each card runs on R1 raw key, R2 static allowlist and caps, R3 ours without payee tiers, R4 ours with payee tiers. Foundry reader: `Card_<id>` in `contracts/test/cards/X1_Cards.t.sol`, one test per configuration (`test_R1` to `test_R4`); TypeScript reader: `agent/src/shooter/cards.ts` and `cards2.ts`. The numbers are in `docs/x1_report.md`.

| Card | Attack | Defense | Proof |
|---|---|---|---|
| `legit_only` | Openness baseline: what the defenses cost honest use | Payee tiers: listed and attested payees pay normally, cold payees inside the exploration budget | `Card_legit_only`, `test_attest_upgradesNewShopToProven`, `test_tier_unprovenTakesExplorationTrack` |
| `ticket_to_attacker` | `buy(ticketId, recipient = attacker)` at an allowed shop | Argument rule binds the recipient to the account | `Card_ticket_to_attacker`, `test_argRule_eqSelf` |
| `set_approval_for_all` | `setApprovalForAll(attacker)`, then pull the held ticket | Operator must be an owner-listed recipient; NFT selectors locked | `Card_set_approval_for_all`, `test_nft_setApprovalForAllLocked` |
| `approve_max` | `approve(attacker, MAX)`, then pull | Approval needs an `IN_RECIPIENTS` rule and an `LTE` bound; allowance growth is metered as spend | `Card_approve_max`, `test_meter_untrackedSpenderApproveMetered`, `test_setPolicy_bareMovingSelectorRefused` |
| `batch_selfcall_delegatecall` | Batch, self-call policy rewrite, direct execute, unknown op kind, EntryPoint withdrawal | The agent path is one call to a non-self, non-EntryPoint target; one op shape | `Card_batch_selfcall_delegatecall`, `test_agent_executeSelectorRefused`, `test_agent_opKindRefused`, `invariant_I2_agentCannotChangeGovernance` |
| `gas_burn_griefing` | Attacker-run bundler collects fees for ops that revert in execution | Gas caps and a gas credit debited in validation | `Card_gas_burn_griefing`, `test_gas_failingOpsStillCostCreditThenStop` |
| `replay_wrong_chain` | Replay an owner payment: same nonce, other chain, other EntryPoint, another session's nonce key | EntryPoint nonce, typed UserOp hash with chain id and EntryPoint, per-session nonce keys | `Card_replay_wrong_chain`, `test_replayedNonce_refused`, `test_wrongChain_ownerOpRefused`, `test_wrongChain_agentOpRefused`, `test_nonceKey_otherSessionAndLane` |
| `greedy_merchant` | An allowed shop pulls ten times the price | Measured balance and allowance deltas, not the advertised price | `Card_greedy_merchant`, `test_meter_ownerAllowancePullCountsInFull`, `test_meter_measuredCapsReverts` |
| `midnight_double_spend` | Spend the cap just before and after midnight | Buckets: burst plus 24 h refill equal the cap, so any 24 h window is at most the cap | `Card_midnight_double_spend`, `test_bucket_midnightNoDoubleSpend`, `test_r2_midnightHole` (R2 shows the hole) |
| `multi_key_cap` | Several session keys each spend a full daily cap | One account-wide bucket per asset shared by all keys | `Card_multi_key_cap`, `test_bucket_globalSharedAcrossKeys`, `invariant_I5_globalOutflowWindow` |
| `x402_side_door` | EIP-3009 authorization signed by the leaked key, submitted to the token | ERC-1271 refuses the agent key; only a registered voucher envelope passes | `Card_x402_side_door`, `test_1271_ownerOnly_sideDoorRefused`, `test_x2_sideDoor`, `invariant_I3_oneDoorNeverOpensWithoutVoucher` |
| `sybil_payee` | Forged, expired, cross-wallet, wrong-chain and old-epoch attestations, then a spray to fresh addresses | A payee is proven only with a valid attestation for this chain, wallet and epoch; everything else is unproven and shares the exploration budget | `Card_sybil_payee`, `test_F24_invalidAttestationIsUnproven`, `test_F25_wrongChainIsUnproven`, `test_F25_wrongWalletIsUnproven`, `test_F25_oldAndFutureEpochIsUnproven`, `invariant_I7` |
| `attestor_compromise` | The attestor key signs PROVEN for the attacker's payee | An attestation never raises a cap; bound is the daily limit; rotation bumps the epoch | `Card_attestor_compromise`, `test_F24_noAttestationRaisesAnyCap`, `test_F27_rotatedAttestorLosesAllPower` |

## 6. Hijack scenarios (X6): defense and proof

The leaked key submits straight to the bundler (`agent/hijack/scenarios/index.ts`, `paymasterSpam.ts`, `recoveryHijack.ts`). Containment, detection and false-freeze numbers per scenario and detector mode are in `docs/x6_report.md`.

| Scenario | Attack | Defense | Contract proof | Scenario record |
|---|---|---|---|---|
| H1 | Burst drain to an unproven payee | Exploration cap, then the strike streak freezes | `invariant_I7`, `test_T3_thirdStrikeFreezes`, `test_explore_I7HandlerNonVacuous` | `byMode.combined.detectionByScenario.H1` |
| H2 | Slow drain under the thresholds with a forged-PROVEN payee | Buckets bound it; detection may miss | `invariant_I5_globalOutflowWindow`, `testFuzz_bucketWindow`, `test_bucket_drainReachesCapNeverBeyond` | `byMode.combined.detectionByScenario.H2` |
| H3 | New-payee spray | Per-op exploration cap, spray tripwire, shared exploration budget | `test_T2_sprayTripsOnSixthDistinctUnprovenPayee`, `test_explore_perTxCapDecodedInValidation`, `invariant_I7` | `byMode.combined.detectionByScenario.H3` |
| H4 | Side-door signature, no UserOp | One door | `test_1271_ownerOnly_sideDoorRefused`, `test_1271_voucher_permitDigestRefused`, `test_x2_sideDoor` | `byMode.combined.detectionByScenario.H4` |
| H5 | Laundering through approvals | Approval rules plus allowance metering; ops rejected in validation leave no trace | `test_setPolicy_bareMovingSelectorRefused`, `test_meter_approveGrowthDebitedPullCountedOnce`, `test_argRule_inRecipients` | `byMode.combined.detectionByScenario.H5` |
| H6 | Gas spam against the paymaster quota, attacker as bundler | Per-agent quota, reservation in validation, postOp charge, isolation between agents | `test_spam_reverting_ops_exhaust_only_own_quota`, `test_second_agent_quota_unaffected`, `invariant_I14_isolation`, `test_depositDrain_bounded_by_sum_of_quotas` | `byMode.combined.detectionByScenario.H6` |
| H7 | Guardian takeover: two keys, early execution, veto race | 3-of-5, 48 h from the proposal, owner veto, one live proposal | `test_execute_twoOfFiveFails`, `test_execute_beforeDelayFails`, `test_veto_cancelsPending`, `invariant_I12_ownerChangesOnlyByOwnerOrRecovery` | `byMode.combined.detectionByScenario.H7` |
| H8 | Approval-request spam | Approvals are owner-signed typed data on their own nonce lane; the watcher's approval-rate detector freezes the key | `test_approval_laneEnforced`, `test_approval_doesNotWaiveRules` (watcher test: "alarms on the 7th request within an hour, not on 6 per hour") | `byMode.combined.detectionByScenario.H8` |
| H9 | Attestor key leaked too: forged-PROVEN payee, burst drain | Daily limit; per-transaction cap; freeze after the strike streak | `invariant_I5_globalOutflowWindow`, `invariant_I11_agentMovesStayInPolicy`, `test_F27_rotatedAttestorLosesAllPower` | `byMode.combined.detectionByScenario.H9` |

The recovery success path (`agent/hijack/recoveryFlow.ts`): 25 [r:results/x6_recovery.json#passed] of 25 [r:results/x6_recovery.json#total] checks pass, and `test_execute_threeOfFiveAfterDelay`, `test_execute_killsOldKeysOnUserOpPath` and `test_replay_executeOnce` prove the same at contract level.

## 7. Invariants

| # | Invariant | Test (long profile: 256 fuzz runs of depth 100 per invariant) |
|---|---|---|
| I1 | Agent outflow per asset per key in any 24 h window is at most that key's cap | `invariant_I1_keyOutflowWindow` |
| I2 | No agent op changes owner, policy, recipients, attestor, epoch, flags, mode, modules or code | `invariant_I2_agentCannotChangeGovernance`, `invariant_I2_ownerAndModeFixed` |
| I3 | `isValidSignature` never returns the magic value for an agent signature without a matching Registered voucher, and never during execution | `invariant_I3_oneDoorNeverOpensWithoutVoucher` |
| I4 | `reclaim` never credits a voucher twice or credits a Used one | `invariant_I4_reclaimCreditsAtMostOnce` |
| I5 | Total outflow per asset across all keys and both tracks in any 24 h window is at most the global cap | `invariant_I5_globalOutflowWindow` |
| I6 | A tracked NFT balance never drops on the agent path | `invariant_I6_noAgentNftMoveOrApprove` |
| I7 | Outflow to unproven payees per asset in any 24 h window is at most the exploration cap | `invariant_I7` |
| I8 | Total outflow is at most the global cap, with exploration spend also debiting the global bucket | `invariant_I8` |
| I9 | A payee is proven only if owner-listed, or attested PROVEN for this chain, wallet and epoch, inside its validity | `invariant_I9` |
| I10 | Attestor-only calls can set flags and nothing else | `invariant_I10` |
| I11 | Funds move only with a valid owner, an in-policy agent, or a recovery approval | `invariant_I11_fundsMoveOnlyWithAuthority`, `invariant_I11_agentMovesStayInPolicy`, `invariant_I11_ownerChangesOnlyByRecovery` |
| I12 | The owner changes only via the owner or an executed recovery; recovery moves no funds | `invariant_I12_ownerChangesOnlyByOwnerOrRecovery`, `invariant_I12_pendingMatchesGhost`, `invariant_I12_recoveryMovesNoFunds` |
| I13 | A frozen key never validates until the owner unfreezes it | `invariant_I13_frozenKeyNeverValidates`, `invariant_I13_onlyOwnerUnfreezes`, `invariant_I13_checkUserOpSaysFrozen` |
| I14 | Sponsored gas per agent per window is at most its quota; one agent's spam never lowers another's | `invariant_I14_window_bound_per_agent`, `invariant_I14_isolation`, `invariant_I14_deposit_drain_le_sum_of_quotas`, `invariant_I14_sybil_never_sponsored`, `invariant_I14_gas_caps_hold`, `invariant_I14_charge_covers_deposit_cost`, `invariant_I14_holds_released_after_each_bundle` |

I11 is a three-campaign fuzz against the real account, with an independent ghost that attributes every balance, allowance, NFT or operator change to an authority. Its coverage is on record so it cannot pass vacuously: the authority campaign logged 258 [r:results/i11.json#campaigns.authority.fuzzRuns] fuzz runs with 1,379 [r:results/i11.json#campaigns.authority.ownerMoves] owner moves, 926 [r:results/i11.json#campaigns.authority.agentMoves] agent moves, 9,123 [r:results/i11.json#campaigns.authority.unauthorizedAttempts] attempts with no authority and 16 [r:results/i11.json#campaigns.authority.recoveriesExecuted] executed recoveries, and accepted 0 [r:results/i11.json#campaigns.authority.forgedOrReplayedOpsAccepted] forged, tampered, replayed or wrong-chain operations.

## 8. Fumble guards (F rows) and traps (T rows)

The F rows come from `nikunj/IDEA.md` section 5; the T rows from `nikunj/HANDOFF.md`. Rows that are pitch or process discipline rather than code say so.

| Row | Failure mode | Guard | Proof |
|---|---|---|---|
| F1, T2 | ERC-1271 accepts the agent key: x402 or Permit2 spend with no UserOp | Owner-only 1271 by default; vouchers only | `test_1271_ownerOnly_agentAndStrangerRefused`, `test_1271_ownerOnly_sideDoorRefused`, `test_1271_ownerOnly_permitRefused`, `test_r2_permissive1271` (R2 has the hole), `test_x2_sideDoor` |
| F2, T4 | Recipient checked as the call target only; recipient hidden in calldata | Argument rules bind `to`, `spender`, `operator` and shop `recipient`; dynamic arguments refused | `test_argRule_eqSelf`, `test_argRule_inRecipients`, `test_argRule_shortCalldataAndDirtyAddress`, `test_setPolicy_dynamicArgRefused`, `test_setPolicy_payeeSlotsOnly` |
| F3, T7 | Daily cap allows double spend around midnight; a naive bucket allows double in a sliding window | Burst plus refill equal the cap | `test_bucket_midnightNoDoubleSpend`, `testFuzz_bucketWindow`, `testFuzz_bucketWindowRefillMonotone`, `test_bucket_capWindow24h`, `invariant_I1_keyOutflowWindow` |
| F4, T1 | Clock read in validation | Expiry and attestation freshness through `validAfter` / `validUntil` in validation data | `test_F26_validationNeverReadsTheClock`, `test_expiry_validationDataWindow`, `test_expiry_notYetValid` |
| F5, T3 | `approve(MAX)` launders the cap | Allowance growth metered as spend, a pull counted once | `test_meter_approveGrowthDebitedPullCountedOnce`, `test_meter_untrackedSpenderApproveMetered`, `test_meter_externalPullVoidsPrepaid`, `Card_approve_max` |
| F6, T6, T12 | Agent batches, delegatecalls, calls the account or changes policy | One call to a non-self target; governance functions unreachable | `test_agent_selfAndEntryPointTargetRefused`, `test_agent_executeSelectorRefused`, `test_setPolicy_forbiddenTargetsAndSelectors`, `invariant_I2_agentCannotChangeGovernance` |
| F7, F31, T5 | Gas burns the prefund; reverting ops still pay an attacker bundler | Gas caps and credit, charged in validation | `test_gas_capsRefused`, `test_gas_creditDebitedByMaxCost`, `test_F31_overCapExplorationCostsNoGas`, `Card_gas_burn_griefing` |
| F8, T11 | The approval screen shows the agent's own words | Owner signs typed data: target, payee, maximum outflow, call data hash, expiry | `test_approval_withinMax`, `test_approval_overMaxOutflowByOneUnit`, `test_approval_tamperedRevertsInExecution`, `test_approval_mismatch` |
| F9, F25, T8 | Replay of approvals or attestations across chains, wallets or EntryPoints | Typed data with chain id and verifying contract, nonce lanes, epoch | `test_approval_wrongChain`, `test_approval_wrongWallet`, `test_approval_replay`, `test_F25_wrongChainIsUnproven`, `test_F25_oldAndFutureEpochIsUnproven`, `test_wrongChain_agentOpRefused`, `test_replayedNonce_refused`, `Card_replay_wrong_chain` |
| F10 | The security story leans on the model | Stated assumption: the agent is fully hijacked; scenarios bypass the tools | Process: `agent/hijack` submits as the leaked key; mode none in `docs/x6_report.md` |
| F12 | Happy-path demo only | Attack cards on four configurations, hijack scenarios, fuzz | The grid in `docs/x1_report.md` |
| F13 | An unbounded "zero loss" claim | Two stated bounds: the daily limit and the exploration cap | `invariant_I5_globalOutflowWindow`, `invariant_I7`, section 1 |
| F16, F24 | Trust gate fails open, or a score raises a cap | Missing, expired or invalid attestation is unproven; attestations never raise a cap | `test_F24_missingAttestationIsUnproven`, `test_F24_expiredAttestationNeverPays`, `test_F24_noAttestationRaisesAnyCap`, `test_attest_fuzzJunkNeverProven` |
| F19 | `buy(ticketId, recipient = 0xEvil)` | Recipient argument rule | `Card_ticket_to_attacker`, `test_argRule_eqSelf` |
| F20 | Agent moves or approves held NFTs | NFT selectors locked; tracked NFT balance must not drop | `test_nft_transferNeedsRule`, `invariant_I6_noAgentNftMoveOrApprove`, `Card_set_approval_for_all` |
| F21 | N session keys times the daily cap | Account-wide bucket shared by all keys | `test_bucket_globalSharedAcrossKeys`, `Card_multi_key_cap` |
| F23 | A static payee list blocks every legit newcomer | Two tracks: proven payees use the normal caps, unproven payees share the exploration budget | `Card_legit_only`, `test_explore_perTxCapDecodedInValidation`, `test_attest_upgradesNewShopToProven` |
| F26 | Score freshness read with the clock or a shared registry in validation | Attestation in the signature; its `validUntil` folded into validation data | `test_F26_validationDataCarriesAttestationValidUntil`, `test_F26_zeroValidUntilNeverMeansForever`, `test_F26_validationNeverReadsTheClock` |
| F27 | Attestor key on the agent host | Separate key; rotation bumps the epoch; the attestor can only flag | `test_F27_rotatedAttestorLosesAllPower`, `test_F27_attestorKeyCannotSignUserOps`, `test_F27_setAttestorRefusesLiveAgentKey`, `test_flag_attestorCanOnlyFlag`, `invariant_I10` |
| F28 | The agent reports its own outcomes and launders a Sybil to proven | Outcomes only from settlement receipts plus a verifier, or owner / verifier signatures | `test_F27_agentSignedAttestationNeverUpgrades`; attestor service tests (`services/attestor/test/outcomes.test.ts`: agent-only reports are ignored) |
| F29, F30 | Raw reputation feedback as the score; per-wallet greedy scoring | TRACE score with Sybil and clique penalties, shared attestor, exploration bucket | Simulator, not a contract test: `docs/x4_report.md` |
| F32 | Claiming the simulator result before running it | X4 pre-registered; run unchanged | `nikunj/EXPERIMENTS.md`, `docs/x4_report.md` |
| F33, F34, F35 | Simulated market sold as real; bounty with no stated bound; no real incident | Stated honestly; bounds announced first; incident framing | Process items; section 4 and the honest-limits lists |
| T9 | Mixed units (native value versus token amount) | Native value metered together with the EntryPoint deposit; a native value riding a token call is capped | `test_meter_nativeValueMetered`, `test_meter_nativeIncludesDeposit`, `test_agent_nativeValueNeedsAsset`, `test_explore_valueOnTokenCallCapped` |
| T10 | Loss that is entirely in-policy | Bounded, not prevented: the buckets and the exploration cap are the answer | `invariant_I11_agentMovesStayInPolicy`, scenarios H2 and H9 |

## 9. Reading order

`README.md` for the claim and how to reproduce it; `docs/api.md` for the contract surface; `docs/x1_report.md` and `docs/x6_report.md` for the measurements; `docs/x4_report.md` for the simulator result that did not hold; `DECISIONS.md` for every key decision and the bugs found while building.
