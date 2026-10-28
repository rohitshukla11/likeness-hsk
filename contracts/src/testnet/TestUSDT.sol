// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDT
/// @notice HSK Chain TESTNET ONLY. A 6-decimal stand-in for USDT with no value, so the Permit2 payment
///         path can run end to end on chain 133 while HSP's testnet USDT has no public faucet. Never
///         deployed on mainnet; the deploy script refuses to.
contract TestUSDT is ERC20, Ownable {
    constructor(address owner_) ERC20("Likeness Test USDT (testnet, no value)", "tUSDT") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
