// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HspSettlement} from "../src/HspSettlement.sol";
import {LicenseRegistry} from "../src/LicenseRegistry.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {HspBase} from "./utils/HspBase.t.sol";

/// @dev USDC.e rail (EIP-3009). HspSettlementPermit2.t.sol runs the shared cases on the Permit2 rail.
contract HspSettlementTest is HspBase {
    bytes32 internal constant FILE = keccak256("render-0.jpg");

    // ---------------------------------------------------------------- the happy path

    function test_payThenRecord_bindsPaymentToRender() public {
        uint256 id = _license(brand, 3);
        uint256 payoutBefore = _balance(payout);

        _pay(id, 0, payout, PRICE);
        assertTrue(settlement.paymentExecuted(id, 0));
        bytes32 txHash = keccak256("hsp-tx-0");
        _record(id, 0, PRICE, txHash);

        assertEq(_balance(payout) - payoutBefore, PRICE, "creator paid by the gateway, not by this contract");
        assertEq(_balance(address(settlement)), 0, "settlement holds nothing");
        assertEq(licences.licence(id).renderCount, 1);
        HspSettlement.Payment memory p = settlement.payment(id, 0);
        assertEq(p.payer, brand);
        assertEq(p.amount, PRICE);
        assertEq(p.hspTxHash, txHash);
        assertTrue(p.nonceBound);
        assertEq(p.nonce, settlement.paymentNonce(id, 0));
        assertTrue(settlement.txUsed(txHash));
    }

    function test_recordPayment_emitsWithNonceAndPayout() public {
        uint256 id = _license(brand, 3);
        _pay(id, 0, payout, PRICE);
        bytes32 nonce = settlement.paymentNonce(id, 0);
        bytes32 ref = keccak256(abi.encode("hsp-payment", id, uint32(0)));
        vm.expectEmit(address(settlement));
        emit HspSettlement.PaymentRecorded(id, 0, brand, payout, PRICE, nonce, true, keccak256("tx"), ref);
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_anchor_afterPayment_writesReceipt() public {
        uint256 id = _license(brand, 3);
        uint32 idx = _payAndRecord(id);
        _anchor(id, idx, FILE);

        (bool found, ReceiptAnchor.Receipt memory r) = receipts.receiptOf(FILE);
        assertTrue(found);
        assertEq(r.licenceId, id);
        assertEq(r.renderIndex, idx);
        assertEq(settlement.payment(id, idx).assetHash, FILE);
    }

    function test_rendersInOrder_upToCap() public {
        uint256 id = _license(brand, 2);
        _payAndRecord(id);
        _payAndRecord(id);
        assertEq(uint8(licences.status(id)), uint8(LicenseRegistry.Status.Exhausted));
        // A third payment can execute on the token, but it is never recorded.
        _pay(id, 2, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Exhausted));
        _record(id, 2, PRICE, keccak256("tx-2"));
    }

    // ---------------------------------------------------------------- not paid (yet)

    function test_record_revertsWhenPaymentNotExecutedYet() public {
        uint256 id = _license(brand, 3);
        bytes32 nonce = settlement.paymentNonce(id, 0);
        assertFalse(settlement.paymentExecuted(id, 0));
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, nonce));
        _record(id, 0, PRICE, keccak256("tx"));
        assertEq(licences.licence(id).renderCount, 0);
    }

    function test_record_paymentForAnotherRenderDoesNotCount() public {
        uint256 id = _license(brand, 3);
        _pay(id, 1, payout, PRICE); // signed for render 1, while render 0 is next
        vm.expectRevert(
            abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, settlement.paymentNonce(id, 0))
        );
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_record_paymentForAnotherLicenceDoesNotCount() public {
        uint256 a = _license(brand, 3);
        uint256 b = _license(brand, 3);
        _pay(a, 0, payout, PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, settlement.paymentNonce(b, 0))
        );
        _record(b, 0, PRICE, keccak256("tx"));
    }

    function test_record_someoneElsesPaymentDoesNotCount() public {
        uint256 id = _license(brand, 3);
        // Another account pays with the same nonce; only the licensee's own authorization counts.
        (address other, uint256 otherPk) = makeAddrAndKey("other");
        usdc.mint(other, PRICE);
        bytes32 nonce = settlement.paymentNonce(id, 0);
        uint256 validBefore = block.timestamp + 10 minutes;
        bytes memory sig = _sign(otherPk, usdc.authorizationDigest(other, payout, PRICE, 0, validBefore, nonce));
        vm.prank(gateway);
        usdc.transferWithAuthorization(other, payout, PRICE, 0, validBefore, nonce, sig);

        vm.expectRevert(abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, nonce));
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_nonce_bindsContractChainLicenceAndRender() public {
        bytes32 n = settlement.paymentNonce(1, 0);
        assertEq(n, keccak256(abi.encode(address(settlement), block.chainid, uint256(1), uint32(0))));
        assertTrue(n != settlement.paymentNonce(1, 1));
        assertTrue(n != settlement.paymentNonce(2, 0));
        vm.chainId(133);
        assertTrue(n != settlement.paymentNonce(1, 0));
    }

    function testFuzz_onlyTheExactNonceCounts(uint256 otherLicence, uint32 otherIndex, bytes32 randomNonce) public {
        uint256 id = _license(brand, 3);
        vm.assume(otherLicence != id || otherIndex != 0);
        vm.assume(randomNonce != settlement.paymentNonce(id, 0));
        _payWithNonce(settlement.paymentNonce(otherLicence, otherIndex), payout, PRICE);
        _payWithNonce(randomNonce, payout, PRICE);
        assertFalse(settlement.paymentExecuted(id, 0));
        vm.expectRevert();
        _record(id, 0, PRICE, keccak256("tx"));
    }

    // ---------------------------------------------------------------- who and what may be recorded

    function test_record_onlyTheCreatorsAgent() public {
        uint256 id = _license(brand, 3);
        _pay(id, 0, payout, PRICE);
        bytes32 nonce = settlement.paymentNonce(id, 0);
        address[3] memory callers = [brand, creator, platform];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(HspSettlement.NotCreatorAgent.selector);
            settlement.recordPayment(id, 0, nonce, PRICE, keccak256("tx"), bytes32(0));
        }
    }

    function test_record_noAgentSet_reverts() public {
        uint256 id = _license(brand, 3);
        vm.prank(creator);
        settlement.setAgent(address(0));
        _pay(id, 0, payout, PRICE);
        vm.expectRevert(HspSettlement.NotCreatorAgent.selector);
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_setAgent_onlyRegisteredCreator() public {
        vm.prank(brand);
        vm.expectRevert(HspSettlement.NotRegistered.selector);
        settlement.setAgent(brand);
    }

    function test_record_wrongAmount_reverts() public {
        uint256 id = _license(brand, 3);
        _pay(id, 0, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.WrongAmount.selector, PRICE, PRICE - 1));
        _record(id, 0, PRICE - 1, keccak256("tx"));
    }

    function test_record_outOfOrder_reverts() public {
        uint256 id = _license(brand, 3);
        _pay(id, 1, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.WrongRenderIndex.selector, uint32(0), uint32(1)));
        _record(id, 1, PRICE, keccak256("tx"));
    }

    function test_record_twice_reverts() public {
        uint256 id = _license(brand, 3);
        _payAndRecord(id);
        // Same render again: the index has moved on.
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.WrongRenderIndex.selector, uint32(1), uint32(0)));
        _record(id, 0, PRICE, keccak256("tx-again"));
    }

    function test_record_txHashReuse_reverts() public {
        uint256 id = _license(brand, 3);
        _pay(id, 0, payout, PRICE);
        _record(id, 0, PRICE, keccak256("tx"));
        _pay(id, 1, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.TxAlreadyUsed.selector, keccak256("tx")));
        _record(id, 1, PRICE, keccak256("tx"));
    }

    function test_record_zeroTxHash_reverts() public {
        uint256 id = _license(brand, 3);
        _pay(id, 0, payout, PRICE);
        vm.expectRevert(HspSettlement.ZeroTxHash.selector);
        _record(id, 0, PRICE, bytes32(0));
    }

    // ---------------------------------------------------------------- consent stops the money

    function test_revoked_noFurtherRenders() public {
        uint256 id = _license(brand, 3);
        _payAndRecord(id);
        vm.prank(creator);
        licences.revoke(id);
        _pay(id, 1, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Revoked));
        _record(id, 1, PRICE, keccak256("tx-1"));
    }

    function test_revokeAll_noFurtherRenders() public {
        uint256 id = _license(brand, 3);
        vm.prank(creator);
        creators.revokeAll();
        _pay(id, 0, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Revoked));
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_expired_noFurtherRenders() public {
        uint256 id = _license(brand, 3);
        vm.warp(block.timestamp + 8 days);
        _pay(id, 0, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Expired));
        _record(id, 0, PRICE, keccak256("tx"));
    }

    function test_paidBeforeRevocation_canStillBeDelivered() public {
        uint256 id = _license(brand, 3);
        uint32 idx = _payAndRecord(id);
        vm.prank(creator);
        licences.revoke(id);
        _anchor(id, idx, FILE);
        (bool found,) = receipts.receiptOf(FILE);
        assertTrue(found);
    }

    // ---------------------------------------------------------------- receipts

    function test_anchor_withoutPayment_reverts() public {
        uint256 id = _license(brand, 3);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _renderSig(id, FILE, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.NotPaid.selector, id, uint32(0)));
        settlement.anchorRender(id, 0, FILE, renderAgent, deadline, sig);
    }

    function test_anchor_twice_reverts() public {
        uint256 id = _license(brand, 3);
        uint32 idx = _payAndRecord(id);
        _anchor(id, idx, FILE);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes32 other = keccak256("render-0-again.jpg");
        bytes memory sig = _renderSig(id, other, idx, deadline);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.AlreadyAnchored.selector, id, idx));
        settlement.anchorRender(id, idx, other, renderAgent, deadline, sig);
    }

    function test_anchor_needsARenderAgent() public {
        uint256 id = _license(brand, 3);
        uint32 idx = _payAndRecord(id);
        (address impostor, uint256 impostorPk) = makeAddrAndKey("impostor");
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _sign(impostorPk, settlement.renderDigest(id, FILE, idx, deadline));
        vm.expectRevert(HspSettlement.NotRenderAgent.selector);
        settlement.anchorRender(id, idx, FILE, impostor, deadline, sig);
    }

    function test_anchor_badSignature_reverts() public {
        uint256 id = _license(brand, 3);
        uint32 idx = _payAndRecord(id);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _renderSig(id, keccak256("a different file"), idx, deadline);
        vm.expectRevert(HspSettlement.BadRenderSignature.selector);
        settlement.anchorRender(id, idx, FILE, renderAgent, deadline, sig);
    }

    function test_anchor_expired_reverts() public {
        uint256 id = _license(brand, 3);
        uint32 idx = _payAndRecord(id);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _renderSig(id, FILE, idx, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(HspSettlement.RenderExpired.selector);
        settlement.anchorRender(id, idx, FILE, renderAgent, deadline, sig);
    }

    function test_onlySettlementWritesRegistries() public {
        uint256 id = _license(brand, 3);
        vm.expectRevert(LicenseRegistry.NotSettlement.selector);
        licences.recordRender(id);
        vm.expectRevert(ReceiptAnchor.NotSettlement.selector);
        receipts.anchor(FILE, id, 0, creator, brand);
    }

    function test_setRenderAgent_onlyOwner() public {
        vm.prank(brand);
        vm.expectRevert();
        settlement.setRenderAgent(brand, true);
    }

    // ---------------------------------------------------------------- the HSP Gateway picks the nonce

    function test_gatewayNonce_recordsTheNonceThatExecuted() public {
        uint256 id = _license(brand, 3);
        bytes32 gatewayNonce = keccak256("nonce chosen by the HSP Gateway");
        _payWithNonce(gatewayNonce, payout, PRICE);
        assertFalse(settlement.paymentExecuted(id, 0), "the bound nonce was not used");

        _recordWithNonce(id, 0, gatewayNonce, PRICE, keccak256("tx"));
        HspSettlement.Payment memory p = settlement.payment(id, 0);
        assertFalse(p.nonceBound);
        assertEq(p.nonce, gatewayNonce);
        assertTrue(settlement.nonceRecorded(brand, gatewayNonce));
        assertEq(licences.licence(id).renderCount, 1);
    }

    function test_gatewayNonce_emitsUnbound() public {
        uint256 id = _license(brand, 3);
        bytes32 gatewayNonce = keccak256("gateway");
        _payWithNonce(gatewayNonce, payout, PRICE);
        vm.expectEmit(address(settlement));
        emit HspSettlement.PaymentRecorded(
            id,
            0,
            brand,
            payout,
            PRICE,
            gatewayNonce,
            false,
            keccak256("tx"),
            keccak256(abi.encode("hsp-payment", id, uint32(0)))
        );
        _recordWithNonce(id, 0, gatewayNonce, PRICE, keccak256("tx"));
    }

    function test_gatewayNonce_revertsWhenNotExecutedYet() public {
        uint256 id = _license(brand, 3);
        bytes32 gatewayNonce = keccak256("gateway");
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, gatewayNonce));
        _recordWithNonce(id, 0, gatewayNonce, PRICE, keccak256("tx"));
    }

    function test_gatewayNonce_countsOnce() public {
        uint256 a = _license(brand, 3);
        uint256 b = _license(brand, 3);
        bytes32 gatewayNonce = keccak256("gateway");
        _payWithNonce(gatewayNonce, payout, PRICE);
        _recordWithNonce(a, 0, gatewayNonce, PRICE, keccak256("tx-a0"));
        // The same executed authorization can't pay for another render, of this licence or another.
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.NonceAlreadyRecorded.selector, brand, gatewayNonce));
        _recordWithNonce(a, 1, gatewayNonce, PRICE, keccak256("tx-a1"));
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.NonceAlreadyRecorded.selector, brand, gatewayNonce));
        _recordWithNonce(b, 0, gatewayNonce, PRICE, keccak256("tx-b0"));
    }

    function test_boundNonce_cannotPayForAnotherRender() public {
        uint256 id = _license(brand, 3);
        _payAndRecord(id);
        bytes32 used = settlement.paymentNonce(id, 0);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.NonceAlreadyRecorded.selector, brand, used));
        _recordWithNonce(id, 1, used, PRICE, keccak256("tx-1"));
    }

    function test_gatewayNonce_onlyTheLicenseesAuthorizationCounts() public {
        uint256 id = _license(brand, 3);
        (address other, uint256 otherPk) = makeAddrAndKey("other");
        usdc.mint(other, PRICE);
        bytes32 gatewayNonce = keccak256("gateway");
        uint256 validBefore = block.timestamp + 10 minutes;
        bytes memory sig = _sign(otherPk, usdc.authorizationDigest(other, payout, PRICE, 0, validBefore, gatewayNonce));
        vm.prank(gateway);
        usdc.transferWithAuthorization(other, payout, PRICE, 0, validBefore, gatewayNonce, sig);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, gatewayNonce));
        _recordWithNonce(id, 0, gatewayNonce, PRICE, keccak256("tx"));
    }

    function test_gatewayNonce_revokedStillStops() public {
        uint256 id = _license(brand, 3);
        vm.prank(creator);
        licences.revoke(id);
        bytes32 gatewayNonce = keccak256("gateway");
        _payWithNonce(gatewayNonce, payout, PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Revoked));
        _recordWithNonce(id, 0, gatewayNonce, PRICE, keccak256("tx"));
    }

    // ---------------------------------------------------------------- helpers

    function _balance(address who) internal view returns (uint256) {
        return usdc.balanceOf(who);
    }
}
