# Hypnexis W3-02 agent wallet: API contract

This file is the contract between every build lane and the later UI. Written in M1 (lane CORE).
Changes are additive and go in the changelog at the end. Section owners: contract surface CORE
(M1), then D2 / D1 / D3 / APPC for their module rows; approval service APPS (M5); attestor ATT (M6);
tools HARN (M7). Numbers here are configuration values, not measurements; measured numbers live in
`results/*.json` only.

Contents: 1 ownership, 2 contract surface, 3 validation and execution with hook call points,
4 encodings (agent op, signature, nonce lanes), 5 typed data, 6 storage layout, 7 reason codes,
events and errors, 8 setPolicy hard rules, 9 module contracts for lanes, 10 R2 baseline,
11 demo policy fixture, 12 HTTP APIs, 13 results file schemas, 14 changelog.

## 1. Ownership (FASTPLAN.md)

| Lane | Owns | Wave |
|---|---|---|
| SIM | `sim/**`, `docs/x4_report.md` | W0 |
| CORE | `contracts/src/AgentAccount*.sol`, `contracts/src/lib/**`, `contracts/src/modules/*` (stubs), `contracts/src/baselines/**`, `contracts/src/mocks/**`, `contracts/test/unit/M1_*`, `docs/api.md`, new files in `packages/shared/src/` | W1 |
| ATT | `services/attestor/**`, `contracts/test/vectors/score_attestation.json`, `docs/api.md` attestor section (append), `packages/shared/src/attestor/**` | W1 |
| D2 | `contracts/src/modules/MeterModule.sol`, `contracts/test/unit/M2_*`, `contracts/test/invariant/M2_*` | W2 |
| D1 | `contracts/src/modules/OneDoorModule.sol`, `contracts/test/unit/M3_*`, `contracts/test/fork/M3_*` | W2 |
| D3 | `contracts/src/modules/PayeeTierModule.sol`, `contracts/test/unit/M4_*` | W2 |
| APPC | `contracts/src/modules/ApprovalModule.sol`, `contracts/src/lens/**`, `contracts/test/unit/M5_*` | W2 |
| APPS | `services/approval/**`, `docs/api.md` approval section (append), `packages/shared/src/approval/**` | W2 |
| HARN | `agent/**`, `tools/x1_*` | W2 |
| INT | any file (log every cross-lane edit) | W3 |
| X1 | `agent/**`, `results/x1_*`, `contracts/test/cards/**`, `tools/x1_*` | W4 |
| M9 | `docs/THREAT_MODEL.md`, `docs/x3_runbook.md`, `docs/slither_triage.md`, `scripts/**`, `contracts/script/**`, `README.md` | W4 |
| FRZ (phase 2) | `contracts/src/modules/FreezeModule.sol`, `contracts/test/unit/FRZ_*` | W2+ |
| REC (phase 2) | `contracts/src/modules/RecoveryModule.sol`, `contracts/test/unit/REC_*` | W2+ |
| PM (phase 2) | `contracts/src/paymaster/**` (`AgentPaymaster.sol`), `contracts/test/unit/PM_*` | W2+ |

File-level detail for the contract tree after M1:

| File | Owner after M1 | Rule |
|---|---|---|
| `src/AgentAccount.sol` (core flow, hook call points, fallback) | CORE, then INT | frozen in W2; change by DECISIONS.md request |
| `src/AgentAccountBase.sol` (`AccountCommon` events/errors/helpers, `AgentAccountBase` hook declarations) | CORE, then INT | frozen in W2 |
| `src/AgentAccountAdmin.sol` (owner setters + views, reached by DELEGATECALL) | CORE, then INT | frozen in W2 |
| `src/AgentAccountFactory.sol` | CORE, then INT | frozen in W2 |
| `src/lib/{PolicyTypes,AccountStorage,PolicyCheck,ArgRules,Buckets,TypedData}.sol` | CORE, then INT | frozen in W2; additive changes only |
| `src/modules/MeterModule.sol` | D2 | edit freely; keep the hook signatures |
| `src/modules/OneDoorModule.sol` | D1 | edit freely; keep the hook signatures |
| `src/modules/PayeeTierModule.sol` | D3 | edit freely; keep the hook signatures |
| `src/modules/ApprovalModule.sol` | APPC | edit freely; keep the hook signatures |
| `src/modules/FreezeModule.sol` (`FreezeStorage`, core-side `FreezeModule` hooks, admin-side `FreezeAdmin`) | FRZ | edit freely; keep the hook signatures and the admin function names |
| `src/modules/RecoveryModule.sol` (`RecoveryStorage`, admin-side `RecoveryModule`) | REC | edit freely; owner changes only through the core hook `_applyRecovery` |
| `src/paymaster/AgentPaymaster.sol` | PM | separate contract; the account only checks its address (section 3.5) |
| `src/baselines/NaiveAccount.sol`, `src/mocks/*` | CORE (M0 created the mocks) | frozen in W2 |
| `test/unit/M1_Fixture.sol` (shared test fixture) | CORE | others import it read-only |
| `test/cards/CardBase.sol`, `test/cards/deck.json`, `test/cards/M1_Cards.t.sol` | CORE in M1; X1 lane from W4 | later lanes add `test/cards/M<k>_*.t.sol` files; deck.json already lists every planned card |

Size budget: both `AgentAccount` and `AgentAccountAdmin` runtimes must stay under 24,576 bytes
(EIP-170). After M1 + phase-2 stubs (`forge build --sizes`): core 14,455 B (10,121 B left for the
D2 / D1 / D3 / APPC / FRZ fills), admin 20,349 B (4,227 B left, mostly for REC). Owner / watcher /
guardian functions that are not on the validation or execution path belong on the admin side
(like `FreezeAdmin` and `RecoveryModule`); ask through DECISIONS.md.

## 2. Contract surface

### 2.1 Contracts

| Contract | Role |
|---|---|
| `AgentAccount` | the wallet (EIP-1167 clone of one implementation). `BaseAccount` (EntryPoint v0.8) + `IAccountExecute` + `IERC1271` + the core-side modules (Meter, OneDoor, PayeeTier, Approval, Freeze). |
| `AgentAccountAdmin` | owner setters and views. Never called on its own address: `AgentAccount.fallback` DELEGATECALLs every selector the core does not implement, so these run on the account's storage with the original `msg.sender`. Callers use the account address with the merged ABI (`AgentAccount` + `AgentAccountAdmin`). Also carries `FreezeAdmin` (FRZ) and `RecoveryModule` (REC). |
| `AgentAccountFactory` | CREATE2 factory of EIP-1167 clones: `constructor(AgentAccount implementation)`, `createAccount(owner, salt)`, `getAddress(owner, salt)`. Deploy order: `AgentAccountAdmin(ep)`, then `AgentAccount(ep, admin)` (the implementation), then the factory. Salt = `keccak256(abi.encode(owner, salt))`, so the address binds the owner; anyone may call it. |
| `AgentPaymaster` (PM lane) | optional paymaster for agent ops; agent ops may name only the owner-set one (section 3.5). |
| `NaiveAccount` | the R2 baseline (section 10). |
| `EntryPoint` | eth-infinitism v0.8.0 (`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` on Base; local deploy in tests). |

### 2.2 AgentAccount (core) functions

| Function | Who | Notes |
|---|---|---|
| `constructor(IEntryPoint ep, address admin)` | factory | implementation is locked (initialized = true) |
| `initialize(address owner)` | factory, once per clone | sets owner, attestEpoch = 1 |
| `validateUserOp(PackedUserOperation, bytes32 userOpHash, uint256 missingFunds) returns (uint256)` | EntryPoint | section 3.1 |
| `executeUserOp(PackedUserOperation, bytes32 userOpHash)` | EntryPoint | section 3.2; the only agent execution path (sandboxed) |
| `agentInnerExecute(OpContext ctx, AgentCall call, bytes approval) returns (Outflow[])` | the account itself only | the sandbox's inner frame; `NotSelf` for any other caller, `InnerNotArmed` unless armed by `executeUserOp` (one shot) |
| `execute(address target, uint256 value, bytes data)` | EntryPoint (owner ops) or owner EOA | owner only in practice: agent ops can never carry this selector |
| `executeBatch(Call[] calls)` | EntryPoint (owner ops) or owner EOA | as above |
| `isValidSignature(bytes32 hash, bytes signature) returns (bytes4)` | anyone | 0xffffffff while an agent op executes; else `_door1271` (M1: owner only) |
| `policyCheck(address agentKey, bytes callData, bytes attestation, bytes approval) view returns (uint16 reason, Tier tier, Track track, uint48 validUntil)` | anyone | validation-equivalent check without nonce, gas or time; base of the M5 `checkPolicy` lens |
| `checkUserOp(PackedUserOperation, bytes32 userOpHash) view returns (uint16 reason, uint48 validAfter, uint48 validUntil)` | anyone | the full validation of section 3.1 without the gas-credit debit; tools and tests use it to learn the reason a UserOp would fail |
| `entryPoint() view`, `admin() view`, `getNonce() view`, `eip712Domain() view` | anyone | |
| `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived` | tokens | accept NFTs |
| `receive()` | anyone | plain ETH |
| `fallback()` | anyone | DELEGATECALL to `AgentAccountAdmin` |

### 2.3 AgentAccountAdmin functions (called on the account address)

Owner = `msg.sender == owner` or `msg.sender == account` (an owner op calling the account).

