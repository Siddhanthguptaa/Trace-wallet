// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {X2Base, IUSDC3009} from "../spike/X2Base.sol";
import {ForkConfig} from "./ForkConfig.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

interface IFiatTokenMinting {
    function masterMinter() external view returns (address);
    function configureMinter(address minter, uint256 minterAllowedAmount) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
}

/// @title X2SideDoor: the X2 spike on a Base fork with real USDC (FiatTokenV2_2) at FORK_BLOCK.
/// @notice Writes results/x2_spike.json.
contract X2SideDoor is X2Base {
    uint256 internal pinnedBlock;
    string internal fundedVia_ = "none";

    function setUp() public {
        pinnedBlock = ForkConfig.forkBlock();
        vm.createSelectFork(ForkConfig.rpcUrl(), pinnedBlock);
        _setUpActors();
    }

    function test_x2_sideDoor() public {
        assertEq(block.chainid, ForkConfig.BASE_CHAIN_ID, "fork is Base");
        assertEq(block.number, pinnedBlock, "fork at FORK_BLOCK");
        assertGt(ForkConfig.ENTRYPOINT_V08.code.length, 0, "EntryPoint v0.8 deployed");
        _runX2();
    }

    function test_x2_ownerControl() public {
        _runOwnerControl();
    }

    /// External so a failing `deal` can be caught.
    function dealExternal(address to, uint256 amount) external {
        deal(ForkConfig.USDC, to, amount);
    }

    function _fund(address to, uint256 amount) internal override {
        try this.dealExternal(to, amount) {
            if (_token().balanceOf(to) == amount) {
                fundedVia_ = "deal";
                return;
            }
        } catch {}
        // Fallback (BUILD.md M0): impersonate the masterMinter, configure a minter and mint.
        IFiatTokenMinting fiat = IFiatTokenMinting(ForkConfig.USDC);
        vm.prank(fiat.masterMinter());
        fiat.configureMinter(address(this), amount);
        fiat.mint(to, amount);
        fundedVia_ = "masterMinter";
    }

    function _entryPoint() internal pure override returns (IEntryPoint) {
        return IEntryPoint(ForkConfig.ENTRYPOINT_V08);
    }

    function _token() internal pure override returns (IUSDC3009) {
        return IUSDC3009(ForkConfig.USDC);
    }

    function _fundedVia() internal view override returns (string memory) {
        return fundedVia_;
    }

    function _chainMode() internal pure override returns (string memory) {
        return "fork";
    }

    function _forkBlock() internal view override returns (uint256) {
        return pinnedBlock;
    }

    function _resultPath() internal pure override returns (string memory) {
        return "../results/x2_spike.json";
    }
}
