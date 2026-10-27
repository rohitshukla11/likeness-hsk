// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @dev Tests only. The signature-transfer half of Uniswap's Permit2 (deployed on HSK Chain at
///      0x000000000022D473030F116dDEE9F6B43aC78BA3): unordered nonces in a bitmap, one bit per nonce,
///      and Permit2's EIP-712 domain, which has no version: EIP712Domain(name, chainId, verifyingContract).
contract MockPermit2 {
    using SafeERC20 for IERC20;

    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    bytes32 public constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 public constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    mapping(address owner => mapping(uint256 wordPos => uint256)) public nonceBitmap;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, address(this)));
    }

    function permitDigest(PermitTransferFrom calldata permit, address spender) public view returns (bytes32) {
        bytes32 permitted = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        return MessageHashUtils.toTypedDataHash(
            DOMAIN_SEPARATOR(),
            keccak256(abi.encode(PERMIT_TRANSFER_FROM_TYPEHASH, permitted, spender, permit.nonce, permit.deadline))
        );
    }

    /// @notice What the HSP Gateway (the spender) calls with the payer's signed permit.
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata details,
        address owner,
        bytes calldata signature
    ) external {
        require(block.timestamp <= permit.deadline, "signature expired");
        require(details.requestedAmount <= permit.permitted.amount, "invalid amount");
        uint256 wordPos = permit.nonce >> 8;
        uint256 bit = 1 << (permit.nonce & 0xff);
        require(nonceBitmap[owner][wordPos] & bit == 0, "invalid nonce");
        nonceBitmap[owner][wordPos] |= bit;
        require(SignatureChecker.isValidSignatureNow(owner, permitDigest(permit, msg.sender), signature), "bad sig");
        IERC20(permit.permitted.token).safeTransferFrom(owner, details.to, details.requestedAmount);
    }
}
