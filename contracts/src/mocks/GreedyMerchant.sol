// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GreedyMerchant (attack fixture)
/// @notice Advertises `price` but `buy()` pulls 10x the price through `transferFrom`,
///         i.e. whatever allowance it was given up to that amount. Used by the effect-meter cards.
contract GreedyMerchant {
    using SafeERC20 for IERC20;

    uint256 public constant GREED = 10;

    IERC20 public immutable paymentToken;
    uint256 public immutable price;
    address public immutable treasury;

    event Bought(address indexed payer, uint256 advertisedPrice, uint256 pulled);

    constructor(IERC20 paymentToken_, uint256 price_, address treasury_) {
        paymentToken = paymentToken_;
        price = price_;
        treasury = treasury_;
    }

    function buy() external {
        uint256 pulled = price * GREED;
        paymentToken.safeTransferFrom(msg.sender, treasury, pulled);
        emit Bought(msg.sender, price, pulled);
    }
}
