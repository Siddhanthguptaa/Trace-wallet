/**
 * Hand-written ABI subsets for the approval path (M1 deferred the forge-artifact ABIs; INT may
 * replace these with generated ones). Names and shapes follow docs/api.md 2.2 / 2.3 / 7.2 and
 * contracts/src (AgentAccount + AgentAccountAdmin, merged at the account address).
 * test/abi.test.ts in services/approval checks every function/event here against the forge
 * artifacts when they exist. Lane APPS (M5).
 */
import { parseAbi } from 'viem';

const USEROP_STRUCT =
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }';

export const approvalAccountAbi = parseAbi([
  USEROP_STRUCT,
  'struct ArgRule { uint8 argIndex; uint8 op; uint256 bound; }',
  'struct GasPolicy { uint32 maxCallGas; uint32 maxVerificationGas; uint32 maxPreVerificationGas; uint64 maxFeePerGas; uint128 gasCredit; }',
  'struct Session { address agentKey; uint48 validAfter; uint48 validUntil; bool revoked; uint32 gen; uint192 nonceKey; GasPolicy gas; }',
  'struct Outflow { address asset; uint256 amount; }',
  'function owner() view returns (address)',
  'function entryPoint() view returns (address)',
  'function nonceKeyOf(address agentKey, uint8 lane) view returns (uint192)',
  'function sessionOf(address agentKey) view returns (uint64 sid, Session s)',
  'function ruleOf(address agentKey, address target, bytes4 selector) view returns (bool allowed, ArgRule[] rules)',
  'function trackedAssets() view returns (address[])',
  'function trackedSpenders() view returns (address[])',
  'function trackedNFTs() view returns (address[])',
  'function policyCheck(address agentKey, bytes callData, bytes attestation, bytes approval) view returns (uint16 reason, uint8 tier, uint8 track, uint48 validUntil)',
  'function checkUserOp(PackedUserOperation userOp, bytes32 userOpHash) view returns (uint16 reason, uint48 validAfter, uint48 validUntil)',
  'event Decision(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, address payee, uint8 tier, uint8 track, Outflow[] outflows)',
  'event PolicyBlocked(bytes32 indexed userOpHash, address indexed agentKey, address indexed target, bytes4 selector, bytes reason)',
  'event AgentFrozen(address indexed agentKey, address indexed by, bytes32 userOpHash)',
  // APPC ApprovalModule (DECISIONS 2026-10-24 20:10): approvalHash = the OutcomeApproval EIP-712 digest.
  'event ApprovedExecuted(bytes32 indexed approvalHash, address indexed payee, Outflow[] outflow)',
  'event ApprovalCancelled(uint256 indexed nonce)',
  'function approvalNonceUsed(uint256 nonce) view returns (bool)',
]);

export const entryPointHandleOpsAbi = parseAbi([
  USEROP_STRUCT,
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
  'function getNonce(address sender, uint192 key) view returns (uint256 nonce)',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function balanceOf(address account) view returns (uint256)',
  'function depositTo(address account) payable',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
