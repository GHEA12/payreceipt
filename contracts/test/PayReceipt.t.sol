// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoiceEscrow} from "../src/InvoiceEscrow.sol";
import {MockTUSD8} from "../src/MockTUSD8.sol";

/// @dev Minimal cheatcode interface so the suite needs no external dependencies.
interface Vm {
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// @notice Dependency-free Foundry tests: plain contracts, require-based asserts.
///         A revert inside a test* function fails the test; expectRevert-style
///         checks use try/catch through the `attempt` helpers below.
contract PayReceiptTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 internal constant AGENT_KEY = 0xA6E17;
    uint256 internal constant AGENT2_KEY = 0xB0B2;
    uint256 internal constant CAP = 1_000_000_000; // 1,000 tUSD8 (6 decimals)

    MockTUSD8 internal token;
    PayeeRegistry internal registry;
    InvoiceEscrow internal escrow;

    address internal payer;
    address internal payee;
    address internal stranger;

    function setUp() public {
        token = new MockTUSD8();
        registry = new PayeeRegistry();
        payer = vm.addr(0x1001);
        payee = vm.addr(0x1002);
        stranger = vm.addr(0x1003);
        escrow = new InvoiceEscrow(address(token), vm.addr(AGENT_KEY), CAP);
        token.mint(payer, 10_000_000_000);
    }

    // ---------- helpers ----------

