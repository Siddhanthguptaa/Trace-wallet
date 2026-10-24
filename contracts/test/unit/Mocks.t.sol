// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC3009} from "../../src/mocks/MockUSDC3009.sol";
import {TicketNFT} from "../../src/mocks/TicketNFT.sol";
import {GroceryMerchant} from "../../src/mocks/GroceryMerchant.sol";
import {GreedyMerchant} from "../../src/mocks/GreedyMerchant.sol";
import {ApiSeller} from "../../src/mocks/ApiSeller.sol";

/// Unit tests for the M0 mocks: the mock token must behave like FiatTokenV2_2 on the paths the
/// attack cards use, and each shop must pull exactly what it says (Greedy: 10x).
contract MocksTest is Test {
    MockUSDC3009 internal usdc;
    uint256 internal constant PAYER_PK = 0xB0B;
    address internal payer;
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        usdc = new MockUSDC3009();
        payer = vm.addr(PAYER_PK);
        usdc.mint(payer, 1_000e6);
        vm.warp(1_800_000_000);
    }

    function _auth(bytes32 typehash, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, payer, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(PAYER_PK, digest);
    }

    function test_mocks_usdcDomainMatchesUsdc() public view {
        assertEq(usdc.decimals(), 6);
        assertEq(usdc.version(), "2");
        assertEq(usdc.name(), "USD Coin");
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"),
                keccak256("2"),
                block.chainid,
                address(usdc)
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
    }

    function test_mocks_3009EoaPathAndReplay() public {
        bytes32 nonce = keccak256("n1");
        uint256 vb = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            _auth(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), treasury, 5e6, 0, vb, nonce);
        vm.prank(relayer);
        usdc.transferWithAuthorization(payer, treasury, 5e6, 0, vb, nonce, v, r, s);
        assertEq(usdc.balanceOf(treasury), 5e6);
        assertTrue(usdc.authorizationState(payer, nonce));

        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        usdc.transferWithAuthorization(payer, treasury, 5e6, 0, vb, nonce, abi.encodePacked(r, s, v));
    }

    function test_mocks_3009TimeWindow() public {
        bytes32 typehash = usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH();
        (uint8 v, bytes32 r, bytes32 s) = _auth(typehash, treasury, 1e6, 0, block.timestamp, keccak256("late"));
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        usdc.transferWithAuthorization(payer, treasury, 1e6, 0, block.timestamp, keccak256("late"), v, r, s);

        uint256 va = block.timestamp + 10;
        (v, r, s) = _auth(typehash, treasury, 1e6, va, va + 100, keccak256("early"));
        vm.expectRevert(bytes("FiatTokenV2: authorization is not yet valid"));
        usdc.transferWithAuthorization(payer, treasury, 1e6, va, va + 100, keccak256("early"), v, r, s);
    }

    function test_mocks_3009WrongSignerRejected() public {
        bytes32 nonce = keccak256("forged");
        uint256 vb = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, relayer, 1e6, 0, vb, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(payer, relayer, 1e6, 0, vb, nonce, abi.encodePacked(r, s, v));
    }

    function _sig(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_mocks_receiveNeedsPayeeAndCancelWorks() public {
        bytes32 nonce = keccak256("recv");
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _sig(
            PAYER_PK,
            keccak256(abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, treasury, 2e6, 0, vb, nonce))
        );
        vm.prank(relayer);
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(payer, treasury, 2e6, 0, vb, nonce, sig);

        usdc.cancelAuthorization(
            payer, nonce, _sig(PAYER_PK, keccak256(abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce)))
        );
        vm.prank(treasury);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        usdc.receiveWithAuthorization(payer, treasury, 2e6, 0, vb, nonce, sig);
    }

    function test_mocks_permitBytesOverload() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.PERMIT_TYPEHASH(), payer, relayer, 7e6, uint256(0), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_PK, digest);
        usdc.permit(payer, relayer, 7e6, deadline, abi.encodePacked(r, s, v));
        assertEq(usdc.allowance(payer, relayer), 7e6);
        assertEq(usdc.nonces(payer), 1);
    }

    function test_mocks_greedyPullsTenTimesPrice() public {
        GreedyMerchant greedy = new GreedyMerchant(IERC20(address(usdc)), 1e6, treasury);
        vm.startPrank(payer);
        usdc.approve(address(greedy), 1e6);
        vm.expectRevert();
        greedy.buy();
        usdc.approve(address(greedy), type(uint256).max);
        greedy.buy();
        vm.stopPrank();
        assertEq(usdc.balanceOf(treasury), 10e6);
    }

    function test_mocks_ticketAndGroceryPullExactly() public {
        TicketNFT tickets = new TicketNFT(IERC20(address(usdc)), 3e6, treasury);
        GroceryMerchant grocery = new GroceryMerchant(IERC20(address(usdc)), treasury);
        vm.startPrank(payer);
        usdc.approve(address(tickets), type(uint256).max);
        usdc.approve(address(grocery), type(uint256).max);
        tickets.buy(42, payer);
        uint256 orderId = grocery.order(4e6, payer);
        vm.stopPrank();
        assertEq(tickets.ownerOf(42), payer);
        assertEq(orderId, 1);
        assertEq(usdc.balanceOf(treasury), 7e6);
    }

    function test_mocks_apiSellerSettles3009() public {
        ApiSeller seller = new ApiSeller(address(usdc), 1e5, treasury);
        uint256 vb = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("x402-1");
        (uint8 v, bytes32 r, bytes32 s) =
            _auth(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(seller), 1e5, 0, vb, nonce);
        vm.prank(relayer);
        seller.settle(payer, 1e5, 0, vb, nonce, abi.encodePacked(r, s, v), "/weather");
        assertEq(usdc.balanceOf(address(seller)), 1e5);

        vm.expectRevert(bytes("ApiSeller: underpaid"));
        seller.settle(payer, 1, 0, vb, keccak256("x402-2"), abi.encodePacked(r, s, v), "/weather");

        vm.prank(treasury);
        seller.withdraw(treasury, 1e5);
        assertEq(usdc.balanceOf(treasury), 1e5);
    }
}
