"use strict";

// Live mode for PayReceipt on Aevum Testnet (chain 44005).
//
// This mirrors the mock flow in agent.js gate for gate, but every read and
// write goes to the deployed PayeeRegistry / InvoiceEscrow contracts via
// ethers v6, and the approval is a real Ethereum signature over the
// contract's approvalDigest (EIP-191), exactly what InvoiceEscrow verifies.
//
// It runs only when PAYRECEIPT_MODE=live and the contract addresses plus a
// faucet-funded AGENT_PRIVATE_KEY are set (see project/.env.example). It is
// not exercised by the test suite: there is no funded wallet on the build
// machine, by design — the wallet is the entrant's step.

const { runChecks, normalizeName } = require("./checks");
const { appendReceipt } = require("./receipts");

const REGISTRY_ABI = [
  "function nameToAddress(bytes32) view returns (address)",
  "function register(bytes32)",
  "function matches(bytes32,address) view returns (bool)",
];
const ESCROW_ABI = [
  "function createInvoice(address,uint256,bytes32,bytes32,uint64) returns (uint256)",
  "function approveRelease(uint256,bytes32,bytes)",
  "function cancel(uint256)",
  "function approvalDigest(uint256,bytes32) view returns (bytes32)",
  "function invoices(uint256) view returns (address payer,address payee,uint256 amount,bytes32 invoiceHash,bytes32 payeeNameHash,uint64 expiry,uint8 state,bytes32 checksHash,bytes32 receiptHash)",
  "function invoiceHashPaid(bytes32) view returns (bool)",
  "function invoiceHashInFlight(bytes32) view returns (bool)",
  "function maxAmount() view returns (uint256)",
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

function requireLiveConfig(config) {
  const missing = [];
  if (!config.registryAddress) missing.push("PAYEE_REGISTRY_ADDRESS");
  if (!config.escrowAddress) missing.push("INVOICE_ESCROW_ADDRESS");
  if (!config.agentPrivateKey) missing.push("AGENT_PRIVATE_KEY");
  if (missing.length) throw new Error("live mode missing config: " + missing.join(", "));
}

async function processLiveRequest(request, config, log) {
  requireLiveConfig(config);
  const { ethers } = require("ethers");
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`RPC is on chain ${network.chainId}, expected ${config.chainId}`);
  }
  const agentWallet = new ethers.Wallet(config.agentPrivateKey, provider);
  const registry = new ethers.Contract(config.registryAddress, REGISTRY_ABI, provider);
  const escrow = new ethers.Contract(config.escrowAddress, ESCROW_ABI, provider);
  const token = new ethers.Contract(config.tusd8Address, ERC20_ABI, provider);

  // On-chain name hash is keccak256 of the normalized name (the off-chain
  // receipt log keeps its own sha256 chain; the two are never mixed).
  const nameHash = ethers.keccak256(ethers.toUtf8Bytes(normalizeName(request.payeeName)));
  const boundAddress = await registry.nameToAddress(nameHash);
  const paid = await escrow.invoiceHashPaid(request.invoiceHash);
  const inFlight = await escrow.invoiceHashInFlight(request.invoiceHash);
  const now = Math.floor(Date.now() / 1000);

  const snapshot = {
    payeeName: request.payeeName,
    payeeAddress: request.payee,
    boundAddress: boundAddress === ethers.ZeroAddress ? null : boundAddress,
    amount: request.amount,
    cap: config.cap,
    invoiceHash: request.invoiceHash,
    invoiceSeen: paid || (inFlight && request.state !== "Funded"),
    denylist: config.denylist,
    escrowFunded: request.state === "Funded",
    expiry: request.expiry,
    now,
  };

  // Gate 1: pre-screen (escrow_ready excluded before funding, as in mock).
  const pre = runChecks(snapshot);
  const preBlockers = pre.results.filter((r) => !r.pass && r.id !== "escrow_ready");
  const at = new Date().toISOString();
  if (preBlockers.length) {
    const record = appendReceipt(log, {
      invoiceId: request.id || 0, invoiceHash: request.invoiceHash, checksHash: pre.checksHash,
      outcome: "blocked", payee: request.payee, amount: request.amount, mode: "live", at,
    });
    return { outcome: "blocked", stage: "pre-screen", failed: preBlockers.map((r) => r.id), receipt: record };
  }

  // Fund the escrow if needed (the payer wallet signs this in the desk app;
  // here the request must arrive already funded, or carry a payer signer).
  if (request.state !== "Funded") {
    throw new Error("live mode expects the invoice to be funded first (payer approves tUSD8 and calls createInvoice), then the agent runs the release gate");
  }

  // Gate 2: full checks against the funded invoice, then sign and release.
  const full = runChecks({ ...snapshot, escrowFunded: true });
  if (!full.passed) {
    const record = appendReceipt(log, {
      invoiceId: request.id, invoiceHash: request.invoiceHash, checksHash: full.checksHash,
      outcome: "blocked", payee: request.payee, amount: request.amount, mode: "live", at,
    });
    return { outcome: "blocked", stage: "release", failed: full.results.filter((r) => !r.pass).map((r) => r.id), receipt: record };
  }

  const checksHashBytes32 = "0x" + full.checksHash;
  const digest = await escrow.approvalDigest(request.id, checksHashBytes32);
  const signature = await agentWallet.signMessage(ethers.getBytes(digest));
  const escrowByAgent = escrow.connect(agentWallet);
  const tx = await escrowByAgent.approveRelease(request.id, checksHashBytes32, signature);
  const receiptTx = await tx.wait();
  const inv = await escrow.invoices(request.id);
  const record = appendReceipt(log, {
    invoiceId: request.id, invoiceHash: request.invoiceHash, checksHash: full.checksHash,
    outcome: "released", payee: request.payee, amount: request.amount, mode: "live",
    txHash: receiptTx.hash, onChainReceiptHash: inv.receiptHash, at,
  });
  return { outcome: "released", stage: "release", txHash: receiptTx.hash, onChainReceiptHash: inv.receiptHash, receipt: record };
}

module.exports = { processLiveRequest, requireLiveConfig, REGISTRY_ABI, ESCROW_ABI, ERC20_ABI };
