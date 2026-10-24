// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {X2Base, IUSDC3009} from "./X2Base.sol";
import {MockUSDC3009} from "../../src/mocks/MockUSDC3009.sol";

/// @title X2SideDoorLocal: local twin of the X2 spike on MockUSDC3009 (no RPC needed).
/// @notice Writes results/x2_spike_local.json. Used on screen when the fork RPC is down (IDEA s11).
contract X2SideDoorLocal is X2Base {
    MockUSDC3009 internal usdc;

    function setUp() public {
        usdc = new MockUSDC3009();
        _setUpActors();
    }

    function test_x2_sideDoor() public {
        _runX2();
    }

    function test_x2_ownerControl() public {
        _runOwnerControl();
    }

    function _token() internal view override returns (IUSDC3009) {
        return IUSDC3009(address(usdc));
    }

    function _fund(address to, uint256 amount) internal override {
        usdc.mint(to, amount);
    }

    function _fundedVia() internal pure override returns (string memory) {
        return "mint";
    }

    function _chainMode() internal pure override returns (string memory) {
        return "local";
    }

    function _forkBlock() internal pure override returns (uint256) {
        return 0;
    }

    function _resultPath() internal pure override returns (string memory) {
        return "../results/x2_spike_local.json";
    }
}
