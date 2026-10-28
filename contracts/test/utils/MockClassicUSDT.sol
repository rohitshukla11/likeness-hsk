// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev What the tests need from a USDT: both the ERC-20 mock and the classic one fit, because the
///      writes declare no return value.
interface IUsdtLike {
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external;
    function transfer(address to, uint256 value) external;
    function mint(address to, uint256 amount) external;
}

/// @dev Tests only. Behaves like Tether's classic TetherToken, which HashKey's testnet USDT
///      (0x372325443233fEbaC1F6998aC750276468c83CC6, "HP2 Tether USD") is: `transfer`, `transferFrom`
///      and `approve` return nothing, and `approve` from a non-zero allowance to another non-zero value
///      reverts. A caller that expects a `bool` back fails on it; SafeERC20-style callers don't.
contract MockClassicUSDT is IUsdtLike {
    string public constant name = "HP2 Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        // TetherToken: "To change the approve amount you first have to reduce the addresses`
        // allowance to zero".
        require(!(value != 0 && allowance[msg.sender][spender] != 0), "reset allowance to 0 first");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
