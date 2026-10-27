// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {CreatorRegistry} from "./CreatorRegistry.sol";
import {LicenseRegistry} from "./LicenseRegistry.sol";
import {ReceiptAnchor} from "./ReceiptAnchor.sol";

/// @title LicenseEscrow
/// @notice USDC escrow per licence. The licensee deposits; each render pays the creator the licence
///         price (less a fixed platform fee) and anchors a receipt, in one transaction; whatever is
///         left is refundable once the licence is revoked, expired or used up.
/// @dev A render needs two keys. The transaction must come from the licensee's wallet, which in the
///      app is a Dynamic embedded wallet the brand has delegated to the render service (Dynamic
///      delegated access), and it must carry an EIP-712 Render signature from a platform render agent
///      attesting that this exact file was produced under this licence. Neither key alone can spend.
///      Cap, price, status and balance are enforced here, not by either key holder, and money can only
///      move to the creator's payout, the treasury (fee) or back to the licensee.
contract LicenseEscrow is Ownable2Step, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Account {
        uint128 deposited;
        uint128 paidToCreator;
        uint128 fees;
        uint128 refunded;
    }

    bytes32 public constant RENDER_TYPEHASH =
        keccak256("Render(uint256 licenceId,bytes32 assetHash,uint32 renderIndex,uint64 deadline)");
    uint16 public constant MAX_FEE_BPS = 2_000;

    IERC20 public immutable usdc;
    LicenseRegistry public immutable licences;
    CreatorRegistry public immutable creators;
    ReceiptAnchor public immutable receipts;
    uint16 public immutable feeBps;
    address public treasury;

    mapping(address agent => bool) public isRenderAgent;
    mapping(uint256 licenceId => Account) private _accounts;

    event RenderAgentSet(address indexed agent, bool allowed);
    event TreasurySet(address indexed treasury);
    event Deposited(uint256 indexed licenceId, address indexed licensee, uint256 amount);
    event RenderPaid(
        uint256 indexed licenceId,
        uint32 indexed renderIndex,
        bytes32 assetHash,
        address agent,
        address payout,
        uint256 creatorAmount,
        uint256 fee
    );
    event Refunded(uint256 indexed licenceId, address indexed licensee, uint256 amount);

    error ZeroAddress();
    error FeeTooHigh();
    error NotLicensee();
    error NotRenderAgent();
    error BadRenderSignature();
    error RenderExpired();
    error ZeroAmount();
    error InsufficientEscrow(uint256 balance, uint256 price);
    error NotRefundable(LicenseRegistry.Status status);

    constructor(
        address owner_,
        IERC20 usdc_,
        LicenseRegistry licences_,
        ReceiptAnchor receipts_,
        address treasury_,
        uint16 feeBps_
    ) Ownable(owner_) EIP712("Likeness LicenseEscrow", "1") {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        usdc = usdc_;
        licences = licences_;
        creators = licences_.creators();
        receipts = receipts_;
        feeBps = feeBps_;
        _setTreasury(treasury_);
    }

    // ---------------------------------------------------------------- platform

    function setRenderAgent(address agent, bool allowed) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        isRenderAgent[agent] = allowed;
        emit RenderAgentSet(agent, allowed);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    // ---------------------------------------------------------------- licensee

    /// @notice Fund an active licence. Needs a prior USDC approval to this contract.
    function deposit(uint256 licenceId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        LicenseRegistry.Licence memory l = licences.licence(licenceId);
        if (msg.sender != l.licensee) revert NotLicensee();
        LicenseRegistry.Status s = licences.status(licenceId);
        if (s != LicenseRegistry.Status.Active) revert LicenseRegistry.NotActive(s);
        _accounts[licenceId].deposited += SafeCast.toUint128(amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(licenceId, msg.sender, amount);
    }

    /// @notice Pay for one render and anchor its receipt.
    /// @param assetHash sha256 of the delivered file, C2PA manifest included.
    /// @param agent The render agent that signed `agentSig`.
    function payRender(uint256 licenceId, bytes32 assetHash, address agent, uint64 deadline, bytes calldata agentSig)
        external
        nonReentrant
        returns (uint32 renderIndex)
    {
        LicenseRegistry.Licence memory l = licences.licence(licenceId);
        if (msg.sender != l.licensee) revert NotLicensee();
        _checkRenderSignature(licenceId, assetHash, l.renderCount, agent, deadline, agentSig);

        // Reverts unless the licence is Active (not revoked, expired or exhausted).
        renderIndex = licences.recordRender(licenceId);
        receipts.anchor(assetHash, licenceId, renderIndex, l.creator, l.licensee);
        (address payout, uint256 creatorAmount, uint256 fee) = _pay(licenceId, l.creator, l.pricePerRender);
        emit RenderPaid(licenceId, renderIndex, assetHash, agent, payout, creatorAmount, fee);
    }

    /// @notice Return unused escrow to the licensee once no more renders are possible. Anyone may
    ///         call it; the funds can only go to the licensee.
    function refund(uint256 licenceId) external nonReentrant returns (uint256 amount) {
        LicenseRegistry.Status s = licences.status(licenceId);
        if (s == LicenseRegistry.Status.Unknown || s == LicenseRegistry.Status.Active) revert NotRefundable(s);
        Account storage a = _accounts[licenceId];
        amount = _balance(a);
        if (amount == 0) revert ZeroAmount();
        a.refunded += uint128(amount);
        address licensee = licences.licence(licenceId).licensee;
        usdc.safeTransfer(licensee, amount);
        emit Refunded(licenceId, licensee, amount);
    }

    // ---------------------------------------------------------------- reads

    function balanceOf(uint256 licenceId) external view returns (uint256) {
        return _balance(_accounts[licenceId]);
    }

    function account(uint256 licenceId) external view returns (Account memory) {
        return _accounts[licenceId];
    }

    function renderDigest(uint256 licenceId, bytes32 assetHash, uint32 renderIndex, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(RENDER_TYPEHASH, licenceId, assetHash, renderIndex, deadline)));
    }

    // ---------------------------------------------------------------- internals

    function _checkRenderSignature(
        uint256 licenceId,
        bytes32 assetHash,
        uint32 renderIndex,
        address agent,
        uint64 deadline,
        bytes calldata sig
    ) private view {
        if (!isRenderAgent[agent]) revert NotRenderAgent();
        if (block.timestamp > deadline) revert RenderExpired();
        bytes32 digest = renderDigest(licenceId, assetHash, renderIndex, deadline);
        if (!SignatureChecker.isValidSignatureNow(agent, digest, sig)) revert BadRenderSignature();
    }

    function _pay(uint256 licenceId, address creator, uint256 price)
        private
        returns (address payout, uint256 creatorAmount, uint256 fee)
    {
        Account storage a = _accounts[licenceId];
        uint256 balance = _balance(a);
        if (balance < price) revert InsufficientEscrow(balance, price);
        fee = price * feeBps / 10_000;
        creatorAmount = price - fee;
        a.paidToCreator += uint128(creatorAmount);
        a.fees += uint128(fee);
        payout = creators.payoutOf(creator);
        usdc.safeTransfer(payout, creatorAmount);
        if (fee != 0) usdc.safeTransfer(treasury, fee);
    }

    function _balance(Account storage a) private view returns (uint256) {
        return uint256(a.deposited) - a.paidToCreator - a.fees - a.refunded;
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }
}
