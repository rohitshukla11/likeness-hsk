// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {CreatorRegistry} from "./CreatorRegistry.sol";
import {LicenseRegistry} from "./LicenseRegistry.sol";
import {ReceiptAnchor} from "./ReceiptAnchor.sol";

/// @notice EIP-3009 (USDC.e on HSK Chain): whether an authorization nonce has been used.
interface IERC3009Nonces {
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @notice Permit2 signature transfers: one bit per used nonce. https://github.com/Uniswap/permit2
interface IPermit2Nonces {
    function nonceBitmap(address owner, uint256 wordPos) external view returns (uint256);
}

/// @title HspSettlement
/// @notice Records per-render payments made through the HSP Gateway and anchors the render receipts.
///         HSP moves the money: the brand's payment agent signs a stablecoin authorization (EIP-3009
///         for USDC.e, Permit2 for USDT) inside an AP2 Payment Mandate, and the Gateway executes it,
///         paying the creator's payout directly. Nothing is held here and nothing is refunded: a render
///         is paid for one at a time, and a revoked, expired or used-up licence stops the next one.
/// @dev A render is recorded only if the licensee's stablecoin authorization has executed on chain,
///      read from the token's own nonce registry, and each authorization counts once.
///      - Bound nonce (preferred): when the payment agent may choose the nonce, it uses
///        `paymentNonce(licenceId, renderIndex)`, so the chain itself shows that the payment for
///        exactly this render executed. Recorded with `nonceBound = true`.
///      - Gateway nonce: if the HSP Gateway picks the nonce, the creator's agent records the nonce
///        the executed authorization actually used. The chain still shows that the licensee's
///        authorization with that nonce executed and that it is counted only once; which licence and
///        render it paid for is the creator agent's attestation. Recorded with `nonceBound = false`.
///      In both cases the amount and recipient are attested by the creator's agent, the only party
///      that may record a payment for the creator: it receives the HSP webhook, reads the transfer
///      from the transaction, and passes the transaction hash, stored with the payment for anyone to
///      audit. The brand cannot underpay (the creator's agent checks what it received); the
///      creator's agent can only act for its own creator.
contract HspSettlement is Ownable2Step, EIP712 {
    enum Rail {
        Eip3009, // USDC.e: TransferWithAuthorization, nonces in authorizationState
        Permit2 // USDT and others: PermitTransferFrom, nonces in Permit2's nonceBitmap
    }

    struct Payment {
        address payer;
        uint64 recordedAt;
        uint128 amount;
        bool nonceBound; // the nonce was paymentNonce(licenceId, renderIndex)
        bytes32 nonce; // the authorization nonce that executed
        bytes32 hspTxHash; // the on-chain transaction the HSP Gateway broadcast
        bytes32 hspPaymentRef; // keccak256 of HSP's payment_request_id (the AP2 Payment Mandate id)
        bytes32 assetHash; // sha256 of the delivered file, once anchored
    }

    bytes32 public constant RENDER_TYPEHASH =
        keccak256("Render(uint256 licenceId,bytes32 assetHash,uint32 renderIndex,uint64 deadline)");

    Rail public immutable rail;
    address public immutable token;
    IPermit2Nonces public immutable permit2;
    LicenseRegistry public immutable licences;
    CreatorRegistry public immutable creators;
    ReceiptAnchor public immutable receipts;

    mapping(address creator => address agent) public agentOf;
    mapping(address agent => bool) public isRenderAgent;
    mapping(bytes32 hspTxHash => bool) public txUsed;
    mapping(address payer => mapping(bytes32 nonce => bool)) public nonceRecorded;
    mapping(uint256 licenceId => mapping(uint32 renderIndex => Payment)) private _payments;

    event AgentSet(address indexed creator, address indexed agent);
    event RenderAgentSet(address indexed agent, bool allowed);
    event PaymentRecorded(
        uint256 indexed licenceId,
        uint32 indexed renderIndex,
        address indexed payer,
        address payout,
        uint128 amount,
        bytes32 nonce,
        bool nonceBound,
        bytes32 hspTxHash,
        bytes32 hspPaymentRef
    );
    event RenderAnchored(uint256 indexed licenceId, uint32 indexed renderIndex, bytes32 assetHash, address agent);

    error ZeroAddress();
    error NotRegistered();
    error NotCreatorAgent();
    error WrongRenderIndex(uint32 expected, uint32 given);
    error WrongAmount(uint128 expected, uint128 given);
    error ZeroTxHash();
    error TxAlreadyUsed(bytes32 hspTxHash);
    error PaymentNotExecuted(address payer, bytes32 nonce);
    error NonceAlreadyRecorded(address payer, bytes32 nonce);
    error NotPaid(uint256 licenceId, uint32 renderIndex);
    error AlreadyAnchored(uint256 licenceId, uint32 renderIndex);
    error NotRenderAgent();
    error RenderExpired();
    error BadRenderSignature();

    constructor(
        address owner_,
        Rail rail_,
        address token_,
        IPermit2Nonces permit2_,
        LicenseRegistry licences_,
        ReceiptAnchor receipts_
    ) Ownable(owner_) EIP712("Likeness HspSettlement", "1") {
        if (token_ == address(0)) revert ZeroAddress();
        if (rail_ == Rail.Permit2 && address(permit2_) == address(0)) revert ZeroAddress();
        rail = rail_;
        token = token_;
        permit2 = permit2_;
        licences = licences_;
        creators = licences_.creators();
        receipts = receipts_;
    }

    // ---------------------------------------------------------------- creator and platform

    /// @notice A registered creator names the agent that may record HSP payments for them (their
    ///         receiving agent, which is also their HSP merchant). Zero removes it.
    function setAgent(address agent) external {
        if (!creators.isRegistered(msg.sender)) revert NotRegistered();
        agentOf[msg.sender] = agent;
        emit AgentSet(msg.sender, agent);
    }

    function setRenderAgent(address agent, bool allowed) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        isRenderAgent[agent] = allowed;
        emit RenderAgentSet(agent, allowed);
    }

