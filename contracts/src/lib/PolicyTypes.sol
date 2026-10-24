// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// @title PolicyTypes: shared enums, structs, constants and reason codes (docs/api.md section 2).
// @notice CORE-owned and frozen after M1. Other lanes import it; changes are additive and go
//         through a DECISIONS.md request. Field meanings follow IDEA.md section 7.1.

// Asset id for native ETH (value sends, gas credit is tracked separately).
address constant NATIVE = address(0);

// Wildcard rule target: only valid with selector 0x00000000 (plain value send) and a
// PAYEE / IN_RECIPIENTS rule on TARGET_ARG. Lets the owner allow "native value to a payee".
address constant ANY_TARGET = address(0);

// Pseudo argument index meaning "the call target" (the native-value payee).
uint8 constant TARGET_ARG = 0xFF;

// Max argument rules per (target, selector) entry; keeps PolicyCheck bounded.
uint256 constant MAX_ARG_RULES = 8;

// ERC-1271 return values.
bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
bytes4 constant ERC1271_INVALID = 0xffffffff;

// Signature envelope roles (userOp.signature = abi.encode(uint8 role, bytes sig, bytes attestation, bytes approval)).
uint8 constant ROLE_OWNER = 0;
uint8 constant ROLE_AGENT = 1;

// sig1271Mode values (IDEA 7.1). Read by OneDoorModule.
uint8 constant SIG1271_OWNER_ONLY = 0;
uint8 constant SIG1271_OWNER_PLUS_X402_VOUCHER = 1;

// Nonce lanes (low byte of the 2D nonce key). Lane 0: normal agent ops. Lane 1: ops that carry an
// owner OutcomeApproval (M5), so a pending approval never blocks the normal lane.
uint8 constant LANE_NORMAL = 0;
uint8 constant LANE_APPROVAL = 1;

// Agent op kinds (first word of the agent op body).
enum OpKind {
    CALL, // one call: execute `data` on `target` with `value`
    REGISTER_VOUCHER // M3 (OneDoorModule): register an x402 voucher; body decoded by the module
}

// Payee tier (D3). NONE = the op has no tiered payee (no PAYEE rule matched).
enum Tier {
    NONE,
    PROVEN,
    UNPROVEN,
    FLAGGED
}

/// Budget track an op is charged to.
enum Track {
    NORMAL, // key bucket + global bucket
    EXPLORE, // exploration bucket + key bucket + global bucket (unproven payee)
    APPROVAL // owner OutcomeApproval: maxOutflow replaces the agent caps (M5)
}

/// Argument rule operators (IDEA 7.1). All read one static 32-byte ABI word.
enum RuleOp {
    EQ_SELF, // arg == address(this)
    IN_RECIPIENTS, // arg is owner-listed (and not flagged)
    PAYEE, // arg is the payee; the D3 tier decides the track (pre-M4 stub: must be listed)
    LTE, // arg <= bound
    EQ // arg == bound
}

/// Voucher state machine (D1, I4): None -> Registered -> Used | Reclaimed, one way only.
enum VoucherState {
    None,
    Registered,
    Used,
    Reclaimed
}

/// Reason codes. A uint16 reason = code | (detail << 8); detail = argument-rule index for ARG_RULE.
/// Codes 1-12 are IDEA 7.2's checkPolicy codes; 13+ are additive core codes.
library Reason {
    uint16 internal constant OK = 0;
    uint16 internal constant REVOKED = 1;
    uint16 internal constant EXPIRED = 2;
    uint16 internal constant TARGET = 3;
    uint16 internal constant ARG_RULE = 4;
    uint16 internal constant RECIPIENT = 5;
    uint16 internal constant FLAGGED = 6;
    uint16 internal constant PER_TX = 7;
    uint16 internal constant EXPLORE_PER_TX = 8;
    uint16 internal constant KEY_BUCKET = 9;
    uint16 internal constant GLOBAL_BUCKET = 10;
    uint16 internal constant EXPLORE_BUCKET = 11;
    uint16 internal constant GAS_CREDIT = 12;
    uint16 internal constant NO_SESSION = 13; // signer is not a session key
    uint16 internal constant NONCE_KEY = 14; // nonce key not this session's (or wrong lane)
    uint16 internal constant OP_SHAPE = 15; // not a single agent op: bad encoding, kind, self/EntryPoint target, exec selector
    uint16 internal constant GAS_CAP = 16; // a per-op gas cap is exceeded, or a paymaster is set
    uint16 internal constant APPROVAL = 17; // approval slot invalid (or approvals not enabled yet)
    uint16 internal constant ASSET = 18; // asset not spendable by this key
    uint16 internal constant FROZEN = 19; // session key frozen (FreezeModule); only the owner unfreezes
    uint16 internal constant PAYMASTER = 20; // paymasterAndData names a paymaster other than the owner-set one

    function argRule(uint256 index) internal pure returns (uint16) {
        return ARG_RULE | uint16(index << 8);
    }

    function code(uint16 reason) internal pure returns (uint8) {
        return uint8(reason);
    }

    function detail(uint16 reason) internal pure returns (uint8) {
        return uint8(reason >> 8);
    }
}