    function _nameHash(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    function _fund(uint256 amount, bytes32 invoiceHash, bytes32 nameHash, uint64 expiry) internal returns (uint256 id) {
        vm.prank(payer);
        token.approve(address(escrow), amount);
        vm.prank(payer);
        id = escrow.createInvoice(payee, amount, invoiceHash, nameHash, expiry);
    }

    function _sign(uint256 key, uint256 id, bytes32 checksHash) internal returns (bytes memory) {
        bytes32 digest = escrow.approvalDigest(id, checksHash);
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, prefixed);
        return abi.encodePacked(r, s, v);
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    // ---------- PayeeRegistry ----------

    function testRegistryBindAndMatch() public {
        bytes32 nh = _nameHash("acme studio");
        vm.prank(payee);
        registry.register(nh);
        require(registry.matches(nh, payee), "CoP match should hold");
        require(!registry.matches(nh, payer), "CoP must not match another address");
        require(!registry.matches(_nameHash("other name"), payee), "unknown name must not match");
    }

    function testRegistryNameCannotBeStolen() public {
        bytes32 nh = _nameHash("acme studio");
        vm.prank(payee);
        registry.register(nh);
        vm.prank(stranger);
        try registry.register(nh) {
            revert("stealing a bound name should revert");
        } catch {}
        require(registry.matches(nh, payee), "binding must stay with the owner");
    }

    function testRegistryRevokeClearsBinding() public {
        bytes32 nh = _nameHash("acme studio");
        vm.prank(payee);
        registry.register(nh);
        vm.prank(payee);
        registry.revoke();
        require(!registry.matches(nh, payee), "revoked binding must not match");
    }

    // ---------- InvoiceEscrow happy path ----------

    function testFundAndReleasePaysPayeeAndWritesReceipt() public {
        bytes32 ih = keccak256("invoice-001");
        uint256 amount = 250_000_000; // 250 tUSD8
        uint256 id = _fund(amount, ih, _nameHash("acme studio"), _expiry());
        require(token.balanceOf(address(escrow)) == amount, "escrow should hold the funds");

        bytes32 checksHash = keccak256("all-checks-passed");
        escrow.approveRelease(id, checksHash, _sign(AGENT_KEY, id, checksHash));

        require(token.balanceOf(payee) == amount, "payee should receive the full amount");
        require(token.balanceOf(address(escrow)) == 0, "escrow should be empty after release");
        require(escrow.receiptCount() == 1, "one receipt expected");
        (,,,,,, InvoiceEscrow.State state, bytes32 storedChecks, bytes32 receiptHash) = escrow.invoices(id);
        require(state == InvoiceEscrow.State.Paid, "invoice should be Paid");
        require(storedChecks == checksHash, "checksHash must be stored on the invoice");
        require(receiptHash != bytes32(0), "receipt hash must be written");
        require(escrow.lastReceiptHash() == receiptHash, "chain head must be the new receipt");
    }

    function testReceiptChainLinksSecondReceiptToFirst() public {
        bytes32 checksHash = keccak256("ok");
        uint256 id1 = _fund(100_000_000, keccak256("inv-a"), _nameHash("acme studio"), _expiry());
        escrow.approveRelease(id1, checksHash, _sign(AGENT_KEY, id1, checksHash));
        (,,,,,,,, bytes32 receipt1) = escrow.invoices(id1);

        uint256 id2 = _fund(50_000_000, keccak256("inv-b"), _nameHash("acme studio"), _expiry());
        escrow.approveRelease(id2, checksHash, _sign(AGENT_KEY, id2, checksHash));
        (,,,,,,,, bytes32 receipt2) = escrow.invoices(id2);

        bytes32 expected2 = keccak256(abi.encode(receipt1, id2, keccak256("inv-b"), checksHash, payee, uint256(50_000_000), block.timestamp));
        require(receipt2 == expected2, "second receipt must chain onto the first");
        require(escrow.receiptCount() == 2, "two receipts expected");
    }

    // ---------- guards ----------

    function testReleaseRejectsWrongSigner() public {
        uint256 id = _fund(10_000_000, keccak256("inv-x"), _nameHash("acme studio"), _expiry());
        bytes32 checksHash = keccak256("ok");
        try escrow.approveRelease(id, checksHash, _sign(AGENT2_KEY, id, checksHash)) {
            revert("release by a non-agent signer should revert");
        } catch {}
        require(token.balanceOf(payee) == 0, "nothing may be paid out");
    }

    function testReleaseRejectsDifferentChecksHash() public {
        uint256 id = _fund(10_000_000, keccak256("inv-y"), _nameHash("acme studio"), _expiry());
        bytes memory sig = _sign(AGENT_KEY, id, keccak256("checks-A"));
        try escrow.approveRelease(id, keccak256("checks-B"), sig) {
            revert("signature must be bound to the exact checksHash");
        } catch {}
    }

    function testDuplicateInvoiceBlockedInFlightAndAfterPayment() public {
        bytes32 ih = keccak256("invoice-dup");
        uint256 id = _fund(10_000_000, ih, _nameHash("acme studio"), _expiry());

        vm.prank(payer);
        token.approve(address(escrow), 10_000_000);
        vm.prank(payer);
        try escrow.createInvoice(payee, 10_000_000, ih, _nameHash("acme studio"), _expiry()) {
            revert("same invoice in flight should revert");
        } catch {}

        bytes32 checksHash = keccak256("ok");
        escrow.approveRelease(id, checksHash, _sign(AGENT_KEY, id, checksHash));

        vm.prank(payer);
        token.approve(address(escrow), 10_000_000);
        vm.prank(payer);
        try escrow.createInvoice(payee, 10_000_000, ih, _nameHash("acme studio"), _expiry()) {
            revert("paying the same invoice twice should revert");
        } catch {}
    }

    function testOverCapReverts() public {
        vm.prank(payer);
        token.approve(address(escrow), CAP + 1);
        vm.prank(payer);
        try escrow.createInvoice(payee, CAP + 1, keccak256("inv-big"), _nameHash("acme studio"), _expiry()) {
            revert("amount over the spend cap should revert");
        } catch {}
    }

    function testCancelRefundsInFullAndFreesInvoice() public {
        uint256 before = token.balanceOf(payer);
        bytes32 ih = keccak256("invoice-cancel");
        uint256 id = _fund(75_000_000, ih, _nameHash("acme studio"), _expiry());
        require(token.balanceOf(payer) == before - 75_000_000, "funding should debit the payer");

        vm.prank(stranger);
        try escrow.cancel(id) {
            revert("only the payer can cancel");
        } catch {}

        vm.prank(payer);
        escrow.cancel(id);
        require(token.balanceOf(payer) == before, "cancel must refund in full");

        // A cancelled attempt does not burn the invoice: it can be funded again.
        uint256 id2 = _fund(75_000_000, ih, _nameHash("acme studio"), _expiry());
        require(id2 != id, "re-funded invoice gets a fresh id");
    }

    function testExpiredEscrowRefundsAndBlocksRelease() public {
        uint256 before = token.balanceOf(payer);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 id = _fund(20_000_000, keccak256("inv-exp"), _nameHash("acme studio"), expiry);

        vm.warp(block.timestamp + 2 hours);
        bytes32 checksHash = keccak256("ok");
        try escrow.approveRelease(id, checksHash, _sign(AGENT_KEY, id, checksHash)) {
            revert("release after expiry should revert");
        } catch {}

        escrow.refundExpired(id);
        require(token.balanceOf(payer) == before, "expired escrow must refund the payer");
    }

    function testAgentRotationInvalidatesOldKey() public {
        uint256 id = _fund(10_000_000, keccak256("inv-rot"), _nameHash("acme studio"), _expiry());
        escrow.setAgent(vm.addr(AGENT2_KEY));
        bytes32 checksHash = keccak256("ok");
        try escrow.approveRelease(id, checksHash, _sign(AGENT_KEY, id, checksHash)) {
            revert("old agent signature must stop working after rotation");
        } catch {}
        escrow.approveRelease(id, checksHash, _sign(AGENT2_KEY, id, checksHash));
        require(token.balanceOf(payee) == 10_000_000, "new agent approval should release");
    }
}
