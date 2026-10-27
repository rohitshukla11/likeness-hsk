// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Categories} from "./Categories.sol";

/// @title CreatorRegistry
/// @notice One entry per creator: a platform-signed attestation that they passed liveness and an age
///         check, and the terms they offer. Holds hashes only, never biometric data: the reference set
///         is stored off-chain as ciphertext and `referenceSetHash` is the hash of that ciphertext.
/// @dev Write rights are split. The creator writes terms, payout, activity and revoke-all; the
///      attester (the platform's verification service) signs attestations but cannot submit them;
///      the owner rotates the attester and can suspend a creator for abuse.
contract CreatorRegistry is Ownable2Step, EIP712 {
    struct Attestation {
        bytes32 referenceSetHash; // sha256 of the encrypted reference-set manifest
        bytes32 livenessSessionHash; // keccak256 of the liveness session id
        bytes32 livenessProvider; // e.g. "aws-rekognition-face-liveness"
        bytes32 ageProvider; // e.g. "persona-sandbox"; never zero, there is no self-declared age
        uint64 verifiedAt;
        bool adult;
    }

    struct Terms {
        uint32 categories; // Categories bitmask, never banned
        uint32 regions; // bitmask, non-empty
        uint64 maxDuration; // seconds
        uint32 maxRenders; // per licence
        uint128 pricePerRender; // USDC, 6 decimals
        bool autoApprove; // licences matching these terms need no creator signature
    }

    struct Creator {
        address payout;
        Attestation attestation;
        Terms terms;
        uint64 epoch; // revokeAll and suspension bump this; licences from older epochs are revoked
        bool active; // accepting new licences
        bool suspended; // set by the platform
        bool registered;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address creator,bytes32 referenceSetHash,bytes32 livenessSessionHash,bytes32 livenessProvider,bytes32 ageProvider,uint64 verifiedAt,bool adult,uint256 nonce,uint64 deadline)"
    );
    uint64 public constant MAX_DURATION = 365 days;

    address public attester;
    mapping(address creator => Creator) private _creators;
    mapping(address creator => uint256) public attestationNonce;

    event AttesterSet(address indexed attester);
    event CreatorRegistered(address indexed creator, address payout, bytes32 referenceSetHash);
    event AttestationUpdated(address indexed creator, bytes32 referenceSetHash, uint64 verifiedAt);
    event TermsSet(address indexed creator, Terms terms);
    event PayoutSet(address indexed creator, address payout);
    event ActiveSet(address indexed creator, bool active);
    event AllRevoked(address indexed creator, uint64 epoch);
    event Suspended(address indexed creator, bool suspended, uint64 epoch);

    error AlreadyRegistered();
    error NotRegistered();
    error NotAdult();
    error MissingProvider();
    error BadAttestation();
    error Expired();
    error ZeroAddress();
    error BadTerms();

    constructor(address owner_, address attester_) Ownable(owner_) EIP712("Likeness CreatorRegistry", "1") {
        _setAttester(attester_);
    }

    // ---------------------------------------------------------------- creator writes

    function register(
        address payout,
        Attestation calldata a,
        uint64 deadline,
        bytes calldata attesterSig,
        Terms calldata initialTerms
    ) external {
        Creator storage c = _creators[msg.sender];
        if (c.registered) revert AlreadyRegistered();
        if (payout == address(0)) revert ZeroAddress();
        _consumeAttestation(msg.sender, a, deadline, attesterSig);
        _requireTerms(initialTerms);
        c.registered = true;
        c.active = true;
        c.payout = payout;
        c.attestation = a;
        c.terms = initialTerms;
        emit CreatorRegistered(msg.sender, payout, a.referenceSetHash);
        emit TermsSet(msg.sender, initialTerms);
    }

    /// @notice Re-capture: a new reference set needs a fresh attestation.
    function updateAttestation(Attestation calldata a, uint64 deadline, bytes calldata attesterSig) external {
        Creator storage c = _registered(msg.sender);
        _consumeAttestation(msg.sender, a, deadline, attesterSig);
        c.attestation = a;
        emit AttestationUpdated(msg.sender, a.referenceSetHash, a.verifiedAt);
    }

    function setTerms(Terms calldata newTerms) external {
        Creator storage c = _registered(msg.sender);
        _requireTerms(newTerms);
        c.terms = newTerms;
        emit TermsSet(msg.sender, newTerms);
    }

    function setPayout(address payout) external {
        Creator storage c = _registered(msg.sender);
        if (payout == address(0)) revert ZeroAddress();
        c.payout = payout;
        emit PayoutSet(msg.sender, payout);
    }

    /// @notice Stop (or resume) accepting new licences. Existing licences are unaffected.
    function setActive(bool active) external {
        _registered(msg.sender).active = active;
        emit ActiveSet(msg.sender, active);
    }

    /// @notice One click: every licence issued so far is revoked. New renders are refused and unused
    ///         escrow becomes refundable.
    function revokeAll() external {
        Creator storage c = _registered(msg.sender);
        emit AllRevoked(msg.sender, ++c.epoch);
    }

    // ---------------------------------------------------------------- platform writes

    function setAttester(address attester_) external onlyOwner {
        _setAttester(attester_);
    }

    /// @notice Abuse response: suspending also revokes every existing licence.
    function suspend(address account, bool suspended) external onlyOwner {
        Creator storage c = _registered(account);
        c.suspended = suspended;
        if (suspended) ++c.epoch;
        emit Suspended(account, suspended, c.epoch);
    }

    // ---------------------------------------------------------------- reads

    function creator(address account) external view returns (Creator memory) {
        return _creators[account];
    }

    function terms(address account) external view returns (Terms memory) {
        return _creators[account].terms;
    }

    function payoutOf(address account) external view returns (address) {
        return _creators[account].payout;
    }

    function epochOf(address account) external view returns (uint64) {
        return _creators[account].epoch;
    }

    /// @notice Registered, not suspended and accepting new licences.
    function canLicense(address account) external view returns (bool) {
        Creator storage c = _creators[account];
        return c.registered && c.active && !c.suspended;
    }

    function isRegistered(address account) external view returns (bool) {
        return _creators[account].registered;
    }

    function attestationDigest(address account, Attestation calldata a, uint256 nonce, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    account,
                    a.referenceSetHash,
                    a.livenessSessionHash,
                    a.livenessProvider,
                    a.ageProvider,
                    a.verifiedAt,
                    a.adult,
                    nonce,
                    deadline
                )
            )
        );
    }

    // ---------------------------------------------------------------- internals

    function _consumeAttestation(address account, Attestation calldata a, uint64 deadline, bytes calldata sig) private {
        if (!a.adult) revert NotAdult();
        if (a.livenessProvider == bytes32(0) || a.ageProvider == bytes32(0)) revert MissingProvider();
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = attestationDigest(account, a, attestationNonce[account]++, deadline);
        if (!SignatureChecker.isValidSignatureNow(attester, digest, sig)) revert BadAttestation();
    }

    function _requireTerms(Terms calldata t) private pure {
        Categories.requireAllowedSet(t.categories);
        Categories.requireRegions(t.regions);
        if (t.maxDuration == 0 || t.maxDuration > MAX_DURATION || t.maxRenders == 0 || t.pricePerRender == 0) {
            revert BadTerms();
        }
    }

    function _registered(address account) private view returns (Creator storage c) {
        c = _creators[account];
        if (!c.registered) revert NotRegistered();
    }

    function _setAttester(address attester_) private {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterSet(attester_);
    }
}
