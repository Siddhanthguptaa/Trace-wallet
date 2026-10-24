#!/usr/bin/env python3
"""check_claims: every results number in README.md and docs/*.md must be traceable to a results file.

Marker convention (same as docs/x4_report.md): the number or word is followed by a marker
  <value> [r:<path from repo root>#<dotted.key>]
e.g.  `116 [r:results/x6_detection.json#byMode.combined.overall.detection.hit]`.
  - keys are dotted; a segment is a dict key, or a list index when the node is a list
  - an optional divisor suffix scales the JSON number:  ...maxAttackerGainBaseUnits/1000000
    (so base units can be shown as USDC; the displayed number is compared with value / divisor)
  - a value shown with % is 100x the JSON fraction (0.9667 is shown as 96.7%)
  - booleans are shown as yes / no (or true / false); other values compare as case-insensitive text
  - numbers may carry thousands separators; the displayed precision sets the rounding tolerance

What fails the run:
  1. a marker whose file or key does not exist, or whose displayed value does not match the file;
  2. an unmarked number inside a section whose heading contains "Results" (case-insensitive), except
     numbers in code spans, URLs, identifiers like H1 / R3 / x402 / ERC-4337 / EB(5%), ordered-list
     numbers, and the short ALLOWED_UNMARKED list of pre-registered parameters;
  3. a test name cited in the docs (test_*, testFuzz_*, invariant_*, Card_*) that does not exist in
     contracts/test, services, agent or packages.

Usage: python tools/check_claims.py [files...]   (default: README.md and docs/*.md)
"""
from __future__ import annotations

import glob
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKER = re.compile(r"\[r:([^#\]\s]+)#([^\]\s]+)\]")
NUMBER = re.compile(r"(?<![\w.])(\d[\d,]*(?:\.\d+)?)(%?)(?![\w])")
TEST_NAME = re.compile(r"\b((?:test|testFuzz|invariant)_[A-Za-z0-9_]*[A-Za-z0-9]|Card_[A-Za-z0-9_]*[A-Za-z0-9])\b")

# Pre-registered design parameters that are not measured results (and sit in generated reports we do not
# own). Each phrase is exempt from the unmarked-number rule wherever it appears; keep this list short.
ALLOWED_UNMARKED = [
    "B* = 5%",  # X4: the wallet's default exploration budget, fixed before any run (nikunj/EXPERIMENTS.md)
]

_json_cache: dict[str, object] = {}
_source_cache: str | None = None


def load_json(rel: str):
    if rel not in _json_cache:
        path = ROOT / rel
        if not path.exists():
            raise FileNotFoundError(f"results file missing: {rel}")
        _json_cache[rel] = json.loads(path.read_text(encoding="utf-8"))
    return _json_cache[rel]


def resolve(rel: str, key: str):
    """Value at the dotted key, with an optional /divisor suffix. Returns (value, divisor)."""
    divisor = 1.0
    m = re.match(r"^(.*)/(\d+(?:\.\d+)?)$", key)
    if m:
        key, divisor = m.group(1), float(m.group(2))
    cur = load_json(rel)
    for seg in key.split("."):
        if isinstance(cur, list):
            if not seg.isdigit() or int(seg) >= len(cur):
                raise KeyError(f"{rel}#{key}: no list index {seg}")
            cur = cur[int(seg)]
        elif isinstance(cur, dict):
            if seg not in cur:
                raise KeyError(f"{rel}#{key}: no key {seg}")
            cur = cur[seg]
        else:
            raise KeyError(f"{rel}#{key}: cannot descend into {type(cur).__name__} at {seg}")
    return cur, divisor


def clean_token(text: str) -> str:
    """The last whitespace-delimited token before a marker, stripped of markdown and punctuation."""
    tok = text.rstrip().split()[-1] if text.strip() else ""
    tok = tok.strip("*_`|()[]<>~")
    return tok.rstrip(".,;:")


def compare(token: str, value, divisor: float) -> str | None:
    """None if the displayed token matches the JSON value, else a reason."""
    low = token.lower()
    if isinstance(value, bool):
        if low in ("yes", "true"):
            return None if value else f"shows {token} but the file says no"
        if low in ("no", "false"):
            return None if not value else f"shows {token} but the file says yes"
        return f"boolean in the file, shown as {token!r} (use yes / no)"
    plain = token.replace(",", "")
    m = re.fullmatch(r"(-?\d+(?:\.(\d+))?)(%?)", plain)
    if m:
        try:
            v = float(value) / divisor
        except (TypeError, ValueError):
            return f"shows number {token} but the file value is {value!r}"
        shown = float(m.group(1))
        decimals = len(m.group(2) or "")
        expected = v * 100 if m.group(3) else v
        tol = 0.5 * 10 ** (-decimals) + 1e-9
        if abs(expected - shown) <= tol:
            return None
        return f"shows {token} but the file gives {expected:.{max(decimals, 1) + 2}f}"
    if str(value).lower() == low:
        return None
    return f"shows {token!r} but the file value is {value!r}"


