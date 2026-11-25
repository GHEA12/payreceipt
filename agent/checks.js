"use strict";

// PayReceipt checking agent — the five verification checks that gate a payment
// release. Pure functions over a plain state snapshot, so the exact same logic
// runs against the mock chain (tests, demo) and the live Aevum Testnet adapter.
//
// The output is a canonical result set plus its SHA-256 hash (checksHash). The
// agent signs the checksHash together with the invoice id; the InvoiceEscrow
// contract releases funds only against that signature, so the on-chain release
// is bound to these exact results.

const crypto = require("node:crypto");

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Deterministic JSON: object keys sorted at every depth, no whitespace.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

// Normalize a payee name the same way everywhere: trim, collapse whitespace,
// lowercase. The name hash mirrors what the payer/agent compute off-chain for
// the on-chain registry (keccak on-chain; sha256 here for the off-chain log —
// the registry binding itself is read from chain state, not recomputed here).
function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function nameHash(name) {
  return sha256Hex(normalizeName(name));
}

const CHECK_LABELS = {
  cop_match: "Confirmation of Payee: name on the invoice belongs to the address being paid",
  amount_within_cap: "Amount is within the payer's spend cap",
  invoice_unique: "Invoice has not been paid or funded before",
  payee_not_denied: "Payee is not on the denylist",
  escrow_ready: "Escrow is funded and has not expired",
};

// snapshot = {
//   payeeName, payeeAddress, boundAddress (address the name is bound to, or null),
//   amount (base units, integer), cap (base units, integer),
//   invoiceHash, invoiceSeen (bool: paid or in flight),
//   denylist (array of addresses), escrowFunded (bool),
//   expiry (unix seconds), now (unix seconds)
// }
function runChecks(snapshot) {
  const results = [];

  const bound = snapshot.boundAddress || null;
  results.push({
    id: "cop_match",
    label: CHECK_LABELS.cop_match,
    pass: bound !== null && bound.toLowerCase() === String(snapshot.payeeAddress).toLowerCase(),
    detail:
      bound === null
        ? `no registry binding for "${normalizeName(snapshot.payeeName)}"`
        : bound.toLowerCase() === String(snapshot.payeeAddress).toLowerCase()
          ? `name bound to ${bound}`
          : `name bound to ${bound}, payment targets ${snapshot.payeeAddress}`,
  });

  results.push({
    id: "amount_within_cap",
    label: CHECK_LABELS.amount_within_cap,
    pass: BigInt(snapshot.amount) > 0n && BigInt(snapshot.amount) <= BigInt(snapshot.cap),
    detail: `amount ${snapshot.amount} vs cap ${snapshot.cap} (tUSD8 base units)`,
  });

  results.push({
    id: "invoice_unique",
    label: CHECK_LABELS.invoice_unique,
    pass: !snapshot.invoiceSeen,
    detail: snapshot.invoiceSeen
      ? `invoice ${snapshot.invoiceHash} already paid or in flight`
      : `invoice ${snapshot.invoiceHash} not seen before`,
  });

  const denied = (snapshot.denylist || []).map((a) => String(a).toLowerCase());
  results.push({
    id: "payee_not_denied",
    label: CHECK_LABELS.payee_not_denied,
    pass: !denied.includes(String(snapshot.payeeAddress).toLowerCase()),
    detail: denied.includes(String(snapshot.payeeAddress).toLowerCase())
      ? `${snapshot.payeeAddress} is denylisted`
      : `${snapshot.payeeAddress} not on the denylist`,
  });

  results.push({
    id: "escrow_ready",
    label: CHECK_LABELS.escrow_ready,
    pass: Boolean(snapshot.escrowFunded) && Number(snapshot.now) < Number(snapshot.expiry),
    detail: !snapshot.escrowFunded
      ? "escrow is not funded"
      : Number(snapshot.now) >= Number(snapshot.expiry)
        ? `escrow expired at ${snapshot.expiry} (now ${snapshot.now})`
        : `funded, expires ${snapshot.expiry} (now ${snapshot.now})`,
  });

  const passed = results.every((r) => r.pass);
  const checksHash = sha256Hex(canonical({ invoiceHash: snapshot.invoiceHash, results }));
  return { passed, results, checksHash };
}

module.exports = { runChecks, canonical, sha256Hex, normalizeName, nameHash, CHECK_LABELS };
