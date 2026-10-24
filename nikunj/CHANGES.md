# CHANGES requested by user (2026-10-24), to apply in Phase D re-run

Source: user-supplied external review of IDEA.md + orchestrator's merge of earlier suggestions + user's real-payment asset. User goal: make IDEA.md as strong as possible against other teams. Do not claim "unbeatable"; claim only what is tagged.

## C0 Correction to the external review
The review says "only Zodiac Roles does parameter conditions, so this strengthens novelty". Wrong framing. Per-parameter rules also appear in Kernel call policy [E6] and likely Smart Sessions action policies [E7] (verify). Parameter rules are a gap fix / table stakes, NOT a differentiator. Novelty stays D1 + D2. Fix RESEARCH.md line ~668 wording if a fetched source shows other engines with parameter conditions.

## HIGH (must be in IDEA.md)
- C1 Write the Policy struct in IDEA.md: every field, type, unit, written meaning, which phase checks it (validation vs execution), default. Include: owner, agent key, validAfter/validUntil, revoked, nonce key, per-asset perTxCap + dailyCap (token bucket), account-wide global cap across all session keys (C11), target+selector rules with argument rules (C2), recipient set, gas caps + gas credit, velocity cap (C13), 1271 mode flag (C5).
- C2 Per-selector argument rules: "arg k == this account" / "arg k in recipient set" / "arg k <= bound". Closes the "buy(ticketId, recipient=0xEvil)" hole. Add card "ticket to attacker".
- C3 NFTs: block ERC-721/1155 safeTransferFrom, transferFrom, approve, setApprovalForAll for the agent by default (or argument rule: spender/to must be in set). Received tickets are held, not movable by agent. Add card "setApprovalForAll to attacker" and "ticket forwarded to attacker".
- C4 Agent-wallet interface: MCP server (tools: get_policy, get_budget, check, pay_x402, buy, request_approval, approval_status) + on-chain view `checkPolicy(callData) -> (ok, reasonCode)` so agent routes to approval instead of burning gas credit. Note checkPolicy cannot see execution-phase metering; agent also runs eth_call simulation.
- C5 1271 default = owner key only. The x402 voucher exception (D1 envelope) is ON only if day-0 test A10 passes. D1 story unchanged either way (side door closed); only the native-x402-for-agent UX depends on A10.
- C6 Approval backend spec: pending request store (DB or on-chain pending hash, pick one, justify; on-chain pendingHash gives audit trail), notification path to owner's phone, who submits the owner-signed op (backend relayer or owner wallet), how agent learns result (MCP approval_status / event), and what service produces simulated outflow (eth_call / anvil fork simulation; contract still enforces maxOutflow, so simulation error can only revert).

## From earlier merged suggestions
- C7 Demo centrepiece: agent private key shown on projector; judges invited to move funds BEYOND POLICY (spending within caps at allowed shops is allowed and is the stated bound). Testnet only (Base Sepolia, faucet USDC), fresh key, only after invariants + Slither pass. Scoreboard counts "funds moved beyond policy".
- C8 Owner approval on phone: owner signer = user's MetaMask (mobile) via EIP-712 signTypedData; WalletConnect/MetaMask deep link from the approval card. Passkey owner (WebAuthn P-256 via RIP-7212 precompile on Base) = stretch; verify Base P-256 precompile with a fetched source before claiming. Owner key recovery: out of scope, say so.

## Real payment (user asset)
- C9 User holds USDC in a MetaMask wallet on Base mainnet. Day-0 test X3: deploy agent smart account on Base mainnet, fund ~1 USDC from MetaMask, pay user's own live TRACE x402 endpoint (POST /v1/x402/score, $0.005 USDC, Base mainnet, listed on Coinbase x402 directory; see D:\trace-api\README.md section 6) with a contract signature. Result decides A10 and C5. Gives a real mainnet x402 receipt for the pitch. Need a little Base ETH for deploy/gas or a paymaster (unknown; ask user only if blocking).
- C10 Key separation rule in IDEA.md: MetaMask key/seed never in .env, repo, agent or projector; projector key is testnet-only; mainnet agent account holds only a small top-up (allowance-wallet rule).

## MEDIUM / LOW (add if they fit capacity; else list in cut table with reason)
- C11 Account-wide cap across all session keys (bound is no longer N x dailyCap).
- C12 Onboarding: CREATE2 account factory (staked-factory note from E2/STO-021), deploy+fund flow, session-key handoff to agent, policy edit UI, session-key rotation (R14).
- C13 Velocity cap (tx per hour).
- C14 "Approve and always allow" on approval card (adds shop to allowlist, owner-signed) to fight approval fatigue (T11).
- C15 Owner activity feed from decision-log events.
- C16 More invariants: agent never changes policy/owner/modules; 1271 never accepts agent sig without matching voucher; reclaim never double-credits; global cap holds across keys.
- C17 ERC-7715-shaped permission request in front of the enforcement (RESEARCH gap row ~666). Also check MetaMask Advanced Permissions / Delegation Toolkit (ERC-7715/7710) as prior art and competitor; fetch + verify before citing.

## Rules for the re-run
- New external facts (Kernel param rules, Smart Sessions param rules, RIP-7212 on Base, MetaMask 7715) must be fetched and added to RESEARCH.md with quotes before IDEA.md cites them. Unverifiable = mark as assumption.
- Re-check time budget (C7-C17 add work); update cut table and 2/3/4-person variants honestly.
- Re-run red team and claims/sources checks over the new IDEA.md.

