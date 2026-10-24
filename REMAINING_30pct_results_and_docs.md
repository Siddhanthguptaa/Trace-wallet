# REMAINING WORK, PART 2 of 2 (about 30%): final results, reports, threat model, README, claims check

Build root: `C:\Users\siddh\Downloads\Hypnexis\Hypnexis`. Effort is in rough working minutes (about 115 min of the ~370 min left, so about 31%). Part 1 is `REMAINING_70pct_integration_and_release.md`.

**Currently running in the background (do not duplicate):**
- A "DOCS" fork owns items 3-6 (threat model, reports, README, claims checker). Check `DECISIONS.md` for `[DOCS]` lines first.
- The final X6 rerun (`tools/x6_run.ts --seeds 42-61`, log `results/x6_scored_run2.log`) and the LLM shooter (`agent/src/shooter/llm.ts`, log `agent/out/x1_llm_full.log`) are running; items 1 and 2 are reading their output.

## Tasks

| # | Task | Min | Done when |
|---|---|---|---|
| 1 | **Final X6 rerun check.** The scored run was repeated after the harness fixes (attacker transactions are now awaited, pinned freeze thresholds applied to every AgentAccount). When all four `results/x6_runs_<mode>.jsonl` have 260 lines and `results/x6_detection.json` is rewritten, diff it against the first scored run (`results/dev/x6_detection_prev_scored.json`). Identical or within noise: keep. Different: find out why before publishing any number | 10 | `lossAssertHeld` true in all modes; diff explained |
| 2 | **LLM column.** Wait for `results/x1_llm.json` (4 configs x 4 injection cards x n=5, qwen2.5-coder:7b, temperature 0, seeds 42-46). Check the control card spends nothing extra, and that R1/R2 are actually hijacked (otherwise "0 hijacked on R3/R4" is vacuous). Report k/n and mean loss per cell, never the best run | 10 | file has `status:"ran"` and 80 runs |
| 3 | **`docs/THREAT_MODEL.md`**: assets, actors, trust assumptions; table attack -> defense -> exact test name for the 13 X1 cards, H1-H9, invariants I1-I14, fumble rows F1-F31 and traps T1-T12. Every test name must be grepped from the repo. Honest limits: 3 colluding guardians win after 48 h if the owner never vetoes; a thief with the owner key can veto/reset guardians; registered vouchers survive recovery (bounded by caps and the 600 s TTL); T1 never fires at the pinned 12 USDC because the 10 USDC burst bucket caps an hour below it; H2 slow drain evades detection (4/20) but is bounded; gas overhead 155k; self-graded synthetic workloads; mock facilitator until X3 | 30 | every test name exists |
| 4 | **`docs/x6_report.md`, `docs/x1_report.md`, `tools/render_reports.py`**: tables generated from the result JSON, every number followed by a marker `[r:<file>#<dotted.key>]` (convention of `docs/x4_report.md`) | 25 | `python tools/render_reports.py` reproduces both files |
| 5 | **`README.md`**: one-liner, ASCII architecture, Phase 1 and Phase 2 checklist with where each requirement is proven, Results section (X1 R2 vs ours, X6 detection / containment / false-freeze with Wilson CIs, I11 coverage, recovery 25/25, gas, paymaster drain, X4 H1 = false stated plainly), honest limits, exact reproduction commands | 20 | every result number carries a marker |
| 6 | **`tools/check_claims.py`**: rebuild each marked value from its JSON and fail on mismatch, missing key, or an unmarked number in a Results section (include `docs/x4_report.md`) | 20 | `python tools/check_claims.py` exits 0 |

Total about 115 min.

## Order and hand-offs
1. Items 1-2 first (they decide the numbers), then 3-6 can run in parallel.
2. After items 1 and 2 land: `python tools/render_reports.py && python tools/check_claims.py`. Hand over to Part 1 task 7 (final Gate G).
3. Numbers come from the JSON files, never from memory.

## Facts to carry (verified today, scored seeds 42-61, first scored run; recheck in item 1)
- X6 combined: detection 116/120 runs that reached the wallet (96.7%, Wilson CI 91.7-98.7%); containment 180/180; false freezes 0/80; max attacker gain 17.96 USDC against the 20 USDC daily limit; max loss to unproven payees 0.496 USDC against the 1 USDC exploration cap. With no detector at all: containment 180/180, max gain 18.16 USDC.
- X1 (both readers, 49 cells, 0 disagreements): R4 loses 0 beyond policy on every card; R2 loses on side door, ticket-to-attacker, greedy merchant and midnight double spend; R4 `legit_only` blocks 0 and needs 0 approvals.
- Thresholds were pinned on dev seeds 1-3 (sweep setting S2, velocity 6000 bps, spend-CUSUM h 0.5) before any scored seed.
