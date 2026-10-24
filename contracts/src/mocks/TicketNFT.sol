// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TicketNFT (demo shop "TicketShop")
/// @notice `buy` pulls exactly `price` of the payment token from the caller and mints
///         `ticketId` to `recipient`. Uses `_mint`, so the recipient needs no receiver hook.
contract TicketNFT is ERC721 {
    using SafeERC20 for IERC20;

    IERC20 public immutable paymentToken;
    uint256 public immutable price;
    address public immutable treasury;

    event TicketBought(address indexed payer, address indexed recipient, uint256 indexed ticketId, uint256 price);

    constructor(IERC20 paymentToken_, uint256 price_, address treasury_) ERC721("Hypnexis Ticket", "TKT") {
        paymentToken = paymentToken_;
        price = price_;
        treasury = treasury_;
    }

    function buy(uint256 ticketId, address recipient) external {
        paymentToken.safeTransferFrom(msg.sender, treasury, price);
        _mint(recipient, ticketId);
        emit TicketBought(msg.sender, recipient, ticketId, price);
    }
}
