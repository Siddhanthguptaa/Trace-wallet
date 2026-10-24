// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ApprovalSimulator (APPS / M5): outflow simulation for owner approvals.
/// @notice Never deployed. The approval service puts this RUNTIME code at the account address with an
///         `eth_call` state override and calls `simulate`. The call then runs as the account would run
///         it in the sandbox inner frame (same address, same balances, same allowances, msg.sender of the
///         target = the account) and returns the measured outflow per asset, using the D2 meter
///         formula (docs/api.md section 9):
///           native  = drop of (balance + EntryPoint deposit)
///           ERC-20  = balance drop + sum over tracked spenders of allowance growth
///           ERC-721 = balance drop (count)
///         The owner signs maxOutflow = this result; the account enforces it in execution, so a wrong
///         or tampered simulation can only make the op fail, never widen it (IDEA 7.3).
///         Callbacks into the account during the call are answered like the account's agent path:
///         token receivers accept, isValidSignature answers 0xffffffff (agent-execution lock).
contract ApprovalSimulator {
    struct Snap {
        uint256 native;
        uint256[] bal;
        uint256[] allow; // tokens.length x spenders.length, row-major
        uint256[] nft;
    }

    struct Req {
        address target;
        uint256 value;
        bytes data;
        address entryPoint;
        address[] tokens;
        address[] spenders;
        address[] nfts;
    }

    struct Res {
        bool ok;
        bytes ret;
        uint256 nativeOut;
        uint256[] tokenOut;
        uint256[] nftOut;
        uint256 gasUsed;
    }

    function simulate(Req calldata q) external returns (Res memory r) {
        Snap memory a = _snap(q.entryPoint, q.tokens, q.spenders, q.nfts);
        uint256 g = gasleft();
        (r.ok, r.ret) = q.target.call{value: q.value}(q.data);
        r.gasUsed = g - gasleft();
        Snap memory b = _snap(q.entryPoint, q.tokens, q.spenders, q.nfts);

        r.nativeOut = _drop(a.native, b.native);
        uint256 n = q.tokens.length;
        uint256 s = q.spenders.length;
        r.tokenOut = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 out = _drop(a.bal[i], b.bal[i]);
            for (uint256 j; j < s; ++j) {
                out += _drop(b.allow[i * s + j], a.allow[i * s + j]); // allowance growth
            }
            r.tokenOut[i] = out;
        }
        r.nftOut = new uint256[](q.nfts.length);
        for (uint256 k; k < q.nfts.length; ++k) {
            r.nftOut[k] = _drop(a.nft[k], b.nft[k]);
        }
    }

    function _drop(uint256 beforeV, uint256 afterV) private pure returns (uint256) {
        return beforeV > afterV ? beforeV - afterV : 0;
    }

    function _snap(address entryPoint, address[] calldata tokens, address[] calldata spenders, address[] calldata nfts)
        private
        view
        returns (Snap memory s)
    {
        s.native = address(this).balance;
        if (entryPoint != address(0)) s.native += _read(entryPoint, abi.encodeWithSelector(0x70a08231, address(this)));
        s.bal = new uint256[](tokens.length);
        s.allow = new uint256[](tokens.length * spenders.length);
        for (uint256 i; i < tokens.length; ++i) {
            s.bal[i] = _read(tokens[i], abi.encodeWithSelector(0x70a08231, address(this)));
            for (uint256 j; j < spenders.length; ++j) {
                s.allow[i * spenders.length + j] =
                    _read(tokens[i], abi.encodeWithSelector(0xdd62ed3e, address(this), spenders[j]));
            }
        }
        s.nft = new uint256[](nfts.length);
        for (uint256 k; k < nfts.length; ++k) {
            s.nft[k] = _read(nfts[k], abi.encodeWithSelector(0x70a08231, address(this)));
        }
    }

    /// uint256 view read; 0 if the call fails or returns short data.
    function _read(address t, bytes memory cd) private view returns (uint256 v) {
        (bool ok, bytes memory r) = t.staticcall(cd);
        if (ok && r.length >= 32) v = abi.decode(r, (uint256));
    }

    // ---- account callbacks during the simulated call

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    receive() external payable {}
}
