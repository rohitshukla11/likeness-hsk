// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {HspSettlement} from "../../src/HspSettlement.sol";
import {ReceiptAnchor} from "../../src/ReceiptAnchor.sol";
import {Base} from "../utils/Base.t.sol";
import {IUsdtLike} from "../utils/MockClassicUSDT.sol";
import {MockPermit2} from "../utils/MockPermit2.sol";
import {IPermit2} from "./HskMainnet.t.sol";

/// @notice HSK Chain testnet (chain 133), forked locally: HashKey's testnet USDT (the classic Tether
///         contract the HSP Gateway pays in) and the real Permit2, our contracts deployed into the fork.
///         Nothing is broadcast. Runs only when HSK_TESTNET_RPC_URL is set:
///         HSK_TESTNET_RPC_URL=https://testnet.hsk.xyz forge test --match-path "test/fork/*"
contract HskTestnetForkTest is Base {
    IUsdtLike internal constant USDT = IUsdtLike(0x372325443233fEbaC1F6998aC750276468c83CC6);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    // The token's owner, which holds most of the supply (Blockscout, 2026-10-29); only used to fund
    // the test brand inside the fork.
    address internal constant USDT_HOLDER = 0x22f7C193d48cCC5d870C138C9B5BB11dD17A759D;

    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    HspSettlement internal settlement;
    address internal gateway = makeAddr("hsp-gateway");
    uint256 internal brandPk;
    address internal creatorAgent = makeAddr("creator-agent");
    uint256 internal renderAgentPk;
    address internal renderAgent;

    function setUp() public override {
        string memory rpc = vm.envOr("HSK_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();
        (, brandPk) = makeAddrAndKey("brand");
        (renderAgent, renderAgentPk) = makeAddrAndKey("render-agent");
        _register(creator);
        vm.prank(creator);
        settlement.setAgent(creatorAgent);
        vm.prank(platform);
        settlement.setRenderAgent(renderAgent, true);
    }

    function _deploySettlement() internal override returns (address) {
        settlement = new HspSettlement(platform, HspSettlement.Rail.Permit2, address(USDT), PERMIT2, licences, receipts);
        return address(settlement);
    }

    function test_testnetFork_usdtIsClassicTether() public {
        assertEq(block.chainid, 133);
        assertEq(IERC20Metadata(address(USDT)).decimals(), 6);
        vm.prank(USDT_HOLDER);
        USDT.transfer(brand, PRICE);
        // No return data from approve, and a non-zero allowance can't be changed to another non-zero
        // value directly: what the agents' forceApprove handles.
        vm.startPrank(brand);
        (bool ok, bytes memory ret) =
            address(USDT).call(abi.encodeWithSignature("approve(address,uint256)", address(PERMIT2), 2));
        assertTrue(ok);
        assertEq(ret.length, 0, "approve returns no data");
        vm.expectRevert();
        USDT.approve(address(PERMIT2), 3);
        USDT.approve(address(PERMIT2), 0);
        USDT.approve(address(PERMIT2), 3);
        vm.stopPrank();
        assertEq(USDT.allowance(brand, address(PERMIT2)), 3);
    }

    function test_testnetFork_realUsdtPermit2_thenRecordAndAnchor() public {
        uint256 id = _license(brand, 3);
        vm.prank(USDT_HOLDER);
        USDT.transfer(brand, PRICE);
        vm.prank(brand);
        USDT.approve(address(PERMIT2), type(uint256).max);

        bytes32 nonce = settlement.paymentNonce(id, 0);
        assertFalse(settlement.paymentExecuted(id, 0));
        MockPermit2.PermitTransferFrom memory permit = MockPermit2.PermitTransferFrom({
            permitted: MockPermit2.TokenPermissions({token: address(USDT), amount: PRICE}),
            nonce: uint256(nonce),
            deadline: block.timestamp + 10 minutes
        });
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                PERMIT2.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        PERMIT_TRANSFER_FROM_TYPEHASH,
                        keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted)),
                        gateway,
                        permit.nonce,
                        permit.deadline
                    )
                )
            )
        );
        uint256 before = USDT.balanceOf(payout);
        vm.prank(gateway);
        PERMIT2.permitTransferFrom(
            permit,
            MockPermit2.SignatureTransferDetails({to: payout, requestedAmount: PRICE}),
            brand,
            _sign(brandPk, digest)
        );
        assertEq(USDT.balanceOf(payout) - before, PRICE);
        assertTrue(settlement.paymentExecuted(id, 0));

        vm.prank(creatorAgent);
        settlement.recordPayment(id, 0, nonce, PRICE, keccak256("tx"), bytes32(0));
        bytes32 file = keccak256("render-0.jpg");
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _sign(renderAgentPk, settlement.renderDigest(id, file, 0, deadline));
        settlement.anchorRender(id, 0, file, renderAgent, deadline, sig);
        (bool found, ReceiptAnchor.Receipt memory receipt) = receipts.receiptOf(file);
        assertTrue(found);
        assertEq(receipt.licenceId, id);
    }
}
