"use strict";

// Deploy PayeeRegistry + InvoiceEscrow to Aevum Testnet (chain 44005).
//
// Prerequisites (the entrant's steps):
//   1. Create an EVM wallet and claim testnet funds at https://faucet.qday.info
//      (5 tQDAY per 24h for gas, plus tUSD8).
//   2. npm install (project root) to get ethers.
//   3. Copy .env.example to .env and fill DEPLOYER_PRIVATE_KEY + AGENT_ADDRESS.
//
//   node scripts/deploy.js
//
// Prints the deployed addresses and explorer links to paste into the README
// and the DoraHacks submission. Bytecode comes from the Foundry build in
// contracts/out — run `forge build` in contracts/ first.

const fs = require("node:fs");
const path = require("node:path");

function artifact(name) {
  const p = path.join(__dirname, "..", "contracts", "out", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`missing artifact ${p} — run "forge build" in contracts/ first`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

(async () => {
  const { ethers } = require("ethers");
  const rpcUrl = process.env.AEVUM_RPC_URL || "https://rpc-test.qday.info";
  const tusd8 = process.env.TUSD8_ADDRESS || "0x456569838f1d43009A91ebA4263147Afd7233483";
  const agent = process.env.AGENT_ADDRESS;
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const maxAmount = BigInt(process.env.MAX_AMOUNT_BASE_UNITS || "1000000000"); // 1,000 tUSD8
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set (see .env.example)");
  if (!agent) throw new Error("AGENT_ADDRESS not set (see .env.example)");

  const provider = new ethers.JsonRpcProvider(rpcUrl, 44005);
  const wallet = new ethers.Wallet(deployerKey, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log("deployer:", wallet.address, "tQDAY balance:", ethers.formatEther(balance));
  if (balance === 0n) throw new Error("deployer has no tQDAY — claim from https://faucet.qday.info first");

  const registryArt = artifact("PayeeRegistry");
  const registry = await new ethers.ContractFactory(registryArt.abi, registryArt.bytecode, wallet).deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("PayeeRegistry:", registryAddress);

  const escrowArt = artifact("InvoiceEscrow");
  const escrow = await new ethers.ContractFactory(escrowArt.abi, escrowArt.bytecode, wallet).deploy(tusd8, agent, maxAmount);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("InvoiceEscrow:", escrowAddress);

  const explorer = "https://explorer-test.qday.info";
  console.log("\nExplorer:");
  console.log(`  ${explorer}/address/${registryAddress}`);
  console.log(`  ${explorer}/address/${escrowAddress}`);
  console.log("\nPut these in .env (PAYEE_REGISTRY_ADDRESS / INVOICE_ESCROW_ADDRESS) and in the README.");
})().catch((e) => {
  console.error("DEPLOY FAILED:", e.message);
  process.exit(1);
});
