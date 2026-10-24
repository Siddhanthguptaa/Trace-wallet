#!/usr/bin/env python3
"""X1 two-reader agreement (BUILD.md M7). The raw-key column has two independent readers: the
Foundry cards (aggregated into results/x1_table.json) and the TypeScript raw-key shooter
(results/x1_shooter.json). This fails unless lostBaseUnits, beyondPolicyBaseUnits, legitBlocked and
legitNeededApproval are equal in every cell both readers scored.

Honesty rule (BUILD.md M7 Fallback): if the readers disagree, fix the buggy reader, never the
targets. A cell only one reader scored (e.g. a `pending` shooter card during the scaffold) is
reported as unmatched, not as a disagreement, unless --strict is given.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLE = ROOT / "results" / "x1_table.json"
SHOOTER = ROOT / "results" / "x1_shooter.json"
KEYS = ["lostBaseUnits", "beyondPolicyBaseUnits", "legitBlocked", "legitNeededApproval"]


def index(cells: list[dict]) -> dict[tuple[str, str], dict]:
    return {(c.get("card"), c.get("config")): c for c in cells if c.get("card") and c.get("config")}


def norm(cell: dict, key: str):
    v = cell.get(key)
    if v is None:
        return None
    if key in ("legitBlocked", "legitNeededApproval"):
        return int(v)
    return str(v)


# The gas-burn card measures ETH paid to an attacker-run bundler. The two readers use different
# addresses (anvil dev account vs makeAddr), so calldata gas differs by a few hundred gas per op and the
# exact wei amount cannot be equal. The claim of the card is the bound (loss <= gasCredit, or not), so
# for this card lost must agree within GAS_TOLERANCE and beyond-policy must agree on zero / non-zero.
GAS_CARD = "gas_burn_griefing"
GAS_TOLERANCE = 0.02


def gas_equal(f: dict, s: dict, k: str) -> bool:
    a, b = int(f.get(k) or 0), int(s.get(k) or 0)
    if k == "beyondPolicyBaseUnits":
        return (a == 0) == (b == 0)
    return a == b or (max(a, b) > 0 and abs(a - b) / max(a, b) <= GAS_TOLERANCE)


def main() -> int:
    strict = "--strict" in sys.argv
    if not TABLE.exists() or not SHOOTER.exists():
        missing = [p.name for p in (TABLE, SHOOTER) if not p.exists()]
        print(f"x1_agree: nothing to compare yet (missing {', '.join(missing)}); "
              "run x1_aggregate and the raw-key shooter first (X1 lane, wave 4).")
        return 0

    foundry = index(json.loads(TABLE.read_text()).get("cells", []))
    shooter_cells = json.loads(SHOOTER.read_text()).get("cells", [])
    # a cell is unscored only if it errored or carries a "pending..." note; other notes (e.g. the measure label of
    # the windowOutflow / attackOutflow cards) are informational
    shooter = index([c for c in shooter_cells if "error" not in c and not str(c.get("notes", "")).startswith("pending")])

    both = sorted(set(foundry) & set(shooter))
    disagreements: list[str] = []
    for key_cell in both:
        f, s = foundry[key_cell], shooter[key_cell]
        for k in KEYS:
            if key_cell[0] == GAS_CARD and k in ("lostBaseUnits", "beyondPolicyBaseUnits"):
                if not gas_equal(f, s, k):
                    disagreements.append(f"{key_cell[0]}/{key_cell[1]} {k}: foundry={norm(f, k)} shooter={norm(s, k)} (tolerance {GAS_TOLERANCE:.0%})")
                continue
            if norm(f, k) != norm(s, k):
                disagreements.append(f"{key_cell[0]}/{key_cell[1]} {k}: foundry={norm(f, k)} shooter={norm(s, k)}")

    only_foundry = sorted(set(foundry) - set(shooter))
    only_shooter = sorted(set(shooter) - set(foundry))
    print(f"x1_agree: {len(both)} cells compared, {len(disagreements)} disagreements; "
          f"foundry-only {len(only_foundry)}, shooter-only {len(only_shooter)}")
    for d in disagreements:
        print(f"  DISAGREE {d}")

    if disagreements:
        return 1
    if strict and (only_foundry or only_shooter):
        print("  --strict: both readers must score every cell", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
