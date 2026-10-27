// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "./utils/Base.t.sol";
import {Categories} from "../src/Categories.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {LicenseRegistry, IERC5192} from "../src/LicenseRegistry.sol";

contract LicenseRegistryTest is Base {
    function setUp() public override {
        super.setUp();
        _register(creator);
    }

    // ---------------------------------------------------------------- issue

    function test_autoApprove_issuesLockedLicence() public {
        vm.expectEmit(address(licences));
        emit IERC5192.Locked(1);
        uint256 id = _license(brand, 10);
        assertEq(id, 1);
        assertEq(licences.ownerOf(id), brand);
        assertTrue(licences.locked(id));
        assertEq(uint8(licences.status(id)), uint8(LicenseRegistry.Status.Active));
        LicenseRegistry.Licence memory l = licences.licence(id);
        assertEq(l.creator, creator);
        assertEq(l.licensee, brand);
        assertEq(l.end, block.timestamp + 7 days);
        assertEq(l.pricePerRender, PRICE);
    }

    function test_autoApprove_rejectsOutsideTerms() public {
        LicenseRegistry.Request memory r = _request(10);
        r.category = Categories.EDITORIAL; // not in the creator's terms
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.OutsideTerms.selector);
        licences.request(r, "");

        r = _request(101); // over maxRenders
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.OutsideTerms.selector);
        licences.request(r, "");

        r = _request(10);
        r.pricePerRender = PRICE - 1; // under the published price
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.OutsideTerms.selector);
        licences.request(r, "");

        r = _request(10);
        r.duration = 31 days;
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.OutsideTerms.selector);
        licences.request(r, "");
    }

    function test_autoApproveOff_needsSignature() public {
        CreatorRegistry.Terms memory t = _terms();
        t.autoApprove = false;
        vm.prank(creator);
        creators.setTerms(t);
        LicenseRegistry.Request memory r = _request(10);
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.OutsideTerms.selector);
        licences.request(r, "");

        bytes memory sig = _sign(creatorPk, licences.approvalDigest(r, brand));
        vm.prank(brand);
        uint256 id = licences.request(r, sig);
        assertEq(licences.ownerOf(id), brand);
    }

    function test_signedDeal_mayDifferFromTerms_butNotBanned() public {
        LicenseRegistry.Request memory r = _request(500);
        r.category = Categories.EDITORIAL;
        r.pricePerRender = 1;
        bytes memory sig = _sign(creatorPk, licences.approvalDigest(r, brand));
        vm.prank(brand);
        licences.request(r, sig);

        uint32[5] memory banned =
            [Categories.POLITICAL, Categories.ADULT, Categories.MINORS, Categories.IMPERSONATION, Categories.DECEPTION];
        for (uint256 i; i < banned.length; ++i) {
            r.category = banned[i];
            r.salt = bytes32(i + 1);
            sig = _sign(creatorPk, licences.approvalDigest(r, brand));
            vm.prank(brand);
            vm.expectRevert(abi.encodeWithSelector(Categories.BannedCategory.selector, banned[i]));
            licences.request(r, sig);
        }
    }

    function testFuzz_request_neverIssuesBannedOrMultiCategory(uint32 category) public {
        LicenseRegistry.Request memory r = _request(10);
        r.category = category;
        bytes memory sig = _sign(creatorPk, licences.approvalDigest(r, brand));
        vm.prank(brand);
        try licences.request(r, sig) returns (uint256 id) {
            uint32 c = licences.licence(id).category;
            assertEq(c & Categories.BANNED, 0);
            assertEq(c & (c - 1), 0);
        } catch {}
    }

    function test_signature_boundToLicensee() public {
        LicenseRegistry.Request memory r = _request(10);
        bytes memory sig = _sign(creatorPk, licences.approvalDigest(r, brand));
        vm.prank(makeAddr("thief"));
        vm.expectRevert(LicenseRegistry.BadApproval.selector);
        licences.request(r, sig);
    }

    function test_signature_singleUse_and_deadline() public {
        LicenseRegistry.Request memory r = _request(10);
        bytes memory sig = _sign(creatorPk, licences.approvalDigest(r, brand));
        vm.prank(brand);
        licences.request(r, sig);
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.ApprovalReused.selector);
        licences.request(r, sig);

        r.salt = bytes32(uint256(1));
        sig = _sign(creatorPk, licences.approvalDigest(r, brand));
        vm.warp(r.deadline + 1);
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.ApprovalExpired.selector);
        licences.request(r, sig);
    }

    function test_unavailableCreator_reverts() public {
        vm.prank(creator);
        creators.setActive(false);
        LicenseRegistry.Request memory r = _request(10);
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.CreatorUnavailable.selector);
        licences.request(r, "");
    }

    // ---------------------------------------------------------------- soulbound

    function test_transfers_revert() public {
        uint256 id = _license(brand, 10);
        address to = makeAddr("to");
        vm.startPrank(brand);
        vm.expectRevert(LicenseRegistry.Soulbound.selector);
        licences.transferFrom(brand, to, id);
        vm.expectRevert(LicenseRegistry.Soulbound.selector);
        licences.safeTransferFrom(brand, to, id);
        vm.expectRevert(LicenseRegistry.Soulbound.selector);
        licences.safeTransferFrom(brand, to, id, "");
        vm.stopPrank();
    }

    function test_erc5192() public {
        assertTrue(licences.supportsInterface(0xb45a3c0e));
        assertTrue(licences.supportsInterface(0x80ac58cd)); // ERC-721
        vm.expectRevert();
        licences.locked(42); // invalid tokens throw, per ERC-5192
    }

    // ---------------------------------------------------------------- status

    function test_status_lifecycle() public {
        assertEq(uint8(licences.status(99)), uint8(LicenseRegistry.Status.Unknown));
        uint256 id = _license(brand, 10);
        vm.warp(block.timestamp + 7 days);
        assertEq(uint8(licences.status(id)), uint8(LicenseRegistry.Status.Expired));
    }

    function test_revoke_onlyCreator() public {
        uint256 id = _license(brand, 10);
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.NotCreator.selector);
        licences.revoke(id);
        vm.prank(creator);
        licences.revoke(id);
        assertEq(uint8(licences.status(id)), uint8(LicenseRegistry.Status.Revoked));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotActive.selector, LicenseRegistry.Status.Revoked));
        licences.revoke(id);
    }

    function test_revokeAll_revokesOldLicencesOnly() public {
        uint256 a = _license(brand, 10);
        uint256 b = _license(brand, 10);
        vm.prank(creator);
        creators.revokeAll();
        uint256 c = _license(brand, 10);
        assertEq(uint8(licences.status(a)), uint8(LicenseRegistry.Status.Revoked));
        assertEq(uint8(licences.status(b)), uint8(LicenseRegistry.Status.Revoked));
        assertEq(uint8(licences.status(c)), uint8(LicenseRegistry.Status.Active));
    }

    function test_recordRender_onlyEscrow() public {
        uint256 id = _license(brand, 10);
        vm.prank(brand);
        vm.expectRevert(LicenseRegistry.NotEscrow.selector);
        licences.recordRender(id);
    }

    function test_setEscrow_once() public {
        vm.prank(platform);
        vm.expectRevert(LicenseRegistry.EscrowAlreadySet.selector);
        licences.setEscrow(address(1));
    }
}
