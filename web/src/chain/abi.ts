import { parseAbi } from 'viem';

/**
 * ABI fragments for the calls and events the UI needs. The owner writes are the real
 * AgentAccountAdmin functions (checked against contracts/out); the events below are still the plan's names.
 */
export const accountAbi = parseAbi([
  // Owner writes: the REAL AgentAccountAdmin functions (contracts/out/AgentAccountAdmin.sol, docs/api.md 2.3)
  'struct GasPolicy { uint32 maxCallGas; uint32 maxVerificationGas; uint32 maxPreVerificationGas; uint64 maxFeePerGas; uint128 gasCredit; }',
  'struct AssetInput { address asset; uint128 perTxCap; uint128 burst; uint128 ratePerDay; }',
  'struct ArgRule { uint8 argIndex; uint8 op; uint256 bound; }',
  'struct CallRuleInput { address target; bytes4 selector; ArgRule[] rules; }',
  'struct PolicyInput { uint48 validAfter; uint48 validUntil; GasPolicy gas; AssetInput[] assets; CallRuleInput[] calls; }',
  'function setPolicy(address agentKey, PolicyInput p)',
  'function revoke(address agentKey)',
  'function rotateKey(address oldKey, address newKey)',
  'function setGlobalCap(address asset, uint128 burst, uint128 ratePerDay)',
  'function setExploreCap(address asset, uint128 burst, uint128 ratePerDay)',
  'function setExplorePerTxCap(address asset, uint128 cap)',
  'function setGasCredit(address agentKey, uint128 gasCredit)',
  'function setSig1271Mode(uint8 mode)',
  'function setRecipient(address payee, bool allowed)',
  'function setTrackedSpenders(address[] spenders)',
  'function unflag(address payee)',
  'function setAttestor(address attestor)',
  'function setWatcher(address watcher)',
  'function setGuardians(address[] guardians, uint8 threshold)',
  'function setFreezeParam(bytes32 key, uint256 value)',
  'function unfreeze(address agentKey)',
  'function bumpEpoch()',
  'function addDeposit() payable',
  // Events
  'event Spent(address indexed agentKey, address indexed payee, address indexed asset, uint256 amount, uint8 track)',
  'event ApprovedExecuted(bytes32 indexed approvalHash, address indexed payee, uint256 outflow)',
  'event PayeeFlagged(address indexed payee)',
  'event FlagCleared(address indexed payee)',
  'event KeyRevoked(address indexed agentKey)',
  'event PolicyChanged(bytes32 indexed field)',
  'event VoucherRegistered(bytes32 indexed nonce, address payTo, uint256 maxValue)',
  'event VoucherUsed(bytes32 indexed nonce)',
  'event VoucherReclaimed(bytes32 indexed nonce)',
  'event EpochBumped(uint64 epoch)',
]);

export const entryPointAbi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
]);

export const factoryAbi = parseAbi([
  'function getAddress(address owner, uint256 salt) view returns (address)',
  'function createAccount(address owner, uint256 salt) returns (address)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export const SIG_1271_MODE = { OWNER_ONLY: 0, OWNER_PLUS_X402_VOUCHER: 1 } as const;

/** RuleOp enum of the contract (PolicyTypes.sol). */
export const RULE_OP = { EQ_SELF: 0, IN_RECIPIENTS: 1, PAYEE: 2, LTE: 3, EQ: 4 } as const;
export const SELECTOR = { transfer: '0xa9059cbb', approve: '0x095ea7b3' } as const;
