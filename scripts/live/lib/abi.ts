/**
 * Minimal, browser-safe ABIs for the OWNER transactions the console sends (no fs, no forge artifacts).
 * test/console.test.ts proves every call built from these decodes with the full artifact ABI, so they
 * cannot drift from the contracts.
 */
import { parseAbi } from 'viem';

export const factoryAbi = parseAbi([
  'function createAccount(address owner, uint256 salt) returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)',
]);

export const accountOwnerAbi = parseAbi([
  'struct GasPolicy { uint32 maxCallGas; uint32 maxVerificationGas; uint32 maxPreVerificationGas; uint64 maxFeePerGas; uint128 gasCredit; }',
  'struct AssetInput { address asset; uint128 perTxCap; uint128 burst; uint128 ratePerDay; }',
  'struct ArgRule { uint8 argIndex; uint8 op; uint256 bound; }',
  'struct CallRuleInput { address target; bytes4 selector; ArgRule[] rules; }',
  'struct PolicyInput { uint48 validAfter; uint48 validUntil; GasPolicy gas; AssetInput[] assets; CallRuleInput[] calls; }',
  'function setPolicy(address agentKey, PolicyInput p)',
  'function setGlobalCap(address asset, uint128 burst, uint128 ratePerDay)',
  'function setExploreCap(address asset, uint128 burst, uint128 ratePerDay)',
  'function setExplorePerTxCap(address asset, uint128 cap)',
  'function setRecipient(address recipient, bool listed)',
  'function setTrackedSpenders(address[] spenders)',
  'function setAttestor(address attestor_)',
  'function setWatcher(address w)',
  'function setGuardians(address[] guardians_, uint8 threshold_)',
  'function setFreezeParam(bytes32 key, uint256 value)',
  'function addDeposit() payable',
  'function unfreeze(address agentKey)',
  'function revoke(address agentKey)',
  'function vetoRecovery()',
  'function owner() view returns (address)',
]);

export const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address who) view returns (uint256)',
]);
