import { parseAbi } from 'viem';

/**
 * Hand-written ABI fragments for the calls and events the UI needs.
 * Replace with ABIs generated from the Foundry build (contracts/out) once it exists;
 * names follow IDEA.md 7.1, 7.3, 7.4 and 7.5 and must be confirmed against the contract (O3).
 */
export const accountAbi = parseAbi([
  // Owner writes
  'function revokeKey(address agentKey)',
  'function rotateKey(address oldKey, address newKey)',
  'function addSessionKey(address agentKey, uint48 validAfter, uint48 validUntil)',
  'function setKeyValidUntil(address agentKey, uint48 validUntil)',
  'function setKeyAssetCaps(address agentKey, address asset, uint128 perTxCap, uint128 cap)',
  'function setGlobalCap(address asset, uint128 cap)',
  'function setExploreCaps(address asset, uint128 cap, uint128 perTxCap)',
  'function setSig1271Mode(uint8 mode)',
  'function setRecipient(address payee, bool allowed)',
  'function clearFlag(address payee)',
  'function setAttestor(address attestor)',
  'function bumpEpoch()',
  'function refillGasCredit(address agentKey, uint128 amount)',
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