| Function | Who | IDEA 7.1 field |
|---|---|---|
| `transferOwnership(address newOwner)` | owner | `owner` (refuses 0, the account, a live agent key) |
| `setPolicy(address agentKey, PolicyInput p)` | owner | per-key `Policy`; section 8 hard rules. Every call starts a new rule/asset generation and a fresh nonce key, resets `revoked` |
| `revoke(address agentKey)` | owner | `revoked` |
| `rotateKey(address oldKey, address newKey)` | owner | moves the session (rules, buckets, gas credit) to `newKey`, fresh nonce key |
| `setGasCredit(address agentKey, uint128 wei)` | owner | `gas.gasCredit` (refill) |
| `setRecipient(address r, bool listed)` | owner | `recipients` |
| `setGlobalCap(address asset, uint128 burst, uint128 ratePerDay)` | owner | `globalCap[asset]`; the first call tracks the asset and sets the 7.1 defaults exploreCap = 5% (burst/rate split in half) and explorePerTxCap = 1% of the cap |
| `setExploreCap(address asset, uint128 burst, uint128 ratePerDay)` | owner | `exploreCap[asset]` |
| `setExplorePerTxCap(address asset, uint128 cap)` | owner | `explorePerTxCap[asset]` |
| `setSig1271Mode(uint8 mode)` | owner | `sig1271Mode` (0 OWNER_ONLY, 1 OWNER_PLUS_X402_VOUCHER) |
| `setAttestor(address a)` | owner | `attestor`; refuses a live agent key (F27) |
| `bumpEpoch()` | owner | `attestEpoch += 1` |
| `flag(address payee)` | attestor or owner | `flagged[payee] = true` (escalate-only, I10) |
| `unflag(address payee)` | owner | `flagged[payee] = false` |
| `setTrackedSpenders(address[] s)` | owner | `trackedSpenders` (replace) |
| `setTrackedNFTs(address[] n)` | owner | `trackedNFTs` (replace) |
| `addDeposit() payable` | anyone | EntryPoint deposit |
| `withdrawDepositTo(address to, uint256 amount)` | owner | EntryPoint deposit |
| `setAgentPaymaster(address pm)` | owner | `agentPaymaster` (phase 2): the only paymaster agent ops may name; 0 = none |
| `freeze(address agentKey)` | owner or watcher | FreezeAdmin (FRZ): `frozen[agentKey] = true` (escalate-only) |
| `unfreeze(address agentKey)` | owner | FreezeAdmin: clears the freeze and the strikes |
| `setWatcher(address w)` | owner | FreezeAdmin: the escalate-only watcher; refuses a live agent key; setPolicy refuses the watcher as a key |
| `setGuardians(address[] g, uint8 threshold)` | owner | RecoveryModule (REC): up to 5 guardians (target: 5, threshold 3) |
| `proposeRecovery(address newOwner)`, `approveRecovery(uint64 id)`, `executeRecovery()` | guardians / anyone after 48 h | RecoveryModule; M1 stub reverts `RecoveryNotEnabled` |
| `vetoRecovery()` | owner | RecoveryModule: cancels the pending proposal |

Views: `owner()`, `sig1271Mode()`, `attestor()`, `attestEpoch()`, `isRecipient(a)`,
`recipientList()` (may include de-listed entries; filter with `isRecipient`), `isFlagged(a)`,
`globalBucket(asset) -> Bucket`, `exploreBucket(asset) -> Bucket`, `explorePerTxCap(asset)`,
`trackedAssets()`, `trackedSpenders()`, `trackedNFTs()`, `voucher(bytes32 nonce) -> Voucher`,
`sessionOf(agentKey) -> (uint64 sid, Session)`, `keyAsset(agentKey, asset) -> AssetLimit`,
`keyAssets(agentKey) -> address[]`, `ruleOf(agentKey, target, selector) -> (bool allowed, ArgRule[])`,
`rulesOf(agentKey) -> RuleRef[]`, `nonceKeyOf(agentKey, uint8 lane) -> uint192`,
`domainSeparator()`, `getDeposit()`, `agentPaymaster()`, `isFrozen(agentKey)`, `strikes(agentKey)`,
`watcher()`, `guardians() -> (address[], uint8 threshold)`,
`pendingRecovery() -> (uint64 id, address newOwner, uint48 proposedAt, uint256 approvalsBitmap, bool vetoed)`.

Bucket levels from views are stored levels: add the refill yourself with
`min(burst, level + ratePerDay * (now - lastRefill) / 86400)` (the `Buckets.availableAt` formula).

`validAfter` is exclusive in EntryPoint v0.8 (an op is valid iff `validAfter < block.timestamp <= validUntil`),
so a policy meant to start now uses `validAfter = now - 1`.

Deploy order: `factory.createAccount(owner, salt)`, fund the account, then as owner:
`setGlobalCap` for every asset the agent may spend (setPolicy refuses an asset without one),
`setRecipient` for the listed shops, `setTrackedSpenders`, `setTrackedNFTs`, optional
`setAttestor`, then `setPolicy(agentKey, ...)` and `addDeposit`.

### 2.4 Structs (lib/PolicyTypes.sol)

```solidity
address constant NATIVE = address(0);      // ETH as an asset id
address constant ANY_TARGET = address(0);  // wildcard rule target: selector 0x00000000 only
uint8 constant TARGET_ARG = 0xFF;          // pseudo argument index: the call target (native-value payee)
uint256 constant MAX_ARG_RULES = 8;
enum OpKind { CALL, REGISTER_VOUCHER }
enum Tier { NONE, PROVEN, UNPROVEN, FLAGGED }   // NONE = op has no PAYEE argument
enum Track { NORMAL, EXPLORE, APPROVAL }
enum RuleOp { EQ_SELF, IN_RECIPIENTS, PAYEE, LTE, EQ }
enum VoucherState { None, Registered, Used, Reclaimed }
struct Bucket { uint128 burst; uint128 ratePerDay; uint128 level; uint48 lastRefill; }
struct ArgRule { uint8 argIndex; RuleOp op; uint256 bound; }
struct GasPolicy { uint32 maxCallGas; uint32 maxVerificationGas; uint32 maxPreVerificationGas; uint64 maxFeePerGas; uint128 gasCredit; }
struct Session { address agentKey; uint48 validAfter; uint48 validUntil; bool revoked; uint32 gen; uint192 nonceKey; GasPolicy gas; }
struct AssetLimit { bool enabled; uint128 perTxCap; Bucket bucket; }
struct RuleSet { bool allowed; ArgRule[] rules; }
struct RuleRef { address target; bytes4 selector; }
struct Voucher { address to; uint128 value; VoucherState state; uint48 validAfter; uint48 validBefore; uint64 sessionId; Track track; address token; }
struct AssetInput { address asset; uint128 perTxCap; uint128 burst; uint128 ratePerDay; }
struct CallRuleInput { address target; bytes4 selector; ArgRule[] rules; }
struct PolicyInput { uint48 validAfter; uint48 validUntil; GasPolicy gas; AssetInput[] assets; CallRuleInput[] calls; }
// hook data (memory only)
struct AgentCall { OpKind kind; address target; uint256 value; bytes data; bytes4 selector; bool hasPayee; address payee; address payAsset; uint256 payAmount; }
struct OpContext { address agentKey; uint64 sessionId; bytes32 userOpHash; bytes32 callDataHash; Tier tier; Track track; bool hasApproval; }
struct Outflow { address asset; uint256 amount; }
```

`AgentCall.payAsset / payAmount` is the decoded amount: the ERC-20 `transfer`, `approve` or
`increaseAllowance` amount on an enabled asset, else the native value; for a voucher op the module
sets them (token, value).

### 2.5 Policy fields (IDEA 7.1 -> storage -> writer -> checked)

| IDEA 7.1 field | Storage (`AccountStorage.Layout`) | Written by | Checked |
|---|---|---|---|
| `owner` | `owner` | initialize, transferOwnership | V (owner sig), 1271 |
| `globalCap[asset]` | `globalBucket[asset]` | setGlobalCap | X (MeterModule, M2) |
| `exploreCap[asset]` | `exploreBucket[asset]` | setGlobalCap default, setExploreCap | X (MeterModule on Track.EXPLORE, M2/M4) |
| `explorePerTxCap[asset]` | `explorePerTxCap[asset]` | setGlobalCap default, setExplorePerTxCap | V (PayeeTierModule, decoded `payAmount`, M4), X (measured, M2/M4) |
| `sig1271Mode` | `sig1271Mode` | setSig1271Mode | 1271 (OneDoorModule, M3) |
| `recipients` | `recipients`, `recipientList` | setRecipient | V (IN_RECIPIENTS rules; PAYEE tier) |
| `attestor` | `attestor` | setAttestor | V (PayeeTierModule, M4); `flag` caller |
| `attestEpoch` | `attestEpoch` | initialize (1), bumpEpoch | V (M4) |
| `flagged[payee]` | `flagged` | flag (attestor/owner), unflag (owner) | V (IN_RECIPIENTS rules, PAYEE tier) |
| `trackedSpenders` | `trackedSpenders` | setTrackedSpenders | X (M2) |
| `trackedNFTs` | `trackedNFTs` | setTrackedNFTs | X (M2) |
| `vouchers[nonce]` | `vouchers` | agent voucher op (M3), reclaim (M3) | 1271, X |
| (tracked ERC-20 balances) | `trackedAssets`, `isTrackedAsset` | setGlobalCap | X (M2) |
| `agentKey` | `keyToSession`, `sessions[sid].agentKey` | setPolicy, rotateKey | V |
| `validAfter`, `validUntil` | `sessions[sid]` | setPolicy | V (validationData; EntryPoint enforces) |
| `revoked` | `sessions[sid].revoked` | revoke, setPolicy (clears) | V and X |
| `nonceKey` | `sessions[sid].nonceKey` | setPolicy, rotateKey (fresh each time) | V |
| `assets[asset]` | `keyAssets[assetKey(sid, gen, asset)]`, `keyAssetList[sid]` | setPolicy | V (per-tx early reject), X (key bucket, M2) |
| `rules[target][selector]` | `rules[ruleKey(sid, gen, target, selector)]`, `ruleRefs[sid]` | setPolicy | V and X |
| `gas` | `sessions[sid].gas` | setPolicy, setGasCredit | V (caps; credit debited by max cost) |

## 3. Validation and execution: fixed hook call points

### 3.1 validateUserOp (EntryPoint only; never reads TIMESTAMP [E2])

1. Decode `userOp.signature` (section 4.2).
2. Role OWNER: valid iff ECDSA over `userOpHash` recovers `owner`. Any callData, any nonce key. Returns 0 or 1.
3. Role AGENT, in order (first failure returns `SIG_VALIDATION_FAILED`):
   1. `agentKey = ecrecover(userOpHash, sig)` must map to a session (`NO_SESSION`); not revoked (`REVOKED`).
   2. `PolicyCheck.checkNonceKey`: nonce key = this session's, lane = `LANE_APPROVAL` iff the approval slot is non-empty (`NONCE_KEY`).
   3. `PolicyCheck.checkCall`: op shape (`OP_SHAPE`: callData must be `executeUserOp` + agent op body, target is not the account / the EntryPoint, inner selector is not execute / executeBatch / executeUserOp), then the (target, selector) rule (`TARGET`), then every argument rule (`ARG_RULE(i)`, `RECIPIENT(i)`, `FLAGGED(i)`). Then **hook `_freezeReason(ctx)`** (FreezeModule: `FROZEN`).
   4. If `kind != CALL`: **hook `_doorDecodeOp(ctx, call)`** (OneDoorModule; M1 stub refuses with `OP_SHAPE`).
   5. If the approval slot is non-empty: **hook `_tierOf`** (tier recorded, its refusal ignored) and **hook `_approvalValidate(ctx, call, approval)`** (ApprovalModule; M1 stub refuses with `APPROVAL`); track = APPROVAL; per-tx caps are not applied.
   6. Else: **hook `_tierOf(ctx, call, attestation)`** (PayeeTierModule; M1 stub: PAYEE behaves as IN_RECIPIENTS); track = EXPLORE if tier = UNPROVEN else NORMAL; then `PolicyCheck.checkPerTx` (`ASSET`, `PER_TX`).
   7. `PolicyCheck.checkGas`: paymaster only if it is the owner-set `agentPaymaster` (`PAYMASTER`, section 3.5); callGasLimit / verificationGasLimit / preVerificationGas / maxFeePerGas within the session's caps, paymaster verification + postOp gas <= maxVerificationGas + maxCallGas (`GAS_CAP`); maxCost = (verificationGasLimit + callGasLimit + preVerificationGas + paymaster gas) x maxFeePerGas <= gasCredit (`GAS_CREDIT`).
   8. Debit `gasCredit -= maxCost` (account storage). Return `_packValidationData(false, min(session.validUntil, hook validUntil), session.validAfter)`.
