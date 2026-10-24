# Hypnexis W3-02 Agent Wallet (backend)

An ERC-4337 account whose agent key can only spend inside the owner's policy, even if the key leaks
or the agent is prompt-injected. Backend only: contracts, services, agent/attack harness, simulator.

## One command

```
pnpm run bootstrap   # JS deps, Foundry deps (contracts/lib), forge build
pnpm run demo        # starts anvil, runs tools/demo/beats/*.ts, writes results/demo_run.json
```

Checks: `pnpm run test:all && pnpm run demo && python tools/gate.py` (Gate G).

## Requirements

Node >= 22, pnpm 11, Foundry (`foundryup`; forge/anvil/cast on PATH or in `~/.foundry/bin`),
Python 3.11 (`uv sync` for the analysis deps), Ollama for the LLM shooter. Copy `.env.example` to `.env`.

## Layout

`contracts/` Foundry project, `packages/shared` config + UserOp v0.8 helpers, `services/approval`,
`services/attestor`, `agent/`, `sim/` (standalone), `tools/` acceptance scripts, `results/` every
metric file (written by code only). `python tools/toolchain.py` re-probes the toolchain and Base.