# CHANGE REQUEST 2: C18-C31 (user, 2026-10-24; full text in CHANGE_REQUEST.md)

User asked to modify "the plan" (IDEA.md + WIN.md + EXPERIMENTS.md + HANDOFF.md) and build the backend only, in milestones. Order: Phase C re-run (C18 touches novelty), then Phase D, then the approval gate. Facts marked [ORCH] in CHANGE_REQUEST.md were re-fetched and verified in Phase C before any citation (RESEARCH.md E34 extension and new entries).

## Novelty and design
- C18 D3 TRACE two-track recipient policy, added to D1/D2 (does not replace them): proven payees use normal caps; unproven, cold-start or unattested payees share an on-chain exploration budget (a small slice of the daily cap, tight per-tx cap), charged with the D2 measured outflow; flagged payees go to owner approval or block. Pitch: "spending limits bound how much; TRACE bounds who". Hook: TRACE section 7.1 "separate tracks with independent budgets" (future work). Hard bound: loss to new payees <= exploration budget per window, even with an injected agent. Weight: about 70% wallet + red team, about 30% TRACE, one slide.
- C19 EIP-712 ScoreAttestation{recipient, tier, validUntil, epoch}, domain {name, version, chainId, verifyingContract = wallet}; carried in userOp.signature; ecrecover against an owner-set, owner-rotatable attestor; validation reads only account storage; validUntil folded into validationData (min with session expiry), no TIMESTAMP; missing or expired = unproven; attestor key separate from agent key and host; honest bound if the attestor is compromised: loss stays within globalCap; per-key gas caps against execution-revert gas griefing.
- C20 Outcome signal for TRACE: x402 settlement + delivery check, ERC-8004 feedback, or owner/verifier-signed outcome; never agent-only; the attestor consumes outcomes and re-scores.
- C21 TRACE paper facts (score components and weights, setup, Tables 1, 2, 8, 9, section 7.1 recovery attempts, density boundary, N=5000, sections 7.5-7.6 limits, cited [14] Xiong and [15] Xia & Wang) and two honesty traps: (a) one wallet is a partitioned view, so per-wallet scoring needs exploration; (b) simulated agents + density boundary + false positives.
- C31 Paper inconsistency: cite 5.0x (32.0 vs 6.4, Table 9) for greedy vs Thompson under partitioned views; 6.8x is greedy-partitioned vs greedy-centralized (32.0 vs 4.7). Do not repeat the inconsistency in the pitch.

## Experiments and proofs
- C22 X4 simulator sweep: fork Trace_CIKM, add TRACE + exploration budget B (greedy on proven, Thompson on unproven, spend capped at B), B in {0,1,2,5,10}%, 4 attacks x 10 seeds, sparse-centralized and partitioned regimes; metrics fraud, MR, served-honest; baselines full, no-bandit, REPUTATION, EigenTrust; Pareto plot; pre-registered hypothesis; no claim before runs.
- C23 Proof layer: Foundry invariant fuzzing (no agent op sequence moves > globalCap + exploration budget per window per asset across keys), Halmos on the bounded policy-check function, THREAT_MODEL.md mapping attack -> defense -> test name.
- C24 Results table extends X1: rows raw key / static allowlist + caps / ours without D3 / ours with D3; about 10 attacks incl. Sybil-payee and prompt-injection cards; metrics funds lost and legit new-payee payments blocked.
- C25 Fumble checklist: TIMESTAMP ban, gas griefing, ERC-20 approve/transferFrom/approve-MAX, 1271/Permit2/EIP-2612, self-call/delegatecall/nested batch/splitting, owner approval EIP-712 single use + expiry + binding.

## Pitch, scope, time
- C26 Real incidents: Freysa (manipulation) and aixbt (dashboard/control compromise), one per threat in the brief.
- C27 Projector bounty: announce the maximum extractable amount (exploration budget per window) first; testnet default; mainnet only after X1 + fuzzing/Halmos pass and rules allow; prerequisites gas caps, 1271 owner-only, self-call block, batch-aware caps.
- C28 Credibility: "TRACE, CIKM '26 (Rome, Nov 7-11 2026)"; the ICLR submission is "under review" and is not described.
- C29 Build backend only, multi-milestone: contracts + Foundry tests, proofs, deploy scripts; services (TRACE attestor ported from Trace_CIKM, approval store with eth_call simulation, outcome ingestion); agent runner + attack harness writing the results table as CSV/JSON; X4 scripts and plots. Out: web frontend, dashboard, mobile UI; owner approval via scripted signer + typedData/passkey test vectors.
- C30 Re-budget with D3 + X4 + proofs and keep an explicit cut order (7579/7702 shaping, Halmos, mainnet bounty, X4 partitioned-only).

## Status
- Phase C re-run 2 (2026-10-24): applied in SWAPS.md (re-run rows), WIN.md (F23-F35, CR25 checklist, N13-N20, pick and honesty test, time budget and cut order), NOVELTY.md (D3 section), EXPERIMENTS.md (X1 table, X4 pre-registration, X5), ASSUMPTIONS.md (A18-A23), RESEARCH.md (E34 extended from the full PDF; new entries; failure-map rows). Phase D must carry these into HANDOFF.md and IDEA.md.
