"use strict";

// Chain adapters for PayReceipt. One interface, two implementations:
//
// - MockChain: an in-memory simulation that implements the same rules as
//   PayeeRegistry + InvoiceEscrow (bindings, escrow balances, spend cap,
//   expiry, duplicate protection, cancel/refund, agent-gated release). It runs
//   today with no wallet and no network. It is a simulation and is labelled
//   as such everywhere its results are shown.
//
// - LiveChain (live.js): the same calls against Aevum Testnet via ethers,
//   used once the contracts are deployed with a faucet-funded wallet.

class MockChain {
  constructor({ cap, agentId }) {
    this.cap = BigInt(cap);
    this.agentId = agentId;
    this.balances = new Map(); // address -> BigInt base units
    this.bindings = new Map(); // nameHash -> address
    this.invoices = new Map(); // id -> invoice
    this.inFlight = new Set(); // invoiceHash
    this.paid = new Set(); // invoiceHash
    this.nextId = 1;
    this.receipts = []; // on-chain-style receipt chain (mock hashes)
    this.lastReceiptHash = "GENESIS";
  }

  mint(address, amount) {
    this.balances.set(address, (this.balances.get(address) || 0n) + BigInt(amount));
  }

  balanceOf(address) {
    return this.balances.get(address) || 0n;
  }

  registerName(nameHash, address) {
    const current = this.bindings.get(nameHash);
    if (current && current.toLowerCase() !== address.toLowerCase()) {
      throw new Error("name bound to another address");
    }
    this.bindings.set(nameHash, address);
  }

  boundAddress(nameHash) {
    return this.bindings.get(nameHash) || null;
  }

  createInvoice({ payer, payee, amount, invoiceHash, payeeNameHash, expiry }) {
    amount = BigInt(amount);
    if (amount <= 0n) throw new Error("zero amount");
    if (amount > this.cap) throw new Error("over spend cap");
    if (this.paid.has(invoiceHash)) throw new Error("invoice already paid");
    if (this.inFlight.has(invoiceHash)) throw new Error("invoice already in flight");
    if (this.balanceOf(payer) < amount) throw new Error("insufficient balance");
    this.balances.set(payer, this.balanceOf(payer) - amount);
    const id = this.nextId++;
    this.invoices.set(id, {
      id, payer, payee, amount, invoiceHash, payeeNameHash, expiry,
      state: "Funded", checksHash: null, receiptHash: null,
    });
    this.inFlight.add(invoiceHash);
    return id;
  }

  getInvoice(id) {
    return this.invoices.get(id) || null;
  }

  invoiceSeen(invoiceHash) {
    return this.paid.has(invoiceHash) || this.inFlight.has(invoiceHash);
  }

  // Duplicate check from one invoice's point of view: true when the invoice
  // hash was already paid, or a *different* funded invoice carries it.
  invoiceSeenByOther(invoiceHash, selfId) {
    if (this.paid.has(invoiceHash)) return true;
    for (const inv of this.invoices.values()) {
      if (inv.invoiceHash === invoiceHash && inv.id !== selfId && inv.state === "Funded") return true;
    }
    return false;
  }

  // Mirrors InvoiceEscrow.approveRelease: the approval must come from the
  // configured agent and carry the checksHash of a fully passed check run.
  release(id, approval) {
    const inv = this.getInvoice(id);
    if (!inv || inv.state !== "Funded") throw new Error("not funded");
    if (approval.agentId !== this.agentId) throw new Error("bad agent signature");
    if (!approval.checksPassed) throw new Error("checks did not pass");
    inv.state = "Paid";
    inv.checksHash = approval.checksHash;
    this.inFlight.delete(inv.invoiceHash);
    this.paid.add(inv.invoiceHash);
    this.balances.set(inv.payee, this.balanceOf(inv.payee) + inv.amount);
    const { sha256Hex, canonical } = require("./checks");
    const receiptHash = sha256Hex(
      canonical({
        prev: this.lastReceiptHash, id, invoiceHash: inv.invoiceHash,
        checksHash: approval.checksHash, payee: inv.payee, amount: String(inv.amount),
      })
    );
    inv.receiptHash = receiptHash;
    this.lastReceiptHash = receiptHash;
    this.receipts.push({ id, receiptHash, prevHash: this.receipts.length ? this.receipts[this.receipts.length - 1].receiptHash : "GENESIS" });
    return { receiptHash };
  }

  cancel(id, by) {
    const inv = this.getInvoice(id);
    if (!inv || inv.state !== "Funded") throw new Error("not funded");
    if (by !== inv.payer) throw new Error("not payer");
    inv.state = "Refunded";
    this.inFlight.delete(inv.invoiceHash);
    this.balances.set(inv.payer, this.balanceOf(inv.payer) + inv.amount);
  }
}

module.exports = { MockChain };
