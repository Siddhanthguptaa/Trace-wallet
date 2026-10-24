"""Summarise `forge test --json` output.

Usage: python tools/forge_summary.py <forge.json> [--out f] [--require a,b,...]

Writes a summary (default results/forge_summary.json, the file tools/gate.py reads) and exits 1 if
any test failed, no test ran, or a required name (substring of "path:Contract::test") is missing.
Stdlib only.
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_forge_json(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Tolerate stray non-JSON lines (warnings, wrappers): take the last line that parses as an object.
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    raise SystemExit(f"forge_summary: no JSON object in {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("forge_json")
    ap.add_argument("--out", default=os.path.join(ROOT, "results", "forge_summary.json"))
    ap.add_argument("--require", default="")
    a = ap.parse_args()

    data = load_forge_json(a.forge_json)
    tests, failed, skipped, passed = [], [], [], []
    for suite, body in (data or {}).items():
        results = (body or {}).get("test_results", {}) or {}
        for name, r in results.items():
            full = f"{suite}::{name}"
            tests.append(full)
            status = str((r or {}).get("status", "")).lower()
            if status == "success":
                passed.append(full)
            elif status == "skipped":
                skipped.append(full)
            else:
                failed.append({"test": full, "status": r.get("status"), "reason": r.get("reason")})

    required = [x for x in a.require.split(",") if x]
    missing = [req for req in required if not any(req in t for t in tests)]
    summary = {
        "source": os.path.relpath(os.path.abspath(a.forge_json), ROOT).replace("\\", "/"),
        "suites": len(data or {}),
        "total": len(tests),
        "passed": len(passed),
        "failed": len(failed),
        "skipped": len(skipped),
        "failedTests": failed,
        "required": required,
        "missingRequired": missing,
        "tests": sorted(tests),
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    ok = not failed and not missing and len(tests) > 0
    print(
        f"forge_summary: {len(passed)} passed, {len(failed)} failed, {len(skipped)} skipped "
        f"({summary['source']}){'' if not missing else ' MISSING ' + ','.join(missing)}"
        f"{'' if tests else ' NO TESTS'} -> {'ok' if ok else 'FAIL'}"
    )
    for fl in failed[:20]:
        print(f"  FAIL {fl['test']}: {str(fl['reason'])[:200]}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
