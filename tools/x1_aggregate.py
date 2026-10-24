#!/usr/bin/env python3
"""X1 table aggregator (BUILD.md M7). Reads every results/cards/<card>__<config>.json written by the
Foundry card tests (the ground-truth raw-key reader) and emits results/x1_table.csv and
results/x1_table.json ({meta, cells: [...]}). The TypeScript raw-key shooter writes
results/x1_shooter.json separately; tools/x1_agree.py checks the two readers agree.

No numbers are invented here: a cell is exactly what its card file holds. Missing cards are listed
in meta.missing so the X1 lane can see what has not run yet.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CARDS_DIR = ROOT / "results" / "cards"
OUT_JSON = ROOT / "results" / "x1_table.json"
OUT_CSV = ROOT / "results" / "x1_table.csv"

# The published card schema (BUILD.md Conventions "Card results"); harness-only keys are dropped.
FIELDS = [
    "card", "config", "chainMode", "asset",
    "lostBaseUnits", "beyondPolicyBaseUnits",
    "legitBlocked", "legitProvenBlocked", "legitBlockedValue", "legitNeededApproval",
    "success",
]
CONFIGS = ["R1", "R2", "R3", "R4"]
# The 13 X1 cards (agent/fixtures/deck_params.json). attestor_compromise is R4 only: R1-R3 have no
# attestor to compromise (EXPERIMENTS X1), so its R1-R3 cells are not "missing".
CARD_CONFIGS = {
    "legit_only": CONFIGS, "ticket_to_attacker": CONFIGS, "set_approval_for_all": CONFIGS,
    "batch_selfcall_delegatecall": CONFIGS, "gas_burn_griefing": CONFIGS, "replay_wrong_chain": CONFIGS,
    "greedy_merchant": CONFIGS, "approve_max": CONFIGS, "midnight_double_spend": CONFIGS,
    "multi_key_cap": CONFIGS, "x402_side_door": CONFIGS, "sybil_payee": CONFIGS,
    "attestor_compromise": ["R4"],
}


def load_cells() -> list[dict]:
    cells: list[dict] = []
    if not CARDS_DIR.exists():
        return cells
    for path in sorted(CARDS_DIR.glob("*.json")):
        try:
            raw = json.loads(path.read_text())
        except json.JSONDecodeError as exc:  # pragma: no cover - surfaced to the user
            print(f"skip {path.name}: {exc}", file=sys.stderr)
            continue
        cell = {k: raw.get(k) for k in FIELDS}
        # Foundry serializes uints as decimal strings already; normalize everything to str.
        for k in ("lostBaseUnits", "beyondPolicyBaseUnits", "legitBlockedValue"):
            if cell.get(k) is not None:
                cell[k] = str(cell[k])
        for k in ("legitBlocked", "legitProvenBlocked", "legitNeededApproval"):
            if cell.get(k) is not None:
                cell[k] = int(cell[k])
        cells.append(cell)
    return cells


def main() -> int:
    cells = load_cells()
    seen = {(c["card"], c["config"]) for c in cells}
    cards = sorted(set(CARD_CONFIGS) | {c["card"] for c in cells})
    expected = [(card, cfg) for card in cards for cfg in CARD_CONFIGS.get(card, CONFIGS)]
    missing = [f"{card}__{cfg}" for card, cfg in expected if (card, cfg) not in seen]
    meta = {
        "source": "results/cards/*.json (Foundry raw-key reader)",
        "cardCount": len(cards),
        "cellCount": len(cells),
        "expectedCells": len(expected),
        "complete": not missing,
        "configs": CONFIGS,
        "missing": missing,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({"meta": meta, "cells": cells}, indent=2) + "\n")
    with OUT_CSV.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS)
        writer.writeheader()
        for cell in cells:
            writer.writerow(cell)
    print(f"x1_aggregate: {len(cells)} cells, {len(cards)} cards -> {OUT_JSON.name}, {OUT_CSV.name}"
          + (f"; missing {len(missing)}" if missing else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
