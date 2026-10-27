// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HspSettlement, IPermit2Nonces} from "../../src/HspSettlement.sol";
import {ReceiptAnchor} from "../../src/ReceiptAnchor.sol";
import {Base} from "../utils/Base.t.sol";
import {MockPermit2} from "../utils/MockPermit2.sol";

/// @dev Circle FiatTokenV2_2 (USDC.e on HSK Chain).
interface IFiatToken3009 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function decimals() external view returns (uint8);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @dev Uniswap Permit2, signature transfers.
interface IPermit2 is IPermit2Nonces {
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permitTransferFrom(
        MockPermit2.PermitTransferFrom calldata permit,
        MockPermit2.SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

/// @notice HSK Chain mainnet (chain 177), forked locally: the real USDC.e and Permit2, our contracts
///         deployed into the fork. Nothing is broadcast. Runs only when HSK_RPC_URL is set:
///         HSK_RPC_URL=https://mainnet.hsk.xyz forge test --match-path "test/fork/*"
contract HskMainnetForkTest is Base {
    IFiatToken3009 internal constant USDC_E = IFiatToken3009(0x054ed45810DbBAb8B27668922D110669c9D88D0a);
    IERC20 internal constant USDT = IERC20(0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    // Top holders on Blockscout (2026-10-27); only used to fund the test brand inside the fork.
    address internal constant USDC_E_HOLDER = 0x62cB71582F277ef581e5F282F78e482fa347Bde7;
    address internal constant USDT_HOLDER = 0x8fed6470991878e806bcb733FFB8392B5D07e95E;

    bytes32 internal constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    HspSettlement internal settlement;
    HspSettlement internal settlementUsdt;
    address internal gateway = makeAddr("hsp-gateway");
    uint256 internal brandPk;
    address internal creatorAgent = makeAddr("creator-agent");
    uint256 internal renderAgentPk;
    address internal renderAgent;

    function setUp() public override {
        string memory rpc = vm.envOr("HSK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();
        (, brandPk) = makeAddrAndKey("brand");
        (renderAgent, renderAgentPk) = makeAddrAndKey("render-agent");
        _register(creator);
        vm.startPrank(creator);
        settlement.setAgent(creatorAgent);
        settlementUsdt.setAgent(creatorAgent);
        vm.stopPrank();
        vm.startPrank(platform);
        settlement.setRenderAgent(renderAgent, true);
        settlementUsdt.setRenderAgent(renderAgent, true);
        vm.stopPrank();
    }

    function _deploySettlement() internal override returns (address) {
        settlement = new HspSettlement(
            platform, HspSettlement.Rail.Eip3009, address(USDC_E), IPermit2Nonces(address(0)), licences, receipts
        );
        // Not wired to the registries: only used to read the Permit2 rail against the real contracts.
        settlementUsdt =
            new HspSettlement(platform, HspSettlement.Rail.Permit2, address(USDT), PERMIT2, licences, receipts);
        return address(settlement);
    }

    function test_fork_chainAndTokens() public view {
        assertEq(block.chainid, 177);
        assertEq(USDC_E.decimals(), 6);
        assertEq(
            USDC_E.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("Bridged USDC"),
                    keccak256("2"),
                    uint256(177),
                    address(USDC_E)
                )
            ),
            "USDC.e EIP-712 domain the payment agent signs against"
        );
        assertEq(
            USDC_E.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertGt(address(PERMIT2).code.length, 0, "Permit2 deployed");
    }

    function test_fork_usdcE_realAuthorization_thenRecordAndAnchor() public {
        uint256 id = _license(brand, 3);
        vm.prank(USDC_E_HOLDER);
        USDC_E.transfer(brand, PRICE);

        bytes32 nonce = settlement.paymentNonce(id, 0);
        assertFalse(USDC_E.authorizationState(brand, nonce));
        vm.prank(creatorAgent);
        vm.expectRevert(abi.encodeWithSelector(HspSettlement.PaymentNotExecuted.selector, brand, nonce));
        settlement.recordPayment(id, 0, nonce, PRICE, keccak256("tx"), bytes32(0));

        // The brand signs against the real token; the Gateway executes it.
        uint256 validBefore = block.timestamp + 10 minutes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                USDC_E.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        USDC_E.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), brand, payout, PRICE, 0, validBefore, nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(brandPk, digest);
        uint256 before = USDC_E.balanceOf(payout);
        vm.prank(gateway);
        USDC_E.transferWithAuthorization(brand, payout, PRICE, 0, validBefore, nonce, v, r, s);
        assertEq(USDC_E.balanceOf(payout) - before, PRICE);
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

    function test_fork_usdt_realPermit2_nonceIsSeen() public {
        uint256 id = _license(brand, 3);
        bytes32 nonce = settlementUsdt.paymentNonce(id, 0);
        assertFalse(settlementUsdt.paymentExecuted(id, 0));

        vm.prank(USDT_HOLDER);
        USDT.transfer(brand, PRICE);
        vm.prank(brand);
        USDT.approve(address(PERMIT2), type(uint256).max);
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
        assertTrue(settlementUsdt.paymentExecuted(id, 0));
    }
}
