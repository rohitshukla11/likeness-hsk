// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ReceiptAnchor
/// @notice One receipt per licensed render, keyed by the hash of the delivered file (with its C2PA
///         manifest embedded). Anyone can look a file up by hash; only LicenseEscrow writes, and only
///         inside a paid render, so a receipt cannot exist without a payment to the creator.
contract ReceiptAnchor is Ownable2Step {
    struct Receipt {
        uint256 licenceId;
        uint32 renderIndex;
        uint64 timestamp;
    }

    address public escrow;
    uint256 public receiptCount;
    mapping(bytes32 assetHash => Receipt) private _receipts;

    event EscrowSet(address indexed escrow);
    event ReceiptAnchored(
        bytes32 indexed assetHash,
        uint256 indexed licenceId,
        address indexed creator,
        address licensee,
        uint32 renderIndex,
        uint64 timestamp
    );

    error NotEscrow();
    error EscrowAlreadySet();
    error ZeroAddress();
    error ZeroHash();
    error AlreadyAnchored(bytes32 assetHash);

    constructor(address owner_) Ownable(owner_) {}

    function setEscrow(address escrow_) external onlyOwner {
        if (escrow != address(0)) revert EscrowAlreadySet();
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    function anchor(bytes32 assetHash, uint256 licenceId, uint32 renderIndex, address creator, address licensee)
        external
    {
        if (msg.sender != escrow) revert NotEscrow();
        if (assetHash == bytes32(0)) revert ZeroHash();
        if (_receipts[assetHash].timestamp != 0) revert AlreadyAnchored(assetHash);
        _receipts[assetHash] = Receipt(licenceId, renderIndex, uint64(block.timestamp));
        ++receiptCount;
        emit ReceiptAnchored(assetHash, licenceId, creator, licensee, renderIndex, uint64(block.timestamp));
    }

    /// @return found False if this file was never anchored.
    function receiptOf(bytes32 assetHash) external view returns (bool found, Receipt memory receipt) {
        receipt = _receipts[assetHash];
        found = receipt.timestamp != 0;
    }
}
