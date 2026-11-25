"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { runChecks, nameHash, normalizeName } = require("../checks");
const { appendReceipt, verifyLog } = require("../receipts");
const { MockChain } = require("../chain");
const { processRequest } = require("../agent");

const CAP = 1_000_000_000n;
const PAYER = "0x1000000000000000000000000000000000000001";
const PAYEE = "0x2000000000000000000000000000000000000002";
const NOW = 1_800_000_000;

function baseSnapshot(overrides = {}) {
  return {
    payeeName: "Acme Studio",
    payeeAddress: PAYEE,
    boundAddress: PAYEE,
    amount: 100_000_000n,
    cap: CAP,
    invoiceHash: "0xinv1",
    invoiceSeen: false,
    denylist: [],
    escrowFunded: true,
    expiry: NOW + 3600,
    now: NOW,
    ...overrides,
  };
}

test("checks: a clean snapshot passes all five checks", () => {
  const { passed, results } = runChecks(baseSnapshot());
  assert.equal(passed, true);
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => r.pass));
});

test("checks: CoP fails when the name is bound to another address", () => {
  const { passed, results } = runChecks(baseSnapshot({ boundAddress: PAYER }));
  assert.equal(passed, false);
  assert.equal(results.find((r) => r.id === "cop_match").pass, false);
});

test("checks: CoP fails when the name is unregistered", () => {
  const { results } = runChecks(baseSnapshot({ boundAddress: null }));
  assert.equal(results.find((r) => r.id === "cop_match").pass, false);
});

test("checks: amount above cap fails, amount at cap passes", () => {
  assert.equal(runChecks(baseSnapshot({ amount: CAP + 1n })).passed, false);
  assert.equal(runChecks(baseSnapshot({ amount: CAP })).passed, true);
});

test("checks: seen invoice, denylisted payee, unfunded and expired escrow each fail", () => {
  const byId = (s) => Object.fromEntries(runChecks(s).results.map((r) => [r.id, r.pass]));
  assert.equal(byId(baseSnapshot({ invoiceSeen: true })).invoice_unique, false);
  assert.equal(byId(baseSnapshot({ denylist: [PAYEE] })).payee_not_denied, false);
  assert.equal(byId(baseSnapshot({ escrowFunded: false })).escrow_ready, false);
  assert.equal(byId(baseSnapshot({ now: NOW + 7200 })).escrow_ready, false);
});

test("checks: checksHash is deterministic and changes when a result flips", () => {
  const a = runChecks(baseSnapshot());
  const b = runChecks(baseSnapshot());
  assert.equal(a.checksHash, b.checksHash);
  const c = runChecks(baseSnapshot({ invoiceSeen: true }));
  assert.notEqual(a.checksHash, c.checksHash);
});

test("checks: name normalization trims, collapses spaces, lowercases", () => {
  assert.equal(normalizeName("  Acme   Studio "), "acme studio");
  assert.equal(nameHash("Acme Studio"), nameHash("acme studio"));
});

test("receipts: a chain of records verifies", () => {
  const log = [];
  for (let i = 1; i <= 3; i++) {
    appendReceipt(log, {
      invoiceId: i, invoiceHash: "0xinv" + i, checksHash: "0xchk" + i,
      outcome: "released", payee: PAYEE, amount: 100n, at: "2026-11-25T00:00:00.000Z",
    });
  }
  const v = verifyLog(log);
  assert.equal(v.ok, true);
  assert.equal(v.count, 3);
});

test("receipts: editing a recorded amount breaks verification", () => {
  const log = [];
  appendReceipt(log, { invoiceId: 1, invoiceHash: "0xa", checksHash: "0xb", outcome: "released", payee: PAYEE, amount: 100n, at: "t" });
  appendReceipt(log, { invoiceId: 2, invoiceHash: "0xc", checksHash: "0xd", outcome: "released", payee: PAYEE, amount: 200n, at: "t" });
  log[0].amount = "999"; // after-the-fact edit
  assert.equal(verifyLog(log).ok, false);
});

test("receipts: reordering records breaks the chain", () => {
  const log = [];
  appendReceipt(log, { invoiceId: 1, invoiceHash: "0xa", checksHash: "0xb", outcome: "released", payee: PAYEE, amount: 100n, at: "t" });
  appendReceipt(log, { invoiceId: 2, invoiceHash: "0xc", checksHash: "0xd", outcome: "blocked", payee: PAYEE, amount: 200n, at: "t" });
  [log[0], log[1]] = [log[1], log[0]];
  assert.equal(verifyLog(log).ok, false);
});

function freshDesk() {
  const config = { agentId: "agent-1", cap: CAP, denylist: [], mode: "mock" };
  const chain = new MockChain({ cap: CAP, agentId: config.agentId });
  chain.mint(PAYER, 10_000_000_000n);
  chain.registerName(nameHash("Acme Studio"), PAYEE);
  return { config, chain, log: [] };
}

test("e2e mock: clean request is funded, released, and receipted", () => {
  const { config, chain, log } = freshDesk();
  const r = processRequest(chain, {
    payer: PAYER, payee: PAYEE, payeeName: "Acme Studio",
    amount: 100_000_000n, invoiceHash: "0xinv-clean", expiry: NOW + 3600, state: "Requested",
  }, config, log, NOW);
  assert.equal(r.outcome, "released");
  assert.equal(chain.balanceOf(PAYEE), 100_000_000n);
  assert.equal(verifyLog(log).ok, true);
});

test("e2e mock: a second request for a paid invoice is blocked as duplicate", () => {
  const { config, chain, log } = freshDesk();
  const req = {
    payer: PAYER, payee: PAYEE, payeeName: "Acme Studio",
    amount: 100_000_000n, invoiceHash: "0xinv-dupe", expiry: NOW + 3600, state: "Requested",
  };
  assert.equal(processRequest(chain, req, config, log, NOW).outcome, "released");
  const again = processRequest(chain, req, config, log, NOW);
  assert.equal(again.outcome, "blocked");
  assert.ok(again.failed.includes("invoice_unique"));
  assert.equal(chain.balanceOf(PAYEE), 100_000_000n); // paid exactly once
});

test("e2e mock: release is impossible without the agent approval path", () => {
  const { chain } = freshDesk();
  const id = chain.createInvoice({
    payer: PAYER, payee: PAYEE, amount: 10_000_000n,
    invoiceHash: "0xinv-guard", payeeNameHash: nameHash("Acme Studio"), expiry: NOW + 3600,
  });
  assert.throws(() => chain.release(id, { agentId: "someone-else", checksPassed: true, checksHash: "0x0" }), /bad agent/);
  assert.throws(() => chain.release(id, { agentId: "agent-1", checksPassed: false, checksHash: "0x0" }), /checks did not pass/);
  assert.equal(chain.balanceOf(PAYEE), 0n);
});
