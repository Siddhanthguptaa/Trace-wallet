"""X4 analysis: pre-registered frontier test (EXPERIMENTS.md X4), partitioned regime only.

Standard library only (runs under `uv run python` or plain `python`), so no project
dependency is needed. Reads sim/results/x4_cells.jsonl and writes:
  sim/results/x4_summary.csv
  sim/results/x4_frontier_partitioned_<attack>.png
  sim/results/x4_h1.json  and  results/x4_h1.json (mirror for BUILD.md M8 / check_claims)

Pre-registered test, per (regime, attack): take the 10-seed mean points of the four
baselines (TRACE-full, TRACE-no-bandit, REPUTATION, EigenTrust). TRACE+EB(B) moves the
frontier iff NO convex combination of the baseline points has both fraud <= its fraud and
served-honest >= its served-honest, and that holds in >= 95% of 1,000 seed-bootstrap
resamples. H1 iff the frontier moves at B* = 5% in the partitioned regime for >= 3 of 4
attacks.

The LP {lambda >= 0, sum lambda = 1, sum lambda_i f_i <= f, sum lambda_i s_i >= s} is solved
exactly: in 2-D the hull of the baseline points meets the closed quadrant
{F <= f, S >= s} iff some segment between two baseline points (a point counts as a
degenerate segment) meets it, because a feasible point can slide toward (-1, +1) inside the
quadrant until it reaches the hull boundary. A brute-force simplex grid cross-checks every
point-estimate decision.
"""
import csv
import json
import math
import os
import random
import struct
import sys
import zlib
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.dirname(HERE)
ROOT = os.path.dirname(SIM)
RES = os.path.join(SIM, "results")
CELLS = os.path.join(RES, "x4_cells.jsonl")

ATTACKS = ["strategic-default", "collusion-ring", "sybil-cluster", "game-theoretic"]
B_VALUES = [0, 1, 2, 5, 10]
B_STAR = 5
EB = ["EB(%d)" % b for b in B_VALUES]
BASELINES = ["TRACE-full", "TRACE-no-bandit", "REPUTATION", "EIGENTRUST"]
POLICIES = EB + BASELINES
SEEDS = list(range(42, 52))
N_BOOT = 1000
BOOT_SEED = 20261024
THRESHOLD = 0.95
REGIME = "partitioned"
EPS = 1e-9

# Sanity values (reported, not a gate): TRACE Table 9 partitioned fraud, n=5 seeds.
TABLE9 = {
    "TRACE-full": {"strategic-default": 6.4, "collusion-ring": 44.6, "sybil-cluster": 24.2, "game-theoretic": 86.8},
    "TRACE-no-bandit": {"strategic-default": 32.0, "collusion-ring": 51.6, "sybil-cluster": 32.8, "game-theoretic": 64.4},
    "REPUTATION": {"strategic-default": 18.0, "collusion-ring": 55.4, "sybil-cluster": 20.0, "game-theoretic": 85.0},
    "EIGENTRUST": {"strategic-default": 8.2, "collusion-ring": 291.0, "sybil-cluster": 103.8, "game-theoretic": 47.6},
}


PARTIAL_OUT = os.environ.get("X4_PARTIAL_OUT")  # debug only: analyse complete seeds so far into a scratch dir


def load():
    global SEEDS, RES
    rows = [json.loads(l) for l in open(CELLS, encoding="utf-8") if l.strip()]
    if PARTIAL_OUT:
        have = {(r["attack"], r["policyLabel"], r["seed"]) for r in rows}
        SEEDS = [s for s in SEEDS if all((a, p, s) in have for a in ATTACKS for p in POLICIES)]
        rows = [r for r in rows if r["seed"] in SEEDS]
        RES = PARTIAL_OUT
        os.makedirs(RES, exist_ok=True)
    by = {}
    for r in rows:
        if r["regime"] != REGIME:
            continue
        key = (r["attack"], r["policyLabel"], r["seed"])
        if key in by:
            raise SystemExit("duplicate cell %s" % (key,))
        by[key] = r
    missing = [(a, p, s) for a in ATTACKS for p in POLICIES for s in SEEDS if (a, p, s) not in by]
    if missing:
        raise SystemExit("x4_cells.jsonl incomplete: %d missing, e.g. %s" % (len(missing), missing[:3]))
    if any(not (42 <= r["seed"] <= 51) for r in rows):
        raise SystemExit("non-scored seed in x4_cells.jsonl")
    return rows, by


