"""Gate G check: results/demo_run.json has ok: true and the latest forge summary has 0 failures.

Usage: python tools/gate.py   (stdlib only; run after `pnpm run test:all && pnpm run demo`)
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return None, f"{rel} missing"
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), None
    except (OSError, json.JSONDecodeError) as e:
        return None, f"{rel} unreadable: {e}"


def main():
    errors = []
    demo, err = load("results/demo_run.json")
    if err:
        errors.append(err)
    elif demo.get("ok") is not True:
        bad = [b.get("beat") for b in demo.get("beats", []) if not b.get("ok")]
        errors.append(f"demo_run.json ok={demo.get('ok')} failing beats={bad}")

    summ, err = load("results/forge_summary.json")
    if err:
        errors.append(err)
    else:
        if summ.get("failed", 1) != 0:
            errors.append(f"forge summary ({summ.get('source')}) has {summ.get('failed')} failures")
        if summ.get("total", 0) <= 0:
            errors.append(f"forge summary ({summ.get('source')}) ran no tests")
        if summ.get("missingRequired"):
            errors.append(f"forge summary missing required: {summ.get('missingRequired')}")

    if errors:
        print("gate FAIL: " + "; ".join(errors))
        sys.exit(1)
    print(
        f"gate ok: demo {len(demo.get('beats', []))} beats ok; forge {summ['passed']} passed, 0 failed "
        f"({summ['source']})"
    )


if __name__ == "__main__":
    main()
