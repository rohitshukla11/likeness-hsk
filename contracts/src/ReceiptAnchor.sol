// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ReceiptAnchor
/// @notice One receipt per licensed render, keyed by the hash of the delivered file (with its C2PA
///         manifest embedded). Anyone can look a file up by hash; only HspSettlement writes, and only
///         for a render whose HSP payment to the creator is recorded, so a receipt cannot exist without one.
contract ReceiptAnchor is Ownable2Step {
    struct Receipt {
        uint256 licenceId;
        uint32 renderIndex;
        uint64 timestamp;
    }

    address public settlement;
    uint256 public receiptCount;
    mapping(bytes32 assetHash => Receipt) private _receipts;

    event SettlementSet(address indexed settlement);
    event ReceiptAnchored(
        bytes32 indexed assetHash,
        uint256 indexed licenceId,
        address indexed creator,
        address licensee,
        uint32 renderIndex,
        uint64 timestamp
    );

    error NotSettlement();
    error SettlementAlreadySet();
    error ZeroAddress();
    error ZeroHash();
    error AlreadyAnchored(bytes32 assetHash);

    constructor(address owner_) Ownable(owner_) {}

    function setSettlement(address settlement_) external onlyOwner {
        if (settlement != address(0)) revert SettlementAlreadySet();
        if (settlement_ == address(0)) revert ZeroAddress();
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    function anchor(bytes32 assetHash, uint256 licenceId, uint32 renderIndex, address creator, address licensee)
        external
    {
        if (msg.sender != settlement) revert NotSettlement();
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