def mean(xs):
    return sum(xs) / len(xs)


def sd(xs):
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) if len(xs) > 1 else 0.0


def interval(a, b, rhs, sense):
    """t in [0,1] with a + t*b <= rhs (sense 'le') or >= rhs ('ge'); returns (lo, hi) or None."""
    lo, hi = 0.0, 1.0
    if sense == "ge":
        a, b, rhs = -a, -b, -rhs
    # a + t b <= rhs
    if abs(b) < 1e-15:
        return (lo, hi) if a <= rhs + EPS else None
    t = (rhs - a) / b
    if b > 0:
        hi = min(hi, t + EPS)
    else:
        lo = max(lo, t - EPS)
    return (lo, hi) if lo <= hi else None


def dominated(point, base_pts):
    """True iff some convex combination of base_pts has F <= f and S >= s (exact, 2-D)."""
    f, s = point
    n = len(base_pts)
    for i in range(n):
        for j in range(i, n):
            (fi, si), (fj, sj) = base_pts[i], base_pts[j]
            i1 = interval(fi, fj - fi, f, "le")
            i2 = interval(si, sj - si, s, "ge")
            if i1 and i2 and max(i1[0], i2[0]) <= min(i1[1], i2[1]):
                return True
    return False


def dominated_grid(point, base_pts, steps=60):
    """Brute-force cross-check on a simplex grid (can only find feasibility, never prove absence)."""
    f, s = point
    n = len(base_pts)
    assert n == 4
    for a in range(steps + 1):
        for b in range(steps + 1 - a):
            for c in range(steps + 1 - a - b):
                d = steps - a - b - c
                lam = (a / steps, b / steps, c / steps, d / steps)
                F = sum(l * p[0] for l, p in zip(lam, base_pts))
                S = sum(l * p[1] for l, p in zip(lam, base_pts))
                if F <= f + 1e-9 and S >= s - 1e-9:
                    return True
    return False


def point_means(by, attack, policy, idx):
    rows = [by[(attack, policy, SEEDS[i])] for i in idx]
    return (mean([r["fraud"] for r in rows]), mean([r["servedHonest"] for r in rows]))


