# TRACE Reproducibility Package
# paper/reproducibility/README.md — v3 (2026-05-15, v2.10)

## System Requirements

- **Node.js** ≥ 18.0 (tested: v18.20.x, v20.x)
- **TypeScript** via `tsx` (`npm install -g tsx`)
- **OS**: Windows 11 / Linux / macOS
- **RAM**: 16 GB minimum (32 GB recommended for N≥5000)
- **Disk**: 2 GB free for database and results

---

## Exact Reproduction Commands

### 1. Install dependencies

```bash
npm install
```

### 2. Reproduce publication-scale matrix (all N levels, 10 seeds)

```bash
# Full matrix: N=10,50,100,1000,5000 × 6 attacks × 4 policies × 10 seeds = 1200 cells
npx tsx scripts/runPublicationMatrix.ts

# Specific N levels only:
npx tsx scripts/runPublicationMatrix.ts --n-levels 100,1000

# With concurrency (if RAM allows):
npx tsx scripts/runPublicationMatrix.ts --max-concurrent 2
```

### 3. Reproduce extreme-scale stress test (N=5000, N=10000)

```bash
# 40 cells: 2 N-levels × 5 attacks × 4 policies × 1 seed
npx tsx scripts/runExtremeScaleMatrix.ts
```

### 4. Reproduce N=1000 smoke matrix (3 seeds, 12 policies incl. ablations)

```bash
# 216 cells: 6 attacks × 3 seeds × 12 policies
npx tsx scripts/runSmokeMatrixN1000.ts
```

### 5. Reproduce single-cell experiment

```bash
# Write config to file, invoke worker directly:
echo '{"cellId":"test","policyLabel":"TRACE-full","policy":"TRACE","ablation":{},"attack":"strategic-default","seed":42,"networkSize":1000,"rounds":60,"jobsPerRound":5,"maliciousRatio":0.3,"configHash":"test"}' > _tmp_config.json
npx tsx scripts/_publicationMatrixWorker.ts _tmp_config.json
```

---

## Configuration Lock

The paper system is TRACE v2.10 with Publication_Preset:

```typescript
// Ghost module flags (both OFF):
GHOST_MODULE_FLAGS.TEMPORAL_ENABLED = false;
GHOST_MODULE_FLAGS.CAUSAL_ENABLED = false;

// Active mechanisms:
// - Bayesian LCB (Framework 1)
// - Thompson Sampling (Framework 2)
// - Personalized PageRank (Framework 3)
// - Counterparty Entropy (Framework 4)
// - CUSUM Change-Point (Framework 5)
// - Progressive Trust Unlocking (Framework 6)
// - Fix 1: Graph signal inversion (deficit-penalty model)

// Routing utility weights:
// alpha_traceScore: 0.40, beta_defaultRisk: 0.30, gamma_cost: 0.15
// delta_networkTrust: 0.10, epsilon_capability: 0.10
// lambda_sybilPenalty: 0.35, mu_cliquePenalty: 0.25
```

---

## Canonical Seeds

- Publication matrix: seeds 42-51 (10 seeds per N level)
- Extreme-scale matrix: seed 42 (1 seed per N level)
- Smoke matrix: seeds 42-44 (3 seeds)

---

## Output Artifacts

### Publication Matrix
```
results/publication/
├── final_matrix_N10.jsonl
├── final_matrix_N50.jsonl
├── final_matrix_N100.jsonl
├── final_matrix_N1000.jsonl
├── final_matrix_N5000.jsonl
├── summary_aggregate.csv
├── summary_per_policy.csv
├── summary_per_attack.csv
├── reproducibility_metadata.json
└── runtime_telemetry.jsonl
```

### Extreme-Scale Matrix
```
results/extreme-scale/
├── extreme_scale_N5000.jsonl
├── extreme_scale_N10000.jsonl
├── summary_aggregate.csv
├── summary_per_policy.csv
├── summary_per_attack.csv
├── reproducibility_metadata.json
└── runtime_telemetry.jsonl
```

### Smoke Matrix
```
smoke_matrix_N1000_seeds3.jsonl
smoke_matrix_N1000_seeds3_summary.csv
```

---

## Verification

Each matrix runner includes a validation cell that:
1. Runs TRACE-full | strategic-default | seed=42 | N=100
2. Verifies all metrics are valid and finite
3. Aborts the full matrix if validation fails

Results are resume-safe: re-running a matrix skips already-completed cells.

---

## Key Results (N=1000, seed=42, 30% malicious)

| Attack | Policy | Fraud (sats) | Mal. Routing |
|--------|--------|:------------:|:------------:|
| strategic-default | TRACE-full | 64 | **27.3%** |
| strategic-default | REPUTATION | 22 | 30.0% |
| strategic-default | STAKE_WEIGHTED | 21 | 30.0% |
| collusion-ring | TRACE-full | 588 | **28.3%** |
| collusion-ring | STAKE_WEIGHTED | 164 | 30.0% |
| sybil-cluster | TRACE-full | 130 | **20.3%** |
| sybil-cluster | REPUTATION | 52 | 30.0% |
| econ-whitewashing | ALL | 0 | — |

> TRACE's advantage: lowest malicious routing rate across all attacks.

---

## File Inventory

```text
paper/
├── drafts/
│   ├── section1_intro_abstract.md   # Abstract + Intro + Problem Formulation
│   ├── section3_system_design.md    # 6 frameworks, utility, Fix 1
│   ├── section4_evaluation.md       # 6 attacks, 4 policies, all results
│   ├── section5_related_work.md     # Bayesian trust, bandits, impossibility
│   ├── section6_methodology.md      # Seeds, isolation, memory, stats
│   └── section7_conclusion.md       # Contributions, impossibility, future work
├── figures/
│   └── (7 figures with PDF/PNG/SVG variants)
├── tables/
│   └── all_tables.md               # T1-T9 updated tables
├── references/
│   └── citation_tracker.md          # BibTeX references
├── reproducibility/
│   └── README.md                    # This file
└── results/
    └── (prior result files — to be updated)
```
