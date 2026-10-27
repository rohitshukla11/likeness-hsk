// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Categories} from "../../src/Categories.sol";
import {CreatorRegistry} from "../../src/CreatorRegistry.sol";
import {LicenseRegistry} from "../../src/LicenseRegistry.sol";
import {ReceiptAnchor} from "../../src/ReceiptAnchor.sol";

abstract contract Base is Test {
    uint128 internal constant PRICE = 50_000; // 0.05 USDC.e

    CreatorRegistry internal creators;
    LicenseRegistry internal licences;
    ReceiptAnchor internal receipts;

    address internal platform = makeAddr("platform");
    uint256 internal attesterPk;
    address internal attester;
    uint256 internal creatorPk;
    address internal creator;
    address internal payout = makeAddr("payout");
    address internal brand = makeAddr("brand");

    function setUp() public virtual {
        (attester, attesterPk) = makeAddrAndKey("attester");
        (creator, creatorPk) = makeAddrAndKey("creator");

        creators = new CreatorRegistry(platform, attester);
        licences = new LicenseRegistry(platform, creators);
        receipts = new ReceiptAnchor(platform);
        _wireSettlement(makeAddr("settlement"));
    }

    /// @dev The settlement contract is the only writer of renders and receipts.
    function _wireSettlement(address settlement) internal virtual {
        vm.startPrank(platform);
        licences.setSettlement(settlement);
        receipts.setSettlement(settlement);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- fixtures

    function _attestation() internal view returns (CreatorRegistry.Attestation memory) {
        return CreatorRegistry.Attestation({
            referenceSetHash: keccak256("ciphertext-manifest"),
            livenessSessionHash: keccak256("liveness-session-id"),
            livenessProvider: "aws-rekognition-face-liveness",
            ageProvider: "persona-sandbox",
            verifiedAt: uint64(block.timestamp),
            adult: true
        });
    }

    function _terms() internal pure returns (CreatorRegistry.Terms memory) {
        return CreatorRegistry.Terms({
            categories: Categories.ADVERTISING | Categories.SOCIAL,
            regions: 0xFFFF,
            maxDuration: 30 days,
            maxRenders: 100,
            pricePerRender: PRICE,
            autoApprove: true
        });
    }

    function _signAttestation(address account, CreatorRegistry.Attestation memory a, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = creators.attestationDigest(account, a, creators.attestationNonce(account), deadline);
        return _sign(attesterPk, digest);
    }

    function _register(address account) internal {
        CreatorRegistry.Attestation memory a = _attestation();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signAttestation(account, a, deadline);
        vm.prank(account);
        creators.register(payout, a, deadline, sig, _terms());
    }

    function _request(uint32 renderCap) internal view returns (LicenseRegistry.Request memory) {
        return LicenseRegistry.Request({
            creator: creator,
            category: Categories.ADVERTISING,
            regions: 1,
            duration: 7 days,
            renderCap: renderCap,
            pricePerRender: PRICE,
            purposeHash: keccak256("spring campaign"),
            deadline: uint64(block.timestamp + 1 hours),
            salt: bytes32(0)
        });
    }

    function _license(address licensee, uint32 renderCap) internal returns (uint256 id) {
        vm.prank(licensee);
        id = licences.request(_request(renderCap), "");
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