# ── tiny PNG renderer (no third-party libs) ──────────────────────────────────
FONT = {
    " ": ["00000"] * 7,
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "10001", "11001", "10101", "10011", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
    ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
    "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
    "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
    ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
    "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
    ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
    "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
    "*": ["00000", "10101", "01110", "11111", "01110", "10101", "00000"],
    "<": ["00010", "00100", "01000", "10000", "01000", "00100", "00010"],
    ">": ["01000", "00100", "00010", "00001", "00010", "00100", "01000"],
    "|": ["00100"] * 7,
    "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
}


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Canvas:
    def __init__(self, w, h, bg):
        self.w, self.h = w, h
        self.px = bytearray(bytes(hexrgb(bg)) * (w * h))

    def set(self, x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < self.w and 0 <= y < self.h:
            i = 3 * (y * self.w + x)
            self.px[i:i + 3] = bytes(c)

    def rect(self, x0, y0, x1, y1, c):
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                self.set(x, y, c)

    def line(self, x0, y0, x1, y1, c, width=1, dash=0):
        n = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
        r = (width - 1) / 2.0
        for k in range(n + 1):
            if dash and (k // dash) % 2 == 1:
                continue
            t = k / max(n, 1)
            x, y = x0 + t * (x1 - x0), y0 + t * (y1 - y0)
            if width <= 1:
                self.set(x, y, c)
            else:
                for dy in range(-int(math.ceil(r)), int(math.ceil(r)) + 1):
                    for dx in range(-int(math.ceil(r)), int(math.ceil(r)) + 1):
                        if dx * dx + dy * dy <= r * r + 0.25:
                            self.set(x + dx, y + dy, c)

    def disc(self, cx, cy, rad, c):
        for dy in range(-rad, rad + 1):
            for dx in range(-rad, rad + 1):
                if dx * dx + dy * dy <= rad * rad:
                    self.set(cx + dx, cy + dy, c)

    def ring(self, cx, cy, rad, c, width=2):
        for dy in range(-rad - width, rad + width + 1):
            for dx in range(-rad - width, rad + width + 1):
                d = math.sqrt(dx * dx + dy * dy)
                if rad <= d <= rad + width:
                    self.set(cx + dx, cy + dy, c)

    def text(self, x, y, s, c, scale=2, anchor="left"):
        s = s.upper()
        wpx = len(s) * 6 * scale
        if anchor == "center":
            x -= wpx / 2
        elif anchor == "right":
            x -= wpx
        for k, ch in enumerate(s):
            g = FONT.get(ch, FONT[" "])
            for gy, row in enumerate(g):
                for gx, bit in enumerate(row):
                    if bit == "1":
                        self.rect(x + (k * 6 + gx) * scale, y + gy * scale, x + (k * 6 + gx) * scale + scale - 1, y + gy * scale + scale - 1, c)
        return wpx

    def save(self, path):
        raw = b"".join(b"\x00" + bytes(self.px[3 * y * self.w:3 * (y + 1) * self.w]) for y in range(self.h))

        def chunk(t, d):
            return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
        with open(path, "wb") as fh:
            fh.write(png)


def nice_ticks(lo, hi, n=5):
    span = max(hi - lo, 1e-9)
    raw = span / n
    mag = 10 ** math.floor(math.log10(raw))
    step = min((m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw), default=10 * mag)
    start = math.floor(lo / step) * step
    ticks = []
    t = start
    while t <= hi + step * 0.5:
        ticks.append(round(t, 6))
        t += step
    return ticks


def hull(points):
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


SURFACE, INK, INK2, GRID, EBC, BASEC, HULLC = "#fcfcfb", "#0b0b0b", "#52514e", "#e6e5e1", "#2a78d6", "#52514e", "#b9b8b2"
SHORT = {"TRACE-full": "TRACE-FULL", "TRACE-no-bandit": "NO-BANDIT", "REPUTATION": "REPUTATION", "EIGENTRUST": "EIGENTRUST"}


class Labeler:
    """Greedy label placement: first candidate offset that stays on canvas and clear of other boxes."""

    def __init__(self, cv, x_min, x_max, y_min, y_max):
        self.cv, self.boxes = cv, []
        self.lim = (x_min, x_max, y_min, y_max)

    def block(self, x0, y0, x1, y1):
        self.boxes.append((x0, y0, x1, y1))

    def place(self, x, y, text, color):
        w, h = len(text) * 12, 14
        cands = [(10, -18), (10, 4), (-10 - w, -18), (-10 - w, 4), (-w / 2, -26), (-w / 2, 12), (14, -34), (14, 20), (-14 - w, -34), (-14 - w, 20)]
        for dx, dy in cands + [(10, -18)]:
            bx0, by0 = x + dx, y + dy
            bx1, by1 = bx0 + w, by0 + h
            if bx0 < self.lim[0] or bx1 > self.lim[1] or by0 < self.lim[2] or by1 > self.lim[3]:
                continue
            if any(not (bx1 + 3 < a0 or bx0 - 3 > a1 or by1 + 2 < b0 or by0 - 2 > b1) for a0, b0, a1, b1 in self.boxes):
                continue
            break
        self.cv.text(bx0, by0, text, color, 2)
        self.boxes.append((bx0, by0, bx1, by1))


def plot(attack, base, ebpts, star_result, path):
    W, H, L, R, T, Bm = 960, 680, 100, 40, 116, 108
    cv = Canvas(W, H, SURFACE)
    allf = [p[0] for p in base.values()] + [p[0] for p in ebpts.values()]
    alls = [p[1] for p in base.values()] + [p[1] for p in ebpts.values()]
    xt = nice_ticks(0, max(allf) * 1.08)
    yt = nice_ticks(min(alls) * 0.9 if min(alls) > 0 else 0, max(alls) * 1.08)
    x0, x1, y0, y1 = xt[0], xt[-1], yt[0], yt[-1]
    X = lambda f: L + (f - x0) / (x1 - x0) * (W - L - R)
    Y = lambda s: H - Bm - (s - y0) / (y1 - y0) * (H - T - Bm)
    for t in yt:
        cv.line(L, Y(t), W - R, Y(t), hexrgb(GRID))
        cv.text(L - 10, Y(t) - 7, ("%g" % t), hexrgb(INK2), 2, "right")
    for t in xt:
        cv.line(X(t), H - Bm, X(t), H - Bm + 6, hexrgb(INK2))
        cv.text(X(t), H - Bm + 12, ("%g" % t), hexrgb(INK2), 2, "center")
    cv.line(L, H - Bm, W - R, H - Bm, hexrgb(INK2))
    cv.line(L, T, L, H - Bm, hexrgb(INK2))
    cv.text(L, 18, "X4 PARTITIONED: %s" % attack, hexrgb(INK), 3)
    verdict = "MOVES" if star_result["moves"] else "DOES NOT MOVE"
    cv.text(L, 54, "FRONTIER AT B*=5%%: %s (BOOTSTRAP %.1f%%, NEED 95%%)" % (verdict, 100 * star_result["bootstrapFraction"]), hexrgb(INK2), 2)
    cv.text((L + W - R) / 2, H - 50, "FRAUD (SATS, SUM OF 5 BUYERS, 10-SEED MEAN)", hexrgb(INK2), 2, "center")
    # y label, written as a column of letters would be unreadable; put it on top-left instead
    cv.text(L - 60, T - 28, "SERVED HONEST PROVIDERS (SUM OF 5 BUYERS)", hexrgb(INK2), 2)
    cv.text(W - R - 4, T + 6, "BETTER: LEFT + UP", hexrgb(INK2), 2, "right")
    ly = H - 22
    cv.rect(L - 5, ly + 2, L + 5, ly + 12, hexrgb(BASEC))
    x = L + 14 + cv.text(L + 14, ly, "BASELINE POLICY", hexrgb(INK2), 2) + 30
    cv.disc(x, ly + 7, 6, hexrgb(EBC))
    x = x + 14 + cv.text(x + 14, ly, "TRACE+EB(B), RING = B*", hexrgb(INK2), 2) + 30
    cv.line(x - 4, ly + 7, x + 26, ly + 7, hexrgb(HULLC), 2, dash=6)
    cv.text(x + 36, ly, "BASELINE HULL", hexrgb(INK2), 2)
    lbl = Labeler(cv, L + 2, W - 4, T - 6, H - Bm - 2)
    lbl.block(W - R - 4 - 17 * 12, T + 6, W - R - 4, T + 20)
    for (f, s) in list(base.values()) + list(ebpts.values()):
        lbl.block(X(f) - 7, Y(s) - 7, X(f) + 7, Y(s) + 7)
    hp = hull(list(base.values()))
    for i in range(len(hp)):
        a, b = hp[i], hp[(i + 1) % len(hp)]
        cv.line(X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), hexrgb(HULLC), 2, dash=6)
    for lab, (f, s) in base.items():
        cv.rect(X(f) - 5, Y(s) - 5, X(f) + 5, Y(s) + 5, hexrgb(BASEC))
    order = sorted(ebpts)
    for i in range(len(order) - 1):
        a, b = ebpts[order[i]], ebpts[order[i + 1]]
        cv.line(X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), hexrgb(EBC), 2)
    for bv in order:
        f, s = ebpts[bv]
        cv.ring(X(f), Y(s), 6, hexrgb(SURFACE), 2)
        cv.disc(X(f), Y(s), 6, hexrgb(EBC))
        if bv == B_STAR:
            cv.ring(X(f), Y(s), 10, hexrgb(EBC), 2)
    for name, (f, s) in base.items():
        lbl.place(X(f), Y(s), SHORT[name], hexrgb(INK))
    for bv in order:
        f, s = ebpts[bv]
        lbl.place(X(f), Y(s), ("EB %d%%*" if bv == B_STAR else "EB %d%%") % bv, hexrgb(INK))
    cv.save(path)


