# Live demo: real Base Sepolia, real USDC, your MetaMask as the owner

Nothing in this demo is mocked. The chain is Base Sepolia, the token is Circle's test USDC, the EntryPoint is
the canonical v0.8, the attestor / approval / watcher are the real services running as processes, and the
owner is **your MetaMask**: your key never touches a script, an env file or a log. The agent key is a
throwaway testnet key that we deliberately **leak on screen**, and the attacks run live against four wallets
that hold the same real test USDC:

| Wallet | What it is | Owner |
|---|---|---|
| **R1** | the agent's own EOA, no policy (the floor) | none |
| **R2** | a static-allowlist smart account (what most teams build) | throwaway deployer |
| **R3** | this wallet without payee tiers (exploration off) | **you (MetaMask)** |
| **R4** | this wallet with payee tiers and the real attestor (the product) | **you (MetaMask)** |

The anvil script `scripts/live/rehearse.ts` is a **pre-flight test only** (it needs a stand-in token because
there is no Circle USDC on a local chain). It is never the demo.

## What you must supply (once)

| What | Where | Amount |
|---|---|---|
| Your MetaMask **public address** | `init --owner` | n/a (never the key or seed) |
| Base Sepolia **ETH** to the deployer / relayer (printed by `init`) | [alchemy faucet](https://www.alchemy.com/faucets/base-sepolia) or [Base faucets](https://docs.base.org/chain/network-faucets) | **0.03 ETH** |
| Base Sepolia **ETH** to your MetaMask | same faucets | **0.01 ETH** |
| Circle test **USDC** to your MetaMask | <https://faucet.circle.com> (choose *Base Sepolia*, paste your MetaMask address) | **10 USDC** (one request) |
| Circle test **USDC** to the deployer | same faucet, paste the deployer address | **10 USDC** (second request) |

Where it goes: `fund --send` pays **3 USDC** each to R1, R2, R3 from the deployer; you send **3 USDC** to R4
from MetaMask in the frontend (that is the "real USDC from MetaMask" moment). The daily limit on R3/R4 is
**2 USDC** (1 burst + 1 refilling per day), so every attack ends well inside the 3 USDC balance. Change
`FUND_USDC`, `DAILY_*` in `.env.live` before `deploy` if you want other numbers.

## Zero to demo (about 15 minutes of setup, mostly waiting for faucets)

Run everything from the repository root (`C:\Users\siddh\Downloads\Hypnexis\Hypnexis`). `pnpm` and Node 22+
and Foundry are required (`contracts/out` must exist: `cd contracts && forge build` once).

1. **Generate the config** (throwaway keys, your public address):
   `pnpm exec tsx scripts/live/live.ts init --owner 0xYourMetaMaskAddress`
   Writes `.env.live` and `web/.env` (both git-ignored; the owner key is nowhere) and prints the addresses to
   fund. It also checks Base Sepolia: EntryPoint v0.8 present, Circle USDC answers `authorizationState`.
2. **Fund the deployer** with 0.03 ETH and your MetaMask with 0.01 ETH (table above).
3. **Deploy** the stack and the four wallets:
   `pnpm exec tsx scripts/live/live.ts deploy`
   Libraries are linked, then R1..R4 are created, R2 is configured, the EntryPoint gas deposits are topped
   up, the watcher and attestor keys get gas, and `deployments/84532.json` (with a `live` section) and
   `web/.env` are written. Takes a few minutes on the public RPC.
4. **Faucet USDC**: 10 to your MetaMask, 10 to the deployer (table above), then
   `pnpm exec tsx scripts/live/live.ts fund --send`
   which pays R1, R2 and R3 their 3 USDC. (`fund` without `--send` shows balances and what is missing.)
5. **Start the real services** (attestor, approval, watcher, gateway):
   `pnpm exec tsx scripts/live/live.ts services up`
   The frontend talks to ONE port, the gateway on `http://localhost:8800`.
6. **Start the frontend**: `cd web && npm run dev` and open <http://localhost:5173>. (`npm ci && npm run build`
   already pass; `web/.env` was written in step 1/3.)
7. **Connect MetaMask** on Base Sepolia (the page offers *Switch network*; it adds the chain if needed) and
   use the **same account you passed to `init --owner`**.
8. **Owner setup of R3 and R4.** Two ways, same result:
   - in the frontend: *Setup* (create/fund/attestor), *Policy* (daily limit), *Keys*, *Payees*; or
   - `pnpm exec tsx scripts/live/live.ts owner-pack` prints/writes `scripts/live/owner_txs.json`: the exact
     owner transactions (`to`, `data`) for R3 and R4 in order (daily limit, trusted merchant, session key
     for the agent, attestor on R4 only, watcher, five guardians 3-of-5, freeze tripwires). Send each from
     MetaMask (Settings > Advanced > *Show hex data* lets you paste the data on a plain Send).
   - **R4 gets its 3 USDC from MetaMask** (frontend *Setup*, "Fund it", or a plain token transfer).
9. **Check everything is green**: `pnpm exec tsx scripts/live/live.ts doctor`
   Red = fix before presenting (each line prints the exact command). Amber items are optional.
10. **Present** (talk track below).

Stop everything afterwards: `pnpm exec tsx scripts/live/live.ts services down`.

## Frontend and contract owner calls (resolved)