/// Token bucket (IDEA 7.1 bucket rule): never holds more than `burst`, refills at
/// `ratePerDay` x elapsed / 86400, cap = burst + ratePerDay. Math in lib/Buckets.sol.
struct Bucket {
    uint128 burst;
    uint128 ratePerDay;
    uint128 level;
    uint48 lastRefill;
}

/// One argument rule: arg word `argIndex` (or TARGET_ARG) must satisfy `op` (with `bound`).
struct ArgRule {
    uint8 argIndex;
    RuleOp op;
    uint256 bound;
}

/// Per-op gas caps and the gas credit (wei) debited in validation by the op's maximum cost.
struct GasPolicy {
    uint32 maxCallGas;
    uint32 maxVerificationGas;
    uint32 maxPreVerificationGas;
    uint64 maxFeePerGas;
    uint128 gasCredit;
}

/// A session key's policy header (IDEA 7.1 "Per session key"). Rules and asset limits live in
/// mappings keyed by (sessionId, gen); `gen` is bumped by every setPolicy so old rules vanish.
struct Session {
    address agentKey;
    uint48 validAfter;
    uint48 validUntil;
    bool revoked;
    uint32 gen;
    uint192 nonceKey; // lane-0 nonce key; lane byte is OR-ed in (LANE_*)
    GasPolicy gas;
}

/// Per-key, per-asset limit: per-op cap on outflow plus this key's bucket.
struct AssetLimit {
    bool enabled;
    uint128 perTxCap;
    Bucket bucket;
}

/// The (target, selector) entry: allowed iff every rule holds.
struct RuleSet {
    bool allowed;
    ArgRule[] rules;
}

struct RuleRef {
    address target;
    bytes4 selector;
}

/// x402 voucher (D1). Registered by a policy-checked agent op that debited `value`.
struct Voucher {
    address to;
    uint128 value;
    VoucherState state;
    uint48 validAfter;
    uint48 validBefore;
    uint64 sessionId;
    Track track;
    address token;
}

// ---------------------------------------------------------------- setPolicy input

struct AssetInput {
    address asset; // NATIVE for ETH value
    uint128 perTxCap;
    uint128 burst;
    uint128 ratePerDay;
}

struct CallRuleInput {
    address target; // ANY_TARGET only with selector 0 (plain value send)
    bytes4 selector; // 0x00000000 = empty calldata (plain value send)
    ArgRule[] rules;
}

struct PolicyInput {
    uint48 validAfter;
    uint48 validUntil;
    GasPolicy gas;
    AssetInput[] assets;
    CallRuleInput[] calls;
}

// ---------------------------------------------------------------- hook data (memory only)

/// A decoded agent op, produced by PolicyCheck (CALL) or OneDoorModule (REGISTER_VOUCHER).
struct AgentCall {
    OpKind kind;
    address target;
    uint256 value;
    bytes data; // inner calldata (CALL) or the voucher body (REGISTER_VOUCHER)
    bytes4 selector; // 0x00000000 when data is empty
    bool hasPayee; // a PAYEE rule matched (or the voucher `to`)
    address payee;
    address payAsset; // asset paid to the payee: token for transfer/approve, NATIVE for value
    uint256 payAmount; // decoded amount paid (transfer amount, approve amount, native value)
}

/// Per-op context handed to every hook.
struct OpContext {
    address agentKey;
    uint64 sessionId;
    bytes32 userOpHash; // 0 in view-only checks (checkPolicy lens)
    bytes32 callDataHash; // keccak256(userOp.callData): what an OutcomeApproval signs
    Tier tier;
    Track track;
    bool hasApproval;
}

/// Measured (or declared) outflow of one asset.
struct Outflow {
    address asset;
    uint256 amount;
}
