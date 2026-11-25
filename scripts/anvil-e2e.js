"use strict";

// End-to-end proof of the LIVE code path against a local anvil chain:
// real contracts, real ethers calls, real agent signature — everything the
// Aevum deployment will do, except the network itself (anvil chain 31337
// stands in for Aevum Testnet 44005; the contract binds its approval digest
// to whatever chain it runs on).
//
//   anvil &  (then)  node scripts/anvil-e2e.js
//
// Uses the well-known PUBLIC anvil dev keys below. They are test-only
// defaults published by Foundry; never use them on any real network.

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { processLiveRequest } = require("../agent/live");
const { verifyLog } = require("../agent/receipts");
const { normalizeName } = require("../agent/checks");

const RPC = "http://127.0.0.1:8545";
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  payer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};
// The payee only sends one transaction (registering its name), so it uses
// anvil's unlocked account signer directly instead of a key.
const PAYEE_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const CAP = 1_000_000_000n;

function artifact(name) {
  const p = path.join(__dirname, "..", "contracts", "out", `${name}.sol`, `${name}.json`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

let failures = 0;
function expect(cond, label) {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ethers + anvil can race on nonce when transactions fire back to back;
// send every transaction with an explicit fresh pending nonce instead.
async function sendTx(wallet, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const nonce = await wallet.provider.getTransactionCount(wallet.address, "pending");
    try {
      const tx = await fn(nonce);
      return await tx.wait();
    } catch (e) {
      if (attempt < 4 && /nonce/i.test(e.message)) { await sleep(400); continue; }
      throw e;
    }
  }
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallets = Object.fromEntries(Object.entries(KEYS).map(([k, pk]) => [k, new ethers.Wallet(pk, provider)]));
  const deploy = async (name, signer, ...args) => {
    const a = artifact(name);
    const factory = new ethers.ContractFactory(a.abi, a.bytecode, signer);
    let contract;
    await sendTx(signer, async (nonce) => {
      contract = await factory.deploy(...args, { nonce });
      return contract.deploymentTransaction();
    });
    await contract.waitForDeployment();
    return contract;
  };

  const token = await deploy("MockTUSD8", wallets.deployer);
  const registry = await deploy("PayeeRegistry", wallets.deployer);
  const escrow = await deploy("InvoiceEscrow", wallets.deployer, await token.getAddress(), wallets.agent.address, CAP);
  console.log("deployed: token", await token.getAddress(), "| registry", await registry.getAddress(), "| escrow", await escrow.getAddress());

  const payeeSigner = await provider.getSigner(PAYEE_ADDRESS);
  await sendTx(wallets.deployer, (nonce) => token.mint(wallets.payer.address, 10_000_000_000n, { nonce }));
  const nameHash = ethers.keccak256(ethers.toUtf8Bytes(normalizeName("Acme Studio")));
  await (await registry.connect(payeeSigner).register(nameHash)).wait();
  console.log("payee registered the name 'Acme Studio'");

  const config = {
    mode: "live", agentId: "payreceipt-agent-1", cap: CAP, denylist: [],
    rpcUrl: RPC, chainId: 31337,
    tusd8Address: await token.getAddress(),
    registryAddress: await registry.getAddress(),
    escrowAddress: await escrow.getAddress(),
    agentPrivateKey: KEYS.agent,
  };
  const log = [];
  const escrowAddress = await escrow.getAddress();
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const invoiceHash = (label) => ethers.keccak256(ethers.toUtf8Bytes("invoice:" + label));

  async function fund(payeeAddr, amount, label) {
    await sendTx(wallets.payer, (nonce) => token.connect(wallets.payer).approve(escrowAddress, amount, { nonce }));
    await sendTx(wallets.payer, (nonce) => escrow.connect(wallets.payer).createInvoice(payeeAddr, amount, invoiceHash(label), nameHash, expiry, { nonce }));
    return Number(await escrow.invoiceCount());
  }

  // Clean payment: funded, agent checks pass, released by signature.
  const id1 = await fund(PAYEE_ADDRESS, 250_000_000n, "INV-001");
  const r1 = await processLiveRequest(
    { id: id1, payee: PAYEE_ADDRESS, payeeName: "Acme Studio", amount: 250_000_000n, invoiceHash: invoiceHash("INV-001"), expiry, state: "Funded" },
    config, log
  );
  console.log(`clean payment: outcome=${r1.outcome} tx=${r1.txHash}`);
  expect(r1.outcome === "released", "live clean payment released via agent signature");
  expect((await token.balanceOf(PAYEE_ADDRESS)) === 250_000_000n, "payee balance is exactly 250 tUSD8");
  const inv1 = await escrow.invoices(id1);
  expect(inv1.state === 2n, "invoice state is Paid on-chain");
  expect(inv1.receiptHash !== ethers.ZeroHash, "on-chain receipt hash written");

  // Impostor payment: same name, wrong address — agent blocks, payer refunds.
  const impostor = wallets.deployer.address;
  const id2 = await fund(impostor, 400_000_000n, "INV-002");
  const r2 = await processLiveRequest(
    { id: id2, payee: impostor, payeeName: "Acme Studio", amount: 400_000_000n, invoiceHash: invoiceHash("INV-002"), expiry, state: "Funded" },
    config, log
  );
  console.log(`impostor payment: outcome=${r2.outcome} blockedBy=${(r2.failed || []).join(",")}`);
  expect(r2.outcome === "blocked" && r2.failed.includes("cop_match"), "live CoP mismatch blocked by the agent");
  expect((await token.balanceOf(impostor)) === 0n, "impostor received nothing on-chain");
  await sendTx(wallets.payer, (nonce) => escrow.connect(wallets.payer).cancel(id2, { nonce }));
  expect((await token.balanceOf(await escrow.getAddress())) === 0n, "escrow empty after cancel refund");

  const v = verifyLog(log);
  expect(v.ok && v.count === 2, "off-chain receipt log verifies (2 records)");
  console.log(failures === 0 ? "ANVIL E2E OK" : `ANVIL E2E FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ANVIL E2E ERROR:", e.message);
  process.exit(1);
});
