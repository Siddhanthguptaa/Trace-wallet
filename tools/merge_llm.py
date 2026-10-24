#!/usr/bin/env python3
"""Merge the two LLM-shooter halves (R1,R2 and R3,R4 run in parallel processes) into results/x1_llm.json.
Same model, temperature and seeds in both halves; refuses to merge if they differ."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
a = json.loads((ROOT / "results" / "dev" / "x1_llm_part_a.json").read_text())
b = json.loads((ROOT / "results" / "dev" / "x1_llm_part_b.json").read_text())
for k in ("status", "model", "temperature", "n", "seeds"):
    assert a.get(k) == b.get(k), f"halves differ on {k}: {a.get(k)} vs {b.get(k)}"
assert a["status"] == "ran", "LLM shooter did not run"
order = {"R1": 0, "R2": 1, "R3": 2, "R4": 3}
cells = sorted(a["cells"] + b["cells"], key=lambda c: (order[c["config"]], c["card"]))
out = {**a, "cells": cells, "meta": {**a["meta"], "mergedFrom": ["x1_llm_part_a.json", "x1_llm_part_b.json"]}}
(ROOT / "results" / "x1_llm.json").write_text(json.dumps(out, indent=2) + "\n")
print(f"merged {len(cells)} cells; runs per cell n={out['n']}; model {out['model']}")
