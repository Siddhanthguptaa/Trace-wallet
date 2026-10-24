// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @title ForkConfig: the one place fork tests read their RPC, block and Base addresses from.
/// @notice FORK_BLOCK is pinned in M0 (results/toolchain.json#forkBlock) and can be overridden
///         with the env vars BASE_RPC and FORK_BLOCK. Addresses checked on Base (BUILD.md Machine check).
library ForkConfig {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant DEFAULT_FORK_BLOCK = 53_026_000;
    string internal constant DEFAULT_RPC = "https://mainnet.base.org";
    uint256 internal constant BASE_CHAIN_ID = 8453;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant ENTRYPOINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function rpcUrl() internal view returns (string memory) {
        string memory fallbackRpc = DEFAULT_RPC;
        return vm.envOr("BASE_RPC", fallbackRpc);
    }

    function forkBlock() internal view returns (uint256) {
        return vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK);
    }
}
