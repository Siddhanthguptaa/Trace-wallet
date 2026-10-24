#!/usr/bin/env python3
"""X6 aggregator (EXPERIMENTS X6). Reads the per-run records written by agent/hijack/run.ts
(results/x6_runs*.jsonl, one RunRecord per line) and emits results/x6_detection.csv and
results/x6_detection.json with the pre-registered metrics, per detector mode:

  - detection rate   = hijack runs frozen before the run ends / hijack runs that REACHED the wallet
                       (an op was mined). Attacks stopped at a door no chain-based detector sees
                       (side-door signatures, a recovery that cannot reach its quorum, ops rejected in
                       validation) are contained, not detected, and are reported as such.
  - containment rate = hijack runs whose loss stayed inside the stated bound / all hijack runs.
  - time-to-freeze   = mean ops before the first freeze, mean value lost before it.
  - false-freeze rate= legit runs with >= 1 freeze / legit runs.
  - loss check       = attacker gain per run vs the global cap (daily limit), unproven-payee gain vs the
                       exploration cap, plus each scenario's own bound (paymaster quota, recovery).

Rates carry a Wilson 95% interval: n is 20 per cell, so a point estimate alone would overstate it.
Numbers are computed from the records only; nothing is tuned here. Runs flagged `pending` or `error`
are excluded from the rates and counted in meta, never dropped silently.

Usage: python tools/x6_aggregate.py [runs.jsonl ...]   (default: results/x6_runs*.jsonl)
"""
from __future__ import annotations

import csv
import glob
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "results" / "x6_detection.json"
OUT_CSV = ROOT / "results" / "x6_detection.csv"
POLICY = ROOT / "agent" / "configs" / "demo_policy.json"
PRIMARY_MODE = "combined"
MODES = ["combined", "tripwires", "watcher", "none"]


def caps() -> tuple[int, int]:
    p = json.loads(POLICY.read_text(encoding="utf-8"))
    g = p["globalCap"]
    e = p["exploreCap"]
    return int(g["burst"]) + int(g["ratePerDay"]), int(e["burst"]) + int(e["ratePerDay"])


def wilson(hit: int, n: int, z: float = 1.96) -> list[float] | None:
    if n == 0:
        return None
    p = hit / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round(max(0.0, (c - m) / d), 4), round(min(1.0, (c + m) / d), 4)]


def rate(hit: int, n: int) -> dict:
    return {"hit": hit, "runs": n, "rate": round(hit / n, 4) if n else None, "ci95": wilson(hit, n)}


def load(paths: list[str]) -> list[dict]:
    out = []
    for path in paths:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def scored(records: list[dict]) -> list[dict]:
    return [r for r in records if not (r.get("notes") or "").startswith(("pending", "error"))]


def bound_held(r: dict, global_cap: int, explore_cap: int) -> bool:
    if int(r["lossTotalBaseUnits"]) > global_cap or int(r["lossUnprovenBaseUnits"]) > explore_cap:
        return False
    return (r.get("metrics") or {}).get("boundHeld", True) is not False


def summarize(rows: list[dict], global_cap: int, explore_cap: int) -> dict:
    hijacks = [r for r in rows if r["kind"] == "hijack"]
    legits = [r for r in rows if r["kind"] == "legit"]
    reached = [r for r in hijacks if r.get("reachedWallet", True)]

    per_scn = {}
    for sid in sorted({r["id"] for r in hijacks}):
        grp = [r for r in hijacks if r["id"] == sid]
        rch = [r for r in grp if r.get("reachedWallet", True)]
        frozen = [r for r in rch if r["frozen"] and r.get("opsToFreeze") is not None]
        per_scn[sid] = {
            "runs": len(grp),
            "reachedWallet": len(rch),
            "detection": rate(sum(1 for r in rch if r["frozen"]), len(rch)),
            "containment": rate(sum(1 for r in grp if bound_held(r, global_cap, explore_cap)), len(grp)),
            "meanOpsToFreeze": round(sum(r["opsToFreeze"] for r in frozen) / len(frozen), 2) if frozen else None,
            "meanLossBeforeFreezeBaseUnits": round(sum(int(r["lossBeforeFreezeBaseUnits"]) for r in frozen) / len(frozen), 1) if frozen else None,
            "maxLossBaseUnits": max((int(r["lossTotalBaseUnits"]) for r in grp), default=0),
            "freezeTriggers": dict(Counter(r.get("freezeTrigger") for r in frozen)),
        }
    per_wl = {}
    for wid in sorted({r["id"] for r in legits}):
        grp = [r for r in legits if r["id"] == wid]
        ff = [r for r in grp if r["falseFreeze"]]
        per_wl[wid] = {"falseFreeze": rate(len(ff), len(grp)), "triggers": dict(Counter(r.get("freezeTrigger") for r in ff))}

    return {
        "overall": {
            "hijackRuns": len(hijacks),
            "reachedWalletRuns": len(reached),
            "detection": rate(sum(1 for r in reached if r["frozen"]), len(reached)),
            "containment": rate(sum(1 for r in hijacks if bound_held(r, global_cap, explore_cap)), len(hijacks)),
            "legitRuns": len(legits),
            "falseFreeze": rate(sum(1 for r in legits if r["falseFreeze"]), len(legits)),
            "maxAttackerGainBaseUnits": max((int(r["lossTotalBaseUnits"]) for r in hijacks), default=0),
            "maxUnprovenGainBaseUnits": max((int(r["lossUnprovenBaseUnits"]) for r in hijacks), default=0),
            "maxLossBeforeFreezeBaseUnits": max((int(r["lossBeforeFreezeBaseUnits"]) for r in reached if r["frozen"]), default=0),
            "globalCap": global_cap,
            "exploreCap": explore_cap,
            "lossAssertHeld": all(bound_held(r, global_cap, explore_cap) for r in hijacks),
            "lossAssertRuns": len(hijacks),
        },
        "detectionByScenario": per_scn,
        "falseFreezeByWorkload": per_wl,
    }


