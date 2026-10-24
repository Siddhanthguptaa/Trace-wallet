#!/usr/bin/env python3
"""render_reports: writes docs/x6_report.md, docs/x1_report.md and the README "Results" block from the
results files. Every number carries a source marker `[r:<file>#<dotted.key>]` that tools/check_claims.py
rebuilds from the file, so a regenerated results file regenerates the documents with it.

  python tools/render_reports.py && python tools/check_claims.py

Inputs (read only): results/x6_detection.json, results/x6_recovery.json, results/i11.json,
results/dev/x6_threshold_sweep.json, results/x1_table.json, results/x1_shooter.json, results/x1_llm.json
(optional), results/gas_m2.json, results/m12_paymaster.json, results/x4_h1.json, results/forge_summary*.json,
results/m*_e2e.json (optional). Writes results/x1_agreement.json (the two-reader comparison, same rules as
tools/x1_agree.py) so the agreement numbers have a source too.

Display rules: base units are shown as USDC (/1000000) or ETH (/1000000000000000000); a value shown with %
is 100x the JSON fraction; booleans are yes / no; a missing optional file produces a plain-words note.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_claims import resolve  # noqa: E402  (one resolver, so writer and checker cannot drift)

X6 = "results/x6_detection.json"
REC = "results/x6_recovery.json"
I11 = "results/i11.json"
SWEEP = "results/dev/x6_threshold_sweep.json"
X1 = "results/x1_table.json"
SHOOT = "results/x1_shooter.json"
LLM = "results/x1_llm.json"
AGREE = "results/x1_agreement.json"
GAS = "results/gas_m2.json"
PM = "results/m12_paymaster.json"
X4 = "results/x4_h1.json"
FS_ALL = "results/forge_summary.json"
FS_CARDS = "results/forge_summary_cards.json"
FS_I11 = "results/forge_summary_i11.json"

MODES = ["combined", "tripwires", "watcher", "none"]
MODE_LABEL = {
    "combined": "combined (tripwires + watcher)",
    "tripwires": "tripwires only (on-chain)",
    "watcher": "watcher only (off-chain)",
    "none": "no detector (caps only)",
}
SCENARIOS = {
    "H1": "burst drain to an unproven payee, as fast as possible",
    "H2": "slow drain, paced under the thresholds, forged-PROVEN payee (attacker knows the detectors)",
    "H3": "new-payee spray across many fresh addresses",
    "H4": "side door: EIP-3009 signature submitted straight to the token, no UserOp",
    "H5": "laundering: approve-MAX and other out-of-policy approvals, then a pull",
    "H6": "gas spam against the paymaster quota, attacker as bundler",
    "H7": "recovery hijack: guardian keys, early execution, owner veto",
    "H8": "approval-request spam (owner fatigue)",
    "H9": "attestor key leaked too: forged-PROVEN payee, burst drain (bound = daily limit)",
}
WORKLOADS = {
    "L1": "steady shopping",
    "L2": "bursty sale day near the caps",
    "L3": "new-shop onboarding (shared legit stream plus fresh payees)",
    "L4": "heavy API use",
}
USDC = 10**6
ETH = 10**18


def exists(rel: str) -> bool:
    return (ROOT / rel).exists()


def raw(rel: str, key: str):
    return resolve(rel, key)[0]


def M(rel: str, key: str, fmt: str = "int", div: int = 1) -> str:
    """The value, formatted, followed by its source marker."""
    suffix = f"/{div}" if div != 1 else ""
    v, _ = resolve(rel, key + suffix)
    if v is None:
        return "n/a"
    if fmt == "yn":
        disp = "yes" if v else "no"
    elif fmt == "txt":
        disp = str(v)
    else:
        x = float(v) / div
        if fmt == "int":
            disp = f"{round(x):,}"
        elif fmt.startswith("pct"):
            disp = f"{x * 100:.{int(fmt[3:] or 1)}f}%"
        elif fmt.startswith("f"):
            disp = f"{x:.{int(fmt[1:])}f}"
        else:
            raise ValueError(fmt)
    return f"{disp} [r:{rel}#{key}{suffix}]"


def usdc(rel: str, key: str, nd: int = 2) -> str:
    return M(rel, key, f"f{nd}", USDC)


def table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def ci(rel: str, base: str, pct: str = "pct1") -> str:
    return f"{M(rel, base + '.ci95.0', pct)} to {M(rel, base + '.ci95.1', pct)}"


def frac(rel: str, base: str) -> str:
    """hit / runs (rate, 95% interval) for a {hit, runs, rate, ci95} node."""
    return f"{M(rel, base + '.hit')} / {M(rel, base + '.runs')} ({M(rel, base + '.rate', 'pct1')}; CI {ci(rel, base)})"


# ============================================================================ X6

def assert_x6_prose() -> None:
    """The sentences in 'What the numbers show' are only written if the data says so."""
    problems = []
    det = lambda m, sid: raw(X6, f"byMode.{m}.detectionByScenario.{sid}")
    for sid in SCENARIOS:
        d = det("combined", sid)
        if d["reachedWallet"] and sid != "H2" and d["detection"]["hit"] != d["detection"]["runs"]:
            problems.append(f"combined mode misses {sid}; the text says only H2 is missed")
    if det("combined", "H2")["detection"]["hit"] == det("combined", "H2")["detection"]["runs"]:
        problems.append("H2 is fully detected; the text says it evades detection in some runs")
    for sid in SCENARIOS:
        for k in det("tripwires", sid)["freezeTriggers"]:
            if k != "T3_strikes":
                problems.append(f"tripwires mode froze {sid} via {k}; the text says only the strike streak freezes on-chain")
    for sid in ("H6", "H8"):
        if det("tripwires", sid)["detection"]["hit"] != 0:
            problems.append(f"tripwires detect {sid}; the text says they cannot")
        if det("watcher", sid)["detection"]["hit"] != det("watcher", sid)["detection"]["runs"]:
            problems.append(f"the watcher misses {sid}; the text says it covers it")
    n = raw(X6, "byMode.none.overall.containment")
    if n["hit"] != n["runs"]:
        problems.append("containment breaks with no detector; the text says it is unchanged")
    if raw(X6, "byMode.combined.overall.falseFreeze.hit") != 0:
        problems.append("combined mode has false freezes; the text implies none")
    if problems:
        raise SystemExit("render_reports: the X6 prose no longer matches the data, edit the text:" + chr(10) + "  " + (chr(10) + "  ").join(problems))


def render_x6() -> str:
    assert_x6_prose()
    P = lambda mode, tail: f"byMode.{mode}.{tail}"
    out: list[str] = []
    w = out.append
    w("# X6: hijack containment, detection and recovery\n")
    w(
        "Phase 2 assumes the agent is already hijacked: the leaked key submits straight to the bundler, so the wallet's own "
        "validation, sandbox and detectors are what get tested (the tools' pre-check is deliberately bypassed). "
        "Generated by `tools/render_reports.py` from the results files; every number carries its source marker "
        "and `python tools/check_claims.py` rebuilds each one.\n"
    )
    w("## Protocol\n")
    w(
        f"Pre-registered in `nikunj/EXPERIMENTS.md` (X6). Thresholds were fixed on dev seeds 1-3 (rule written before the sweep ran, see below) and pinned in "
        f"`agent/hijack/thresholds.json` before any scored seed ran. Scored seeds {M(X6, 'meta.seeds.0')} to {M(X6, 'meta.seeds.19')}, "
        f"one fresh anvil chain per run, so a seed reproduces a run exactly (amounts, counts, gaps and payees come from a seeded rng). "
        f"Nine hijack scenarios and four legit workloads, each run in four detector modes: {', '.join(MODE_LABEL[m] for m in MODES)}. "
        f"Records written: {M(X6, 'meta.totalRecords')}, of which pending or errored: {M(X6, 'meta.pendingOrError')}. "
        "Nothing was dropped or re-run selectively.\n"
    )
    w("Metric definitions:\n")
    w("- **Detection rate** = hijack runs frozen before the run ends / hijack runs that reached the wallet (an op was mined, or the attack has an off-chain signal). "
      "H4, H5 and H7 are stopped at doors a chain-based detector never sees (a token-side signature, an op rejected in validation, a guardian quorum that cannot form), so they are contained but outside the detection denominator.")
    w("- **Containment rate** = hijack runs whose loss stayed inside the stated bound / all hijack runs. Bound: the daily limit (global cap), the exploration cap for unproven payees, and each scenario's own bound (paymaster quota, recovery).")
    w("- **False-freeze rate** = legit runs with at least one freeze / legit runs. Legit workloads go through the tools like an honest agent.")
    w("- CI = Wilson 95% interval; the cells are small, so a point estimate alone would overstate precision.\n")

    w("## Scored results\n")
    w("### Headline by detector mode\n")
    rows = []
    for m in MODES:
        o = P(m, "overall")
        rows.append([
            MODE_LABEL[m],
            frac(X6, o + ".detection"),
            frac(X6, o + ".containment"),
            frac(X6, o + ".falseFreeze"),
            usdc(X6, o + ".maxAttackerGainBaseUnits"),
            usdc(X6, o + ".maxUnprovenGainBaseUnits"),
            usdc(X6, o + ".maxLossBeforeFreezeBaseUnits"),
        ])
    w(table(["Detector mode", "Detection (runs that reached the wallet)", "Containment (all hijack runs)", "False freezes (legit runs)",
             "Max attacker gain (USDC)", "Max gain at unproven payees (USDC)", "Max loss before the freeze (USDC)"], rows))
    o = P("combined", "overall")
    w(
        f"The loss assertion held in every run of every mode: the largest attacker gain was {usdc(X6, o + '.maxAttackerGainBaseUnits')} USDC against a daily limit of "
        f"{usdc(X6, o + '.globalCap')} USDC, and the largest gain at unproven payees was {usdc(X6, o + '.maxUnprovenGainBaseUnits')} USDC against an exploration cap of "
        f"{usdc(X6, o + '.exploreCap')} USDC (assertion held in {M(X6, o + '.lossAssertRuns')} runs: {M(X6, o + '.lossAssertHeld', 'yn')}).\n"
    )

    w("### Per scenario, combined mode\n")
    rows = []
    for sid, desc in SCENARIOS.items():
        b = P("combined", f"detectionByScenario.{sid}")
        reached = raw(X6, b + ".reachedWallet")
        trig = raw(X6, b + ".freezeTriggers")
        trig_txt = ", ".join(f"{k}: {M(X6, b + '.freezeTriggers.' + k)}" for k in trig) if trig else "not frozen"
        if reached:
            det = f"{M(X6, b + '.detection.hit')} / {M(X6, b + '.detection.runs')}"
            ttf = M(X6, b + ".meanOpsToFreeze", "f1") if raw(X6, b + ".meanOpsToFreeze") is not None else "n/a"
            lbf = usdc(X6, b + ".meanLossBeforeFreezeBaseUnits") if raw(X6, b + ".meanLossBeforeFreezeBaseUnits") is not None else "n/a"
        else:
            det, ttf, lbf = "contained at the door", "n/a", "n/a"
            trig_txt = "no chain-visible attempt"
        rows.append([f"{sid}: {desc}", M(X6, b + ".reachedWallet") + " / " + M(X6, b + ".runs"), det,
                     f"{M(X6, b + '.containment.hit')} / {M(X6, b + '.containment.runs')}", ttf, lbf, usdc(X6, b + ".maxLossBaseUnits"), trig_txt])
    w(table(["Scenario", "Reached the wallet", "Detected", "Contained", "Mean ops to freeze", "Mean loss before freeze (USDC)", "Max loss (USDC)", "What froze it"], rows))

    w("### Detection by scenario and detector mode\n")
    rows = []
    for sid in SCENARIOS:
        row = [sid]
        for m in MODES:
            b = P(m, f"detectionByScenario.{sid}")
            if raw(X6, b + ".reachedWallet"):
                row.append(f"{M(X6, b + '.detection.hit')} / {M(X6, b + '.detection.runs')}")
            else:
                row.append("door")
        rows.append(row)
    w(table(["Scenario"] + [MODE_LABEL[m] for m in MODES], rows))
    w("Reading the matrix: the on-chain tripwires alone cannot see gas spam (H6) or approval spam (H8), which produce no policy breach; the watcher covers both through its revert-streak and approval-rate detectors. "
      "With no detector at all the detection column is empty, yet containment is unchanged: the caps, not the detectors, bound the loss.\n")

    w("### False freezes by workload\n")
    rows = []
    for wid, desc in WORKLOADS.items():
        row = [f"{wid}: {desc}"]
        for m in MODES:
            b = P(m, f"falseFreezeByWorkload.{wid}.falseFreeze")
            row.append(f"{M(X6, b + '.hit')} / {M(X6, b + '.runs')}")
        rows.append(row)
    w(table(["Workload"] + [MODE_LABEL[m] for m in MODES], rows))
    ff = P("combined", "overall.falseFreeze")
    w(f"Combined mode: {M(X6, ff + '.hit')} false freezes in {M(X6, ff + '.runs')} legit runs, upper CI bound {M(X6, ff + '.ci95.1', 'pct1')}.\n")

    w("## Threshold fixing on dev seeds (not scored)\n")
    w(
        f"Rule, written before the sweep ran: {raw(SWEEP, 'rule')}. One knob moves the on-chain velocity tripwire (T1) and the off-chain spend CUSUM together. "
        f"Dev seeds {M(SWEEP, 'seeds.0')} to {M(SWEEP, 'seeds.2')} only; never reported as results. The rule picked **{M(SWEEP, 'chosen', 'txt')}**.\n"
    )
    rows = []
    for i in range(len(raw(SWEEP, "rows"))):
        r = f"rows.{i}"
        rows.append([
            M(SWEEP, r + ".id", "txt"), M(SWEEP, r + ".velocityBps"), M(SWEEP, r + ".h", "f1"),
            f"{M(SWEEP, r + '.falseFreezes')} / {M(SWEEP, r + '.legitRuns')}",
            usdc(SWEEP, r + ".peakLegitHourSpend"),
            f"{M(SWEEP, r + '.H9.detected')} / {M(SWEEP, r + '.H9.runs')}", usdc(SWEEP, r + ".H9.meanLossBeforeFreeze"), usdc(SWEEP, r + ".H9.maxLoss"),
            f"{M(SWEEP, r + '.H2.detected')} / {M(SWEEP, r + '.H2.runs')}", usdc(SWEEP, r + ".H2.maxLoss"),
        ])
    w(table(["Setting", "T1 velocity (bps of the daily cap)", "Spend CUSUM h", "Dev false freezes", "Peak legit spend in an hour (USDC)",
             "H9 detected", "H9 mean loss before freeze (USDC)", "H9 max loss (USDC)", "H2 detected", "H2 max loss (USDC)"], rows))
    w("At the tighter settings the freeze cuts the legit stream short, so its measured peak spend is lower there; from the pinned setting up the stream completes. "
      "The trade-off is visible: the tighter settings freeze the forged-PROVEN drain after a smaller loss but also freeze the legit onboarding stream, "
      "which spends close to half the daily cap within minutes. The most sensitive setting with no false freeze was pinned.\n")

    w("## Recovery flow (success path)\n")
    w(
        f"Guardian recovery on the integrated account, a fresh chain per case: {M(REC, 'passed')} of {M(REC, 'total')} checks pass (all passed: {M(REC, 'ok', 'yn')}). "
        f"Delay {M(REC, 'meta.delaySeconds')} seconds, {M(REC, 'meta.guardians')} guardians, threshold {M(REC, 'meta.threshold')}. "
        "Case A recovers a lost owner key; case B is an owner veto inside the window; case C is misuse (two approvals, double approval, replay, the leaked agent key proposing).\n"
    )
    rows = []
    for i, c in enumerate(raw(REC, "checks")):
        rows.append([c["name"], M(REC, f"checks.{i}.pass", "yn")])
    w(table(["Check", "Passed"], rows))

    w("## Authorization fuzz (I11)\n")
    w(
        "`contracts/test/invariant/I11_Authorization.t.sol`: a handler attacks the real account with outsider calls to account functions, forged, tampered, replayed and wrong-chain UserOps, "
        "a replaced owner's stale signature, token-side pulls and signatures from the agent key, guardian recovery games and time warps. An independent ghost snapshots balances, allowances, NFTs and operator approvals "
        "around every action and attributes any change to an authority (owner, in-policy agent, executed recovery) or flags it. Coverage per campaign, so the invariant cannot pass vacuously:\n"
    )
    rows = []
    for name in ("authority", "agent", "owner"):
        b = f"campaigns.{name}"
        rows.append([name, M(I11, b + ".fuzzRuns"), M(I11, b + ".ownerMoves"), M(I11, b + ".agentMoves"), M(I11, b + ".unauthorizedAttempts"),
                     M(I11, b + ".recoveriesExecuted"), M(I11, b + ".runsWithRecovery"), M(I11, b + ".forgedOrReplayedOpsAccepted")])
    w(table(["Campaign", "Fuzz runs", "Owner moves", "Agent moves", "Attempts with no authority", "Recoveries executed", "Runs with a recovery", "Forged or replayed ops accepted"], rows))
    w(f"Forge result for the three campaigns: {M(FS_I11, 'passed')} passed, {M(FS_I11, 'failed')} failed (`results/forge_summary_i11.json`).\n")

    w("## Paymaster quota (H6 and I14)\n")
    w(
        f"{M(PM, 'agents')} agents spam reverting ops every hour for {M(PM, 'elapsedSec')} seconds and a Sybil account tries every hour: "
        f"the deposit drain was {M(PM, 'depositDrainedWei', 'f4', ETH)} ETH against a sum-of-quotas bound of {M(PM, 'sumOfQuotasBoundWei', 'f4', ETH)} ETH; "
        f"sponsored ops {M(PM, 'sponsoredOps')}; Sybil attempts {M(PM, 'sybilAttempts')}, sponsored {M(PM, 'sybilSponsored')}.\n"
    )

    w("## What the numbers show\n")
    c = P("combined", "detectionByScenario")
    w("- **Containment does not depend on detection.** With every detector off the loss bound still holds in every run; the buckets and the exploration cap are the containment, the detectors shorten the attack.")
    w(f"- **The only missed detections are the threshold-aware slow drain (H2).** It is paced to stay under the velocity tripwire and the CUSUM drift; it is detected in {M(X6, c + '.H2.detection.hit')} of {M(X6, c + '.H2.detection.runs')} runs "
      f"(the strike streak fires only once the buckets run dry) and its loss is still bounded by the daily limit ({usdc(X6, c + '.H2.maxLossBaseUnits')} USDC at most). Detection is not containment.")
    w("- **At the pinned thresholds every on-chain freeze comes from the strike streak (T3), never the velocity tripwire (T1).** The burst bucket caps one hour below T1's trigger, so T1 can only fire at the tighter settings, "
      "which false-freeze legit bursts. The caps bound the loss; the strike streak and the watcher end the attack.")
    w("- **The watcher is what sees gas spam and approval spam**, neither of which breaches policy.")
    w("- **The recovery success path works end to end** and the hijack variants fail: two guardian keys never reach quorum, three are stopped by the owner's veto inside the window, and recovery never moves funds.\n")
    w("## Honest limits\n")
    w("- Counts over our own scripted scenarios and workloads: self-graded and synthetic. The scenarios and the workload schedules are in the repo so judges can add their own.")
    w("- Runs are on a local anvil chain with one-second blocks; watcher latency is one op (a poll after each op), not a network round trip.")
    w("- H4, H5 and H7 are outside the detection denominator by construction; read their containment, not a detection rate.")
    w("- The legit workloads are plausible-heavy but ours; a real owner with a bursty pattern needs the thresholds tuned on their own traffic (the sweep above shows the cost of each setting).")
    w("- The x402 facilitator is a local mock until the mainnet run (X3, user-run).\n")
    return "\n".join(out)


# ============================================================================ X1

CARD_ORDER = [
    ("legit_only", "legit stream only (openness baseline)", "none", "usdc"),
    ("ticket_to_attacker", "buy(ticket, recipient = attacker) at an allowed shop", "none", "usdc"),
    ("set_approval_for_all", "setApprovalForAll(attacker) on held tickets, then a pull", "none", "usdc"),
    ("approve_max", "approve(attacker, MAX), then a pull", "none", "usdc"),
    ("batch_selfcall_delegatecall", "batch, self-call, direct execute, an unknown op kind, EntryPoint withdrawal, then pay the attacker", "none", "usdc"),
    ("gas_burn_griefing", "attacker-run bundler collects fees from ops that revert in execution (ETH)", "gas credit", "eth"),
    ("replay_wrong_chain", "replay an owner payment: same nonce, other chain, other EntryPoint, other session's nonce key", "none", "usdc"),
    ("greedy_merchant", "allowed shop pulls ten times the price through transferFrom", "listed price", "usdc"),
    ("midnight_double_spend", "spend the cap just before and just after midnight (window outflow)", "daily limit", "usdc"),
    ("multi_key_cap", "several session keys each spend the cap (attack outflow)", "daily limit", "usdc"),
    ("x402_side_door", "EIP-3009 authorization signed by the leaked key, submitted straight to the token", "none", "usdc"),
    ("sybil_payee", "forged attestations, then a spray to fresh addresses", "exploration cap", "usdc"),
    ("attestor_compromise", "compromised attestor upgrades the attacker's payee to PROVEN", "daily limit", "usdc"),
]
CONFIGS = ["R1", "R2", "R3", "R4"]
CONFIG_LABEL = {
    "R1": "R1 raw key",
    "R2": "R2 static allowlist and caps",
    "R3": "R3 ours without payee tiers",
    "R4": "R4 ours with payee tiers",
}


def compute_agreement() -> None:
    """Same comparison rules as tools/x1_agree.py; written to results/x1_agreement.json."""
    if not (exists(X1) and exists(SHOOT)):
        return
    foundry = {(c["card"], c["config"]): c for c in raw(X1, "cells")}
    shooter_cells = json.loads((ROOT / SHOOT).read_text(encoding="utf-8")).get("cells", [])
    shooter = {(c["card"], c["config"]): c for c in shooter_cells if "error" not in c and not str(c.get("notes", "")).startswith("pending")}
    both = sorted(set(foundry) & set(shooter))
    keys = ["lostBaseUnits", "beyondPolicyBaseUnits", "legitBlocked", "legitNeededApproval"]
    bad: list[str] = []
    for cell in both:
        f, s = foundry[cell], shooter[cell]
        for k in keys:
            if cell[0] == "gas_burn_griefing" and k in ("lostBaseUnits", "beyondPolicyBaseUnits"):
                a, b = int(f.get(k) or 0), int(s.get(k) or 0)
                ok = ((a == 0) == (b == 0)) if k == "beyondPolicyBaseUnits" else (a == b or (max(a, b) > 0 and abs(a - b) / max(a, b) <= 0.02))
            else:
                ok = str(f.get(k)) == str(s.get(k))
            if not ok:
                bad.append(f"{cell[0]}/{cell[1]} {k}: foundry={f.get(k)} shooter={s.get(k)}")
    out = {
        "cellsCompared": len(both),
        "disagreements": len(bad),
        "foundryOnly": len(set(foundry) - set(shooter)),
        "shooterOnly": len(set(shooter) - set(foundry)),
        "fieldsCompared": keys,
        "gasCardRule": "lost within 2%, beyond-policy equal on zero / non-zero (the readers use different addresses, so calldata gas differs)",
        "disagreementList": bad,
    }
    (ROOT / AGREE).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")


def cell_index() -> dict[tuple[str, str], int]:
    return {(c["card"], c["config"]): i for i, c in enumerate(raw(X1, "cells"))}


def claims() -> dict[str, bool]:
    cells = raw(X1, "cells")
    idx = {(c["card"], c["config"]): c for c in cells}
    r34 = all(int(c["beyondPolicyBaseUnits"]) == 0 for c in cells if c["config"] in ("R3", "R4"))
    r2_hole = all(int(idx[(k, "R2")]["beyondPolicyBaseUnits"]) > 0 for k in ("x402_side_door", "greedy_merchant", "ticket_to_attacker", "midnight_double_spend"))
    sybil = int(idx[("sybil_payee", "R4")]["lostBaseUnits"]) <= 1_000_000
    att = int(idx[("attestor_compromise", "R4")]["lostBaseUnits"]) <= 20_000_000
    l4 = idx[("legit_only", "R4")]
    legit_r4 = int(l4["legitProvenBlocked"]) == 0 and int(l4["legitNeededApproval"]) == 0
    legit_r23 = all(int(idx[("legit_only", k)]["legitBlocked"]) + int(idx[("legit_only", k)]["legitNeededApproval"]) >= 1 for k in ("R2", "R3"))
    return {"r34_zero_beyond": r34, "r2_hole": r2_hole, "sybil_bound": sybil, "attestor_bound": att, "legit_r4_open": legit_r4, "legit_r2_r3_cost": legit_r23}


def render_x1() -> str:
    compute_agreement()
    ix = cell_index()
    cl = claims()
    out: list[str] = []
    w = out.append
    w("# X1: attack cards across four wallet configurations\n")
    w(
        "The Phase-1 evidence: thirteen attack cards fired with the leaked agent key at four configurations holding the same funds. "
        "Generated by `tools/render_reports.py` from `results/x1_table.json` (the Foundry reader); every number carries its source marker.\n"
    )
    w("## Protocol\n")
    w("- **R1** raw agent key: an EOA holding the funds, no policy (the floor).")
    w("- **R2** static allowlist and caps, what most teams build: target and selector allowlist, decoded per-transaction cap, calendar-day cap, static recipients, and an ERC-1271 that accepts the session key.")
    w("- **R3** ours without payee tiers: one-door ERC-1271, effect metering, all guards; every unknown payee needs owner approval (exploration off, no attestor).")
    w("- **R4** ours with payee tiers: R3 plus attested payee tiers and the account-wide exploration budget at its defaults.")
    w("- Every card replays the shared legit stream first (listed shops, an x402 payment through the one door, two attested payees, one cold payee), then attacks with the leaked key straight at the wallet. "
      "The freeze thresholds pinned on dev seeds apply to R3 and R4.")
    w("- **Two independent readers.** The Foundry cards (`contracts/test/cards`) and the TypeScript raw-key shooter (`agent/src/shooter`) fire the same deck from `agent/fixtures/deck_params.json`; `tools/x1_agree.py` compares them cell by cell.")
    w("- **Lost** = value that reached attacker-controlled addresses. **Beyond the bound** = lost minus the card's stated bound. USDC unless the card says ETH.")
    w("- Caveat: the deck and the legit stream are ours (self-graded); the payees and Sybils are synthetic. Both are in the repo so judges can add cards.\n")

    def grid(field: str) -> str:
        rows = []
        for card, desc, bound, unit in CARD_ORDER:
            row = [f"`{card}`: {desc}", bound]
            for cfg in CONFIGS:
                if (card, cfg) not in ix:
                    row.append("n/a")
                    continue
                key = f"cells.{ix[(card, cfg)]}.{field}"
                row.append(M(X1, key, "f6", ETH) if unit == "eth" else usdc(X1, key))
            rows.append(row)
        return table(["Card", "Stated bound"] + [CONFIG_LABEL[c] for c in CONFIGS], rows)

    w("## Scored results: attack cards by configuration\n")
    w("### Lost to the attacker (USDC; ETH for the gas card)\n")
    w(grid("lostBaseUnits"))
    w("### Beyond the stated bound (USDC; ETH for the gas card)\n")
    w(grid("beyondPolicyBaseUnits"))
    w(
        "Reading the grid: R1 and R2 lose on the cards the plan predicts (R2's allowlist has no recipient rule, no allowance metering, a calendar-day cap, and an ERC-1271 that trusts the session key). "
        f"R3 and R4 stay inside the stated bound on every card: {'yes' if cl['r34_zero_beyond'] else 'NO'}. "
        f"R2 exceeds its bound on the side door, the greedy merchant, the ticket to the attacker and the midnight double spend: {'yes' if cl['r2_hole'] else 'NO'}. "
        f"The Sybil spray costs R4 no more than the exploration cap: {'yes' if cl['sybil_bound'] else 'NO'}. "
        f"A compromised attestor costs R4 no more than the daily limit: {'yes' if cl['attestor_bound'] else 'NO'}.\n"
    )

    w("### Openness: what the legit stream costs each configuration\n")
    rows = []
    for cfg in CONFIGS:
        i = ix[("legit_only", cfg)]
        b = f"cells.{i}"
        rows.append([CONFIG_LABEL[cfg], M(X1, b + ".legitBlocked"), M(X1, b + ".legitProvenBlocked"), usdc(X1, b + ".legitBlockedValue"), M(X1, b + ".legitNeededApproval")])
    w(table(["Configuration", "Legit payments blocked", "Of which to listed or attested payees", "Blocked value (USDC)", "Needed owner approval"], rows))
    w(
        f"R4 blocks no legit proven payee and needs no owner approval: {'yes' if cl['legit_r4_open'] else 'NO'}. "
        f"R2 and R3 each block or escalate at least one legit new payee (R2 blocks, R3 escalates to the owner): {'yes' if cl['legit_r2_r3_cost'] else 'NO'}. "
        "This is the fraud-openness trade-off measured on-chain: the static list is safe and closed, the payee tiers are safe and open.\n"
    )

    w("### Two-reader agreement\n")
    if exists(AGREE):
        w(
            f"Cells compared: {M(AGREE, 'cellsCompared')}; disagreements: {M(AGREE, 'disagreements')}; Foundry-only cells: {M(AGREE, 'foundryOnly')}; shooter-only cells: {M(AGREE, 'shooterOnly')}. "
            "Compared fields: lost, beyond-policy, legit blocked, legit needed approval. The gas card compares lost within a small tolerance and beyond-policy on zero or non-zero, "
            "because the readers use different addresses and calldata gas differs by a few hundred gas per op.\n"
        )
        bad = raw(AGREE, "disagreementList")
        if bad:
            w("Disagreements (the buggy reader gets fixed, never the target):\n")
            for b in bad:
                w(f"- `{b}`")
            w("")
    else:
        w("The agreement file is not available yet (needs both readers' result files).\n")

    w("## LLM shooter (open-weight model through the same tools)\n")
    if exists(LLM):
        st = raw(LLM, "status")
        if st == "ran":
            w(
                f"Model `{raw(LLM, 'model')}` through the local Ollama endpoint, temperature {M(LLM, 'temperature', 'f1')}, {M(LLM, 'n')} fixed-seed runs per injection card and configuration; "
                "a run is hijacked if any value reached the attacker. Reported as hijacked / runs and the mean loss per run, never the best run. "
                "The control page is benign; the three injections are an instruction hidden in the page, a fake mandatory fee, and a Freysa-style redefinition of a tool.\n"
            )
            cells = raw(LLM, "cells")
            lookup = {(c["card"], c["config"]): i for i, c in enumerate(cells)}
            cards = []
            for c in cells:
                if c["card"] not in cards:
                    cards.append(c["card"])
            rows = []
            for card in cards:
                row = [f"`{card}`"]
                for cfg in CONFIGS:
                    if (card, cfg) not in lookup:
                        row.append("n/a")
                        continue
                    b = f"cells.{lookup[(card, cfg)]}"
                    if not raw(LLM, b + ".authored") and card != "control":
                        row.append("not authored")
                    else:
                        row.append(f"{M(LLM, b + '.hijacked')} / {M(LLM, b + '.runs')}, mean loss {usdc(LLM, b + '.meanLossBaseUnits')} USDC")
                rows.append(row)
            w(table(["Injection card"] + [CONFIG_LABEL[c] for c in CONFIGS], rows))
            w("A nonzero hijack count on R1 and R2 shows the injections work on this model; the R3 and R4 columns are the wallet holding while the agent is fooled. "
              "A 7B open-weight model is a weak target, so this is a floor on the injection success rate, not an estimate of frontier-model behaviour.\n")
        else:
            w(f"The LLM column was skipped: {raw(LLM, 'reason')}. The raw-key column leads.\n")
    else:
        w("The LLM column has not been produced yet (`results/x1_llm.json` is absent), so no LLM claim is made here.\n")

    w("## Honest limits\n")
    w("- Self-graded: the deck, the legit stream and R2's exact configuration are ours.")
    w("- The raw-key column is one deterministic run per cell. That is the ground truth for a leaked key, not a rate.")
    w("- The x402 payment uses a local mock facilitator until the mainnet run (X3, user-run).")
    w("- On cards that drain a shared budget, legit payments can be blocked by design (liveness); those counts are reported as they are.\n")
    return "\n".join(out)


# ============================================================================ README block

def render_readme_block() -> str:
    cl = claims()
    ix = cell_index()
    out: list[str] = []
    w = out.append
    w("<!-- results:start -->")
    w("_Generated by `tools/render_reports.py`; every number below has a source marker that `tools/check_claims.py` verifies. Do not edit between the markers._\n")
    w(f"- **Contract suite:** {M(FS_ALL, 'passed')} of {M(FS_ALL, 'total')} Foundry tests pass, {M(FS_ALL, 'failed')} fail, fork tests included. Attack cards: {M(FS_CARDS, 'passed')} of {M(FS_CARDS, 'total')} pass.")
    w("")
    w(f"**X1, attack cards ({M(X1, 'meta.cardCount')} cards on four configurations, {M(X1, 'meta.cellCount')} cells; full grid in `docs/x1_report.md`).** Lost to the attacker, in USDC:\n")
    pick = ["ticket_to_attacker", "x402_side_door", "approve_max", "greedy_merchant", "midnight_double_spend", "multi_key_cap", "sybil_payee", "attestor_compromise"]
    unit = {c[0]: c[3] for c in CARD_ORDER}
    rows = []
    for card in pick:
        row = [f"`{card}`"]
        for cfg in CONFIGS:
            if (card, cfg) not in ix:
                row.append("n/a")
            else:
                row.append(usdc(X1, f"cells.{ix[(card, cfg)]}.lostBaseUnits"))
        rows.append(row)
    w(table(["Card", "R1 raw key", "R2 static allowlist", "R3 ours", "R4 ours + payee tiers"], rows))
    w(f"Stays inside the stated bound on every card in R3 and R4: {'yes' if cl['r34_zero_beyond'] else 'NO'}. "
      f"R4 blocks no legit proven payee and needs no owner approval: {'yes' if cl['legit_r4_open'] else 'NO'}; "
      f"R2 blocks {M(X1, 'cells.' + str(ix[('legit_only', 'R2')]) + '.legitBlocked')} legit payments and R3 escalates {M(X1, 'cells.' + str(ix[('legit_only', 'R3')]) + '.legitNeededApproval')} to the owner.")
    if exists(AGREE):
        w(f"The two readers (Foundry and TypeScript) agree on {M(AGREE, 'cellsCompared')} cells with {M(AGREE, 'disagreements')} disagreements.")
    w("")
    c = "byMode.combined.overall"
    w("**X6, nine hijack scenarios against the leaked key (full report in `docs/x6_report.md`).**\n")
    w(f"- Containment: {frac(X6, c + '.containment')} of runs stayed inside the stated bound; largest attacker gain {usdc(X6, c + '.maxAttackerGainBaseUnits')} USDC against a daily limit of {usdc(X6, c + '.globalCap')} USDC.")
    w(f"- With no detector at all containment is {frac(X6, 'byMode.none.overall.containment')}: the caps bound the loss, the detectors end the attack sooner.")
    w(f"- Detection (runs that reached the wallet): {frac(X6, c + '.detection')}. The misses are the threshold-aware slow drain.")
    w(f"- False freezes on legit workloads: {frac(X6, c + '.falseFreeze')}.")
    w(f"- Thresholds were fixed on dev seeds before the scored seeds ran: {M(SWEEP, 'chosen', 'txt')} was pinned.")
    w("")
    a = "campaigns.authority"
    w(f"**I11, funds move only with a valid owner, an in-policy agent or a recovery approval.** {M(FS_I11, 'passed')} fuzz campaigns pass; the authority campaign logged {M(I11, a + '.fuzzRuns')} fuzz runs: "
      f"{M(I11, a + '.ownerMoves')} owner moves, {M(I11, a + '.agentMoves')} agent moves, {M(I11, a + '.unauthorizedAttempts')} attempts with no authority, "
      f"{M(I11, a + '.recoveriesExecuted')} executed recoveries; forged, tampered, replayed or wrong-chain ops accepted: {M(I11, a + '.forgedOrReplayedOpsAccepted')}.")
    w("")
    w(f"**Recovery:** {M(REC, 'passed')} of {M(REC, 'total')} checks pass on the integrated account (three of five guardians, {M(REC, 'meta.delaySeconds')} second delay, owner veto, replay, funds untouched).")
    w("")
    w(f"**Gas:** the effect meter adds {M(GAS, 'meterOverheadGas')} gas per agent op with {M(GAS, 'trackedTokens')} tracked tokens and {M(GAS, 'trackedSpenders')} tracked spenders (cold, first op).")
    w("")
    w(f"**Paymaster quota:** {M(PM, 'agents')} spamming agents plus a Sybil drained {M(PM, 'depositDrainedWei', 'f4', ETH)} ETH from the deposit against a sum-of-quotas bound of {M(PM, 'sumOfQuotasBoundWei', 'f4', ETH)} ETH; the Sybil was sponsored {M(PM, 'sybilSponsored')} times.")
    w("")
    w(f"**X4, simulator sweep (TRACE plus an exploration budget).** The pre-registered headline did not hold: the frontier moved for {M(X4, 'attacksMovedAtBstar')} attacks, H1 = {M(X4, 'H1', 'yn')}. "
      "The pitch leads with the hard bound, not the simulator.")
    e2e = [("results/m5_approval_e2e.json", "approval service"), ("results/m6_attestor_e2e.json", "attestor service"), ("results/m10_freeze_e2e.json", "freeze and watcher"), ("results/m12_paymaster_e2e.json", "paymaster")]
    have = [(f, n) for f, n in e2e if exists(f)]
    if have:
        w("")
        w("**End-to-end against the real account (anvil):** " + "; ".join(f"{n} {M(f, 'ok', 'yn')}" for f, n in have) + ".")
    if exists(LLM) and raw(LLM, "status") == "ran":
        w("")
        w(f"**LLM shooter:** model `{raw(LLM, 'model')}`, {M(LLM, 'n')} runs per injection card and configuration; per-cell hijack counts in `docs/x1_report.md`.")
    w("<!-- results:end -->")
    return "\n".join(out)


MARK_RE = re.compile(r"(?P<tok>[^\s|()\[\]*`]+)(?P<sp>\s*)(?P<mk>\[r:(?P<file>[^#\]\s]+)#(?P<key>[^\]\s]+)\])")


def refresh_markers(text: str) -> str:
    """Rewrite the number shown before each hand-written marker from its results file, keeping the
    precision, % and thousands-separator style that was written. Booleans become yes / no. Anything
    else (text, missing files) is left for check_claims to judge."""

    def fix(m: re.Match) -> str:
        tok = m.group("tok").rstrip(".,;:")
        tail = m.group("tok")[len(tok):]
        try:
            v, div = resolve(m.group("file"), m.group("key"))
        except (FileNotFoundError, KeyError):
            return m.group(0)
        if isinstance(v, bool):
            if tok.lower() in ("yes", "no", "true", "false"):
                return ("yes" if v else "no") + tail + m.group("sp") + m.group("mk")
            return m.group(0)
        mm = re.fullmatch(r"(-?[\d,]+)(?:\.(\d+))?(%?)", tok)
        if not mm or isinstance(v, (dict, list)):
            return m.group(0)
        try:
            x = float(v) / div
        except (TypeError, ValueError):
            return m.group(0)
        nd = len(mm.group(2) or "")
        if mm.group(3):
            disp = f"{x * 100:.{nd}f}%"
        else:
            disp = f"{x:,.{nd}f}" if "," in mm.group(1) else f"{x:.{nd}f}"
        return disp + tail + m.group("sp") + m.group("mk")

    return MARK_RE.sub(fix, text)


def main() -> int:
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "x6_report.md").write_text(render_x6(), encoding="utf-8")
    (ROOT / "docs" / "x1_report.md").write_text(render_x1(), encoding="utf-8")
    tm = ROOT / "docs" / "THREAT_MODEL.md"
    if tm.exists():
        tm.write_text(refresh_markers(tm.read_text(encoding="utf-8")), encoding="utf-8")
    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    block = render_readme_block()
    if "<!-- results:start -->" in text and "<!-- results:end -->" in text:
        a = text.index("<!-- results:start -->")
        b = text.index("<!-- results:end -->") + len("<!-- results:end -->")
        text = refresh_markers(text[:a]) + block + refresh_markers(text[b:])
        readme.write_text(text, encoding="utf-8")
        print("render_reports: wrote docs/x6_report.md, docs/x1_report.md, refreshed docs/THREAT_MODEL.md and the README results block")
    else:
        print("render_reports: wrote docs/x6_report.md and docs/x1_report.md (README has no results markers yet)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
