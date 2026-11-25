"use strict";

// PayReceipt agent orchestrator. A payment request goes through two gates:
//
// 1. Pre-screen (before funding): the four checks that do not need escrow
//    (Confirmation of Payee, spend cap, duplicate invoice, denylist). A
//    failure here blocks the request before any money moves.
// 2. Release gate (after the payer funds escrow): all five checks re-run
//    against the funded invoice; only a full pass earns the agent's signed
//    approval, and the escrow releases to the named payee.
//
// Every outcome — released or blocked — is appended to the hash-chained
// receipt log. A blocked payment is a first-class, receipted outcome.

const { runChecks, nameHash } = require("./checks");
const { appendReceipt } = require("./receipts");

function buildSnapshot(chain, invoice, config, now) {
  return {
    payeeName: invoice.payeeName,
    payeeAddress: invoice.payee,
    boundAddress: chain.boundAddress(nameHash(invoice.payeeName)),
    amount: invoice.amount,
    cap: config.cap,
    invoiceHash: invoice.invoiceHash,
    invoiceSeen: chain.invoiceSeenByOther(invoice.invoiceHash, invoice.id || 0),
    denylist: config.denylist || [],
    escrowFunded: invoice.state === "Funded",
    expiry: invoice.expiry,
    now,
  };
}

// Mock approval: a labelled stand-in signature. In live mode the agent signs
// the contract's approvalDigest with its Ethereum key (see live.js); the
// mock chain checks the same fields (agent identity + checksHash + passed).
function mockSign(config, invoiceId, checksHash) {
  const { sha256Hex } = require("./checks");
  return "mock-sig:" + sha256Hex(`${config.agentId}|${invoiceId}|${checksHash}`).slice(0, 32);
}

function processRequest(chain, request, config, log, now) {
  const at = new Date(now * 1000).toISOString();

  // Gate 1: pre-screen. escrow_ready is expected to "fail" before funding
  // (detail: not funded), so it is excluded from the blocking set here.
  const pre = runChecks(buildSnapshot(chain, request, config, now));
  const preBlockers = pre.results.filter((r) => !r.pass && r.id !== "escrow_ready");
  if (preBlockers.length) {
    const record = appendReceipt(log, {
      invoiceId: request.id || 0, invoiceHash: request.invoiceHash, checksHash: pre.checksHash,
      outcome: "blocked", payee: request.payee, amount: request.amount,
      mode: config.mode || "mock", at,
    });
    return { outcome: "blocked", stage: "pre-screen", failed: preBlockers.map((r) => r.id), results: pre.results, checksHash: pre.checksHash, receipt: record };
  }

  // Fund the escrow if the payer has not already.
  let invoice = request;
  if (request.state !== "Funded") {
    const id = chain.createInvoice({
      payer: request.payer, payee: request.payee, amount: request.amount,
      invoiceHash: request.invoiceHash, payeeNameHash: nameHash(request.payeeName), expiry: request.expiry,
    });
    invoice = { ...chain.getInvoice(id), payeeName: request.payeeName };
  }

  // Gate 2: full five checks against the funded invoice.
  const full = runChecks(buildSnapshot(chain, invoice, config, now));
  if (!full.passed) {
    const record = appendReceipt(log, {
      invoiceId: invoice.id, invoiceHash: invoice.invoiceHash, checksHash: full.checksHash,
      outcome: "blocked", payee: invoice.payee, amount: invoice.amount,
      mode: config.mode || "mock", at,
    });
    return { outcome: "blocked", stage: "release", failed: full.results.filter((r) => !r.pass).map((r) => r.id), results: full.results, checksHash: full.checksHash, receipt: record, invoice };
  }

  const approval = {
    agentId: config.agentId,
    checksPassed: true,
    checksHash: full.checksHash,
    signature: config.mode === "live" ? null : mockSign(config, invoice.id, full.checksHash),
  };
  const { receiptHash } = chain.release(invoice.id, approval);
  const record = appendReceipt(log, {
    invoiceId: invoice.id, invoiceHash: invoice.invoiceHash, checksHash: full.checksHash,
    outcome: "released", payee: invoice.payee, amount: invoice.amount,
    mode: config.mode || "mock", onChainReceiptHash: receiptHash, at,
  });
  return { outcome: "released", stage: "release", results: full.results, checksHash: full.checksHash, receipt: record, onChainReceiptHash: receiptHash, invoice };
}

module.exports = { processRequest, buildSnapshot, mockSign };
