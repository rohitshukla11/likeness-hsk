// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HspSettlement, IPermit2Nonces} from "../src/HspSettlement.sol";
import {LicenseRegistry} from "../src/LicenseRegistry.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {HspBase} from "./utils/HspBase.t.sol";

/// @dev The USDT fallback: HSP pays through Permit2 signature transfers, so the settlement checks the
///      licensee's bit in Permit2's nonce bitmap instead of EIP-3009's authorizationState.
contract HspSettlementPermit2Test is HspBase {
    function _rail() internal pure override returns (HspSettlement.Rail) {
        return HspSettlement.Rail.Permit2;
    }

    function test_permit2_payThenRecordThenAnchor() public {
        uint256 id = _license(brand, 3);
        uint256 before = usdt.balanceOf(payout);
        _pay(id, 0, payout, PRICE);
        assertTrue(settlement.paymentExecuted(id, 0));
        _record(id, 0, PRICE, keccak256("tx"));
        assertEq(usdt.balanceOf(payout) - before, PRICE);
        assertEq(licences.licence(id).renderCount, 1);

        bytes32 file = keccak256("render-0.jpg");
        _anchor(id, 0, file);
        (bool found, ReceiptAnchor.Receipt memory r) = receipts.receiptOf(file);
        assertTrue(found);
        assertEq(r.licenceId, id);
    }

    function test_permit2_record_revertsWhenPaymentNotExecutedYet() public {
        uint256 id = _license(brand, 3);
        assertFalse(settlement.paymentExecuted(id, 0));
        vm.expectRevert(
            abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, settlement.paymentNonce(id, 0))
        );
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_permit2_neighbouringBitDoesNotCount() public {
        uint256 id = _license(brand, 3);
        // Same bitmap word, a different bit: not this render's nonce.
        _payWithNonce(bytes32(uint256(settlement.paymentNonce(id, 0)) ^ 1), payout, PRICE);
        assertFalse(settlement.paymentExecuted(id, 0));
    }

    function test_permit2_revoked_noFurtherRenders() public {
        uint256 id = _license(brand, 3);
        vm.prank(creator);
        licences.revoke(id);
        _pay(id, 0, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Revoked));
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_permit2_rail_needsPermit2Address() public {
        vm.expectRevert(HspSettlement.ZeroAddress.selector);
        new HspSettlement(
            platform, HspSettlement.Rail.Permit2, address(usdt), IPermit2Nonces(address(0)), licences, receipts
        );
    }
}