`web/src/chain/abi.ts` was aligned to the deployed contracts (WEBFIX): `setPolicy(agent, PolicyInput)` creates and
edits session keys, `setGlobalCap(asset, burst, ratePerDay)`, `setExploreCap` + `setExplorePerTxCap`, `revoke`,
`unflag`, `setGasCredit`, `unfreeze`. Declining a request signs `Hypnexis approval service: reject request <id>`
in MetaMask (the real service needs it). The frontend's Setup, Policy, Keys, Payees and Approvals buttons therefore
work against the real account, and `owner-pack` (step 8) is only a fallback if you prefer pasting calldata.
The Activity page decodes the contract's own events; reading state goes through the gateway.

## The 10-minute talk track

1. **(1 min) The promise.** "An AI agent has a key. Assume it leaks. What can it cost you?" Open *Overview*:
   R4 holds 3 USDC, daily limit 2 USDC, one trusted merchant.
2. **(2 min) You are the owner.** In MetaMask, show the policy you signed (or sign one step live): the daily
   limit, the one merchant, the agent's session key, the watcher that can only freeze. "My key is in
   MetaMask. The agent never had it."
3. **(1 min) Leak it.** `pnpm exec tsx scripts/live/live.ts leak` prints the agent's private key on the
   projector. "It is public now."
4. **(3 min) Attack with it, live** (Demo page, or `live.ts attack all` in a terminal):
   - **R1** (the raw key): everything is gone. **R2** (static allowlist): the side door and a recipient
     argument still drain it.
   - **R4**: the side-door signature is refused (`0xffffffff`); approve-max is refused; paying an unknown
     address is capped at the tiny exploration amount; the third strike **freezes the key** (watch the
     freeze appear on-chain); the forged "trusted payee" attack stops at the daily limit.
   - The running counter shows what the attacker holds against the **2 USDC daily limit**.
5. **(1 min) Owner responds.** In MetaMask, **Unfreeze** the key (only you can; the watcher can only freeze).
   Then "disable detectors" (demo only) and run the attack once more: with every detector off, the daily
   limit alone still bounds the loss.
6. **(1 min) Approve something out of policy.** The agent files a request ("pay this unknown address 1
   USDC"); you read it in plain words in *Approvals* and **sign the approval in MetaMask**. The approval
   caps the outflow, the payee and the expiry; the agent's own words are not signed.
7. **(1 min) The numbers.** Open the README Results section (every figure there is checked against the result files by `tools/check_claims.py`): the scored hijack campaign (containment, detection, false freezes, the largest attacker gain against the daily limit) and the 49-cell attack table that compares the static-allowlist baseline with R4. Do not quote numbers from memory.

## What is real, what is not

- **Real:** Base Sepolia, Circle test USDC (EIP-3009 side door works on it), EntryPoint v0.8, the deployed
  contracts, your MetaMask signatures, the attestor / approval / watcher services (own processes, own keys,
  logs in `scripts/live/.state/logs/`), the freeze transactions the watcher sends.
- **Throwaway / simulated by design:** the agent key (leaked on purpose), the attacker identity, the
  merchant (a plain address), the deployer-owned R2 baseline, the gateway's attack runner (it is OUR script
  playing the attacker, with the leaked key, against real wallets). There is no bundler on this path: UserOps
  are sent with `EntryPoint.handleOps` by the relayer EOA.
- **Not covered here:** x402 (a real facilitator exists on mainnet only; that is the user-run X3 in
  `docs/x3_runbook.md`), and the LLM attacker (see `results/x1_llm.json`).

## Safety

- Testnet only. A mainnet chain is **refused** by every command unless you pass `--allow-mainnet`; then the
  contracts are unaudited, so keep the account at about 1 USDC.
- `.env.live` holds throwaway testnet keys, is git-ignored, and never contains your owner key. Do not paste a
  seed phrase or private key anywhere: `init` rejects anything that looks like one.
- Faucet USDC and ETH have no value. Nothing here can touch your real funds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `doctor` red *deployer has ETH* | send 0.03 Base Sepolia ETH to the printed deployer address |
| `deploy` fails with rate limits / timeouts | put an Alchemy / Infura Base Sepolia URL in `RPC_URL` in `.env.live` and re-run (it resumes: existing contracts/wallets are skipped) |
| `fund --send` says the deployer is short | the faucet gives 10 USDC per request; request again for the deployer address |
| Frontend says *wrong network* / *not the owner* | switch MetaMask to Base Sepolia and select the account you gave `init --owner` |
| An owner button reverts | it is a name in the frontend ABI table above; use `owner-pack` |
| `services up` does not start the gateway | `services/gateway` must exist; `pnpm install` once, then re-run |
| Approval service cannot simulate | RPC lacks `eth_call` state overrides: `APPROVAL_SIMULATION_MODE=declared` in `.env.live` |
| Port in use | change `*_PORT` in `.env.live`, run `init` again to refresh `web/.env` (keeps keys), `services down`, `services up` |
| Start over | `live.ts init --force --owner 0x…` regenerates every key; `deploy` makes a fresh stack |

## Commands

```
live.ts init --owner 0x…     live.ts deploy [--redeploy]     live.ts fund [--send]     live.ts owner-pack
live.ts doctor               live.ts services up|down|status live.ts status [--json]   live.ts leak
live.ts attack unproven|forged|spray|sidedoor|approvemax|all   live.ts legit | pay | request | vouch
live.ts recovery propose|approve|status    live.ts fund-keys [--guardians]    live.ts watcher
```
(all as `pnpm exec tsx scripts/live/live.ts <command>`)
