# HANDOFF: W3-02 Agent Wallet (re-run 2, 2026-10-24)

**Problem.** Build an ERC-4337 wallet that gives an AI agent a key able to spend only within an owner-defined policy. The policy must hold if the key leaks or a malicious page manipulates the agent [P1][P2][P3]. It covers contracts and functions, per-tx limits, daily limits, recipients, expiry and owner approval for out-of-policy requests [P4]-[P9]. There is no rubric and no dataset [P15]. Time is 1 week+ with 2-4 people and strong Solidity [P16].

**Requirements R1-R17** (REQUIREMENTS.md):
- R1 4337 account; R2 agent key under a policy; R3 holds under misbehaviour.
- R4-R9 the six policy clauses; R10 any open model or bot; R11 signatures/nonces/chain IDs; R12 precise policy.
- R13 use cases; R14 revoke; R15 live injection demo; R16 attack suite as the eval; R17 assumed judging [A1].

**Baseline v0.** SimpleAccount + agent session key + target/selector allowlist + per-tx cap + daily counter + `validUntil` + owner signs the UserOp. Score = X1.

**Traps.**
- T1 no time reads in validation [E2]. T2 ERC-1271 side door [E20][E21][E22][E42]. T3 approve laundering. T4 recipient hidden in calldata.
- T5 gas as a spend channel, incl. execution-revert griefing. T6 batch/self-call. T7 boundary double spend (calendar day, and a burst = cap token bucket in a sliding window). T8 replay.
- T9 mixed units. T10 in-policy loss. T11 attacker-written approval text. T12 admin path.
- New: static payee lists vs an open market (F23); trust gates that fail open or loosen caps (F16, F24); attestation replay (F25); TIMESTAMP or a shared registry in validation (F26); agent-reported outcomes (F28).

**Failure map.**
- Model-level injection defenses fall to adaptive attacks [E39], so the agent is untrusted. Off-chain policy engines are bypassed by a key or host leak [E18][E19].
- Benchmarks mock finance tools [E27][E29].
- Session-key products don't show an EIP-3009-aware 1271 policy [E7]. x402 periodic permissions use one cap for all payees [E74].
- Trust propagation is captured by Sybils: EigenTrust 81.7% malicious routing [E34]. Raw ERC-8004 feedback is Sybil-funded [E60].

**Differentiators.**
1. **D1 One door.** `isValidSignature` refuses the agent key except a pre-registered, already-debited x402 envelope (opt-in after X3). Closest: Smart Sessions 1271 policies [E7]; x402 "permissive" accounts [E42].
2. **D2 Meter the effect + sign the outcome.** Execution-phase caps on measured balance and allowance deltas; the owner signs target/payee/maxOutflow. Closest: PACE [E46]; Safe/Uniswap hooks [E45][E44].
3. **D3 Two tracks** (about 30% of the effort, one slide).
   - Proven payees (owner-listed or attested) use the normal caps. Unproven payees share an account-wide exploration bucket (5% of globalCap per 24 h, per-tx 1% [A19]). Flagged payees need owner approval.
   - The EIP-712 `ScoreAttestation` sits in `userOp.signature`, validUntil goes into validationData [E65][E66], and flags are written on-chain by an escalate-only attestor.
   - It enforces TRACE's "separate tracks with independent budgets" [E34]. Closest: MetaMask periodic x402 permission [E74], static allowlists [E75], bank new-payee limits [E80], conservative bandits [E77].

**Key corrections (orchestrator review).**
- Buckets use burst + 24 h refill = cap, so any 24 h window ≤ cap.
- Attestations only upgrade; flags live on-chain.
- D3 covers value-transfer payees, not new contracts.
- Cite 5.0x (not 6.8x) for greedy vs Thompson under partitioned views [E34].

**Default entry.** Allowlist + calendar daily cap + owner-signs-UserOp page with the agent's text + happy-path demo + static payee list [E40][E47][E48][E49]. It falls into F1, F3, F5, F8, F10, F12, F13, F23 and often F2.

**Experiments.**
- X1 results table: R1 raw key, R2 static allowlist + caps, R3 ours without D3, R4 ours with D3, by about 10 cards, by {funds lost, legit new payees blocked}.
- X2 side-door spike. X3 mainnet x402 receipt (user-run).
- X4 pre-registered simulator sweep, TRACE+EB(B) on a runnable Trace_CIKM fork [E58]: B in {0,1,2,5,10}%, 2 regimes, 4 attacks, 10 seeds; frontier test; H1 only if it moves at B* = 5% in the partitioned regime for at least 3 of 4 attacks.
- X5 proofs: invariants I1-I10, Halmos, THREAT_MODEL.md.

**Build scope.** Backend only (CR29): contracts + Foundry tests/proofs + deploy scripts, attestor, approval service, agent tools + attack harness, X4.
- Build root: `C:\Users\siddh\Downloads\Hypnexis\Hypnexis` (never inside nikunj/).
- Milestones M0-M9 are in IDEA.md section 10.
- The human-team estimate is ≈ 24.35 pd against ≈ 22.4 for 4 people, with a 9-step cut order.

**Open items.**
- Bundler v0.8 [A9]; facilitator contract signatures [A10]; gas overhead [A8].
- Trace_CIKM runnable [A21]; Base ETH for X3 [A14].
- Team size and duration.
