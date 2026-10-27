// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Tests only. A plain 6-decimal ERC-20 without permit, like USDT on HSK Chain
///      (0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029), which HSP pays through Permit2.
contract MockUSDT is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