def check_markers(path: Path, text: str, errors: list[str]) -> int:
    n = 0
    for m in MARKER.finditer(text):
        n += 1
        line = text.count("\n", 0, m.start()) + 1
        rel, key = m.group(1), m.group(2)
        token = clean_token(text[: m.start()])
        try:
            value, divisor = resolve(rel, key)
        except (FileNotFoundError, KeyError, json.JSONDecodeError) as e:
            errors.append(f"{path.name}:{line}: {e}")
            continue
        if isinstance(value, (dict, list)):
            errors.append(f"{path.name}:{line}: {rel}#{key} is a {type(value).__name__}, not a value")
            continue
        why = compare(token, value, divisor)
        if why:
            errors.append(f"{path.name}:{line}: {rel}#{key} {why}")
    return n


def results_sections(lines: list[str]) -> list[tuple[int, int]]:
    """Line ranges (start, end) of sections whose heading contains 'results' (heading line excluded)."""
    out = []
    i = 0
    in_fence = False
    heads = []
    for idx, ln in enumerate(lines):
        if ln.lstrip().startswith("```"):
            in_fence = not in_fence
        if not in_fence:
            h = re.match(r"^(#{1,6})\s+(.*)$", ln)
            if h:
                heads.append((idx, len(h.group(1)), h.group(2)))
    for k, (idx, level, title) in enumerate(heads):
        if "results" not in title.lower():
            continue
        end = len(lines)
        for idx2, level2, _ in heads[k + 1 :]:
            if level2 <= level:
                end = idx2
                break
        out.append((idx + 1, end))
    return out


def strip_ignorable(line: str) -> str:
    line = re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), line)
    line = re.sub(r"\]\([^)]*\)", "]()", line)
    line = re.sub(r"https?://\S+", " ", line)
    line = re.sub(r"<!--.*?-->", " ", line)
    return line


def check_unmarked(path: Path, text: str, errors: list[str]) -> int:
    lines = text.splitlines()
    ranges = results_sections(lines)
    scanned = 0
    for start, end in ranges:
        in_fence = False
        for idx in range(start, end):
            raw = lines[idx]
            if raw.lstrip().startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence or re.match(r"^\s*\|?[\s:|-]+\|?\s*$", raw):
                continue
            if raw.lstrip().startswith("<!--"):
                continue
            ln = strip_ignorable(raw)
            # digits inside a marker (the divisor, ci95) are not displayed numbers: blank them, keep the "[r:" prefix
            ln = MARKER.sub(lambda m: "[r:" + "x" * (len(m.group(0)) - 4) + "]", ln)
            for phrase in ALLOWED_UNMARKED:
                ln = ln.replace(phrase, " " * len(phrase))
            ln = re.sub(r"^\s*\d+\.\s", "   ", ln)  # ordered-list number
            scanned += 1
            for m in NUMBER.finditer(ln):
                a = m.start()
                # identifiers such as ERC-4337 / EIP-712: a letter, a hyphen, then digits
                if a >= 2 and ln[a - 1] == "-" and ln[a - 2].isalpha():
                    continue
                # policy / function labels such as TRACE+EB(5%) or f(2)
                if a >= 2 and ln[a - 1] == "(" and (ln[a - 2].isalpha() or ln[a - 2] == "+"):
                    continue
                after = ln[m.end() :].lstrip()
                if after.startswith("[r:"):
                    continue
                errors.append(f"{path.name}:{idx + 1}: unmarked number {m.group(0)!r} in a Results section")
    return scanned


def all_sources() -> str:
    global _source_cache
    if _source_cache is None:
        parts = []
        for pat in ("contracts/test/**/*.sol", "services/**/test/**/*.ts", "services/**/test/**/*.sol", "agent/**/*.ts", "packages/**/*.ts", "tools/**/*.ts"):
            for f in glob.glob(str(ROOT / pat), recursive=True):
                if "node_modules" in f:
                    continue
                try:
                    parts.append(Path(f).read_text(encoding="utf-8", errors="ignore"))
                except OSError:
                    pass
        _source_cache = "\n".join(parts)
    return _source_cache


def check_test_names(path: Path, text: str, errors: list[str]) -> int:
    src = all_sources()
    seen = set()
    for m in TEST_NAME.finditer(text):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        if name.startswith("Card_"):
            ok = re.search(rf"\bcontract\s+{re.escape(name)}\b", src) is not None
        else:
            ok = re.search(rf"\bfunction\s+{re.escape(name)}\b", src) is not None
        if not ok:
            line = text.count("\n", 0, m.start()) + 1
            errors.append(f"{path.name}:{line}: test {name} is cited but does not exist in the repo")
    return len(seen)


def main() -> int:
    if len(sys.argv) > 1:
        files = [Path(a) for a in sys.argv[1:]]
    else:
        files = [ROOT / "README.md"] + sorted(Path(p) for p in glob.glob(str(ROOT / "docs" / "*.md")))
    errors: list[str] = []
    n_markers = n_tests = n_lines = 0
    for f in files:
        if not f.exists():
            errors.append(f"{f}: file missing")
            continue
        text = f.read_text(encoding="utf-8")
        n_markers += check_markers(f, text, errors)
        n_lines += check_unmarked(f, text, errors)
        n_tests += check_test_names(f, text, errors)
    if errors:
        print(f"check_claims: FAIL, {len(errors)} problem(s) in {len(files)} files")
        for e in errors[:80]:
            print("  " + e)
        if len(errors) > 80:
            print(f"  ... and {len(errors) - 80} more")
        return 1
    print(f"check_claims: ok, {n_markers} markers verified, {n_tests} distinct test names found, {n_lines} Results-section lines scanned, {len(files)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