def main():
    rows, by = load()
    out_rows = []
    summary = {}
    for a in ATTACKS:
        for p in POLICIES:
            cells = [by[(a, p, s)] for s in SEEDS]
            fr = [c["fraud"] for c in cells]
            sv = [c["servedHonest"] for c in cells]
            mr = [c["maliciousRoutingRate"] for c in cells]
            ex = [c["eb"]["exploreJobs"] for c in cells] if p in EB else None
            es = [c["eb"]["exploreSpend"] / c["eb"]["totalSpend"] if c["eb"]["totalSpend"] else 0 for c in cells] if p in EB else None
            rec = {
                "regime": REGIME, "attack": a, "policy": p, "B": (B_VALUES[EB.index(p)] if p in EB else ""), "n": len(cells),
                "fraud_mean": round(mean(fr), 3), "fraud_sd": round(sd(fr), 3),
                "servedHonest_mean": round(mean(sv), 3), "servedHonest_sd": round(sd(sv), 3),
                "mr_mean": round(mean(mr), 4), "totalJobs_mean": round(mean([c["totalJobs"] for c in cells]), 2),
                "exploreJobs_mean": (round(mean(ex), 2) if ex else ""), "exploreSpendShare_mean": (round(mean(es), 4) if es else ""),
            }
            out_rows.append(rec)
            summary[(a, p)] = rec
    with open(os.path.join(RES, "x4_summary.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(out_rows[0].keys()))
        w.writeheader()
        w.writerows(out_rows)

    full = list(range(len(SEEDS)))
    rng = random.Random(BOOT_SEED)
    boots = [[rng.randrange(len(SEEDS)) for _ in SEEDS] for _ in range(N_BOOT)]

    per = []
    grid_disagree = []
    moved_at_star = 0
    for a in ATTACKS:
        base_full = {p: point_means(by, a, p, full) for p in BASELINES}
        sweep = {}
        for bv, p in zip(B_VALUES, EB):
            e_full = point_means(by, a, p, full)
            dom = dominated(e_full, list(base_full.values()))
            if dominated_grid(e_full, list(base_full.values())) and not dom:
                grid_disagree.append((a, p))
            moves_count = 0
            for idx in boots:
                bp = [point_means(by, a, q, idx) for q in BASELINES]
                if not dominated(point_means(by, a, p, idx), bp):
                    moves_count += 1
            frac = moves_count / N_BOOT
            sweep[str(bv)] = {
                "moves": frac >= THRESHOLD,
                "bootstrapFraction": frac,
                "pointEstimateMoves": not dom,
                "fraud": round(e_full[0], 3),
                "servedHonest": round(e_full[1], 3),
                "mr": summary[(a, p)]["mr_mean"],
                "exploreSpendShare": summary[(a, p)]["exploreSpendShare_mean"],
            }
        star = sweep[str(B_STAR)]
        if star["moves"]:
            moved_at_star += 1
        per.append({
            "regime": REGIME,
            "attack": a,
            "movesAtBstar": star["moves"],
            "bootstrapFractionAtBstar": star["bootstrapFraction"],
            "pointEstimateMovesAtBstar": star["pointEstimateMoves"],
            "ebAtBstar": {"fraud": star["fraud"], "servedHonest": star["servedHonest"], "mr": star["mr"]},
            "dominatedOutrightByAtBstar": [q for q in BASELINES if base_full[q][0] <= star["fraud"] + EPS and base_full[q][1] >= star["servedHonest"] - EPS],
            "exploreSpendShareAtBstar": star["exploreSpendShare"],
            "baselines": {p: {"fraud": round(base_full[p][0], 3), "servedHonest": round(base_full[p][1], 3), "mr": summary[(a, p)]["mr_mean"]} for p in BASELINES},
            "sweep": sweep,
        })
        plot(a, base_full, {bv: (sweep[str(bv)]["fraud"], sweep[str(bv)]["servedHonest"]) for bv in B_VALUES}, star,
             os.path.join(RES, "x4_frontier_%s_%s.png" % (REGIME, a)))

    H1 = moved_at_star >= 3
    sanity = {
        "note": "reported, not a gate. Paper Table 9 partitioned fraud is n=5 seeds from the author's single-process worker; ours is n=10 with one process per buyer session.",
        "fraud": {p: {a: {"ours": summary[(a, p)]["fraud_mean"], "paperTable9": TABLE9[p][a]} for a in ATTACKS} for p in BASELINES},
    }
    out = {
        "H1": H1,
        "rule": "H1 iff TRACE+EB(B*=5%) moves the fraud vs served-honest frontier of the 4 baselines in the partitioned regime for >= 3 of 4 attacks; moves = no convex combination of baseline 10-seed means has fraud <= and served-honest >= the EB point, in >= 95% of 1,000 paired seed-bootstrap resamples",
        "regime": REGIME,
        "Bstar": B_STAR,
        "attacksMovedAtBstar": moved_at_star,
        "attacksNeeded": 3,
        "perRegimeAttack": per,
        "sweepB": B_VALUES,
        "baselines": BASELINES,
        "nCells": len(rows),
        "seeds": SEEDS,
        "bootstrap": {"resamples": N_BOOT, "rngSeed": BOOT_SEED, "paired": True, "threshold": THRESHOLD},
        "lp": "exact 2-D reduction (segment-quadrant test over all baseline pairs); simplex-grid cross-check disagreements: %d" % len(grid_disagree),
        "metrics": {"fraud": "sats paid to malicious providers on jobs that defaulted, summed over the 5 buyers", "servedHonest": "distinct honest providers given >= 1 job, summed over the 5 buyer sessions (each session draws its own market of 700 honest providers)"},
        "cut": "FASTPLAN cut 4: partitioned regime only (360 cells); the sparse-centralized regime was not run",
        "unitCaveat": "sats on a simulated Lightning market (TRACE simulator); informs the wallet's design and default B, not a measurement of the wallet",
        "sanity": sanity,
        "source": "sim/results/x4_cells.jsonl",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    js = json.dumps(out, indent=2) + "\n"
    with open(os.path.join(RES, "x4_h1.json"), "w", encoding="utf-8") as fh:
        fh.write(js)
    if not PARTIAL_OUT:
        os.makedirs(os.path.join(ROOT, "results"), exist_ok=True)
        with open(os.path.join(ROOT, "results", "x4_h1.json"), "w", encoding="utf-8") as fh:
            fh.write(js)
    print("H1 = %s (moved at B*=5%% for %d/4 attacks)" % (H1, moved_at_star))
    for r in per:
        print("  %-18s B*: moves=%s frac=%.3f point=%s | %s" % (
            r["attack"], r["movesAtBstar"], r["bootstrapFractionAtBstar"], r["pointEstimateMovesAtBstar"],
            " ".join("B%s:%.2f" % (b, r["sweep"][b]["bootstrapFraction"]) for b in map(str, B_VALUES))))
    if grid_disagree:
        print("grid cross-check disagreement:", grid_disagree)
        sys.exit(3)


if __name__ == "__main__":
    main()
