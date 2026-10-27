// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Categories} from "./Categories.sol";
import {CreatorRegistry} from "./CreatorRegistry.sol";

/// @notice ERC-5192 minimal soulbound interface. https://eips.ethereum.org/EIPS/eip-5192
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}

/// @title LicenseRegistry
/// @notice A licence is a non-transferable, expiring ERC-721 (locked per ERC-5192) held by the
///         licensee. It is issued either against the creator's EIP-712 approval of the exact deal, or
///         automatically when the creator has opted in and the request fits their published terms.
/// @dev Write rights: the licensee requests, the creator revokes, only LicenseEscrow counts renders.
contract LicenseRegistry is ERC721, IERC5192, Ownable2Step, EIP712 {
    enum Status {
        Unknown,
        Active,
        Revoked,
        Expired,
        Exhausted
    }

    struct Request {
        address creator;
        uint32 category; // exactly one Categories bit
        uint32 regions;
        uint64 duration; // seconds from issue
        uint32 renderCap;
        uint128 pricePerRender; // USDC, 6 decimals
        bytes32 purposeHash; // hash of the off-chain brief (brand, campaign, intended use)
        uint64 deadline; // for the creator's signature
        bytes32 salt; // lets a creator approve the same deal more than once
    }

    struct Licence {
        address creator;
        uint64 start;
        address licensee;
        uint64 end;
        uint32 category;
        uint32 regions;
        uint32 renderCap;
        uint32 renderCount;
        uint64 creatorEpoch;
        bool revoked;
        uint128 pricePerRender;
        bytes32 purposeHash;
    }

    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "Approval(address creator,address licensee,uint32 category,uint32 regions,uint64 duration,uint32 renderCap,uint128 pricePerRender,bytes32 purposeHash,uint64 deadline,bytes32 salt)"
    );
    bytes4 private constant ERC5192_INTERFACE_ID = 0xb45a3c0e;

    CreatorRegistry public immutable creators;
    address public escrow;
    uint256 public licenceCount;

    mapping(uint256 id => Licence) private _licences;
    mapping(bytes32 digest => bool) public approvalUsed;

    event EscrowSet(address indexed escrow);
    event LicenceIssued(
        uint256 indexed id,
        address indexed creator,
        address indexed licensee,
        uint32 category,
        uint32 regions,
        uint64 end,
        uint32 renderCap,
        uint128 pricePerRender,
        bytes32 purposeHash,
        bool autoApproved
    );
    event LicenceRevoked(uint256 indexed id, address indexed creator);
    event RenderRecorded(uint256 indexed id, uint32 renderIndex);

    error Soulbound();
    error NotCreator();
    error NotEscrow();
    error EscrowAlreadySet();
    error ZeroAddress();
    error CreatorUnavailable();
    error BadRequest();
    error OutsideTerms();
    error BadApproval();
    error ApprovalExpired();
    error ApprovalReused();
    error NotActive(Status status);

    constructor(address owner_, CreatorRegistry creators_)
        ERC721("Likeness Licence", "LIKENESS-L")
        Ownable(owner_)
        EIP712("Likeness LicenseRegistry", "1")
    {
        creators = creators_;
    }

    /// @notice Wire the escrow once; it alone may record renders.
    function setEscrow(address escrow_) external onlyOwner {
        if (escrow != address(0)) revert EscrowAlreadySet();
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    // ---------------------------------------------------------------- licensee

    /// @param creatorSig The creator's EIP-712 Approval of this exact request for msg.sender. Pass empty
    ///        bytes to rely on auto-approve, which only accepts requests inside the published terms.
    function request(Request calldata r, bytes calldata creatorSig) external returns (uint256 id) {
        if (!creators.canLicense(r.creator)) revert CreatorUnavailable();
        Categories.requireLicensable(r.category);
        Categories.requireRegions(r.regions);
        if (r.duration == 0 || r.duration > creators.MAX_DURATION() || r.renderCap == 0 || r.pricePerRender == 0) {
            revert BadRequest();
        }

        bool auto_ = creatorSig.length == 0;
        if (auto_) {
            CreatorRegistry.Terms memory t = creators.terms(r.creator);
            if (
                !t.autoApprove || r.category & t.categories != r.category || r.regions & t.regions != r.regions
                    || r.duration > t.maxDuration || r.renderCap > t.maxRenders || r.pricePerRender < t.pricePerRender
            ) revert OutsideTerms();
        } else {
            // A signed approval is a negotiated deal and may differ from the published terms, but never
            // reaches a banned category: that was checked above for every request.
            if (block.timestamp > r.deadline) revert ApprovalExpired();
            bytes32 digest = approvalDigest(r, msg.sender);
            if (approvalUsed[digest]) revert ApprovalReused();
            if (!SignatureChecker.isValidSignatureNow(r.creator, digest, creatorSig)) revert BadApproval();
            approvalUsed[digest] = true;
        }

        id = ++licenceCount;
        uint64 end = uint64(block.timestamp) + r.duration;
        _licences[id] = Licence({
            creator: r.creator,
            start: uint64(block.timestamp),
            licensee: msg.sender,
            end: end,
            category: r.category,
            regions: r.regions,
            renderCap: r.renderCap,
            renderCount: 0,
            creatorEpoch: creators.epochOf(r.creator),
            revoked: false,
            pricePerRender: r.pricePerRender,
            purposeHash: r.purposeHash
        });
        _mint(msg.sender, id);
        emit Locked(id);
        emit LicenceIssued(
            id, r.creator, msg.sender, r.category, r.regions, end, r.renderCap, r.pricePerRender, r.purposeHash, auto_
        );
    }

    // ---------------------------------------------------------------- creator

    function revoke(uint256 id) external {
        Licence storage l = _licences[id];
        if (msg.sender != l.creator) revert NotCreator();
        Status s = status(id);
        if (s != Status.Active) revert NotActive(s);
        l.revoked = true;
        emit LicenceRevoked(id, msg.sender);
    }

    // ---------------------------------------------------------------- escrow

    /// @return renderIndex Zero-based index of this render within the licence.
    function recordRender(uint256 id) external returns (uint32 renderIndex) {
        if (msg.sender != escrow) revert NotEscrow();
        Status s = status(id);
        if (s != Status.Active) revert NotActive(s);
        renderIndex = _licences[id].renderCount++;
        emit RenderRecorded(id, renderIndex);
    }

    // ---------------------------------------------------------------- reads

    /// @notice Unknown for ids never issued. Revoked (by the creator, revoke-all or suspension) takes
    ///         precedence over Expired, which takes precedence over Exhausted.
    function status(uint256 id) public view returns (Status) {
        Licence storage l = _licences[id];
        if (l.creator == address(0)) return Status.Unknown;
        if (l.revoked || l.creatorEpoch < creators.epochOf(l.creator)) return Status.Revoked;
        if (block.timestamp >= l.end) return Status.Expired;
        if (l.renderCount >= l.renderCap) return Status.Exhausted;
        return Status.Active;
    }

    function licence(uint256 id) external view returns (Licence memory) {
        return _licences[id];
    }

    function approvalDigest(Request calldata r, address licensee) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    APPROVAL_TYPEHASH,
                    r.creator,
                    licensee,
                    r.category,
                    r.regions,
                    r.duration,
                    r.renderCap,
                    r.pricePerRender,
                    r.purposeHash,
                    r.deadline,
                    r.salt
                )
            )
        );
    }

    /// @inheritdoc IERC5192
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == ERC5192_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    /// @dev Mint only. Every transfer path in ERC-721 goes through `_update`, so this one check makes
    ///      `transferFrom` and both `safeTransferFrom`s revert, as ERC-5192 requires for locked tokens.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }
}
