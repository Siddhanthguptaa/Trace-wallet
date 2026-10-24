// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GroceryMerchant (demo shop "GroceryShop")
/// @notice `order` pulls exactly `amount` from the caller to the treasury and logs the order.
contract GroceryMerchant {
    using SafeERC20 for IERC20;

    IERC20 public immutable paymentToken;
    address public immutable treasury;
    uint256 public orderCount;

    event Ordered(uint256 indexed orderId, address indexed payer, address indexed recipient, uint256 amount);

    constructor(IERC20 paymentToken_, address treasury_) {
        paymentToken = paymentToken_;
        treasury = treasury_;
    }

    function order(uint256 amount, address recipient) external returns (uint256 orderId) {
        paymentToken.safeTransferFrom(msg.sender, treasury, amount);
        orderId = ++orderCount;
        emit Ordered(orderId, msg.sender, recipient, amount);
    }
}
