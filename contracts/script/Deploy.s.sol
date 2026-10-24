// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountAdmin} from "../src/AgentAccountAdmin.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {PolicyLens} from "../src/lens/PolicyLens.sol";
import {AgentPaymaster} from "../src/paymaster/AgentPaymaster.sol";

/// @title Deploy: the Hypnexis agent-wallet stack.
/// @notice Deploys AgentAccountAdmin, the AgentAccount implementation, AgentAccountFactory, PolicyLens
///         and (optionally) AgentPaymaster. The four external libraries the implementation links
///         (MeterLib, OneDoorLib, FreezeTripwires, ApprovalLib) are deployed and linked by forge itself
///         when the script is broadcast; scripts/deploy.ts does the same by hand with viem.
///
///         Env:
///           ENTRYPOINT        existing EntryPoint v0.8 (Base: 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108);
///                             unset -> a fresh EntryPoint is deployed (local chains)
///           PAYMASTER_OWNER   set -> also deploy AgentPaymaster owned by this address
///           PM_MAX_FEE_GWEI   paymaster gas-field caps (defaults: 2 gwei, 500k call, 300k verification,
///                             100k preVerification, 100k pm verification, 100k pm postOp)
///
///           forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY
///         Writes ../results/deploy_<chainid>.json (the only path forge may write; scripts/deploy.ts
///         writes deployments/<chainid>.json with the same fields).
contract Deploy is Script {
    function run() external {
        address epAddr = vm.envOr("ENTRYPOINT", address(0));
        address pmOwner = vm.envOr("PAYMASTER_OWNER", address(0));
        vm.startBroadcast();
        if (epAddr == address(0)) epAddr = address(new EntryPoint());
        IEntryPoint ep = IEntryPoint(epAddr);
        AgentAccountAdmin admin = new AgentAccountAdmin(ep);
        AgentAccount impl = new AgentAccount(ep, address(admin));
        AgentAccountFactory factory = new AgentAccountFactory(impl);
        PolicyLens lens = new PolicyLens();
        address pm;
        if (pmOwner != address(0)) {
            AgentPaymaster.GasCaps memory caps = AgentPaymaster.GasCaps({
                maxFeePerGas: uint64(vm.envOr("PM_MAX_FEE_GWEI", uint256(2)) * 1 gwei),
                callGasLimit: 500_000,
                verificationGasLimit: 300_000,
                preVerificationGas: 100_000,
                paymasterVerificationGasLimit: 100_000,
                paymasterPostOpGasLimit: 100_000
            });
            pm = address(new AgentPaymaster(ep, pmOwner, caps));
        }
        vm.stopBroadcast();

        require(address(factory.accountImplementation()) == address(impl), "factory/impl mismatch");
        require(address(factory.entryPoint()) == epAddr, "factory/entryPoint mismatch");

        console2.log("EntryPoint         ", epAddr);
        console2.log("AgentAccountAdmin  ", address(admin));
        console2.log("AgentAccount (impl)", address(impl));
        console2.log("AgentAccountFactory", address(factory));
        console2.log("PolicyLens         ", address(lens));
        console2.log("AgentPaymaster     ", pm);

        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "entryPoint", epAddr);
        vm.serializeAddress(k, "admin", address(admin));
        vm.serializeAddress(k, "implementation", address(impl));
        vm.serializeAddress(k, "factory", address(factory));
        vm.serializeAddress(k, "lens", address(lens));
        string memory json = vm.serializeAddress(k, "paymaster", pm);
        vm.writeJson(json, string.concat("../results/deploy_", vm.toString(block.chainid), ".json"));
    }
}