4. Pay the prefund (BaseAccount).

### 3.2 executeUserOp (EntryPoint only): the execution sandbox

1. Owner role: decode the body, require `kind == CALL`, call the target (self-calls allowed: owner admin).
2. Agent role, **outer frame** (persists bookkeeping; never reverts for a policy reason):
   1. Re-run steps 3.1.3 to 3.1.6 on the same bytes (+ `_freezeReason`), so a revoke, freeze, flag or rule change between validation and execution still bites.
   2. Set the agent-execution lock (transient slot `hypnexis.AgentAccount.execlock`; `isValidSignature` answers `0xffffffff` while it is held).
   3. Re-check failed: go to step 4 with `PolicyViolation(reason)`.
   4. Else arm the one-shot inner flag (transient slot `hypnexis.AgentAccount.innerarm`) and `try this.agentInnerExecute(ctx, call, approval)`.
3. **Inner frame** `agentInnerExecute` (only `msg.sender == account`, only while armed; it disarms itself):
   1. **hook `_preCallTripwire(ctx, call)`**: true -> `revert TripwireTripped(0)`.
   2. Approval op: **hook `_approvalBefore(ctx, call, approval) -> state`**.
   3. `kind == CALL`: **hook `_meterBefore(ctx, call) -> snapshot`**, the one call `target.call{value}(data)` (failure -> `revert CallFailed(returnData)`), **hook `_meterAfter(ctx, call, snapshot) -> Outflow[]`** (reverts on a cap breach).
      `kind == REGISTER_VOUCHER`: **hook `_doorExecuteOp(ctx, call)`**, then **hook `_meterDebitDeclared(ctx, call.payAsset, call.payAmount)`**; outflows = [(payAsset, payAmount)].
   4. Approval op: **hook `_approvalAfter(ctx, call, approval, state, outflows)`** (reverts if outflow > maxOutflow).
   5. **hook `_postCallTripwire(ctx, call, outflows)`**: true -> `revert TripwireTripped(1)`.
4. Back in the outer frame:
   - inner returned: `emit Decision(userOpHash, agentKey, target, selector, payee, tier, track, outflows)`;
   - inner reverted with `CallFailed(ret)`: the target itself failed (not a policy event); the outer frame re-reverts with `ret`, so the EntryPoint records `success = false` and `UserOperationRevertReason`; no strike;
   - any other revert (policy breach from a module, `PolicyViolation`, `TripwireTripped`, out of gas in the inner frame): the inner frame's effects (the spend) are undone; **hook `_onBlocked(ctx, revertData, tripped)`** records a strike and returns whether to freeze; if so **hook `_freezeKey(agentKey)`** and `emit AgentFrozen(agentKey, account, userOpHash)`; then `emit PolicyBlocked(userOpHash, agentKey, target, selector, revertData)` and return normally. The EntryPoint records `success = true`: read `PolicyBlocked` (and the measured deltas) to see that nothing moved.
5. Clear the lock.

Consequence for cards and services: an execution-time policy refusal lands on-chain as a successful
UserOp with a `PolicyBlocked` event (the strike / freeze must persist); only a reverting target gives
`success = false`. Card results are judged by measured deltas (`lostBaseUnits`), never by the flag.

### 3.3 isValidSignature

