// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base} from "./utils/Base.t.sol";
import {Categories} from "../src/Categories.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";

contract CreatorRegistryTest is Base {
    function test_register() public {
        _register(creator);
        CreatorRegistry.Creator memory c = creators.creator(creator);
        assertTrue(c.registered);
        assertTrue(c.active);
        assertEq(c.payout, payout);
        assertEq(c.attestation.referenceSetHash, keccak256("ciphertext-manifest"));
        assertTrue(creators.canLicense(creator));
        assertEq(creators.attestationNonce(creator), 1);
    }

    function test_register_twice_reverts() public {
        _register(creator);
        CreatorRegistry.Attestation memory a = _attestation();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signAttestation(creator, a, deadline);
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.AlreadyRegistered.selector);
        creators.register(payout, a, deadline, sig, _terms());
    }

    function test_selfAttestation_reverts() public {
        CreatorRegistry.Attestation memory a = _attestation();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = creators.attestationDigest(creator, a, 0, deadline);
        bytes memory sig = _sign(creatorPk, digest);
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.BadAttestation.selector);
        creators.register(payout, a, deadline, sig, _terms());
    }

    function test_attestationForSomeoneElse_reverts() public {
        address other = makeAddr("other");
        CreatorRegistry.Attestation memory a = _attestation();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signAttestation(creator, a, deadline);
        vm.prank(other);
        vm.expectRevert(CreatorRegistry.BadAttestation.selector);
        creators.register(payout, a, deadline, sig, _terms());
    }

    function test_notAdult_reverts() public {
        CreatorRegistry.Attestation memory a = _attestation();
        a.adult = false;
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signAttestation(creator, a, deadline);
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.NotAdult.selector);
        creators.register(payout, a, deadline, sig, _terms());
    }

    function test_missingAgeProvider_reverts() public {
        CreatorRegistry.Attestation memory a = _attestation();
        a.ageProvider = bytes32(0);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signAttestation(creator, a, deadline);
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.MissingProvider.selector);
        creators.register(payout, a, deadline, sig, _terms());
    }

    function test_expiredAttestation_reverts() public {
        CreatorRegistry.Attestation memory a = _attestation();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signAttestation(creator, a, deadline);
        vm.warp(deadline + 1);
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.Expired.selector);
        creators.register(payout, a, deadline, sig, _terms());
    }

    function test_updateAttestation_consumesNonce() public {
        _register(creator);
        CreatorRegistry.Attestation memory a = _attestation();
        a.referenceSetHash = keccak256("recaptured");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signAttestation(creator, a, deadline);
        vm.prank(creator);
        creators.updateAttestation(a, deadline, sig);
        assertEq(creators.creator(creator).attestation.referenceSetHash, keccak256("recaptured"));

        // The same signature cannot be replayed: the nonce moved on.
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.BadAttestation.selector);
        creators.updateAttestation(a, deadline, sig);
    }

    function test_terms_rejectEveryBannedCategory() public {
        uint32[5] memory banned =
            [Categories.POLITICAL, Categories.ADULT, Categories.MINORS, Categories.IMPERSONATION, Categories.DECEPTION];
        _register(creator);
        for (uint256 i; i < banned.length; ++i) {
            CreatorRegistry.Terms memory t = _terms();
            t.categories |= banned[i];
            vm.prank(creator);
            vm.expectRevert(abi.encodeWithSelector(Categories.BannedCategory.selector, t.categories));
            creators.setTerms(t);
        }
    }

    function testFuzz_terms_neverStoreBannedBits(uint32 categories) public {
        _register(creator);
        CreatorRegistry.Terms memory t = _terms();
        t.categories = categories;
        vm.prank(creator);
        try creators.setTerms(t) {
            uint32 stored = creators.terms(creator).categories;
            assertEq(stored & Categories.BANNED, 0);
            assertEq(stored & ~Categories.ALLOWED, 0);
        } catch {}
    }

    function test_terms_rejectEmptyAndZero() public {
        _register(creator);
        CreatorRegistry.Terms memory t = _terms();
        t.regions = 0;
        vm.prank(creator);
        vm.expectRevert(Categories.EmptyRegions.selector);
        creators.setTerms(t);

        t = _terms();
        t.pricePerRender = 0;
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.BadTerms.selector);
        creators.setTerms(t);

        t = _terms();
        t.maxDuration = 366 days;
        vm.prank(creator);
        vm.expectRevert(CreatorRegistry.BadTerms.selector);
        creators.setTerms(t);
    }

    function test_writeRights_areSplit() public {
        _register(creator);
        // The platform cannot touch a creator's terms or payout: those calls act on msg.sender.
        vm.prank(platform);
        vm.expectRevert(CreatorRegistry.NotRegistered.selector);
        creators.setPayout(platform);
        // A creator cannot rotate the attester or suspend anyone.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator));
        creators.setAttester(creator);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator));
        creators.suspend(creator, true);
    }

    function test_revokeAll_and_suspend_bumpEpoch() public {
        _register(creator);
        vm.prank(creator);
        creators.revokeAll();
        assertEq(creators.epochOf(creator), 1);
        vm.prank(platform);
        creators.suspend(creator, true);
        assertEq(creators.epochOf(creator), 2);
        assertFalse(creators.canLicense(creator));
        vm.prank(platform);
        creators.suspend(creator, false);
        assertEq(creators.epochOf(creator), 2);
        assertTrue(creators.canLicense(creator));
    }

    function test_setActive_gatesNewLicences() public {
        _register(creator);
        vm.prank(creator);
        creators.setActive(false);
        assertFalse(creators.canLicense(creator));
    }
}
