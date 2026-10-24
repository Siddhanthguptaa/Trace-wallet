#!/usr/bin/env python3
"""I11 coverage summary: reads the per-run lines the I11 fuzz writes (results/i11_runs_*.txt,
columns ownerMoves,agentMoves,unauthorizedAttempts,recoveries,forgedAccepted) and writes
results/i11.json: how many fuzz runs, how many reached each authority, and the totals.
The invariants prove nothing if no run ever reaches an authority, so this is the other half of I11.
"""
import glob
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = {"campaigns": {}}
for f in sorted(glob.glob(str(ROOT / "results" / "i11_runs_*.txt"))):
    rows = [tuple(int(x) for x in l.split(",")) for l in Path(f).read_text().splitlines() if l.strip()]
    name = Path(f).stem.replace("i11_runs_", "")
    out["campaigns"][name] = {
        "fuzzRuns": len(rows),
        "runsWithOwnerMove": sum(1 for r in rows if r[0] > 0),
        "runsWithAgentMove": sum(1 for r in rows if r[1] > 0),
        "runsWithUnauthorizedAttempt": sum(1 for r in rows if r[2] > 0),
        "runsWithRecovery": sum(1 for r in rows if r[3] > 0),
        "ownerMoves": sum(r[0] for r in rows),
        "agentMoves": sum(r[1] for r in rows),
        "unauthorizedAttempts": sum(r[2] for r in rows),
        "recoveriesExecuted": sum(r[3] for r in rows),
        "forgedOrReplayedOpsAccepted": sum(r[4] for r in rows),
    }
(ROOT / "results" / "i11.json").write_text(json.dumps(out, indent=2) + "\n")
for k, v in out["campaigns"].items():
    print(k, v)