def main() -> int:
    global OUT_JSON, OUT_CSV
    paths = sys.argv[1:] or sorted(glob.glob(str(ROOT / "results" / "x6_runs*.jsonl")))
    if paths and all(Path(p).resolve().parent.name == "dev" for p in paths):
        # Dev seeds (threshold fixing) never share a file with the scored run.
        OUT_JSON = ROOT / "results" / "dev" / "x6_detection.json"
        OUT_CSV = ROOT / "results" / "dev" / "x6_detection.csv"
    records = load(paths) if paths else []
    if not records:
        print("x6_aggregate: no records (run agent/hijack/run.ts first).")
        return 0
    global_cap, explore_cap = caps()
    rows = scored(records)
    by_mode: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_mode[r.get("mode") or PRIMARY_MODE].append(r)

    out = {
        "meta": {
            "inputs": [Path(p).name for p in paths],
            "totalRecords": len(records),
            "scoredRecords": len(rows),
            "pendingOrError": len(records) - len(rows),
            "seeds": sorted({r["seed"] for r in rows}),
            "modes": {m: "combined = tripwires + watcher; tripwires = on-chain only; watcher = off-chain only; none = caps only" for m in MODES if m in by_mode},
            "note": "Counts over our own scripted scenarios and workloads: self-graded, synthetic. Detection is not containment; the caps hold with no detector (mode none).",
        },
        "primaryMode": PRIMARY_MODE,
        "byMode": {m: summarize(by_mode[m], global_cap, explore_cap) for m in MODES if m in by_mode},
        "errors": [
            {"kind": r["kind"], "id": r["id"], "seed": r["seed"], "mode": r.get("mode"), "notes": r.get("notes")}
            for r in records
            if (r.get("notes") or "").startswith(("pending", "error"))
        ],
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")

    with OUT_CSV.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["mode", "metric", "id", "hit", "runs", "rate", "ci95_lo", "ci95_hi"])
        for mode, s in out["byMode"].items():
            for sid, v in s["detectionByScenario"].items():
                d, c = v["detection"], v["containment"]
                w.writerow([mode, "detection_of_runs_reaching_wallet", sid, d["hit"], d["runs"], d["rate"], *(d["ci95"] or ["", ""])])
                w.writerow([mode, "containment_within_bound", sid, c["hit"], c["runs"], c["rate"], *(c["ci95"] or ["", ""])])
            for wid, v in s["falseFreezeByWorkload"].items():
                f = v["falseFreeze"]
                w.writerow([mode, "false_freeze", wid, f["hit"], f["runs"], f["rate"], *(f["ci95"] or ["", ""])])
            o = s["overall"]
            for name in ("detection", "containment", "falseFreeze"):
                x = o[name]
                w.writerow([mode, f"overall_{name}", "ALL", x["hit"], x["runs"], x["rate"], *(x["ci95"] or ["", ""])])

    primary = out["byMode"].get(PRIMARY_MODE)
    bad = [m for m, s in out["byMode"].items() if not s["overall"]["lossAssertHeld"]]
    if bad:
        print(f"x6_aggregate: LOSS ASSERT FAILED in mode(s) {bad} (a hijack run exceeded a bound)", file=sys.stderr)
        return 1
    if primary:
        o = primary["overall"]
        print(
            f"x6_aggregate[{PRIMARY_MODE}]: {o['hijackRuns']} hijack ({o['reachedWalletRuns']} reached the wallet) + {o['legitRuns']} legit runs; "
            f"detection={o['detection']['rate']} containment={o['containment']['rate']} falseFreeze={o['falseFreeze']['rate']} "
            f"maxGain={o['maxAttackerGainBaseUnits']} (cap {o['globalCap']}) lossOk={o['lossAssertHeld']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