Agent-execution lock held: `0xffffffff`. Otherwise **hook `_door1271(hash, signature)`**.
M1 stub: magic value iff the signature recovers the owner (the X2 spike's one door).

### 3.4 Hook signatures (lib types from section 2.4; declared in `AgentAccountBase`)

```solidity
// PayeeTierModule (D3). Validation AND execution; pure function of (call, attestation, own storage).
function _tierOf(OpContext memory ctx, AgentCall memory call, bytes memory attestation)
    internal view virtual returns (Tier tier, uint16 reason, uint48 validUntil);
// MeterModule (D2). Execution only (inner frame).
function _meterBefore(OpContext memory ctx, AgentCall memory call) internal virtual returns (bytes memory snapshot);
function _meterAfter(OpContext memory ctx, AgentCall memory call, bytes memory snapshot)
    internal virtual returns (Outflow[] memory outflows);
function _meterDebitDeclared(OpContext memory ctx, address asset, uint256 amount) internal virtual;
function _meterCredit(uint64 sessionId, Track track, address asset, uint256 amount) internal virtual;
// OneDoorModule (D1).
function _door1271(bytes32 hash, bytes calldata signature) internal view virtual returns (bytes4);
function _doorDecodeOp(OpContext memory ctx, AgentCall memory call) internal view virtual returns (uint16 reason);
function _doorExecuteOp(OpContext memory ctx, AgentCall memory call) internal virtual;
// ApprovalModule (APPC).
function _approvalValidate(OpContext memory ctx, AgentCall memory call, bytes memory approval)
    internal view virtual returns (uint16 reason, uint48 validUntil);
function _approvalBefore(OpContext memory ctx, AgentCall memory call, bytes memory approval)
    internal virtual returns (bytes memory state);
function _approvalAfter(OpContext memory ctx, AgentCall memory call, bytes memory approval, bytes memory state, Outflow[] memory outflows)
    internal virtual;
// FreezeModule (FRZ).
function _freezeReason(OpContext memory ctx) internal view virtual returns (uint16 reason);   // validation + re-check
function _preCallTripwire(OpContext memory ctx, AgentCall memory call) internal virtual returns (bool trip);   // inner frame
function _postCallTripwire(OpContext memory ctx, AgentCall memory call, Outflow[] memory outflows)
    internal virtual returns (bool trip);                                                      // inner frame
function _onBlocked(OpContext memory ctx, bytes memory reason, bool tripped) internal virtual returns (bool freezeNow); // outer frame
function _freezeKey(address agentKey) internal virtual;                                        // outer frame
```

Core helper for REC (in `AccountCommon`): `_applyRecovery(address newOwner)` sets the owner, revokes
every session key and bumps `attestEpoch` (emits `OwnerChanged` and `RecoveryApplied`). The only
owner changes are `transferOwnership` (owner) and `RecoveryModule.executeRecovery` -> `_applyRecovery`.

Each hook is implemented (with `override`) in exactly one module. Any module may call any hook
(they resolve to the owning module in the final contract), e.g. OneDoorModule's `reclaim` calls
`_meterCredit`. Shared helpers in `AccountCommon` / `AgentAccountBase`: `_l()` (core storage),
`_isOwnerCaller()`, `_isAgentExecuting()`, `_setAgentExecuting(bool)`, `_entryPointAddress()`,
`_hashTyped(structHash)` (EIP-712 digest in the account's domain), `_applyRecovery(newOwner)`.
Inner-frame hooks signal a breach by reverting (any error); outer-frame hooks must not revert.

Stub behaviour (safe defaults): `_tierOf` = listed and not flagged -> PROVEN, flagged -> FLAGGED
refused, else UNPROVEN refused with RECIPIENT, attestations ignored; meter hooks = no-ops (nothing
measured or debited); `_door1271` = owner only, voucher ops refused; approvals refused; freeze =
frozen keys refused, tripwires never trip, each blocked op adds a strike, no automatic freeze from
strikes; recovery = guardians settable, propose / approve / execute revert `RecoveryNotEnabled`.

### 3.5 Paymaster rule (PM lane builds `contracts/src/paymaster/AgentPaymaster.sol`)

Agent ops may carry `paymasterAndData` only if its first 20 bytes equal the owner-set
`agentPaymaster` (`setAgentPaymaster`; 0 = agent ops cannot use a paymaster) and it is at least
52 bytes (EntryPoint v0.8 layout: paymaster, uint128 verification gas, uint128 postOp gas, data);
otherwise validation fails with `PAYMASTER`. The paymaster's gas limits count in maxCost and are
debited from the gas credit like the account's own gas (so a paymaster cannot widen the agent's gas
budget), and are capped at maxVerificationGas + maxCallGas. Owner ops may use any paymaster. The
account never calls the paymaster; the PM lane owns its validation and postOp logic.

## 4. Encodings

### 4.1 Agent op (userOp.callData)

```
callData = 0x8dd7712f                       // executeUserOp selector
        ++ abi.encode(uint8 kind, address target, uint256 value, bytes data)
```

- `kind = 0` (CALL): one call `target.call{value}(data)`. `data` empty = plain value send (selector `0x00000000`).
- `kind = 1` (REGISTER_VOUCHER, M3): proposed body `target = token`, `value = 0`,
  `data = abi.encode(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)`; D1 fixes it and updates this row.
- Owner ops may use the same encoding through `executeUserOp`, or plain `execute` / `executeBatch`.
- Agent ops are only valid with this encoding: `execute` / `executeBatch` callData is refused for the agent role (`OP_SHAPE`).

### 4.2 Signature (userOp.signature)

```
raw 65-byte ECDSA signature             -> owner role
abi.encode(uint8 role, bytes sig, bytes attestation, bytes approval)
  role 0 = OWNER: sig = owner ECDSA over userOpHash; attestation, approval ignored
  role 1 = AGENT: sig = agent-key ECDSA over userOpHash
                  attestation = empty | D3 attestation (4.3)
                  approval    = empty | owner OutcomeApproval (4.4)
```

`userOpHash` is the EntryPoint v0.8 EIP-712 hash (domain {"ERC4337", "1", chainId, EntryPoint}),
so it already binds the chain and the EntryPoint [E5]. Signatures are raw (no EIP-191 prefix).

### 4.3 Attestation slot (D3 proposal from IDEA 7.1; D3 confirms)

`attestation = abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes attestorSig)`, where
`attestorSig` signs `ScoreAttestation{recipient = call.payee, tier, validUntil, epoch}` (section 5).
Only `tier == 1 (PROVEN)` with `epoch == attestEpoch` and a valid `attestor` signature upgrades.
Anything else (missing, malformed, expired, wrong chain / wallet / epoch) = UNPROVEN, never a failure.

### 4.4 Approval slot (APPC proposal; APPC confirms)

`approval = abi.encode(TypedData.OutcomeApproval approval, bytes ownerSig)`, with
`approval.callDataHash == keccak256(userOp.callData)` and the op on nonce lane 1.

### 4.5 Nonce keys and lanes

`nonce = (nonceKey << 64) | sequence`, the EntryPoint 2D nonce. `nonceKey = nonceKeyOf(agentKey, lane)`:

```
nonceKey = (uint192(uint160(agentKey)) << 32) | (salt24 << 8) | lane
```

`salt24` changes on every `setPolicy` / `rotateKey`, so ops signed under an older policy or key
can never execute. Lanes: `0 = LANE_NORMAL` (ops with an empty approval slot), `1 = LANE_APPROVAL`
(ops carrying an OutcomeApproval), so a pending approval never blocks the normal lane.
Owner ops may use any nonce key.

### 4.6 x402 envelope (D1, IDEA D1; D1 confirms)

`isValidSignature(hash, abi.encode(uint8 MODE_X402 = 1, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes agentSig))`
is accepted only in `OWNER_PLUS_X402_VOUCHER` mode, only if the rebuilt USDC EIP-3009
`TransferWithAuthorization(from = account, to, value, validAfter, validBefore, nonce)` digest equals
`hash`, the voucher `nonce` is Registered with the same fields, and its agent key is live.

## 5. Typed data (EIP-712, lib/TypedData.sol)

Account domain: `{name: "AgentAccount", version: "1", chainId, verifyingContract: account}`.

```
ScoreAttestation(address recipient,uint8 tier,uint48 validUntil,uint64 epoch)
OutcomeApproval(address account,uint256 chainId,uint256 nonce,address target,bytes4 selector,address payee,AssetAmount[] maxOutflow,bytes32 callDataHash,uint48 validUntil)AssetAmount(address asset,uint256 amount)
```

viem form:

```ts
const domain = { name: "AgentAccount", version: "1", chainId, verifyingContract: account };
const types = {
  ScoreAttestation: [
    { name: "recipient", type: "address" }, { name: "tier", type: "uint8" },
    { name: "validUntil", type: "uint48" }, { name: "epoch", type: "uint64" } ],
  AssetAmount: [ { name: "asset", type: "address" }, { name: "amount", type: "uint256" } ],
  OutcomeApproval: [
    { name: "account", type: "address" }, { name: "chainId", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "target", type: "address" },
    { name: "selector", type: "bytes4" }, { name: "payee", type: "address" },
    { name: "maxOutflow", type: "AssetAmount[]" }, { name: "callDataHash", type: "bytes32" },
    { name: "validUntil", type: "uint48" } ],
};
```

- Tier numbering is the `Tier` enum: 0 NONE, 1 PROVEN, 2 UNPROVEN, 3 FLAGGED.
- `maxOutflow` asset `0x0000000000000000000000000000000000000000` = native ETH.
- Other typed data the system touches: EntryPoint v0.8 `PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)` in domain {"ERC4337", "1"}; USDC EIP-3009 `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)` in domain {"USD Coin", "2"}.
- Reference vectors: `results/m1_typed_data_vectors.json` (written by `test/unit/M1_TypedData.t.sol`, digests computed by the contract code). The ATT lane's `contracts/test/vectors/score_attestation.json` must agree with it.

## 6. Storage layout (ERC-7201)

| Namespace | Slot | Owner | Contents |
|---|---|---|---|
| `hypnexis.AgentAccount.core` | `0xca31081fa2b076faf525cab77e8d16adb2d2bb3ecfbf020c1ea3cc7dff89ee00` | CORE | `AccountStorage.Layout`: all IDEA 7.1 fields (section 2.5). Append-only. |
| `hypnexis.AgentAccount.meter` | `0x23af9bb09907b1ce8bb1c7e70f746ecc4f9229c49fe6393b5af38222e721e500` | D2 | `MeterModule.MeterStorage` |
| `hypnexis.AgentAccount.onedoor` | `0xd5016249e50e970ecf897ca25846607d42a56b9e88833c1dd505575f59184f00` | D1 | `OneDoorModule.OneDoorStorage` |
| `hypnexis.AgentAccount.payeetier` | `0x55f917a41df0015e2d6b18b6f966f560d156e83464296839b2eabefcc97b3c00` | D3 | `PayeeTierModule.PayeeTierStorage` |
| `hypnexis.AgentAccount.approval` | `0xef8735f5bc79a62329e83666e1f010327e85446f0af8dda503c2cdd6acd48c00` | APPC | `ApprovalModule.ApprovalStorage` |
| `hypnexis.AgentAccount.freeze` | `0xe8cb2d89f755fa565752f95bb5ba5c96f49d6b2bdd02c69424d7de9c7d817c00` | FRZ | `FreezeStorage.Layout`: frozen, strikes, watcher |
| `hypnexis.AgentAccount.recovery` | `0x4c00d54f06551cc3c921bc40ef34572715e8d5c1dc7251f2a57a87bac66d8800` | REC | `RecoveryStorage.Layout`: guardians, threshold, pending proposal |
| `hypnexis.AgentAccount.execlock` (transient) | `0xb39352720d31c5c3fc46f7b27ae6cecf8348a51a132053381a3c496287997900` | CORE | agent-execution lock (TSTORE/TLOAD) |
| `hypnexis.AgentAccount.innerarm` (transient) | `0x04445b0e1d6e8c4774aa4b6b13323a9f6d5b1f478428d77a8952febefd674900` | CORE | one-shot permission for the sandbox inner frame |

Slot formula: `keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff))`
(`cast index-erc7201 <id>`). `test/unit/M1_Storage.t.sol` checks every constant.

`AccountStorage.Layout` field order (append-only): owner, initialized, sig1271Mode, attestor,
attestEpoch, nextSessionId, nonceSalt, recipients, recipientList, globalBucket, exploreBucket,
explorePerTxCap, trackedAssets, isTrackedAsset, flagged, trackedSpenders, trackedNFTs, vouchers,
keyToSession, sessions, rules, ruleRefs, keyAssets, keyAssetList, agentPaymaster (phase 2).
Keys: `ruleKey = keccak256(abi.encode(uint64 sid, uint32 gen, address target, bytes4 selector))`,
`assetKey = keccak256(abi.encode(uint64 sid, uint32 gen, address asset))`.

## 7. Reason codes, events, errors

### 7.1 Reason codes (`lib/PolicyTypes.sol` `Reason`)

`uint16 reason = code | (detail << 8)`; `detail` = the argument-rule index for ARG_RULE,
RECIPIENT and FLAGGED raised by an argument rule.

| Code | Name | Raised by | Meaning |
|---|---|---|---|
| 0 | OK | | passes |
| 1 | REVOKED | core | session revoked |
| 2 | EXPIRED | checkPolicy lens (M5) | outside validAfter / validUntil (validation leaves time to the EntryPoint) |
| 3 | TARGET | core | no (target, selector) rule |
| 4 | ARG_RULE(i) | core | argument rule i fails (or calldata too short for it) |
| 5 | RECIPIENT | core (IN_RECIPIENTS rule), PayeeTier stub | address not owner-listed |
| 6 | FLAGGED | core (IN_RECIPIENTS rule), PayeeTier | payee / recipient flagged |
| 7 | PER_TX | core | decoded amount or native value above the key's perTxCap |
| 8 | EXPLORE_PER_TX | PayeeTier (M4) | unproven payee, amount above explorePerTxCap |
| 9 | KEY_BUCKET | lens (M5); Meter reverts in execution | key bucket too low |
| 10 | GLOBAL_BUCKET | lens (M5); Meter | global bucket too low |
| 11 | EXPLORE_BUCKET | lens (M5); Meter | exploration bucket too low |
| 12 | GAS_CREDIT | core | op's max gas cost above the remaining gas credit |
| 13 | NO_SESSION | core | signer is not a session key |
| 14 | NONCE_KEY | core | nonce key not this session's, or wrong lane |
| 15 | OP_SHAPE | core, OneDoor stub | not a single agent op (encoding, kind, self / EntryPoint target, execute selector) |
| 16 | GAS_CAP | core | a per-op gas cap (or the paymaster gas cap) is exceeded |
| 17 | APPROVAL | Approval | approval slot invalid (M1 stub: approvals off) |
| 18 | ASSET | core | asset not enabled for this key (or no global cap) |
| 19 | FROZEN | FreezeModule | session key frozen (owner, watcher or an execution tripwire); only the owner unfreezes |
| 20 | PAYMASTER | core | paymasterAndData names a paymaster other than the owner-set `agentPaymaster` |

### 7.2 Events (`AccountCommon`)

```solidity
event Decision(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, address payee, Tier tier, Track track, Outflow[] outflows);
event OwnerChanged(address indexed previousOwner, address indexed newOwner);
event PolicySet(address indexed agentKey, uint64 indexed sessionId, uint32 gen, uint192 nonceKey, uint48 validAfter, uint48 validUntil);
event Revoked(address indexed agentKey, uint64 indexed sessionId);
event KeyRotated(address indexed oldKey, address indexed newKey, uint64 indexed sessionId, uint192 nonceKey);
event GasCreditSet(address indexed agentKey, uint128 gasCredit);
event RecipientSet(address indexed recipient, bool listed);
event GlobalCapSet(address indexed asset, uint128 burst, uint128 ratePerDay);
event ExploreCapSet(address indexed asset, uint128 burst, uint128 ratePerDay);
event ExplorePerTxCapSet(address indexed asset, uint128 cap);
event Sig1271ModeSet(uint8 mode);
event AttestorSet(address indexed attestor);
event EpochBumped(uint64 epoch);
event Flagged(address indexed payee, address indexed by);
event Unflagged(address indexed payee);
event TrackedSpendersSet(address[] spenders);
event TrackedNFTsSet(address[] nfts);
// phase 2
event PolicyBlocked(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, bytes reason);
event AgentFrozen(address indexed agentKey, address indexed by, bytes32 userOpHash);   // by = account (tripwire), owner or watcher
event AgentUnfrozen(address indexed agentKey);
event WatcherSet(address indexed watcher);
event AgentPaymasterSet(address indexed paymaster);
event RecoveryApplied(address indexed previousOwner, address indexed newOwner, uint64 attestEpoch);
// RecoveryModule (REC)
event GuardiansSet(address[] guardians, uint8 threshold);
event RecoveryProposed(uint64 indexed proposalId, address indexed newOwner, address indexed by);
event RecoveryApproved(uint64 indexed proposalId, address indexed guardian);
event RecoveryVetoed(uint64 indexed proposalId);
```

Planned by module lanes (add the exact signature here when built): `ApprovedExecuted(bytes32
approvalHash, address payee, Outflow[] outflow)` (APPC), `VoucherRegistered` / `VoucherUsed` /
`VoucherReclaimed` (D1). EntryPoint events: `UserOperationEvent(bytes32 indexed userOpHash, address
indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost,
uint256 actualGasUsed)` and `UserOperationRevertReason` give the on-chain `success=false` record.

### 7.3 Errors

Core / admin (`AccountCommon`): `NotOwner()`, `NotOwnerOrAttestor()`, `NotEntryPoint()`,
`AlreadyInitialized()`, `BadAddress(address)`, `OpenEndedKey(uint48 validAfter, uint48 validUntil)`,
`UnknownKey(address)`, `KeyInUse(address)`, `AssetNoGlobalCap(address)`, `DuplicateEntry()`,
`BadMode(uint8)`, `AgentKeyActive(address)`, `PolicyViolation(uint16 reason)`, `OwnerOpKind(uint256)`,
`TripwireTripped(uint8 stage)`, `CallFailed(bytes returnData)`, `NotSelf()`, `InnerNotArmed()`.
Recovery: `RecoveryNotEnabled()`, `BadGuardians()`. Factory: `ImplementationMismatch()`.
Rules (`ArgRules`): `RuleTargetForbidden(address)`, `RuleSelectorForbidden(bytes4)`,
`RuleTooMany(uint256)`, `RuleArgIndex(uint256 ruleIndex, uint8 argIndex)`,
`RuleDynamicArg(uint256 ruleIndex, uint8 argIndex)`, `RulePayeeSlot(uint256 ruleIndex)`,
`RuleUnbound(address target, bytes4 selector)`, `RuleWildcard()`.
Buckets: `BucketExceeded(uint256 amount, uint256 available)`.
Validation never reverts on a policy failure: it returns `SIG_VALIDATION_FAILED`, which the
EntryPoint reports as `FailedOp(i, "AA24 signature error")`. Use `checkUserOp` for the reason.
Execution never reverts on a policy failure either (sandbox, section 3.2): read `PolicyBlocked`.

## 8. setPolicy hard rules (code, not config; IDEA 7.1)

`setPolicy` reverts unless:
- `agentKey` is not 0, the owner, the account or the attestor;
- `validUntil != 0`, `validUntil != type(uint48).max` and `validUntil > validAfter` (no open-ended key);
- every asset has a global cap (`setGlobalCap` first) and appears once;
- every (target, selector) entry appears once and passes `ArgRules.validateEntry`:
  - target is not the account or the EntryPoint; selector is not execute / executeBatch / executeUserOp;
  - at most 8 rules;
  - `ANY_TARGET` (address 0) only with selector `0x00000000` and a PAYEE or IN_RECIPIENTS rule on `TARGET_ARG`;
  - `TARGET_ARG` only with selector `0x00000000` and op PAYEE, IN_RECIPIENTS or EQ; a selector-0 entry has no other argument rules;
  - known selectors: no index past the static head, no rule on a dynamic argument;
  - PAYEE only on ERC-20 `transfer` arg 0 or on `TARGET_ARG`; at most one per entry;
  - asset-moving selectors must bind their `to` / `spender` / `operator` argument:

| Selector | Function | Bound arg | Binding ops |
|---|---|---|---|
| `0xa9059cbb` | `transfer(address,uint256)` | 0 | EQ_SELF, IN_RECIPIENTS, EQ, PAYEE |
| `0x23b872dd` | `transferFrom(address,address,uint256)` (ERC-20 and 721) | 1 | EQ_SELF, IN_RECIPIENTS |
| `0x095ea7b3` | `approve(address,uint256)` (ERC-20 and 721) | 0 | EQ_SELF, IN_RECIPIENTS |
| `0x39509351` | `increaseAllowance(address,uint256)` | 0 | EQ_SELF, IN_RECIPIENTS |
| `0xa22cb465` | `setApprovalForAll(address,bool)` | 0 | EQ_SELF, IN_RECIPIENTS |
| `0x42842e0e` | `safeTransferFrom(address,address,uint256)` | 1 | EQ_SELF, IN_RECIPIENTS |
| `0xb88d4fde` | `safeTransferFrom(address,address,uint256,bytes)` (arg 3 dynamic) | 1 | EQ_SELF, IN_RECIPIENTS |
| `0xf242432a` | ERC-1155 `safeTransferFrom(address,address,uint256,uint256,bytes)` (arg 4 dynamic) | 1 | EQ_SELF, IN_RECIPIENTS |
| `0x2eb2c2d6` | ERC-1155 `safeBatchTransferFrom(...)` (args 2-4 dynamic) | 1 | EQ_SELF, IN_RECIPIENTS |
| `0x87517c45` | Permit2 `approve(address,address,uint160,uint48)` | 1 | EQ_SELF, IN_RECIPIENTS |

Run-time rule semantics: rules read the 32-byte word at `4 + 32 * argIndex` of the inner
calldata (or the target for `TARGET_ARG`); address operators require a clean address word
(upper 96 bits zero); IN_RECIPIENTS also fails on a flagged address. A `transfer` on an asset the
key has not enabled is refused (`ASSET`); `approve` / `increaseAllowance` on a non-asset contract
(an ERC-721 approve) is allowed only through its binding rule.

## 9. Module contracts for the W2 lanes

All metering, approval and tripwire checks run in the sandbox's inner frame: signal a breach by
reverting (`PolicyViolation(code)` preferred, any error works); the outer frame turns it into a
strike, an optional freeze and `PolicyBlocked`. Do not use `CallFailed` for policy breaches: it is
reserved for a reverting target and is bubbled as `success = false` without a strike.

- **D2 MeterModule.** Implement the four meter hooks. Snapshot: native balance, EntryPoint deposit
  (`IEntryPoint(_entryPointAddress()).balanceOf(this)`), `balanceOf(this)` of every
  `trackedAssets` ERC-20, `allowance(this, s)` for every `trackedSpenders` x tracked ERC-20,
  `balanceOf(this)` of every `trackedNFTs`. Measured outflow per asset = balance drop + allowance
  growth. Check: per-tx cap (`keyAsset.perTxCap`), key bucket, global bucket, and on
  `Track.EXPLORE` the exploration bucket and `explorePerTxCap`; revert on breach (`BucketExceeded`
  or `PolicyViolation(code)`); tracked NFT balance must not drop. Debit with `lib/Buckets`
  (`block.timestamp`, execution only). Default for `Track.APPROVAL`: measure and return outflows,
  no bucket debit, no cap revert (the owner's maxOutflow replaces them; APPC enforces it). Gas paid
  as prefund in validation is bounded by the gas credit, not by the meter. Note the
  approve-then-pull pattern (allowance growth metered at `approve`, then the shop's pull lowers
  balance and allowance): count each unit once.
- **D1 OneDoorModule.** Implement `_door1271` (owner + envelope, section 4.6), `_doorDecodeOp`
  (fill `call.payee / hasPayee / payAsset / payAmount` from the voucher body; the core then runs
  `_tierOf` and `checkPerTx` on it), `_doorExecuteOp` (write `AccountStorage.vouchers[nonce]`; the
  core debits through `_meterDebitDeclared`), plus external `reclaim(bytes32 nonce)` crediting
  through `_meterCredit`. Caveat: a voucher debits at registration but can settle until
  `validBefore`; keep `validBefore - registration` short (or state the bound on debit time),
  otherwise outflow measured at settlement time can exceed a sliding 24 h window.
- **D3 PayeeTierModule.** Implement `_tierOf`: owner-listed and not flagged -> PROVEN; valid
  attestation (section 4.3) -> PROVEN with `validUntil` = the attestation's; flagged -> FLAGGED with
  reason FLAGGED; else UNPROVEN with reason OK, or EXPLORE_PER_TX if `call.payAmount >
  explorePerTxCap[call.payAsset]`. Never read TIMESTAMP; never fail open; an attestation never
  raises a cap. `flag`, `unflag`, `setAttestor` (F27) and `bumpEpoch` are already in the admin.
- **FRZ FreezeModule.** Fill `_preCallTripwire` / `_postCallTripwire` (inner frame; return true to
  undo the op and freeze the key), `_onBlocked` (outer frame; strike policy, e.g. freeze after N
  strikes in a window; must not revert) and keep `_freezeReason` / `_freezeKey`. Admin side
  (`FreezeAdmin`): `freeze` (owner or watcher), `unfreeze` (owner), `setWatcher` (owner).
- **REC RecoveryModule.** Admin-side only (runs in `AgentAccountAdmin`). Implement `proposeRecovery`
  (guardian), `approveRecovery` (guardian, bitmap), `executeRecovery` (threshold reached, 48 h after
  the proposal, not vetoed) calling `_applyRecovery(newOwner)`; `vetoRecovery` (owner) is in place.
  Target parameters: 5 guardians, threshold 3, 48 h delay. Budget: about 4 KB of admin bytecode.
- **PM AgentPaymaster.** Separate contract in `contracts/src/paymaster/`. The account accepts it on
  agent ops only when `agentPaymaster` names it (section 3.5); its gas counts against the gas credit.
- **APPC ApprovalModule.** Implement the three approval hooks on lane 1 ops (section 4.4).
  Validation: owner signature over the OutcomeApproval digest (`_hashTyped`), nonce unused,
  `account == this`, `chainId == block.chainid`, `target / selector / payee` match `call`,
  `callDataHash == ctx.callDataHash`; return `validUntil`. Execution: consume the nonce, enforce
  measured outflow <= maxOutflow per asset (an asset missing from maxOutflow means 0), emit
  `ApprovedExecuted`. The approval path does not waive TARGET / ARG_RULE (argument rules); it waives
  tier refusals, per-tx caps and (by the D2 default) buckets. `checkPolicy(agentKey, callData,
  attestation) -> (ok, track, reasonCode)` goes in `contracts/src/lens/`: call
  `account.policyCheck(...)`, then add EXPIRED (time), KEY_BUCKET / GLOBAL_BUCKET / EXPLORE_BUCKET
  (bucket views + `Buckets.availableAt`) and GAS_CREDIT.

## 10. R2 baseline: `NaiveAccount` (EXPERIMENTS X1)

"What most teams build". Published so judges can rerun or add cards.
- Constructor `(address owner, address agent)` (unchanged from M0, used by the X2 spike).
- `configure(IEntryPoint ep, R2Config cfg)` (owner, once): `cfg = {targets[], selectors[], recipients[], tokens[], perTxCaps[], dailyCaps[]}`; token `address(0)` = native ETH.
- Validation (`validateUserOp`, raw 65-byte signature): owner -> any call. Agent -> callData must be
  `executeAgent(address target, uint256 value, bytes data)`; `(target, selector)` must be allowlisted
  (target + selector only, no argument rules); for ERC-20 `transfer(to, amount)` the decoded `to` must
  be in the static recipient list and `amount <= perTxCap[target]`; native `value <= perTxCap[0]`.
  No gas caps, no nonce keys.
- Execution (`executeAgent`): calendar-day daily cap on the decoded `transfer` amount and native value:
  `spent[token][block.timestamp / 86400] + amount <= dailyCap[token]`.
- ERC-1271: accepts the owner or the agent key (the "permissive" account [E42]).
- Not metered: `approve`, merchant pulls, NFT moves, allowance growth.

## 11. Demo policy fixture (BUILD.md "Demo policy"; `agent/configs/demo_policy.json` from M7 is the source of truth)

| Field | Value (USDC 6 decimals) |
|---|---|
| globalCap USDC | burst 10e6 + ratePerDay 10e6 (20 USDC / 24 h) |
| key bucket USDC | burst 10e6 + ratePerDay 10e6 |
| perTxCap USDC | 10e6 |
| exploreCap USDC | 0.5e6 + 0.5e6 (setGlobalCap default: 5% of 20 USDC) |
| explorePerTxCap USDC | 0.2e6 (default: 1%) |
| recipients | ApiSeller, TicketShop (TicketNFT), GroceryShop |
| validUntil | deploy + 6 days |
| gasCredit | 0.001 ETH (1e15 wei) |
| gas caps (fixture) | maxCallGas 500,000; maxVerificationGas 300,000; maxPreVerificationGas 100,000; maxFeePerGas 1 gwei (Base runs far below; local tests use 0.01 gwei) |
| sig1271Mode | OWNER_ONLY |
| R3 rules | USDC `transfer` {arg0 PAYEE}; USDC `approve` {arg0 IN_RECIPIENTS, arg1 LTE 10e6}; TicketNFT `buy(uint256,address)` {arg1 EQ_SELF}; TicketNFT `setApprovalForAll` {arg0 IN_RECIPIENTS}; GroceryMerchant `order(uint256,address)` {arg0 LTE 10e6, arg1 EQ_SELF} |
| R2 allowlist | the same (target, selector) pairs without argument rules; recipients = the 3 shops; perTxCap 10 USDC; dailyCap 20 USDC |

`test/unit/M1_Fixture.sol` builds exactly this.

## 12. HTTP APIs (request/response JSON; owners refine additively)

All bodies are JSON; amounts are decimal strings in base units; addresses are 0x-hex;
errors are `{ "error": { "code": "<REASON_OR_HTTP_CODE>", "message": "..." } }`.

### 12.1 Agent tools (IDEA 7.2; owner HARN / M7)

Base `http://localhost:8787/v1/tools`. The tools layer holds the agent key only.

| Tool | Request | Response |
|---|---|---|
| `POST /get_policy` | `{}` | `{ account, agentKey, validAfter, validUntil, revoked, nonceKey, assets: [{asset, perTxCap, bucket:{burst, ratePerDay, level, lastRefill}}], rules: [{target, selector, rules:[{argIndex, op, bound}]}], recipients: [..], sig1271Mode }` |
| `POST /get_budget` | `{ asset }` | `{ asset, key: {available, cap}, global: {available, cap}, explore: {available, cap}, explorePerTxCap, perTxCap, gasCredit }` |
| `POST /check` | `{ target, value, data, payee? }` | `{ ok, reason, reasonCode, track, tier, simulatedOutflows: [{asset, amount}] }` |
| `POST /pay` | `{ asset, to, amount }` | `{ status: "executed" \| "reverted" \| "refused" \| "needs_approval", reason?, userOpHash?, txHash?, success? }` |
| `POST /pay_x402` | `{ url, maxAmount }` | `{ status, receipt?, voucherNonce?, reason? }` |
| `POST /buy` | `{ shop: "ticket" \| "grocery" \| "<address>", item, amount?, recipient? }` | same as `/pay` |
| `POST /request_approval` | `{ target, value, data, reason }` | `{ requestId, status: "pending" }` |
| `POST /approval_status` | `{ requestId }` | `{ requestId, status: "pending" \| "approved" \| "executed" \| "rejected" \| "expired" \| "reverted", txHash? }` |

### 12.2 Approval service (IDEA 7.3; owner APPS / M5)

Base `http://localhost:8788/v1`.

| Endpoint | Request | Response |
|---|---|---|
| `POST /requests` | `{ account, chainId, userOp: <PackedUserOperation JSON, agent-signed, lane 1>, note }` | `{ id, status: "pending", simulation: { outflows: [{asset, amount}], ok } }` |
| `GET /requests/:id/typed-data` | | `{ domain, types, primaryType: "OutcomeApproval", message }` (section 5) |
| `POST /requests/:id/signature` | `{ signature }` (owner, eth_signTypedData_v4) | `{ id, status: "approved" }` |
| `GET /requests/:id` | | `{ id, status, approvalHash?, userOpHash?, txHash?, success? }` |

### 12.3 TRACE attestor (IDEA 7.5; owner ATT / M6)

Base `http://localhost:8789/v1`.

| Endpoint | Request | Response |
|---|---|---|
| `GET /attest?wallet=&payee=&chainId=` | | `{ tier: 1, validUntil, epoch, signature, recipient, wallet, chainId }` or `404 { "error": { "code": "NO_ATTESTATION" } }` |
| `POST /outcomes` | `{ kind: "x402_receipt" \| "signed_outcome", payee, wallet, receipt?, delivery?, outcome?, signature? }` | `{ accepted: true \| false, reason? }` (agent-only reports are ignored) |
| `GET /health` | | `{ ok, attestor, epoch }` |

Tier map: only ROUTE -> PROVEN (attestation issued); ROUTE_WITH_CAUTION and cold start -> no
attestation; HOLD / INVESTIGATE / REFER / QUARANTINE / unknown -> FLAGGED (`flag(payee)` sent).

## 13. Results file schemas

| File | Writer | Schema |
|---|---|---|
| `results/cards/<card>__<config>.json` | card tests | `{card, config, chainMode, asset, lostBaseUnits, beyondPolicyBaseUnits, legitBlocked, legitProvenBlocked, legitBlockedValue, legitNeededApproval, success}`; `success` = the attack moved value to an attacker (lostBaseUnits > 0) |
| `results/m1_typed_data_vectors.json` | `M1_TypedData.t.sol` | `{chainId, verifyingContract, domainSeparator, scoreAttestation: {recipient, tier, validUntil, epoch, structHash, digest}, outcomeApproval: {..., structHash, digest}}` |
| `results/forge_m<k>.json` | `forge test --json` | Foundry JSON; summarised by `tools/forge_summary.py` |
| `results/x2_spike*.json` | X2 spike | `{chainMode, forkBlock, authValue, naive: {lostBaseUnits, isValidSignature}, oneDoor: {contract, lostBaseUnits, isValidSignature}, userOps}` |
| `results/gas_m2.json` | M2 | `{meterOverheadGas, trackedTokens, trackedSpenders}` |
| `results/m5_approval_e2e.json` | M5 | `{approved, tampered, replay}` |
| `results/x1_table.{csv,json}` | M7 / X1 | rows per (card, config): the card fields plus `shooter` and `runs` |
| `results/demo_run.json` | `tools/demo.ts` | `{ok, beats: [...]}` |

## 14. Changelog

- 2026-10-24 M1 (CORE): first version. Contract surface, hook call points and signatures, storage
  layout, reason codes, typed data, setPolicy hard rules, R2 config, demo fixture, HTTP drafts,
  results schemas, ownership table.
- 2026-10-24 M1 phase 2 (CORE, user scope): execution sandbox (outer frame persists strikes, freezes
  and `PolicyBlocked` / `AgentFrozen`; inner self-call frame `agentInnerExecute` reverts on a policy
  breach or tripwire; a reverting target still gives `success = false`); FreezeModule stub (lane FRZ:
  reason FROZEN = 19, `freeze` / `unfreeze` / `setWatcher`, tripwire and strike hooks); RecoveryModule
  stub (lane REC, admin side; core hook `_applyRecovery` revokes every key and bumps attestEpoch);
  owner-set `agentPaymaster` for agent ops (reason PAYMASTER = 20; lane PM writes the paymaster);
  factory now takes a pre-deployed implementation (deploy order admin -> implementation -> factory);
  `validAfter` exclusivity note; new storage namespaces freeze / recovery / innerarm.

## 15. TRACE attestor service (ATT, M6): implemented contract

Owner: ATT. Code: `services/attestor` (`@hypnexis/attestor`). Shared types: `packages/shared/src/attestor/`
(`tier.ts`, `typedData.ts`; import the files directly until INT adds an `./attestor` subpath export).
This section is the implemented API and replaces the 12.3 draft where they differ (12.3 is kept
unchanged above). Copy of record: `services/attestor/API.md`.

Start: `pnpm --filter @hypnexis/attestor start`. Default base `http://127.0.0.1:8789/v1`.

### 15.1 Endpoints

| Endpoint | Request | Response |
|---|---|---|
| `GET /health` | | `{ service, ok: true, status: "ready", mode: "trace"\|"scripted", attestor, chainId }` |
| `GET /v1/attest?wallet=&payee=[&chainId=]` | `chainId` optional; must equal the attestor's | **200** `{ tier: "PROVEN", tierCode: 1, validUntil, epoch, signature, attestation, digest, wallet, payee, recipient, chainId, attestor, code: "ROUTE" }`. **404** `{ error: "no_attestation", tier: "UNPROVEN"\|"FLAGGED", code, reason, flag? }`. **400** bad address / `wrong_chain`. **503** `epoch_unavailable` (RPC down) |
| `POST /v1/outcomes` | one of the bodies in 15.3 | **200** `{ accepted: true, status: "accepted", id, payee, success, source, tier, code, flags }`. **202** `{ accepted: false, status: "ignored", reason }` (agent-only). **409** `duplicate`. **400** `rejected` + reason |
| `GET /v1/score?payee=` | | the payee's TRACE profile: `{ payee, totalJobs, successes, failures, lcb95, traceScore, riskTier, defaultProbability, scoreVolatility, cusumScore, cusumSensitive, sybilRisk, networkTrust, hardFilter, utility: {...Eq. 1 breakdown}, code, tier, reason }` |
| `POST /v1/flags/sync` | | `{ results: [{ wallet, payee, status: "sent"\|"already"\|"skipped"\|"error", txHash?, reason? }] }` |

- `attestation` is ready to drop into the agent envelope (section 4.2/4.3):
  `abi.encode(uint8 tier, uint48 validUntil, uint64 epoch, bytes attestorSig)`.
- `validUntil` = now + 24 h (`ATTEST_TTL_SECONDS`), capped at uint48 max. `epoch` is read from the
  wallet's `attestEpoch()` on every request; if it cannot be read the service answers 503 and never
  signs with a guessed epoch.
- Only PROVEN is ever signed (the signer refuses any other tier). Negative information goes on-chain
  through `flag(payee)`, because the agent can always omit a negative attestation.
- **Tools rule (M7):** any non-200 answer, a timeout, or the service being down means the payee is
  UNPROVEN (exploration track). Never treat a missing attestation as PROVEN [A20].

### 15.2 Tier decision (decision code, then IDEA 7.5 map)

| Condition (first match, from the TRACE router hard filters) | Code | Tier | Action |
|---|---|---|---|
| no accepted outcome for the payee (cold start) | `null` | UNPROVEN | none |
| Sybil filter: `sybilRisk > 0.5`, or `> 0.15` with any failure | QUARANTINE | FLAGGED | `flag(payee)` |
| primary CUSUM alarm (`cusumScore > 4.2`) | HOLD | FLAGGED | `flag(payee)` |
| failure rate > 30% after >= 3 jobs | INVESTIGATE | FLAGGED | `flag(payee)` |
| > 3 disputes (unreachable on this rail) | REFER | FLAGGED | `flag(payee)` |
| other router filter: TRACE score < 300, default prob > 0.55, cold_start_high_risk | ROUTE_WITH_CAUTION | UNPROVEN | none |
| `LCB95(s, f \| Beta(1,3)) >= LCB95(3, 0)` (= 0.2505) | ROUTE | PROVEN | sign |
| otherwise | ROUTE_WITH_CAUTION | UNPROVEN | none |

Unknown codes map to FLAGGED (fail closed). PROVEN always implies the pre-registered X4 rule
(`packages/shared/src/attestor/tier.ts`, a copy of `sim/hx/tierRule.ts`, checked against
`sim/hx/tier_vectors.json`). `ATTESTOR_MODE=scripted` is the D3-lite fallback: same signer and API,
fixed tiers from `SCRIPTED_TIERS`, no TRACE scoring.

Scoring: `src/trace/port.ts` ports Trace_CIKM @94c4b9f (LCB, both CUSUMs, TRACE score, default
probability, SCC/spectral/cycle/diversity/dense-subgraph Sybil risk, network trust, PPR, entropy,
contamination, Eq. 1 utility), checked equal to the vendored fork on fixed inputs
(`test/port.test.ts`). EVM adapter: one accepted outcome = one job of the payee and one trust edge
wallet -> payee; 1 volume unit = 0.01 token; round = floor(ts / `ROUND_SECONDS`, default 3600).

### 15.3 Outcome bodies (`POST /v1/outcomes`) [A22]

Off-chain EIP-712 domain: `{ name: "HypnexisAttestor", version: "1", chainId }` (no verifyingContract).

```
Outcome(address wallet,address payee,bool success,bytes32 ref,address asset,uint256 amount)
DeliveryCheck(address wallet,address payee,bytes32 txHash,uint16 httpStatus,bool schemaOk)
```

| `source` | Body | Accepted when |
|---|---|---|
| `"x402"` | `{ source, wallet, payee, asset, amount, decimals?=6, receipt: { success, transaction, network, payer }, delivery: { httpStatus, schemaOk, signature } }` | `receipt` is the facilitator's settlement response; the tx is checked on-chain (status success and an `asset` `Transfer(wallet -> payee, value >= amount)`); `payer == wallet`; the `DeliveryCheck` is signed by a key in `VERIFIER_ADDRESSES`. success = `httpStatus == 200 && schemaOk` |
| `"owner"` | `{ source, outcome: Outcome, decimals?, signature }` | signer == the wallet's on-chain `owner()` |
| `"verifier"` | `{ source, outcome: Outcome, decimals?, signature }` | signer is in `VERIFIER_ADDRESSES` |
| `"agent"` or any other signer | anything | never: **202 ignored** (`agent_only_ignored`) |

- A signature by an agent key is ignored even if that key were listed as a verifier; startup
  refuses that configuration.
- Dedup id = `ref:<wallet>:<payee>:<ref or txHash>`, so the same job reported twice (or by two
  sources using the same ref) counts once (409).
- `wallet == payee` is rejected. Without `RPC_URL`, x402 bodies are rejected (`receipt_unverifiable`).

### 15.4 Flag sender

When a payee is FLAGGED (after an accepted outcome, on `/v1/attest`, or `/v1/flags/sync`), the
service calls `flag(payee)` from the attestor key on every wallet it serves (wallets seen in
`/v1/attest` and outcomes, plus `WALLETS`). It first reads `attestor()` (skips wallets whose attestor
is someone else) and `isFlagged(payee)` (no duplicate tx), and records sent flags in SQLite. Flags
are escalate-only on-chain (only the owner can `unflag`, I10), so retries are safe.

### 15.5 Keys and config (env)

| Var | Default | Meaning |
|---|---|---|
| `ATTESTOR_PRIVATE_KEY` | required | attestor signer and `flag` sender. Must differ from every agent key: the service refuses to start otherwise [A20] |
| `AGENT_ADDRESSES`, `AGENT_PRIVATE_KEY` | empty | agent keys, for key separation and to ignore agent-signed reports |
| `VERIFIER_ADDRESSES` | empty | delivery checkers / outcome verifiers |
| `CHAIN_ID`, `RPC_URL` | 31337, none | without RPC: no epoch reads (uses `DEFAULT_EPOCH`), owners from `OWNERS` JSON, no x402, no flag txs |
| `ATTESTOR_PORT`, `ATTESTOR_DB` | 8789, `:memory:` | HTTP port; `node:sqlite` file |
| `ATTESTOR_MODE`, `SCRIPTED_TIERS` | `trace`, `{}` | `scripted` = D3-lite |
| `ATTEST_TTL_SECONDS`, `ROUND_SECONDS`, `WALLETS` | 86400, 3600, empty | |

### 15.6 Test vectors and results

- `contracts/test/vectors/score_attestation.json` (for D3): 8 signed cases (PROVEN on 31337 and 8453,
  epoch 2, a second wallet, uint48/uint64 maxima, tier-2 and tier-3 signatures that must not upgrade,
  an agent-key signature) and 4 replays (wrong chain, wrong wallet, old epoch, wrong recipient), each
  with domainSeparator, structHash, digest, signer, signature, the encoded `attestation` and
  `expectProven`. Wallets `0x5FbD...0aa3` / `0xe7f1...0512` are anvil deployer nonces 0 / 1; attestor
  = anvil key #4, agent = #1. Regenerate: `pnpm --filter @hypnexis/attestor vectors`. Every digest
  was checked against `TypedData.sol` on anvil, and the signer agrees with
  `results/m1_typed_data_vectors.json`.
- `pnpm --filter @hypnexis/attestor e2e` writes `results/m6_attestor_e2e_stub.json`
  `{target, realAccount: false, chainMode, provenAccepted, flaggedOnChain, coldStartUnproven,
  agentOnlyIgnored, ok, details}` against the TypedData.sol stub. With `E2E_TARGET_MODULE` (an
  `E2ETarget` for the real AgentAccount, INT) it writes `results/m6_attestor_e2e.json` with the same
  schema and `realAccount: true`.

Changelog: 2026-10-24 ATT (M6): first version of section 15.

## 16. Owner approval service (APPS, M5): implemented contract

Owner: APPS. Code: `services/approval` (`@hypnexis/approval`). Shared code: `packages/shared/src/approval/`
(`typedData.ts`, `agentOp.ts`, `abi.ts`, `submitter.ts`, `agentClient.ts`; import the files directly until
INT adds an `./approval` subpath export). This section is the implemented API and replaces the 12.2 draft
where they differ (12.2 is kept unchanged above). Copy of record: `services/approval/API.md`.

Start: `pnpm --filter @hypnexis/approval start`. Default base `http://127.0.0.1:8788`. Errors follow
section 12: `{ "error": { "code", "message", ...extra } }`. Amounts are decimal strings in base units.

### 16.1 Endpoints

| Endpoint | Request | Response |
|---|---|---|
| `GET /health` | | `{ service, ok: true, status: "ready", chainId, simulationMode }` |
| `POST /v1/requests` | `{ account, chainId, userOp, note? }`. `userOp` = PackedUserOperation JSON (or the unpacked RPC shape), agent role, nonce lane 1, approval slot EMPTY, `signature = abi.encode(1, agentSig, attestation, 0x)` | **201** `{ id, status: "pending", userOpHash, approvalHash, agentKey, payee, validUntil, simulation: { mode, ok, outflows: [{asset, amount}], declared, gasUsed, tracked, warnings }, preflight: { reasonCode, reason, tier } \| "unavailable" }` |
| `GET /v1/requests/:id/typed-data` | | eth_signTypedData_v4 JSON `{ domain, types (with EIP712Domain), primaryType: "OutcomeApproval", message }` + `status`, `approvalHash`, `display { account, target, selector, payee, maxOutflow, validUntil, validUntilIso, agentKey, noteUntrusted, simulation }` |
| `POST /v1/requests/:id/signature[?wait=1]` | `{ signature }` = owner EIP-712 signature over the typed data | `{ id, status: "approved" }`; with `wait=1` the final status object after the relay |
| `POST /v1/requests/:id/reject` | `{ signature }` = owner EIP-191 `personal_sign` of `Hypnexis approval service: reject request <id>` | `{ id, status: "rejected" }` |
| `GET /v1/requests/:id` | | `{ id, status, account, chainId, agentKey, userOpHash, approvalHash, nonce, target, selector, payee, maxOutflow, validUntil, note, simulation, txHash?, success?, blocked?, reason?, outflows?, createdAt, updatedAt }` |
| `GET /v1/requests/:id/userop` | | the relay-ready op with the final signature (anyone may relay it); 409 before the owner signed |
| `GET /v1/requests?account=&agentKey=&status=&limit=` | | `{ requests: [status objects] }` |
| `GET /v1/keys/:agentKey?account=` | | rate-limit view `{ windowSeconds, limit, maxPending, attempts, accepted, refused, rateLimited, pending }` (for the FRZ watcher's approval-spam signal) |

Status values (same as the 12.1 `approval_status` tool): `pending` -> `approved` -> `executed` |
`reverted` | `rejected`; `pending` -> `expired` | `rejected`.
- `executed`: UserOperationEvent success and no `PolicyBlocked` for this userOpHash; `outflows` = the
  account's `Decision` outflows.
- `reverted`: nothing moved. Either the target reverted (`success: false`, reason `target_reverted`) or the
  sandbox blocked it (`success: true, blocked: true`, reason `PolicyBlocked: <decoded error>`, e.g. the
  measured outflow above maxOutflow). Section 3.2: a policy block is a successful UserOp with `PolicyBlocked`.
- `rejected`: never included: preflight `checkUserOp` failed, the EntryPoint refused it (`AA24`, `AA25`...),
  the owner rejected it, or another request with the same EntryPoint nonce executed (`nonce_consumed`).
- `expired`: chain time passed `validUntil` before execution.

### 16.2 Request checks (`POST /v1/requests`, in order)

1. Body shape, `note` <= 280 chars, `chainId` == the service's, `userOp.sender == account`, callData <= 16 KiB.
2. Signature envelope: role 1 (AGENT), approval slot empty, 65-byte agent signature.
3. Attribution: `agentKey = ecrecover(userOpHash, agentSig)` with the v0.8 userOpHash
   (EntryPoint = `account.entryPoint()`, else `ENTRYPOINT`). The signature covers the whole op, so the
   request is attributable; a changed op recovers a different key (refused below). `note` is not signed:
   agent text, shown to the owner as untrusted.
4. Rate limit per (account, agentKey): attempts in the window (accepted + refused, every attributed
   request counts) >= `RATE_LIMIT_MAX` -> 429 `RATE_LIMITED`; pending >= `MAX_PENDING_PER_KEY` -> 429
   `TOO_MANY_PENDING`. RPC failures (503) do not count.
5. Nonce: key belongs to agentKey (`NONCE_KEY_MISMATCH`), lane 1 (`WRONG_LANE`), equals
   `nonceKeyOf(agentKey, 1)` (0 -> 403 `NO_SESSION`; other -> `STALE_NONCE_KEY`); `sessionOf` not revoked
   (403 `REVOKED`); sequence == `EntryPoint.getNonce(account, key)` (`STALE_NONCE` 409 / `NONCE_GAP` 400).
   Several pending requests may share one nonce; only one can execute, the rest become `nonce_consumed`.
6. Op: `executeUserOp` agent op, kind CALL only (`UNSUPPORTED_OP` for voucher ops in this build); same
   userOpHash already filed -> 409 `DUPLICATE` with its id.
7. Payee exactly as the account derives `call.payee`: the PAYEE argument rule from
   `ruleOf(agentKey, target, selector)` (the `ANY_TARGET` entry for plain value sends), else `0x0`. No rule
   -> 422 `POLICY_REFUSED` / `TARGET`. If `ruleOf` is unreadable: transfer arg 0, value-send target, else 0.
8. Preflight: `policyCheck(agentKey, callData, attestation, draftApprovalWithZeroSig)`; any reason other
   than OK / APPROVAL (TARGET, ARG_RULE(i), RECIPIENT, FLAGGED, FROZEN, OP_SHAPE, ...) -> 422
   `POLICY_REFUSED` with `reason`, because an owner approval cannot waive it (section 9 APPC).
9. Simulation (16.3); a reverting call -> 422 `SIMULATION_REVERTED`; RPC failure -> 503.
10. OutcomeApproval: `account`, `chainId`, `nonce = userOp.nonce`, `target`, `selector` (0x00000000 for a
    value send), `payee`, `maxOutflow` = simulated outflows (assets with 0 omitted, sorted by address,
    native = `0x0`), `callDataHash = keccak256(userOp.callData)`, `validUntil = min(now + APPROVAL_TTL_SECONDS,
    session validUntil)` (chain time, never 0).

### 16.3 Simulation (IDEA 7.3)

`eth_call` against the latest state with a state override that puts the `ApprovalSimulator` runtime
(`services/approval/contracts/ApprovalSimulator.sol`, checked-in bytecode in `src/simulatorArtifact.ts`,
drift-tested against a fresh solc build) at the account address, then `simulate(target, value, data, ...)`.
The call runs as the account (same address, balances, allowances; msg.sender of the target = account);
callbacks get the account's agent-path answers (token receivers accept, `isValidSignature` = 0xffffffff).
Outflow per asset is the D2 meter formula: native = drop of (balance + EntryPoint deposit); ERC-20 =
balance drop + allowance growth over the tracked spenders; ERC-721 = balance drop. Inputs: the account's
`trackedAssets / trackedSpenders / trackedNFTs`, plus `EXTRA_TRACKED_ASSETS`, the decoded token and the
decoded `approve` spender (warning `untracked_spender` if the account does not meter it). The owner signs
maxOutflow = this result; the account enforces it in execution, so a wrong simulation can only block the
op. `SIMULATION_MODE=declared` is the BUILD M5 fallback: maxOutflow = the decoded transfer / approve
amount or native value.

### 16.4 Owner signature, relay

- The signature must recover (EIP-712, account domain, section 5) to the account's on-chain `owner()`,
  read at submit time; otherwise 401 `NOT_OWNER` and the request stays pending.
- Final signature = `abi.encode(1, agentSig, attestation, abi.encode(OutcomeApproval, ownerSig))`
  (sections 4.2 / 4.4). The agent's signature stays valid because the v0.8 userOpHash excludes `signature`.
- Preflight `checkUserOp(finalOp, userOpHash)`; non-OK -> `rejected` (`preflight checkUserOp: <REASON>`), no relay.
- Relay through a `Submitter`: `DirectSubmitter` (simulates `handleOps([op])` by eth_call, so a
  validation failure is reported as `FailedOp` without spending gas, then sends it from `RELAYER_PRIVATE_KEY`)
  or `BundlerSubmitter` (`eth_sendUserOperation` + `eth_getUserOperationReceipt`, when `BUNDLER_URL` is set).
  Without either, the request stays `approved` and `GET /v1/requests/:id/userop` serves the op.
- `approvalHash` = the EIP-712 digest = APPC's `ApprovedExecuted.approvalHash`.
- APPC semantics (ApprovalModule): the approval nonce is spent only when the approved op executes (or by
  owner `cancelApproval(nonce)`); a blocked attempt leaves it unspent, so the same signed outcome may be
  retried until `validUntil` and can execute at most once, never above maxOutflow. Owner kill switches:
  `cancelApproval(nonce)` (the nonce is shown as `nonce` in the status object) and `revoke(agentKey)`.

### 16.5 Scripted owner signer and vectors [A18]

- CLI: `pnpm --filter @hypnexis/approval sign -- --id <id> [--url] [--wait] [--reject] [--max <baseUnits>]
  [--account 0x..] [--chain-id N]`, key from `OWNER_PRIVATE_KEY` or `--dev-key 0-9`. It checks the typed
  data (primaryType, domain bound to `message.account` / `message.chainId`, `approvalHash` recomputed
  locally), prints what a wallet would show, signs locally and posts. Key policy: the 10 public anvil dev
  keys on any chain (fork mode runs chainId 8453 locally); any other key only on 31337 / 1337 / 84532 /
  11155111. MetaMask `eth_signTypedData_v4` replaces it once the UI exists [A15].
- Vectors: `services/approval/vectors/outcome_approval.json` (`pnpm --filter @hypnexis/approval vectors`),
  owner = anvil #0, agent = #1. 11 cases: `m1_vector` (fields and contract digest of
  `results/m1_typed_data_vectors.json`), Base 8453 lane-1 transfer, empty maxOutflow, native send, uint
  maxima, agent-signed, and 5 replay / tamper cases (wrong chain, wrong account, other callData,
  maxOutflow +1, other payee) whose owner signature must not verify. Each has domainSeparator, structHash,
  digest, signature, recovered signer, `valid` and the encoded `approvalSlot`; every digest is checked
  against `contracts/src/lib/TypedData.sol` on anvil (`test/anvil.test.ts`).

### 16.6 Config (env)

| Var | Default | Meaning |
|---|---|---|
| `RPC_URL`, `CHAIN_ID` | required, 31337 | chain access; requests for another chain are refused |
| `ENTRYPOINT` | canonical v0.8 | used when `account.entryPoint()` is unreadable |
| `RELAYER_PRIVATE_KEY` / `BUNDLER_URL` | none | relay mode (direct handleOps / bundler RPC); the relayer is never the owner |
| `APPROVAL_PORT`, `APPROVAL_DB` | 8788, `:memory:` | HTTP port; `node:sqlite` file |
| `APPROVAL_TTL_SECONDS` | 3600 | approval validUntil = now + TTL, capped by the session |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`, `MAX_PENDING_PER_KEY` | 20, 3600, 5 | per (account, agentKey) |
| `SIMULATION_MODE`, `EXTRA_TRACKED_ASSETS` | `eth_call`, empty | 16.3 |
| `MAX_NOTE_CHARS` | 280 | |

The service never holds the owner key. It holds no agent key either: requests arrive signed.

### 16.7 Tests and results

- `pnpm --filter @hypnexis/approval test`: store, typed-data digest == the M1 contract vector, vectors,
  agent-op encodings, service checks (attribution, lanes, nonces, preflight, rate limit, expiry,
  owner-only signatures, replayed signatures, relay outcomes), signer key policy, ABI subset == forge
  artifacts, and on anvil: simulator bytecode drift, vector digests == TypedData.sol, simulation of pulls /
  transfers / approve growth / native value, and the relay with executed and blocked outcomes.
- `pnpm --filter @hypnexis/approval e2e` (real HTTP service, spawned owner CLI, EntryPoint v0.8 on anvil)
  writes `results/m5_approval_e2e_stub.json` `{target, realAccount: false, chainMode, chainId, approved,
  tampered, replay, payeeTransfer, foreignKeyRefused, ok, details}` against
  `services/approval/test/anvil/ApprovalStub.sol` (a test-only account that verifies approvals with
  TypedData.sol). `tampered` = the shop raises its price 1 base unit after the owner signed, so the
  measured outflow is maxOutflow + 1. With `E2E_TARGET_MODULE` (default export: an `E2ETarget` from
  `scripts/lib/stubTarget.ts` for the real AgentAccount; INT) it writes `results/m5_approval_e2e.json`
  with the same schema and `realAccount: true`, the BUILD M5 Done-when file.

Changelog: 2026-10-24 APPS (M5): first version of section 16.
