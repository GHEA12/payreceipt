"use strict";

// PayReceipt scripted demo — runs the full flow in MOCK mode (in-memory
// simulation of the Aevum contracts; no wallet, no network). One clean
// payment is released; three are blocked for three different reasons; the
// receipt chain is verified at the end.
//
//   node demo.js
//
// Exits 0 and prints DEMO OK when every scenario behaves as designed.

const { MockChain } = require("./chain");
const { processRequest } = require("./agent");
const { verifyLog } = require("./receipts");
const { sha256Hex } = require("./checks");

const CAP = 1_000_000_000n; // 1,000 tUSD8 (6 decimals)
const PAYER = "0x1000000000000000000000000000000000000001";
const PAYEE = "0x2000000000000000000000000000000000000002";
const IMPOSTOR = "0x3000000000000000000000000000000000000003";
const NOW = 1_800_000_000; // fixed clock for reproducible output
const EXPIRY = NOW + 86_400;

const config = { agentId: "payreceipt-agent-1", cap: CAP, denylist: [], mode: "mock" };
const chain = new MockChain({ cap: CAP, agentId: config.agentId });
chain.mint(PAYER, 10_000_000_000n);

// "Acme Studio" is bound to the real payee address in the registry.
const { nameHash } = require("./checks");
chain.registerName(nameHash("Acme Studio"), PAYEE);

const log = [];
const invoiceHash = (label) => "0x" + sha256Hex("invoice:" + label);
let failures = 0;
function expect(cond, label) {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failures++;
}

// Scenario 1: a clean invoice payment, released end to end.
console.log("Scenario 1: clean invoice (Acme Studio, 250 tUSD8)");
const r1 = processRequest(chain, {
  payer: PAYER, payee: PAYEE, payeeName: "Acme Studio",
  amount: 250_000_000n, invoiceHash: invoiceHash("INV-001"), expiry: EXPIRY, state: "Requested",
}, config, log, NOW);
console.log(`  outcome=${r1.outcome} checksHash=${r1.checksHash.slice(0, 16)}… receipt#${r1.receipt.seq}`);
expect(r1.outcome === "released", "clean payment is released");
expect(chain.balanceOf(PAYEE) === 250_000_000n, "payee received exactly 250 tUSD8");

// Scenario 2: the invoice names Acme Studio but the money targets an impostor
// address. The payer funds escrow first (the desk flow), the agent blocks the
// release on Confirmation of Payee, and the payer cancels for a full refund.
console.log("Scenario 2: Confirmation-of-Payee mismatch (impostor address)");
const id2 = chain.createInvoice({
  payer: PAYER, payee: IMPOSTOR, amount: 400_000_000n,
  invoiceHash: invoiceHash("INV-002"), payeeNameHash: nameHash("Acme Studio"), expiry: EXPIRY,
});
const funded2 = { ...chain.getInvoice(id2), payeeName: "Acme Studio" };
const r2 = processRequest(chain, funded2, config, log, NOW);
console.log(`  outcome=${r2.outcome} blockedBy=${r2.failed.join(",")}`);
expect(r2.outcome === "blocked" && r2.failed.includes("cop_match"), "CoP mismatch blocks the release");
expect(chain.balanceOf(IMPOSTOR) === 0n, "impostor received nothing");
const payerBefore = chain.balanceOf(PAYER);
chain.cancel(id2, PAYER);
expect(chain.balanceOf(PAYER) === payerBefore + 400_000_000n, "payer refunded in full after cancel");

// Scenario 3: the same invoice as scenario 1 submitted again after payment.
console.log("Scenario 3: duplicate invoice (INV-001 again)");
const r3 = processRequest(chain, {
  payer: PAYER, payee: PAYEE, payeeName: "Acme Studio",
  amount: 250_000_000n, invoiceHash: invoiceHash("INV-001"), expiry: EXPIRY, state: "Requested",
}, config, log, NOW);
console.log(`  outcome=${r3.outcome} blockedBy=${r3.failed.join(",")}`);
expect(r3.outcome === "blocked" && r3.failed.includes("invoice_unique"), "duplicate invoice blocked at pre-screen");

// Scenario 4: an invoice above the payer's spend cap.
console.log("Scenario 4: over-cap invoice (2,000 tUSD8 vs 1,000 cap)");
const r4 = processRequest(chain, {
  payer: PAYER, payee: PAYEE, payeeName: "Acme Studio",
  amount: 2_000_000_000n, invoiceHash: invoiceHash("INV-004"), expiry: EXPIRY, state: "Requested",
}, config, log, NOW);
console.log(`  outcome=${r4.outcome} blockedBy=${r4.failed.join(",")}`);
expect(r4.outcome === "blocked" && r4.failed.includes("amount_within_cap"), "over-cap invoice blocked at pre-screen");

// Receipt chain: 4 records (1 released, 3 blocked), all verifiable.
const v = verifyLog(log);
console.log(`Receipt log: ${v.count} records, verify ok=${v.ok}`);
expect(v.ok && v.count === 4, "receipt chain verifies with 4 records");

console.log(failures === 0 ? "DEMO OK" : `DEMO FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
