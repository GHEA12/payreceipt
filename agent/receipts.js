"use strict";

// Off-chain receipt log for PayReceipt — mirrors the on-chain receipt chain.
// Every released (or blocked) payment produces one canonical receipt record;
// each record's hash commits to the previous record's hash, so editing any
// historical record breaks verification from that point on. In live mode the
// record also carries the on-chain receipt hash and tx hash; the on-chain
// chain in InvoiceEscrow is authoritative, this log is the readable mirror.

const { canonical, sha256Hex } = require("./checks");

function receiptHash(record) {
  const { hash, ...unsigned } = record;
  return sha256Hex(canonical(unsigned));
}

function appendReceipt(log, fields) {
  const prevHash = log.length ? log[log.length - 1].hash : "GENESIS";
  const record = {
    seq: log.length + 1,
    prevHash,
    invoiceId: fields.invoiceId,
    invoiceHash: fields.invoiceHash,
    checksHash: fields.checksHash,
    outcome: fields.outcome, // "released" | "blocked" | "refunded"
    payee: fields.payee,
    amount: String(fields.amount),
    mode: fields.mode || "mock", // "mock" | "live"
    txHash: fields.txHash || null,
    onChainReceiptHash: fields.onChainReceiptHash || null,
    at: fields.at,
  };
  record.hash = receiptHash(record);
  log.push(record);
  return record;
}

function verifyLog(log) {
  const failures = [];
  let prevHash = "GENESIS";
  log.forEach((record, i) => {
    if (record.seq !== i + 1) failures.push(`seq ${record.seq}: out of order`);
    if (record.prevHash !== prevHash) failures.push(`seq ${record.seq}: prevHash does not match the previous record`);
    if (receiptHash(record) !== record.hash) failures.push(`seq ${record.seq}: hash mismatch (record was edited)`);
    prevHash = record.hash;
  });
  return { ok: failures.length === 0, failures, count: log.length };
}

module.exports = { appendReceipt, verifyLog, receiptHash };
