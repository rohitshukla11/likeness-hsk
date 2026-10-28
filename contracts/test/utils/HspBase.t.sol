// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {HspSettlement, IPermit2Nonces} from "../../src/HspSettlement.sol";
import {Base} from "./Base.t.sol";
import {MockPermit2} from "./MockPermit2.sol";
import {MockUSDC3009} from "./MockUSDC3009.sol";
import {IUsdtLike} from "./MockClassicUSDT.sol";
import {MockUSDT} from "./MockUSDT.sol";

/// @dev The HSP payment path end to end, with the HSP Gateway played by an address that executes the
///      brand's signed authorization, as the real Gateway does after verifying the Payment Mandate.
abstract contract HspBase is Base {
    MockUSDC3009 internal usdc;
    IUsdtLike internal usdt;
    MockPermit2 internal permit2;
    HspSettlement internal settlement;

    address internal gateway = makeAddr("hsp-gateway");
    uint256 internal brandPk;
    address internal creatorAgent;
    uint256 internal renderAgentPk;
    address internal renderAgent;

    function _rail() internal pure virtual returns (HspSettlement.Rail) {
        return HspSettlement.Rail.Eip3009;
    }

    /// @dev The USDT the Permit2 rail runs on; overridden to rerun the suite on a classic Tether token.
    function _newUsdt() internal virtual returns (IUsdtLike) {
        return IUsdtLike(address(new MockUSDT()));
    }

    function _deploySettlement() internal override returns (address) {
        usdc = new MockUSDC3009();
        usdt = _newUsdt();
        permit2 = new MockPermit2();
        HspSettlement.Rail rail = _rail();
        address token = rail == HspSettlement.Rail.Eip3009 ? address(usdc) : address(usdt);
        settlement = new HspSettlement(platform, rail, token, IPermit2Nonces(address(permit2)), licences, receipts);
        return address(settlement);
    }

    function setUp() public virtual override {
        super.setUp();
        (, brandPk) = makeAddrAndKey("brand"); // same address as Base's `brand`
        creatorAgent = makeAddr("creator-agent");
        (renderAgent, renderAgentPk) = makeAddrAndKey("render-agent");

        _register(creator);
        vm.prank(creator);
        settlement.setAgent(creatorAgent);
        vm.prank(platform);
        settlement.setRenderAgent(renderAgent, true);
        usdc.mint(brand, 100_000_000);
        usdt.mint(brand, 100_000_000);
        vm.prank(brand);
        usdt.approve(address(permit2), type(uint256).max); // the one-time Permit2 approval
    }

    // ---------------------------------------------------------------- the HSP payment

    /// @dev The brand's payment agent signs with the settlement nonce for this render; the Gateway
    ///      executes. `to` and `value` come from the Cart Mandate (the creator's payout, the price).
    function _pay(uint256 id, uint32 renderIndex, address to, uint256 value) internal {
        _payWithNonce(settlement.paymentNonce(id, renderIndex), to, value);
    }

    function _payWithNonce(bytes32 nonce, address to, uint256 value) internal {
        if (_rail() == HspSettlement.Rail.Eip3009) {
            uint256 validBefore = block.timestamp + 10 minutes;
            bytes32 digest = usdc.authorizationDigest(brand, to, value, 0, validBefore, nonce);
            bytes memory sig = _sign(brandPk, digest);
            vm.prank(gateway);
            usdc.transferWithAuthorization(brand, to, value, 0, validBefore, nonce, sig);
        } else {
            MockPermit2.PermitTransferFrom memory permit = MockPermit2.PermitTransferFrom({
                permitted: MockPermit2.TokenPermissions({token: address(usdt), amount: value}),
                nonce: uint256(nonce),
                deadline: block.timestamp + 10 minutes
            });
            bytes memory sig = _sign(brandPk, permit2.permitDigest(permit, gateway));
            vm.prank(gateway);
            permit2.permitTransferFrom(
                permit, MockPermit2.SignatureTransferDetails({to: to, requestedAmount: value}), brand, sig
            );
        }
    }

    /// @dev The creator's agent records with the bound nonce (the payment agent chose it).
    function _record(uint256 id, uint32 renderIndex, uint128 amount, bytes32 txHash) internal {
        // Computed here, not read from the contract, so `vm.expectRevert` applies to recordPayment.
        // test_nonce_bindsContractChainLicenceAndRender checks it matches paymentNonce.
        bytes32 nonce = keccak256(abi.encode(address(settlement), block.chainid, id, renderIndex));
        _recordWithNonce(id, renderIndex, nonce, amount, txHash);
    }

    /// @dev The creator's agent records the nonce the executed authorization actually used.
    function _recordWithNonce(uint256 id, uint32 renderIndex, bytes32 nonce, uint128 amount, bytes32 txHash) internal {
        vm.prank(creatorAgent);
        settlement.recordPayment(
            id, renderIndex, nonce, amount, txHash, keccak256(abi.encode("hsp-payment", id, renderIndex))
        );
    }

    function _payAndRecord(uint256 id) internal returns (uint32 renderIndex) {
        renderIndex = licences.licence(id).renderCount;
        _pay(id, renderIndex, payout, PRICE);
        _record(id, renderIndex, PRICE, keccak256(abi.encode("tx", id, renderIndex)));
    }

    function _renderSig(uint256 id, bytes32 assetHash, uint32 renderIndex, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(renderAgentPk, settlement.renderDigest(id, assetHash, renderIndex, deadline));
    }

    function _anchor(uint256 id, uint32 renderIndex, bytes32 assetHash) internal {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        settlement.anchorRender(
            id, renderIndex, assetHash, renderAgent, deadline, _renderSig(id, assetHash, renderIndex, deadline)
        );
    }
}
