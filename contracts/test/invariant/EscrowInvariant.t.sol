// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Base} from "../utils/Base.t.sol";
import {LicenseRegistry} from "../../src/LicenseRegistry.sol";
import {LicenseEscrow} from "../../src/LicenseEscrow.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";

/// @dev Drives random deposits, renders, revocations, time jumps and refunds across several brands
///      and licences, keeping its own ledger of every transfer it causes.
contract EscrowHandler is Test {
    MockUSDC internal immutable usdc;
    LicenseRegistry internal immutable licences;
    LicenseEscrow internal immutable escrow;
    address internal immutable creator;
    address internal immutable agent;
    uint256 internal immutable agentPk;

    address[3] internal brands = [makeAddr("brandA"), makeAddr("brandB"), makeAddr("brandC")];
    uint256[] public ids;

    // Ghost ledger, written only by this handler.
    mapping(uint256 => uint256) public ghostDeposited;
    mapping(uint256 => uint256) public ghostPaid; // creator + fee
    mapping(uint256 => uint256) public ghostRefunded;
    uint256 public ghostDepositedTotal;
    uint256 public ghostPaidTotal;
    uint256 public ghostRefundedTotal;
    uint256 public renders;

    constructor(
        MockUSDC usdc_,
        LicenseRegistry licences_,
        LicenseEscrow escrow_,
        address creator_,
        address agent_,
        uint256 agentPk_
    ) {
        usdc = usdc_;
        licences = licences_;
        escrow = escrow_;
        creator = creator_;
        agent = agent_;
        agentPk = agentPk_;
    }

    function brand(uint256 i) external view returns (address) {
        return brands[i];
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function license(uint256 brandSeed, uint32 cap, uint64 duration) external {
        address brand = brands[brandSeed % 3];
        LicenseRegistry.Request memory r = LicenseRegistry.Request({
            creator: creator,
            category: 1 << 8,
            regions: 1,
            duration: uint64(bound(duration, 1 hours, 30 days)),
            renderCap: uint32(bound(cap, 1, 50)),
            pricePerRender: 2_000_000,
            purposeHash: bytes32(0),
            deadline: uint64(block.timestamp + 1 hours),
            salt: bytes32(0)
        });
        vm.prank(brand);
        ids.push(licences.request(r, ""));
    }

    function deposit(uint256 seed, uint256 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        if (licences.status(id) != LicenseRegistry.Status.Active) return;
        address brand = licences.licence(id).licensee;
        amount = bound(amount, 1, 100e6);
        usdc.mint(brand, amount);
        vm.startPrank(brand);
        usdc.approve(address(escrow), amount);
        escrow.deposit(id, amount);
        vm.stopPrank();
        ghostDeposited[id] += amount;
        ghostDepositedTotal += amount;
    }

    function render(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        LicenseRegistry.Licence memory l = licences.licence(id);
        if (licences.status(id) != LicenseRegistry.Status.Active) return;
        if (escrow.balanceOf(id) < l.pricePerRender) return;
        bytes32 asset = keccak256(abi.encode(id, l.renderCount));
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, escrow.renderDigest(id, asset, l.renderCount, deadline));
        vm.prank(l.licensee);
        escrow.payRender(id, asset, agent, deadline, abi.encodePacked(r, s, v));
        ghostPaid[id] += l.pricePerRender;
        ghostPaidTotal += l.pricePerRender;
        ++renders;
    }

    function revoke(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        if (licences.status(id) != LicenseRegistry.Status.Active) return;
        vm.prank(creator);
        licences.revoke(id);
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 1, 10 days));
    }

    function refund(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        LicenseRegistry.Status s = licences.status(id);
        if (s == LicenseRegistry.Status.Active || escrow.balanceOf(id) == 0) return;
        uint256 amount = escrow.refund(id);
        ghostRefunded[id] += amount;
        ghostRefundedTotal += amount;
    }
}

contract EscrowInvariantTest is Base {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        _register(creator);
        handler = new EscrowHandler(usdc, licences, escrow, creator, agent, agentPk);
        targetContract(address(handler));
    }

    /// @notice Conservation, globally: every USDC that entered the escrow is either still in it, was
    ///         paid out for a render, or was refunded. Nothing is created or lost.
    function invariant_conservation_global() public view {
        assertEq(
            handler.ghostDepositedTotal(),
            usdc.balanceOf(address(escrow)) + handler.ghostPaidTotal() + handler.ghostRefundedTotal()
        );
        assertEq(usdc.balanceOf(payout) + usdc.balanceOf(treasury), handler.ghostPaidTotal());
    }

    /// @notice Conservation, per licence, and the contract's own books agree with the ghost ledger.
    function invariant_conservation_perLicence() public view {
        uint256 sum;
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            LicenseEscrow.Account memory a = escrow.account(id);
            assertEq(a.deposited, handler.ghostDeposited(id));
            assertEq(uint256(a.paidToCreator) + a.fees, handler.ghostPaid(id));
            assertEq(a.refunded, handler.ghostRefunded(id));
            assertEq(escrow.balanceOf(id), a.deposited - a.paidToCreator - a.fees - a.refunded);
            sum += escrow.balanceOf(id);
        }
        assertEq(sum, usdc.balanceOf(address(escrow)));
    }

    /// @notice No licence ever records more renders than its cap, or more than it paid for.
    function invariant_rendersWithinCapAndPaid() public view {
        uint256 total;
        for (uint256 i; i < handler.idCount(); ++i) {
            uint256 id = handler.ids(i);
            LicenseRegistry.Licence memory l = licences.licence(id);
            assertLe(l.renderCount, l.renderCap);
            assertEq(uint256(l.renderCount) * l.pricePerRender, handler.ghostPaid(id));
            total += l.renderCount;
        }
        assertEq(total, handler.renders());
        assertEq(receipts.receiptCount(), handler.renders());
    }

    /// @notice Revoked or expired licences hold nothing once refunded, and refunds only reach licensees.
    function invariant_refundsOnlyToLicensees() public view {
        assertEq(
            usdc.balanceOf(handler.brand(0)) + usdc.balanceOf(handler.brand(1)) + usdc.balanceOf(handler.brand(2)),
            handler.ghostRefundedTotal()
        );
    }
}
