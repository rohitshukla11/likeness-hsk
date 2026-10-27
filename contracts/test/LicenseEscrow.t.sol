// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./utils/Base.t.sol";
import {LicenseRegistry} from "../src/LicenseRegistry.sol";
import {LicenseEscrow} from "../src/LicenseEscrow.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";

contract LicenseEscrowTest is Base {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        _register(creator);
        id = _license(brand, 3);
    }

    function test_render_paysCreatorAndFee_andAnchors() public {
        _fund(id, brand, 10 * PRICE);
        bytes32 asset = keccak256("file-1");
        uint32 index = _render(id, brand, asset);
        assertEq(index, 0);

        uint256 fee = uint256(PRICE) * FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(payout), PRICE - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(escrow.balanceOf(id), 9 * uint256(PRICE));
        assertEq(licences.licence(id).renderCount, 1);

        (bool found, ReceiptAnchor.Receipt memory r) = receipts.receiptOf(asset);
        assertTrue(found);
        assertEq(r.licenceId, id);
        assertEq(r.renderIndex, 0);
        assertEq(r.timestamp, block.timestamp);
        (found,) = receipts.receiptOf(keccak256("never rendered"));
        assertFalse(found);
    }

    function test_render_needsLicenseeSender() public {
        _fund(id, brand, PRICE);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("f"), 0, deadline);
        // The render agent alone cannot spend the brand's escrow.
        vm.prank(agent);
        vm.expectRevert(LicenseEscrow.NotLicensee.selector);
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);
    }

    function test_render_needsAgentSignature() public {
        _fund(id, brand, PRICE);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        // The brand alone cannot mint a receipt for a file the service never produced.
        (, uint256 brandPk) = makeAddrAndKey("brand");
        bytes memory sig = _sign(brandPk, escrow.renderDigest(id, keccak256("f"), 0, deadline));
        vm.prank(brand);
        vm.expectRevert(LicenseEscrow.BadRenderSignature.selector);
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);

        vm.prank(brand);
        vm.expectRevert(LicenseEscrow.NotRenderAgent.selector);
        escrow.payRender(id, keccak256("f"), brand, deadline, sig);
    }

    function test_render_signatureBoundToIndex_noReplay() public {
        _fund(id, brand, 3 * PRICE);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("f"), 0, deadline);
        vm.prank(brand);
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);
        vm.prank(brand);
        vm.expectRevert(LicenseEscrow.BadRenderSignature.selector);
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);
    }

    function test_render_expiredSignature_reverts() public {
        _fund(id, brand, PRICE);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("f"), 0, deadline);
        vm.warp(deadline + 1);
        vm.prank(brand);
        vm.expectRevert(LicenseEscrow.RenderExpired.selector);
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);
    }

    function test_render_sameFileTwice_reverts() public {
        _fund(id, brand, 3 * PRICE);
        _render(id, brand, keccak256("f"));
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("f"), 1, deadline);
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(ReceiptAnchor.AlreadyAnchored.selector, keccak256("f")));
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);
    }

    function test_render_insufficientEscrow_reverts() public {
        _fund(id, brand, PRICE - 1);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("f"), 0, deadline);
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(LicenseEscrow.InsufficientEscrow.selector, PRICE - 1, PRICE));
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);
    }

    function test_render_capThenExhausted_refund() public {
        _fund(id, brand, 5 * PRICE);
        _render(id, brand, keccak256("a"));
        _render(id, brand, keccak256("b"));
        _render(id, brand, keccak256("c"));
        assertEq(uint8(licences.status(id)), uint8(LicenseRegistry.Status.Exhausted));

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("d"), 3, deadline);
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Exhausted));
        escrow.payRender(id, keccak256("d"), agent, deadline, sig);

        escrow.refund(id);
        assertEq(usdc.balanceOf(brand), 2 * uint256(PRICE));
        assertEq(escrow.balanceOf(id), 0);
    }

    function test_revoke_refusesRenders_andRefundsUnused() public {
        _fund(id, brand, 3 * PRICE);
        _render(id, brand, keccak256("a"));
        vm.prank(creator);
        licences.revoke(id);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("b"), 1, deadline);
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Revoked));
        escrow.payRender(id, keccak256("b"), agent, deadline, sig);

        // Anyone can trigger the refund; it can only go to the licensee.
        vm.prank(makeAddr("stranger"));
        assertEq(escrow.refund(id), 2 * uint256(PRICE));
        assertEq(usdc.balanceOf(brand), 2 * uint256(PRICE));
        vm.expectRevert(LicenseEscrow.ZeroAmount.selector);
        escrow.refund(id);
    }

    function test_expiry_refunds() public {
        _fund(id, brand, 2 * PRICE);
        vm.warp(block.timestamp + 7 days);
        escrow.refund(id);
        assertEq(usdc.balanceOf(brand), 2 * uint256(PRICE));
    }

    function test_refund_whileActive_reverts() public {
        _fund(id, brand, PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseEscrow.NotRefundable.selector, LicenseRegistry.Status.Active));
        escrow.refund(id);
        vm.expectRevert(abi.encodeWithSelector(LicenseEscrow.NotRefundable.selector, LicenseRegistry.Status.Unknown));
        escrow.refund(999);
    }

    function test_deposit_onlyLicensee_onlyActive() public {
        usdc.mint(address(this), PRICE);
        usdc.approve(address(escrow), PRICE);
        vm.expectRevert(LicenseEscrow.NotLicensee.selector);
        escrow.deposit(id, PRICE);

        vm.prank(creator);
        licences.revoke(id);
        usdc.mint(brand, PRICE);
        vm.startPrank(brand);
        usdc.approve(address(escrow), PRICE);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Revoked));
        escrow.deposit(id, PRICE);
        vm.stopPrank();
    }

    function test_payoutChange_appliesToNextRender() public {
        _fund(id, brand, 2 * PRICE);
        address newPayout = makeAddr("newPayout");
        vm.prank(creator);
        creators.setPayout(newPayout);
        _render(id, brand, keccak256("a"));
        assertEq(usdc.balanceOf(newPayout), PRICE - uint256(PRICE) * FEE_BPS / 10_000);
        assertEq(usdc.balanceOf(payout), 0);
    }

    function test_revokedAgent_cannotSign() public {
        _fund(id, brand, PRICE);
        vm.prank(platform);
        escrow.setRenderAgent(agent, false);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _agentSig(id, keccak256("f"), 0, deadline);
        vm.prank(brand);
        vm.expectRevert(LicenseEscrow.NotRenderAgent.selector);
        escrow.payRender(id, keccak256("f"), agent, deadline, sig);
    }

    function test_anchor_onlyEscrow() public {
        vm.expectRevert(ReceiptAnchor.NotEscrow.selector);
        receipts.anchor(keccak256("f"), id, 0, creator, brand);
    }

    function test_feeCap() public {
        vm.expectRevert(LicenseEscrow.FeeTooHigh.selector);
        new LicenseEscrow(platform, usdc, licences, receipts, treasury, 2_001);
    }

    function testFuzz_render_conserves(uint128 price, uint16 renders, uint128 extra) public {
        price = uint128(bound(price, 1, 1e12));
        renders = uint16(bound(renders, 1, 20));
        extra = uint128(bound(extra, 0, 1e12));
        LicenseRegistry.Request memory r = _request(renders);
        r.pricePerRender = price;
        r.salt = keccak256(abi.encode(price, renders));
        bytes memory sig = _sign(creatorPk, licences.approvalDigest(r, brand));
        vm.prank(brand);
        uint256 lid = licences.request(r, sig);
        uint256 total = uint256(price) * renders + extra;
        _fund(lid, brand, total);
        for (uint256 i; i < renders; ++i) {
            _render(lid, brand, keccak256(abi.encode(lid, i)));
        }
        if (extra != 0) escrow.refund(lid);
        assertEq(usdc.balanceOf(payout) + usdc.balanceOf(treasury) + usdc.balanceOf(brand), total);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(brand), extra);
    }
}
