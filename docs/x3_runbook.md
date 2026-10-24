# X3 runbook: a real x402 payment on Base mainnet with a contract signature

**User-run.** No script in this repo sends a transaction or a payment unless you pass `--send`, and nothing
here ever asks for the owner key. The point of X3 (EXPERIMENTS.md) is one real, tiny payment that proves a
contract signature (the one-door envelope) settles through a real facilitator, and that the three negative
cases hold on mainnet.

## What it decides

| Outcome | Decision |
|---|---|
| Pass | Ship ERC-1271 mode `OWNER_PLUS_X402_VOUCHER` as an opt-in and put the receipt link on the slide. |
| Fail | `OWNER_ONLY` stays the default; x402 runs through a capped float EOA (IDEA.md section 11). The side-door card holds either way. |

Honest unit: one payment of $0.005 to your own endpoint. It shows that a contract signature settles
through a real facilitator. It does not show that strangers' merchants accept it.

## Safety rules

- The mainnet account holds **about 1 USDC and a little ETH**. The contracts are unaudited.
- The **owner key stays in MetaMask**. `plan` prints transactions for you to sign there. The owner seed is
  never in `.env`, the repo, the agent host, or on a projector.
- The agent key is a fresh throwaway (`scripts/x3/.agent.key`, git-ignored). It holds no funds and no ETH.
- The relayer is a separate EOA with a few cents of Base ETH, used only for `handleOps`.
- Policy on the account: only `USDC.transfer(payee)` for the single listed `payTo` address, 0.01 USDC per
  transaction, 0.05 USDC per 24 h, expiry in 7 days. The most this setup can lose is 0.05 USDC a day.

## Steps

All commands run from the repository root: `pnpm exec tsx scripts/x3/x3.ts <command>`.

0. **Local rehearsal (no mainnet, no keys with value):** `pnpm exec tsx scripts/x3/selftest.ts`. It applies the
   owner tx pack, registers a voucher, builds the digest, envelope and `X-PAYMENT` header, and settles through
   the account on anvil. Expect `10/10 ok` (`results/x3_selftest.json`).
1. **Deploy the stack on Base (your decision):**
   `RPC_URL=https://mainnet.base.org DEPLOYER_KEY=<a fresh deployer EOA with ~0.005 ETH> ENTRYPOINT=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108 pnpm exec tsx scripts/deploy.ts --allow-mainnet`
   writes `deployments/8453.json`. (Or `forge script contracts/script/Deploy.s.sol`; same contracts.)
2. **Agent key:** `x3.ts agent-key` prints the agent address.
3. **Owner transactions:** `x3.ts plan --owner <your MetaMask address> --pay-to <TRACE payTo> --salt 1`
   writes `scripts/x3/owner_txs.json` (create account, daily limit, listed payee, agent session, 1271 mode,
   EntryPoint deposit, 1 USDC top-up). Send them from MetaMask in order.
4. **Voucher:** `TRACE_X402_URL=<live endpoint> RELAYER_KEY=<relayer EOA> x3.ts voucher --send` registers a
   voucher for exactly the endpoint price (5000 base units = $0.005), valid 540 s. **Run step 5 immediately:**
   the account caps voucher validity at 600 s (`OneDoorLib.VOUCHER_MAX_TTL`).
5. **Pay:** `x3.ts pay --send` does the 402 dance. It first checks that the 402 terms (payTo, amount, asset)
   equal the registered voucher and refuses to sign otherwise, then signs the EIP-3009 authorization with the
   agent key, wraps it in the one-door envelope, and retries with `X-PAYMENT`.
6. **Verify:** `x3.ts verify --tx <settlement tx hash from X-PAYMENT-RESPONSE>` writes `results/x3_mainnet.json`.

## Pass criteria (all recorded by `verify`)

- The endpoint returned 200 with a settlement receipt.
- Basescan shows a USDC transfer from the agent account to `payTo` of exactly 5000 base units.
- `authorizationState(account, nonce)` is true, so a second payment with that nonce is refused by the token.
- The account's global bucket was debited once, at voucher registration.
- An agent signature with no voucher behind it gets `0xffffffff` from `isValidSignature`.

## Known fail modes (record whichever happens)

- **A10:** the facilitator rejects a non-65-byte contract signature, or the client cannot choose the nonce.
  Then 1271 stays `OWNER_ONLY` and x402 goes through the float EOA.
- **No v0.8 bundler on Base mainnet:** `voucher --send` already uses `handleOps` from your relayer EOA, so this
  only matters if you want a real bundler.
- **A14:** no Base ETH for the deployer, relayer or deposit.
- **Expired voucher:** the account refused a validity above 600 s, or the payment came after `validBefore`.
  Re-run `voucher --send` then `pay --send`.

## Rig stub

`scripts/rig/rig.ts` (testnets and anvil only; it refuses every other chain): `new-key`, `fund --to --eth`,
`reset --account --agents` (revoke, unfreeze, bump the attestation epoch) for a clean take between demo runs.
