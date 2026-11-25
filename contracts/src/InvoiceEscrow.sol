// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title InvoiceEscrow — agent-verified invoice payments in tUSD8 on Aevum Testnet
/// @notice A payer funds an invoice into escrow. Funds are released to the named
///         payee only when the registered checking agent signs an approval bound to
///         the hash of its verification results (checksHash). The agent can approve
///         but can never redirect funds: the payee and amount are fixed at funding
///         time. Every release writes a hash-chained receipt (each receipt hash
///         commits to the previous one), giving a tamper-evident on-chain audit
///         trail. Safety controls: per-invoice spend cap, escrow expiry with a
///         refund path, payer cancel (instant revocation) before release, and
///         duplicate-invoice protection.
contract InvoiceEscrow {
    enum State {
        None,
        Funded,
        Paid,
        Refunded
    }

    struct Invoice {
        address payer;
        address payee;
        uint256 amount;
        bytes32 invoiceHash;
        bytes32 payeeNameHash;
        uint64 expiry;
        State state;
        bytes32 checksHash;
        bytes32 receiptHash;
    }

    IERC20 public immutable token;
    address public owner;
    address public agent;
    uint256 public maxAmount;

    uint256 public invoiceCount;
    uint256 public receiptCount;
    bytes32 public lastReceiptHash;

    mapping(uint256 => Invoice) public invoices;
    mapping(bytes32 => bool) public invoiceHashInFlight;
    mapping(bytes32 => bool) public invoiceHashPaid;

    event InvoiceFunded(
        uint256 indexed id, address indexed payer, address indexed payee, uint256 amount, bytes32 invoiceHash, uint64 expiry
    );
    event ReceiptIssued(
        uint256 indexed id, bytes32 receiptHash, bytes32 previousReceiptHash, address indexed payee, uint256 amount, bytes32 checksHash
    );
    event InvoiceRefunded(uint256 indexed id, address indexed payer, uint256 amount, string reason);
    event AgentUpdated(address indexed previousAgent, address indexed newAgent);
    event MaxAmountUpdated(uint256 previousMax, uint256 newMax);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address token_, address agent_, uint256 maxAmount_) {
        require(token_ != address(0) && agent_ != address(0), "zero address");
        require(maxAmount_ > 0, "cap must be positive");
        token = IERC20(token_);
        owner = msg.sender;
        agent = agent_;
        maxAmount = maxAmount_;
    }

    /// @notice Rotate or revoke the checking agent. Setting a new agent instantly
    ///         invalidates approvals signed by the old one.
    function setAgent(address newAgent) external onlyOwner {
        require(newAgent != address(0), "zero address");
        emit AgentUpdated(agent, newAgent);
        agent = newAgent;
    }

    /// @notice Adjust the per-invoice spend cap (in tUSD8 base units, 6 decimals).
    function setMaxAmount(uint256 newMax) external onlyOwner {
        require(newMax > 0, "cap must be positive");
        emit MaxAmountUpdated(maxAmount, newMax);
        maxAmount = newMax;
    }

    /// @notice Fund an invoice into escrow. The payer must have approved this
    ///         contract to spend `amount` of tUSD8 first.
    /// @param payee The only address that can ever receive these funds.
    /// @param amount tUSD8 base units (6 decimals); must be within the cap.
    /// @param invoiceHash Hash of the invoice document/metadata (kept off-chain).
    /// @param payeeNameHash keccak256 of the normalized payee name, for CoP checks.
    /// @param expiry Unix time after which the escrow can be refunded.
    function createInvoice(address payee, uint256 amount, bytes32 invoiceHash, bytes32 payeeNameHash, uint64 expiry)
        external
        returns (uint256 id)
    {
        require(payee != address(0), "zero payee");
        require(amount > 0, "zero amount");
        require(amount <= maxAmount, "over spend cap");
        require(invoiceHash != bytes32(0), "empty invoice hash");
        require(expiry > block.timestamp, "expiry in past");
        require(!invoiceHashPaid[invoiceHash], "invoice already paid");
        require(!invoiceHashInFlight[invoiceHash], "invoice already in flight");

        id = ++invoiceCount;
        invoices[id] = Invoice({
            payer: msg.sender,
            payee: payee,
            amount: amount,
            invoiceHash: invoiceHash,
            payeeNameHash: payeeNameHash,
            expiry: expiry,
            state: State.Funded,
            checksHash: bytes32(0),
            receiptHash: bytes32(0)
        });
        invoiceHashInFlight[invoiceHash] = true;

        require(token.transferFrom(msg.sender, address(this), amount), "funding transfer failed");
        emit InvoiceFunded(id, msg.sender, payee, amount, invoiceHash, expiry);
    }

    /// @notice The digest the agent signs to approve a release. Binding the chain id,
    ///         this contract, the invoice id and the checksHash means a signature
    ///         cannot be replayed on another chain, contract, invoice, or against
    ///         different check results.
    function approvalDigest(uint256 id, bytes32 checksHash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, checksHash));
    }

    /// @notice Release escrowed funds to the payee against the agent's signed
    ///         approval. Callable by anyone; the signature is the authorization.
    function approveRelease(uint256 id, bytes32 checksHash, bytes calldata signature) external {
        Invoice storage inv = invoices[id];
        require(inv.state == State.Funded, "not funded");
        require(block.timestamp < inv.expiry, "escrow expired");
        require(_recover(approvalDigest(id, checksHash), signature) == agent, "bad agent signature");

        inv.state = State.Paid;
        inv.checksHash = checksHash;
        delete invoiceHashInFlight[inv.invoiceHash];
        invoiceHashPaid[inv.invoiceHash] = true;

        bytes32 previousHash = lastReceiptHash;
        bytes32 receiptHash = keccak256(
            abi.encode(previousHash, id, inv.invoiceHash, checksHash, inv.payee, inv.amount, block.timestamp)
        );
        inv.receiptHash = receiptHash;
        lastReceiptHash = receiptHash;
        receiptCount++;

        require(token.transfer(inv.payee, inv.amount), "release transfer failed");
        emit ReceiptIssued(id, receiptHash, previousHash, inv.payee, inv.amount, checksHash);
    }

    /// @notice Payer cancels before release: full refund, instantly. This is the
    ///         revocation path if the agent's checks fail or anything looks wrong.
    function cancel(uint256 id) external {
        Invoice storage inv = invoices[id];
        require(inv.state == State.Funded, "not funded");
        require(msg.sender == inv.payer, "not payer");
        _refund(id, inv, "cancelled by payer");
    }

    /// @notice After expiry, anyone can send the funds back to the payer.
    function refundExpired(uint256 id) external {
        Invoice storage inv = invoices[id];
        require(inv.state == State.Funded, "not funded");
        require(block.timestamp >= inv.expiry, "not expired yet");
        _refund(id, inv, "escrow expired");
    }

    function _refund(uint256 id, Invoice storage inv, string memory reason) internal {
        inv.state = State.Refunded;
        delete invoiceHashInFlight[inv.invoiceHash];
        require(token.transfer(inv.payer, inv.amount), "refund transfer failed");
        emit InvoiceRefunded(id, inv.payer, inv.amount, reason);
    }

    /// @dev EIP-191 recovery over a 32-byte digest, matching ethers signMessage.
    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(prefixed, v, r, s);
    }
}