    // ---------------------------------------------------------------- payments

    /// @notice Record the HSP payment for the next render of a licence. Called by the creator's agent
    ///         after the Gateway reports the payment and the agent has checked the transfer.
    /// @param renderIndex Must be the licence's next render (its current render count).
    /// @param nonce The nonce of the licensee's executed authorization: `paymentNonce(licenceId,
    ///        renderIndex)` when the payment agent chose it, otherwise the one the Gateway used.
    /// @param amount What the creator's payout received; must equal the licence price.
    function recordPayment(
        uint256 licenceId,
        uint32 renderIndex,
        bytes32 nonce,
        uint128 amount,
        bytes32 hspTxHash,
        bytes32 hspPaymentRef
    ) external {
        LicenseRegistry.Licence memory l = licences.licence(licenceId);
        address agent = agentOf[l.creator];
        if (agent == address(0) || msg.sender != agent) revert NotCreatorAgent();
        if (renderIndex != l.renderCount) revert WrongRenderIndex(l.renderCount, renderIndex);
        if (amount != l.pricePerRender) revert WrongAmount(l.pricePerRender, amount);
        if (hspTxHash == bytes32(0)) revert ZeroTxHash();
        if (txUsed[hspTxHash]) revert TxAlreadyUsed(hspTxHash);

        if (nonceRecorded[l.licensee][nonce]) revert NonceAlreadyRecorded(l.licensee, nonce);
        if (!_nonceUsed(l.licensee, nonce)) revert PaymentNotExecuted(l.licensee, nonce);
        bool bound = nonce == paymentNonce(licenceId, renderIndex);

        // Reverts unless the licence is Active (not revoked, expired or used up).
        licences.recordRender(licenceId);
        txUsed[hspTxHash] = true;
        nonceRecorded[l.licensee][nonce] = true;
        _payments[licenceId][renderIndex] = Payment({
            payer: l.licensee,
            recordedAt: uint64(block.timestamp),
            amount: amount,
            nonceBound: bound,
            nonce: nonce,
            hspTxHash: hspTxHash,
            hspPaymentRef: hspPaymentRef,
            assetHash: bytes32(0)
        });
        emit PaymentRecorded(
            licenceId,
            renderIndex,
            l.licensee,
            creators.payoutOf(l.creator),
            amount,
            nonce,
            bound,
            hspTxHash,
            hspPaymentRef
        );
    }

    /// @notice Anchor the receipt of a paid render. Anyone may submit it; it needs a platform render
    ///         agent's EIP-712 signature that this exact file was produced for this render. A render
    ///         paid before the licence was revoked can still be delivered.
    function anchorRender(
        uint256 licenceId,
        uint32 renderIndex,
        bytes32 assetHash,
        address agent,
        uint64 deadline,
        bytes calldata agentSig
    ) external {
        Payment storage p = _payments[licenceId][renderIndex];
        if (p.recordedAt == 0) revert NotPaid(licenceId, renderIndex);
        if (p.assetHash != bytes32(0)) revert AlreadyAnchored(licenceId, renderIndex);
        if (!isRenderAgent[agent]) revert NotRenderAgent();
        if (block.timestamp > deadline) revert RenderExpired();
        bytes32 digest = renderDigest(licenceId, assetHash, renderIndex, deadline);
        if (!SignatureChecker.isValidSignatureNow(agent, digest, agentSig)) revert BadRenderSignature();

        p.assetHash = assetHash;
        LicenseRegistry.Licence memory l = licences.licence(licenceId);
        receipts.anchor(assetHash, licenceId, renderIndex, l.creator, l.licensee);
        emit RenderAnchored(licenceId, renderIndex, assetHash, agent);
    }

    // ---------------------------------------------------------------- reads

    /// @notice The nonce the payment agent must put in its stablecoin authorization for this render.
    ///         It binds the payment to this settlement contract, chain, licence and render.
    function paymentNonce(uint256 licenceId, uint32 renderIndex) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, licenceId, renderIndex));
    }

    /// @notice Whether the licensee's authorization with this render's bound nonce has executed.
    function paymentExecuted(uint256 licenceId, uint32 renderIndex) external view returns (bool) {
        return _nonceUsed(licences.licence(licenceId).licensee, paymentNonce(licenceId, renderIndex));
    }

    function payment(uint256 licenceId, uint32 renderIndex) external view returns (Payment memory) {
        return _payments[licenceId][renderIndex];
    }

    function renderDigest(uint256 licenceId, bytes32 assetHash, uint32 renderIndex, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(RENDER_TYPEHASH, licenceId, assetHash, renderIndex, deadline)));
    }

    // ---------------------------------------------------------------- internals

    function _nonceUsed(address payer, bytes32 nonce) private view returns (bool) {
        if (rail == Rail.Eip3009) return IERC3009Nonces(token).authorizationState(payer, nonce);
        uint256 n = uint256(nonce);
        return (permit2.nonceBitmap(payer, n >> 8) >> (n & 0xff)) & 1 == 1;
    }
}
