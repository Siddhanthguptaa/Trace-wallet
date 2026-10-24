# WIN: fumble map, default entry, differentiators

Criteria are assumed, since no rubric has been published [P15][A1]: security correctness, demo, UX/product, code quality, novelty/presentation. With no published weights, each is weighted 1. There is no dataset [P15], so the evidence is E (research), P/A (statement and assumptions) and, later, X (the attack suite).

**Phase C re-run 2 (2026-10-24).** Applies change request CR18-CR31 (CHANGE_REQUEST.md; written "CR" here so it does not clash with candidate ids C1-C12). New: D3 TRACE two-track recipient policy with an on-chain exploration budget (CR18), EIP-712 score attestations (CR19), outcome ingestion (CR20), X4 simulator sweep (CR22), proof layer X5 (CR23), results table X1 (CR24), fumble checklist (CR25), incident hook (CR26), bounty bound (CR27), backend-only build (CR29) and a new time budget (CR30). New fumble rows are F23-F35; new candidates are N13-N20. The build ships backend only; UX points that need a UI are deferred to the later UI, not dropped.

## Step 1. Fumble map

`common` = a fumble that most teams on this track will fall into (based on Baseline v0, the comparison table in RESEARCH.md, and the same-track competitor allowance.eth [E40]).

| # | Fumble | How it costs points (criterion [P#]) | Evidence | Guard | Guard cost (h) |
|---|---|---|---|---|---|
| F1 | **common.** The account's ERC-1271 accepts the agent key, so x402 EIP-3009 / Permit2 signatures move USDC with no UserOp and every on-chain policy is skipped | Security: "must hold if the key leaks" [P3]; a protocol-literate judge breaks it in one question | [E20][E21][E22][E26] | **feature**: one-door `isValidSignature` (refuse the agent key; narrow x402 path that applies the policy) + **test** per side door | 10 |
| F2 | **common.** Recipient checked as the call target only, so `USDC.transfer(attacker, x)` or `transferFrom(this, attacker, x)` passes when USDC is allowlisted | Security; P7 "allowed recipients" | [E16][E40][E18] | **feature**: argument rules bind `to`/`spender` for `transfer`, `transferFrom` and `approve` + **test** each | 3 |
| F3 | **common.** Calendar-day bucket: 2x the daily cap around midnight | Security; P6 | [E14][E17] | **feature**: token bucket in execution with burst + 24 h refill = cap (a burst = cap bucket still allows 2x in a sliding 24 h window; re-run 2 fix) + **test** (spend at 23:59 and 00:01, and burst-then-refill over 24 h) | 3 |
| F4 | **common.** `block.timestamp` read in `validateUserOp`; bundlers reject the op, or the team only tests with a direct EntryPoint call | Code quality; demo breaks on a real bundler | [E2][E32] | **feature**: expiry via `validUntil`, time only in execution + **test** with bundler-spec-tests once | 2 |
| F5 | **common.** `approve(spender, MAX)` launders the cap: the spender pulls later, outside the counter | Security; P5/P6 | T3 [E13] | **feature**: approve only to allowed spenders, allowance growth counted as spend (balance/allowance delta) + **test** | 3 |
| F6 | Agent can call `executeBatch` (also nested inside an allowed call), `delegatecall`, or the account itself (`upgradeTo`, setters) and rewrite the policy; or split one big spend into many small ops | Security; P3 | T6, T12 | **feature**: agent path = single `execute` to non-self target, no batch, no delegatecall; splitting is bounded by the per-key and global buckets (I1, I5) + **test** each | 2 |
| F7 | Gas is a spend channel: a leaked key sets a huge `maxFeePerGas` and burns the prefund | Security; P3 | T5 | **feature**: per-session-key gas caps in validation + gas credit + **test** | 2 |
| F8 | **common.** "Owner approval" shows the agent's own description, so an injected agent words a malicious request to look benign | Security + UX; P9/P13 | [E26], T11 | **feature**: approval rendered only from decoded calldata and simulated outflow; owner signs callData hash + max outflow (EIP-712) | 6 |
| F9 | Replay: owner approval valid on another chain, across EntryPoint versions, twice, or forever | Security; P11 | [E5][E4][E41][E65] | **feature**: pin EntryPoint v0.8; EIP-712 domain with chainId + verifyingContract (the account); approval single use by nonce, with validUntil, bound to target/payee/maxOutflow/callDataHash + **test** (wrong chain, wrong EP, reused nonce, expired) | 2 |
| F10 | **common.** Security story leans on the LLM ("system prompt says never pay strangers") or on an injection detector | Security + novelty; judges have read "prompt injection" news | [E39][E23][E24] | **slide/answer**: "we assume the agent is fully hijacked; model defenses fail at >90% ASR [E39]" | 0.5 |
| F11 | **common.** Policy lives in an off-chain server (CDP-style) or in the agent harness; a key/host leak bypasses it | Security; P3 | [E18][E19][E38][E35] | **scope cut** (no off-chain engine) + **slide**: comparison table row | 0.5 |
| F12 | **common.** Demo is a happy path only: "agent buys a ticket". No attack shown, or one scripted attack | Demo + security | [E40] (7 happy/fail scripts, no attack suite) | **feature**: attack cards fired at 4 wallet configs; results table with funds lost and legit new-payee payments blocked [X1] | 8 |
| F13 | Claiming "zero loss": a hijacked agent can still overpay an allowed merchant up to the caps, and with D3 pay unproven payees inside the exploration budget | Honesty under the hardest judge question | T10 (no source found) | **slide/answer**: claim bounded loss and state both bounds: ≤ globalCap per asset per 24 h for all keys; ≤ explorationCap to unproven payees [A19] | 0.5 |
| F14 | Benchmark ASR presented as "funds safe": injection benchmarks mock finance tools | Security claims | [E27][E29] | **test**: every attack card maps to an on-chain outcome (refused / reverted / bounded loss) with a tx hash | 1 |
| F15 | Spam the owner with approval requests (approval fatigue) | UX; P13 | T11 | **feature** (cheap): rate-limit pending requests per session key; **scope cut** anything fancier | 1 |
| F16 | Trust-score gate fails open on a missing score, or a score raises the caps themselves | Security (TRACE is now used, D3) | [E34], prior_work.md (extension.py:105-107) | **feature** (re-run 2): a missing or invalid attestation means unproven; the attestation only picks the track inside globalCap and never raises globalCap or dailyCap; flagged payees go to owner approval + **test** | 0.5 |
| F17 | Mixed units: ETH and 6-decimal USDC under one cap; fee-on-transfer tokens | Security; P5 | T9 | **feature**: caps per asset, no oracle; only tracked assets are spendable by the agent | 1 |
| F18 | Non-crypto judges cannot follow "ERC-4337 validateUserOp" | Demo + presentation; 15 PS across 6 tracks [P15] | [P15] | **slide**: one plain-words policy line ("$20/day, only these 3 shops, until Friday") + one scoreboard | 1 |
| F23 | **common.** Static recipient allowlist in an open agent market: every legit new payee is blocked or becomes an owner ping, so teams loosen the list by hand or let a score loosen it | Security + UX; P7, P13 | [E34] (66/700 vs 125/700 honest providers served; "separate tracks with independent budgets") | **feature**: D3 two-track recipient policy (proven / exploration budget / flagged) + **test**: X1 metric 2, legit new-payee payments blocked | 8 (contract + validation; service hours in Step 7) |
| F24 | Trust signal fails open: a missing, expired or unverifiable score counts as good (the user's earlier trace-api gate failed open, prior_work.md) | Security | [E34], prior_work.md | **feature + test**: missing, expired, wrong-domain or rotated-attestor attestation = unproven, by construction; one test per case | 1 |
| F25 | Attestation replay: a score signed for one chain or one wallet is reused on another | Security; P11 | [E65][E1] | **feature + test**: EIP-712 domain with chainId and verifyingContract = this wallet; epoch counter; wrong-chain and wrong-wallet tests | 1 |
| F26 | **common.** Validation reads a shared score registry or `block.timestamp` to check freshness, so bundlers drop the op, or the team only tests a direct `handleOps` | Code quality + demo | [E2][E66] | **feature**: attestation carried in `userOp.signature`, ecrecovered against the account-stored attestor; validUntil folded into validationData, as the reference VerifyingPaymaster does | 1 |
| F27 | Attestor key on the agent host, or no rotation: one host compromise upgrades the attacker to proven | Security; P3 | CR19, [A20] | **feature**: separate attestor key and host; owner-only rotation and epoch bump. **slide**: a compromised attestor still stays inside globalCap | 0.5 |
| F28 | Agent self-reports job outcomes, so an injected agent launders a Sybil into "proven" | Security | [E34] (binary outcomes), [A22] | **feature + test**: outcomes only from x402 settlement + delivery check [E70] or an owner/verifier-signed outcome; agent-only reports ignored | 1 |
| F29 | Raw on-chain reputation (ERC-8004 feedback) used as the trust score | Security + novelty Q&A | [E59][E60] | **design + answer**: TRACE score with Sybil and clique penalties [E34]; ERC-8004 feedback is at most a discounted input | 0.5 |
| F30 | Per-wallet greedy scoring: one wallet sees only its own payments (partitioned view), where greedy has 5.0x the strategic-default fraud of Thompson sampling (32.0 vs 6.4 sats); also quoting the paper's 6.8x for that comparison | Security + honesty | [E34] (Table 9; CR31) | **feature**: exploration budget + shared attestor. **slide**: cite 5.0x, never 6.8x, for the Thompson comparison | 0.25 |
| F31 | Budget checks that revert in execution used for gas griefing: the op passes validation, reverts on a bucket, and an attacker-run bundler still collects the gas | Security | [E1] (prefund), CR19, CR25 | **feature + test**: per-key maxFeePerGas and gas-limit caps plus the gas credit debited in validation (extends F7) | 0.5 |
| F32 | Claiming the simulator result before running it, or picking the best B after the runs | Honesty | CR22 | **test discipline**: X4 pre-registered (primary B*, bootstrap rule, seeds); all B reported; if the frontier does not move, the pitch shows the hard bound only [X4] | 0.25 |
| F33 | Simulated agent market sold as real-market evidence; Sybil detector presented as accurate on real graphs | Honesty | [E34] (collusion fraud 6.2 sats at 0.8% density vs 47.1 at 1.2%; edge-to-job false positives on real graphs), [A23] | **slide/answer**: "simulated agents, sparse regime; known false positives on dense real graphs; the on-chain bound does not depend on the score being right" | 0.25 |
| F34 | Projector bounty with no stated bound, or on mainnet before the proofs pass | Demo + honesty | CR27 | **feature + slide**: announce the maximum extractable amount first: explorationCap per window to new addresses; everything else reaches only proven or allowlisted payees. Testnet; mainnet only after X1 + X5 pass and the event rules allow it | 0.25 |
| F35 | Pitch with no real incident: judges file "an injected agent drains its wallet" as hypothetical | Presentation | [E62][E63][E64] | **slide**: Freysa (talked into paying) and aixbt (control compromise) map onto the brief's two threats | 0.25 |

**CR25 fumble checklist.** Every item was already guarded or is guarded by a new row; none was missing. Test names are proposals for THREAT_MODEL.md [X5].

| CR25 item | Rows | Proposed tests |
|---|---|---|
| ERC-7562 TIMESTAMP ban: validUntil/validAfter only | F4, F26 | bundler-spec run once [E32]; `test_attestation_validUntilFolded` |
| Gas griefing: per-key maxFeePerGas and gas limits | F7, F31 | `test_gasCaps_perKey`, `test_revertingOp_costsCreditNotPrefund` |
| ERC-20 approve, transferFrom, approve-MAX | F2, F5 | `test_transferFrom_toBound`, `test_approveMax_meteredAsSpend` |
| ERC-1271 / Permit2 / EIP-2612 side door | F1 (D1) | `test_1271_refusesAgent_{EIP3009,Permit2,EIP2612}` |
| Self-calls, delegatecall, nested executeBatch, batch splitting | F6, I1, I5 | `test_agent_noSelfCall`, `_noDelegatecall`, `_noNestedBatch`, `invariant_splitBound` |
| Owner approval: EIP-712 chainId + verifyingContract, single use, expiry, bound to target/payee/maxOutflow/callDataHash | F8, F9 | `test_approval_{wrongChain,replay,expired,payeeMismatch,overMaxOutflow}` |

## Step 2. The default entry (the bar to clear)

Most W3-02 teams will ship: a SimpleAccount or Kernel/Smart Sessions account [E6][E7] with an agent session key, a target+selector allowlist, a per-tx cap on native value or the decoded ERC-20 amount, a daily counter reset per calendar day, `validUntil` expiry (or, worse, `block.timestamp` in validation), and an owner-signs-the-UserOp approval page that shows the agent's description. The demo is an LLM agent buying API credits or a ticket, plus one "attacker tells the agent to pay them" prompt that the allowlist rejects. Same-shape entries: Phylax SDK [E47], session-policy-wallet [E48], chaingpt-claude-skill [E49]. allowance.eth [E40] is the strongest known example of this shape and shows its typical gaps: targets only, no selectors, no decoded recipient, a guard the key can route around. The default entry falls into F1, F2 (often), F3, F5, F8, F10, F12 and F13.

**Re-run 2 addition (recipients).** For payees the default entry ships a static allowlist: every new payee is blocked or becomes an owner ping (F23). Teams that add reputation tend to read raw on-chain feedback (F29), let a score loosen caps or fail open (F16, F24), or check freshness with `block.timestamp` in validation (F26). The default demo has no real incident (F35) and no stated bounty bound (F34).

## Step 3. Candidates (from `adhd`, 5 isolated frames: attacker, regulator, game design, inversion, biology; 30 ideas)

Scores: N = novelty, V = viability in 1 week, F = fit to the criteria. Clusters are grouped by underlying angle.

**A. Meter the effect, not the calldata**
- Balance-delta invariant: snapshot tracked balances and allowances, revert if net outflow > cap, whatever the calldata said (regulator, attacker) [N7 V8 F9]
- Owner signs the outcome: approval binds callData hash + max outflow per asset; post-exec check enforces it (attacker) [N8 V7 F9]
- Single USD budget over the whole portfolio via balance diff (attacker) [N7 V3 F6], **trap**: needs a price oracle, which hits T1/T9

**B. One door: close the side doors**
- `isValidSignature` hard-refuses the agent key; spend only via UserOp (inversion, biology) [N6 V9 F10]
- Narrow x402 exception: parse the EIP-3009 typed data and apply the same policy, with the nonce pre-registered by a policy-checked UserOp (deepened) [N8 V7 F10]
- Spend-path exhaustiveness: Foundry invariant "assets leave only through policy-checked execute" (regulator) [N6 V8 F9]; with Certora/Halmos [N7 V4 F8], **trap**: formal tooling cost
- Just-in-time funding: the agent account holds 0 permit-able balance and pulls from an owner vault inside policy-checked execution (inversion) [N7 V6 F8]
- Endospore sub-accounts: single-use spores funded with one per-tx limit (biology) [N8 V4 F7], **trap**: deploy and UX overhead, and it does not fix recipients

**C. Untrusted narrator (approval UX)**
- Approval screen built only from decoded calldata + simulated balance diff; the agent's text is shown struck through as "untrusted" (game, inversion, regulator, attacker, biology: 5/5 frames) [N5 V9 F9]
- Rate-limited pending queue per session key [N3 V9 F6]

**D. Proof as the demo**
- Attack-card deck fired live by the judge; scoreboard "agent hypnotized: YES / funds beyond policy: 0" (game) [N7 V8 F9]
- Leaked-key bounty: agent private key on screen, judges get 60 s to drain (game, inversion, attacker) [N8 V7 F8]
- Side-by-side naive wallet that loses on the same cards (deepened) [N6 V8 F9]
- Exploit corpus as a "compliance certificate": every known bypass shipped as a Foundry test (regulator) [N5 V9 F9]

**E. Tripwires**
- Canary recipient/selector: touching it freezes the session key and pings the owner (game, inversion, attacker, biology: 4/5 frames) [N7 V8 F6], with the caveat that it is detection, not prevention: an adaptive attacker who knows the canary avoids it [E39]

**F. Trust- and time-shaped budgets**
- Token-bucket "stamina bar" drawn live; midnight double-spend replay on a calendar wallet (game) [N5 V9 F8]
- Probation tier for newly allowed recipients: tiny cap + 24 h cooldown (attacker) [N6 V7 F6]
- Monotone ratchet: tightening instant, loosening only after an owner timelock (inversion) [N6 V7 F6]
- Coagulation-style decaying charge with escalating co-signers (biology) [N6 V5 F5], which is a token bucket with more steps
- TRACE XP: caps level up with clean history (game) [N6 V5 F4], **trap**: an off-chain score loosens on-chain caps, which breaks F16
- Budget refills from x402 earnings (inversion) [N7 V3 F3], **trap**: off-topic complexity
- Refundable escrow for in-policy payments (attacker) [N8 V3 F5], **trap**: x402 merchants and facilitators will not accept delayed settlement
- Provenance-tagged UserOps: the agent commits the hash of the page that triggered it (regulator) [N7 V5 F4], **trap**: a hijacked agent self-reports, so the tag proves nothing

**G. Audit trail**
- Forensic decision log: every op emits policy hash + matched rule id + budget left (regulator) [N4 V9 F7]

### Deepened branches (adhd Phase 2)

These branches were sketched from model knowledge with no fetch. Lines marked (inferred) must be checked on day 1 of the build.

**One door (B).**
- **How it works.** ERC-1271 receives only the hash, so the account cannot read the typed data from it. The agent therefore sends an envelope: `(MODE_X402, to, value, validAfter, validBefore, nonce, agentSig)`. The account rebuilds the USDC EIP-3009 digest with `from = address(this)` and requires it to equal the hash. It then requires that the nonce was pre-registered as a voucher (payTo, maxValue, validBefore) by a policy-checked UserOp, and that UserOp already debited the budget at `maxValue`. Any other hash signed by the agent key returns `0xffffffff`; this covers EIP-2612, Permit2 and marketplace orders. Only the owner gets general 1271.
- **Replay.** Cross-chain and cross-account replay are closed by the token's EIP-712 domain (chainId, verifying contract), by `from == this`, and by per-chain voucher storage (inferred).
- **Variation.** A voucher book: one UserOp registers a Merkle root of N vouchers and debits their sum, so x402 latency is paid once per batch.
- **Load-bearing risk.** Facilitator and client compatibility. The x402 client must sign with a pre-registered nonce instead of a random one, and the facilitator must pass a non-65-byte contract signature to the `bytes` overload of `transferWithAuthorization` (inferred).
- **Day-1 test.** On a Base fork, a naive account that accepts the agent key in 1271 loses USDC to `transferWithAuthorization` with zero UserOps. Then run the x402 facilitator's verify against the same signature.

**Meter the effect (A).**
- **How it works.** SimpleAccount v0.8 plus `executeUserOp`. First, a boundary filter: deny-by-default targets; no self-calls, delegatecall, `setApprovalForAll` or `EntryPoint.withdrawTo`; tracked tokens allow only transfer/approve with a decoded recipient. Then snapshot the native balance, the EntryPoint deposit, the tracked ERC-20 balances and the allowances to known spenders (Permit2 included). Run the call, take the positive deltas, and revert on per-tx cap, allowance growth or token-bucket underflow. `block.timestamp` is read only here.
- **Why it holds.** Fee-on-transfer is counted conservatively. Reentrancy cannot re-enter `execute` (EntryPoint-only), and 1271 is locked while a call runs.
- **Cost.** About 60-90k gas of overhead for 3 tokens and 4 spenders (inferred).
- **Load-bearing risk.** Completeness of the metered set. Any value door outside the snapshot bypasses it silently, so the guarantee rests on deny-by-default targets plus the 1271 lockdown plus EntryPoint-deposit tracking.
- **Children.** Two-sided outcome bounds (`minIn`: "if USDC leaves, at least X arrives") give oracle-free slippage and hidden-recipient protection. A gas credit is debited in validation from the account's own storage and refilled in execution.

**Attack-card demo (D).**
- **How it works.** Each card is one Foundry test with `expectNaiveLoss > 0` and `expectHardenedLoss == 0`, fired at the hardened account and at a naive account built from a stock default config, named, so it is not a strawman. Every card has two shooters:
  - the open-weight LLM fed a poisoned page, which is stochastic and fills only the "agent hypnotized" column;
  - a raw-key script holding the leaked agent key, which is deterministic and is the ground truth for "funds beyond policy: 0".
- **Demo design trap.** An op rejected in `validateUserOp` never lands on-chain, so there is no explorer link. Cards meant to be shown on-chain should fail in execution instead: the op lands with `success=false`.
- **Midnight card.** Shown on a fork with `vm.warp`.
- **Fallbacks.** Live Base Sepolia via a bundler, then direct `handleOps` from an EOA, then the anvil fork, then pre-landed tx hashes for the video.
- **Load-bearing risk.** Credibility. If the naive wallet looks like a strawman, or the LLM visibly refuses half the injections, judges read it as staged. So lead with the deterministic column.

### Re-run 2 candidates (CR18-CR31; frames: judge, user, competitor)

`adhd` is not installed in this run, so these were written under the three frames. Most are user-directed by the change request; the frames decide how each is shown.
- **N13 D3 two-track recipient policy** (CR18). Proven payees (owner-listed, or attested proven) use the normal caps; unproven or unattested payees share one account-wide exploration bucket per asset (about 5% of globalCap per 24 h, small per-tx cap [A19]), charged with D2's measured outflow; flagged payees go to owner approval or are blocked. *User:* the agent can pay a legit new shop without pinging the owner. *Judge:* it enforces on-chain the open problem a published paper left as future work [E34]. *Competitor:* static lists everywhere (F23). It subsumes the first-pass "probation tier" (C11).
- **N14 EIP-712 score attestation, ERC-7562-safe** (CR19). `ScoreAttestation{recipient, tier, validUntil, epoch}` inside `userOp.signature`, owner-set attestor, validUntil folded into validationData. Enabling piece of N13; the pattern is established [E66], so it is engineering, not novelty.
- **N15 Outcome ingestion** (CR20). x402 settlement receipt + delivery check, owner/verifier-signed outcomes, agent-only reports ignored [A22]. Enabling piece of N13.
- **N16 X4 simulator sweep** (CR22). TRACE + exploration budget B in the forked simulator, Pareto plot of fraud vs served-honest, pre-registered [X4].
- **N17 Proof layer** (CR23). Invariants I7-I9 on top of I1-I6, Halmos on the bounded policy-check function, THREAT_MODEL.md [X5].
- **N18 Results table** (CR24). 4 wallet configs x about 10 cards x 2 metrics [X1]. *Judge:* one slide carries the whole security story and the trade-off.
- **N19 Real-incident hook** (CR26). Freysa and aixbt, one per threat in the brief. *Judge:* turns "hypothetical" into "already happened".
- **N20 Bounty with an announced bound** (CR27). The maximum extractable amount is stated before judges get the key.
- Small folds (no own row): an attestor-compromise card that shows the globalCap bound live (judge frame); an owner epoch bump that revokes every attestation in one tx (user frame); the exploration-bucket level printed by the CLI next to the budget line (user frame).

## Step 4. Score

Weight 1 per criterion (A1). Points 0-3 vs the default entry. Value = Σ points; value/effort = value ÷ person-days.

| Candidate | Security | Demo | UX | Code | Novelty | Value | Visible <30 s? | Effort (pd) | Risk | Value/effort |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 One door (1271 refuse + policy-checked x402 path) | 3 | 2 | 0 | 2 | 3 | 10 | yes: "x402 drain via signature" card, naive wallet loses USDC, ours refuses | 2.5 | facilitator must accept a contract sig (USDC does [E21]); nonce pre-registration adds one UserOp per x402 payment | 4.0 |
| C2 Effect metering (balance + allowance delta) | 3 | 1 | 0 | 2 | 2 | 8 | yes, with a card: allowed merchant `buy()` that secretly pulls 10x | 2 | gas cost; untracked assets; reentrancy during the call | 4.0 |
| C3 Sign the outcome (approval binds callData hash + max outflow) | 2 | 2 | 3 | 1 | 2 | 10 | yes: the approval screen shows "−$40 USDC to 0xabc (not in your list)"; agent text struck through | 2 | simulation needs an RPC; it is a UI risk, not a safety one (the post-check enforces the bound) | 5.0 |
| C4 Attack-card deck + side-by-side naive wallet + scoreboard | 2 | 3 | 2 | 1 | 1 | 9 | yes (it is the demo) | 2.5 | live LLM nondeterminism; testnet/bundler latency | 3.6 |
| C5 Leaked-key bounty on stage | 1 | 3 | 0 | 0 | 2 | 6 | yes | 0.5 | judges will not actually try; works as a 10 s video beat | 12.0 |
| C6 Token-bucket stamina bar + midnight replay | 1 | 2 | 2 | 1 | 0 | 6 | yes | 0.75 | none | 8.0 |
| C7 Canary tripwire freeze | 1 | 2 | 1 | 0 | 1 | 5 | yes | 0.75 | detection only; adaptive attacker avoids it | 6.7 |
| C8 Exploit corpus as Foundry tests (X1) | 3 | 1 | 0 | 3 | 1 | 8 | partly (CI badge, test list in README) | 2 | none | 4.0 |
| C9 Forensic decision log events | 1 | 0 | 1 | 1 | 0 | 3 | no | 0.25 | none | fold into guard |
| C10 Monotone ratchet (loosen behind timelock) | 1 | 0 | 1 | 0 | 1 | 3 | no | 0.5 | UX friction | fold into guard |
| C11 Probation tier for new recipients | 1 | 0 | 0 | 0 | 1 | 2 | no | 0.75 | complexity | cut |
| C12 TRACE escalate-only recipient risk | 1 | 1 | 1 | 0 | 2 | 5 | yes, if a "low-trust shop → owner approval" card exists | 1.5 | network dependency; must fail closed | 3.3 (superseded by N13) |
| N13 D3 two-track recipients (N14, N15 folded in) | 2 | 2 | 2 | 1 | 3 | 10 | yes: Sybil-payee card, R3 vs R4 columns: the injected agent keeps paying fresh Sybils and stops at explorationCap, while a legit new shop is paid with no owner ping | 4.25 (contract 1.0, attestation 0.75, simulator fork setup 0.75, attestor 1.25, outcomes 0.5) | TRACE port effort [A21]; attestor key [A20]; partitioned-view honesty (F30); synthetic market (F33) | 2.4 |
| N16 X4 sweep + Pareto plot | 0 | 1 | 0 | 1 | 2 | 4 | one plot on the TRACE slide, shown only if H1 passes | 1.25 after the shared fork setup (2.0 alone) | public repo not runnable as published [E58]; runtime unknown; H1 may fail | 3.2 |
| N17 Proof layer (I7-I9, Halmos, THREAT_MODEL.md) | 3 | 1 | 0 | 3 | 1 | 8 | partly: THREAT_MODEL table with test names, CI badge | 1.5 (Halmos 1.0, I7-I9 0.25, THREAT_MODEL 0.25) | Halmos setup on Windows; bounds must be stated | 5.3 |
| N18 Results table (4 configs x ~10 cards x 2 metrics) | 2 | 3 | 1 | 2 | 2 | 10 | yes: one table; R2 loses money, R3 blocks newcomers, R4 is bounded on both | 1.5 on top of the card deck | self-graded deck and legit stream | 6.7 |
| N19 Real-incident hook slide | 0 | 2 | 0 | 0 | 1 | 3 | yes, the opening 10 s | 0.1 | none once sources are verified | 30 |
| N20 Bounty with announced bound | 1 | 3 | 0 | 0 | 2 | 6 | yes | 0.1 on top of C5 | judges may not try | 60 |

Re-run 2 note on UX: the build is backend only (CR29), so UX points here are what the later UI will show from the same APIs (the exploration-bucket level, "paid a new shop without asking you"). No UX point is claimed for a screen this build does not make.

## Step 5. Pick

**Cover first.** These reach the top-3 bar from the REQUIREMENTS ambition check: guards F2-F9, F14, F15, F17 (in-account features with one test each), C8 (attack corpus = X1 metric), C6 (token bucket, shown as a bar), C3's UI half (decoded approval screen) and C4 (attack-card demo). Together they cover security, demo, UX and code.

**Then spike (differentiators a judge sees in under 30 s):**
1. **One door [C1, with C2 as its execution-side twin].** "Every dollar leaves through one door, and that door checks the policy." The x402 signature card is the moment: the naive wallet loses USDC to an EIP-3009 signature with no UserOp, while ours refuses unless the payment fits the policy. It guards the top fumble F1, which the default entry falls into, and it hits the user's own x402 stack [A5]. Effect metering (C2) is the same promise on the UserOp path: the cap counts what actually left, not what the calldata claimed.
2. **Sign the outcome [C3].** The owner approves "−$40 USDC to 0xabc, once, by Friday", built from decoded calldata and simulation, never from the agent's words. The contract enforces that bound after execution. This guards F8, the approval half of the PS [P9][P13], and gives non-crypto judges something to look at.

**Honesty test.**
- One door: "Can a hijacked agent still lose money?" Yes, up to the caps, to allowed recipients (F13). "Does x402 still work?" Yes, for allowed payees within the caps; one extra registration UserOp per payment (or per batch of nonces) is the price. "What if a token we don't track is drained?" The agent path can only touch tracked assets and allowed targets; untracked tokens are out of the agent's reach by allowlist, not by metering.
- Sign the outcome: "What if the simulation is wrong?" The post-execution check reverts if the real outflow exceeds the signed bound, so a bad simulation can only cause a failed tx, never an overspend.
- Both survive. C7 (canary) does not fully survive "an adaptive attacker avoids it" [E39], so it is a stretch beat, not a differentiator.

### Re-run 2 pick (CR18-CR31)

**Cover first.** Add guards F23-F35, N17's invariants I7-I9 and THREAT_MODEL.md, N18 (the results table is X1), N19 (one slide) and N20 (one sentence before the bounty). These keep every criterion at its top-3 bar with a backend-only build.

**Differentiators.** D1 (one door) and D2 (meter the effect, sign the outcome) stay the two spikes a judge sees first. **D3 = N13** is added by the user's decision (CR18) as the third, smaller differentiator: one slide, about 30% of the effort, and visible inside the results table through the second metric. Its value/effort (2.4) is below D1/D2 (4.0-5.0), which is why it stays the smaller share. X4 (N16) is a supporting plot, shown only if its pre-registered test passes. The pitch line is "spending limits bound how much; TRACE bounds who".

**Design rules for D3 (for Phase D).**
- The only path to "proven" is an owner listing or a valid attestor signature for this chainId and this wallet, inside validUntil and the current epoch. Everything else is unproven, by construction.
- The attestor maps TRACE decisions to tiers with an allow-list: only ROUTE becomes proven; HOLD, INVESTIGATE, REFER, QUARANTINE and any unknown code become flagged; ROUTE_WITH_CAUTION and cold start become unproven. This fixes the two bugs of the user's earlier trace-api gate, a deny-list that let QUARANTINE pass and a missing score defaulting to 1.0 (research_parts/prior_work.md).
- Exploration spend debits the exploration bucket and also the key and global buckets, so the overall bound stays globalCap [A19].
- A flagged payee goes to owner approval even if the owner listed it (the owner decides). So the attestor can delay a payment (liveness) but cannot move money.
- The attestor never sees the agent key, and the agent host never sees the attestor key [A20]. If the attestor is down, payees fall back to unproven.

**Honesty test, D3.**
- "So a leaked key can pay itself?" Yes: up to explorationCap per window, to a new address, and we announce that number before the bounty (F34). A static allowlist would block that payment, and also every legit new shop (X1 metric 2).
- "What if the attestor is hacked?" It can upgrade attacker payees to proven. Loss still stays within globalCap per asset per window, and the attestor cannot touch the 1271 door, the argument rules or the owner path. The owner rotates the attestor or bumps the epoch in one tx.
- "Your own paper says greedy fails for a single buyer." Yes, and that is why the wallet does not run pure greedy. The exploration track is the insurance: greedy has 5.0x the strategic-default fraud of Thompson sampling under partitioned views [E34]. A shared attestor gives a wider view than one wallet.
- "Simulated agents?" Yes. The demo market is synthetic [A23], and TRACE's Sybil signal has known false positives on dense real graphs [E34]. The on-chain bound does not depend on the score being right.
- "Why not ERC-8004 reputation?" ERC-8004 is a registry [E59], and its feedback shows coordinated Sybil funding [E60]. We use it at most as a discounted input.
- D3 survives. Its claim is the hard bound plus the measured trade-off, not "TRACE detects fraud on-chain".

## Step 6. Light prior check (full log in NOVELTY.md)

- **One door.** The premise is confirmed: Permit2 and USDC v2.2 EIP-3009 call the payer account's `isValidSignature`, and x402 docs call an account that accepts a raw controlling-key signature there "permissive" [E42][E43]. The EIP-3009 path needs no prior approval. The Permit2 path still needs an on-chain `approve` to Permit2 through `execute` [E42], which the allowance-delta check meters.
  - Closest prior work we found is Smart Sessions [E7]. It offers an ERC-1271 policy type per session.
  - It differs in that its README shows no policy that decodes EIP-3009 fields, charges them to the same budget as UserOp spends, needs a nonce pre-registered by a UserOp, or refuses the session key on every other 1271 request. Its source was not read, so treat this as "not shown", not "absent".
- **Meter the effect / sign the outcome.**
  - Closest prior work we found is PACE [E46]. Signed policy records bind intent, policy and a simulation report to the exact execution bytes: 0.00 vs 0.80 unsafe-execution rate in a deterministic sandbox.
  - It differs in that it trusts the off-chain simulation. We measure the real balance and allowance deltas in execution, and the owner signs a max outflow per asset.
  - The post-execution hook slot itself is established prior art: Safe `checkAfterExecution` [E45], and Uniswap `afterExecute`, which lists "Spending limits" as a use [E44].
- **Competitors.** Phylax SDK [E47] (ERC-4337, session keys, recipient and contract guardrails), session-policy-wallet [E48] and chaingpt-claude-skill [E49] all claim agent-drain protection. Only their descriptions were read, so the pitch shows the x402 signature attack live instead of claiming that they fail it. This raises the default entry: assume competitors also decode recipients, so the 1271 door and effect metering are what separate us.
- **D3 two tracks (re-run 2; full log in NOVELTY.md).**
  - Closest prior work we found is MetaMask's periodic x402 permission [E74]: an on-chain weekly cap on an agent's x402 spend, one cap for every payee, with no trust input shown. Static allowlist rules such as Openfort's [E75] block unknown payees or cap the amount.
  - Plain-world analog: Bank of Ireland UK caps new payees at €1,000 / £1,000 per day for up to 48 hours against €20,000 / £20,000 for existing payees, i.e. 5% [E80]. That status ends by time; D3's ends by evidence and is enforced against a hostile agent.
  - Bandits: conservative bandits bound an honest learner's reward shortfall, statistically [E77][E78]. D3 is a hard per-window loss cap against a possibly hostile chooser.
  - The attestation check is the established VerifyingPaymaster pattern [E66], so it is engineering, not novelty.
  - Closest competitor: starknet-agentic (Starknet, not 4337) lists a spending policy next to ERC-8004 registries; a policy that reads reputation is not shown [E81].
  - D3 survives the check as "a known split (banks, bandits) keyed to a signed trust tier and enforced in ERC-4337 validation and execution". Never "first".

## Step 7. Scope cut

Time: 1 week+, 2-4 people [P16]. Plan ~80% for the build, ~20% for polish, video and buffer. Estimated build: guards ~4 pd, C1+C2 ~4.5 pd, C3 ~2 pd, C4+C6 ~3.25 pd, C8 ~2 pd = ~16 pd, which fits 3 people × 7 days × 0.8 ≈ 17 pd. With 2 people, cut C2 to "decoded amount + allowance delta only" and drop C6's animation.

| Cut | Why |
|---|---|
| USD portfolio budget / price oracle | Oracle reads are banned in validation (T1) and add unit risk (T9); per-asset caps are enough |
| Formal verification (Certora/Halmos) | Certora: cut, days of setup no generalist judge sees. Halmos: back in for the bounded policy-check function only (CR23, re-run 2), second in the cut order; Foundry invariants still carry the main claim |
| Endospore sub-accounts | Deploy and UX overhead; does not fix recipients |
| Refundable escrow | x402 settlement is immediate; merchants will not accept clawbacks |
| Provenance-tagged UserOps | A hijacked agent self-reports, so the tag proves nothing |
| TRACE XP / earned budgets | An off-chain score must never raise the caps themselves (F16). D3 differs: it only picks the track inside globalCap |
| TRACE escalate-only gate | Superseded by D3 (N13, re-run 2) |
| Canary tripwire | **Stretch**: one 10-second demo beat at most; detection, not prevention |
| Full ERC-7579 module conformance + install on Nexus | **Stretch**: code-quality bonus, invisible in the demo |
| Probation tiers, monotone ratchet | Invisible in the demo; fold the ratchet into "loosening needs the owner key" (already true) |
| Mainnet deployment | Testnet is enough [A2]; one optional mainnet x402 receipt |
| Agent-side injection defenses | By design: the wallet must hold with a fully hijacked agent [E39] |
| Web frontend, dashboard, mobile UI, approval card, phone push, MetaMask deep link (re-run 2) | CR29: backend-only build. Owner approval is exercised with a scripted signer and EIP-712 typedData test vectors [A18]; the UI comes later on the same APIs |
| ERC-7579 / EIP-7702 shaping (re-run 2) | First in the cut order (CR30); invisible in a 3-minute demo |
| Mainnet bounty (re-run 2) | Testnet by default; mainnet only after X1 + X5 pass and the event rules allow it (CR27) |
| TRACE section 7.6 ideas: gap-gated Thompson sampling, Louvain/Leiden community baseline (re-run 2) | Research-grade; X4 tests only the budgeted track. State the known false-positive limit instead [E34] |
| ERC-8004 registry integration beyond a discounted input (re-run 2) | Its feedback shows coordinated Sybil funding [E60]; not worth build time |

### Re-run 2 time budget and cut order (CR30)

Planning estimate in person-days [A17][A18]. The first-pass 3-person total was ≈ 17.1 (IDEA.md section 10).
- **Removed by backend-only (CR29):** approval card UI, dashboard / policy editor / scoreboard screens, MetaMask mobile deep link: about -1.25, giving ≈ 15.85.
- **Added:** D3 contract 1.0; attestation check in validation 0.75; runnable Trace_CIKM fork 0.75 (shared by the attestor and X4) [A21]; attestor service 1.25; outcome ingestion 0.5; X4 policy, sweep and plots 1.25; Halmos 1.0; invariants I7-I9 0.25; THREAT_MODEL.md 0.25; results-table harness, legit stream and new cards 1.5. Total +8.5.
- **Total ≈ 24.35 person-days.** Capacity at 7 days x 0.8: 3 people ≈ 16.8, 4 people ≈ 22.4 [P16][A11].
- **D3 share** (contract, attestation, fork, attestor, outcomes, X4, Sybil cards) ≈ 5.75 pd, about 24%, inside the ~30% TRACE budget (CR18).

**Cut order** (apply at the day-3 checkpoint, in this order):
1. ERC-7579 / 7702 shaping: already outside the estimate; stays cut (0).
2. Halmos; keep the fuzzing and I1-I9: -1.0, giving ≈ 23.35.
3. Mainnet bounty; keep the testnet bounty: already outside the estimate (0).
4. X4 on the partitioned regime only: -0.5, giving ≈ 22.85.
5. X3 mainnet x402 test; the fork proof X2 stands: -0.5, giving ≈ 22.35.
6. MCP server replaced by plain HTTP tools: -0.25, giving ≈ 22.1.
7. Projector rig replaced by a recorded run: -0.25, giving ≈ 21.85.
8. D3-lite: a scripted attestor (real EIP-712 signatures, fixed tiers, no TRACE port) and no X4: -2.5, giving ≈ 19.35.
9. NFT balance meter, and the eth_call outcome simulation (the owner signs the decoded maxOutflow instead): -0.5, giving ≈ 18.85.

**Fit.**
- 4 people: on the line after step 5 (≈ 22.35 of ≈ 22.4); comfortable after step 7.
- 3 people: do not fit even after step 9 (≈ 18.85 vs ≈ 16.8, about 2 pd over). They need 2-3 extra days, or D3-lite plus every earlier cut.
- 2 people: the first-pass 2-person variant plus the D3 contract with a scripted attestor only.
- Team size and duration are user decisions at the approval gate. The 20% buffer is never spent on scope.

## Optional spike

Skipped. Foundry is not installed on this machine, and there is no dataset [P15]. The first build task (Phase E) is the spike: a Foundry test where a naive account that accepts the agent key in `isValidSignature` loses USDC to an EIP-3009 `transferWithAuthorization` with no UserOp, and the one-door account refuses. It will be logged as X2.

Re-run 2: an X4 spike was checked and skipped. The public Trace_CIKM tree has no package.json and lacks three imported modules [E58], so it does not run as published. Making it runnable and reproducing one Table 1 cell is X4's step 0 in the build [A21][X4].
