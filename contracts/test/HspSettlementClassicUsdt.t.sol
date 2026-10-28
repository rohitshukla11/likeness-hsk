// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HspSettlementPermit2Test} from "./HspSettlementPermit2.t.sol";
import {IUsdtLike, MockClassicUSDT} from "./utils/MockClassicUSDT.sol";

/// @dev The whole Permit2 suite again, on a token that behaves like HashKey's testnet USDT (Tether's
///      classic contract: no return values, zero-first approve). The settlement never moves the
///      token itself; Permit2 does, with a transfer helper that accepts an empty return.
contract HspSettlementClassicUsdtTest is HspSettlementPermit2Test {
    function _newUsdt() internal override returns (IUsdtLike) {
        return IUsdtLike(address(new MockClassicUSDT()));
    }

    function test_classicUsdt_mockReturnsNothing() public {
        vm.prank(brand);
        (bool ok, bytes memory ret) =
            address(usdt).call(abi.encodeWithSignature("transfer(address,uint256)", payout, 1));
        assertTrue(ok);
        assertEq(ret.length, 0, "transfer returns no data");
        vm.prank(payout);
        (ok, ret) = address(usdt).call(abi.encodeWithSignature("approve(address,uint256)", brand, 1));
        assertTrue(ok);
        assertEq(ret.length, 0, "approve returns no data");
    }

    function test_classicUsdt_approveNeedsZeroFirst() public {
        // setUp approved Permit2 for the maximum; changing it directly reverts, as on TetherToken.
        vm.startPrank(brand);
        vm.expectRevert("reset allowance to 0 first");
        usdt.approve(address(permit2), 1);
        usdt.approve(address(permit2), 0);
        usdt.approve(address(permit2), 1);
        vm.stopPrank();
        assertEq(usdt.allowance(brand, address(permit2)), 1);
    }
}
