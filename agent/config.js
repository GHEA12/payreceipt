"use strict";

// PayReceipt configuration — everything comes from the environment (see
// project/.env.example). The agent core defaults to mock mode; live mode is
// switched on only when the contracts are deployed and a funded agent key is
// provided. No key material lives in this repo.

function loadConfig(env = process.env) {
  return {
    mode: env.PAYRECEIPT_MODE || "mock", // "mock" | "live"
    agentId: env.PAYRECEIPT_AGENT_ID || "payreceipt-agent-1",
    cap: BigInt(env.PAYRECEIPT_CAP_BASE_UNITS || "1000000000"), // default 1,000 tUSD8
    denylist: (env.PAYRECEIPT_DENYLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rpcUrl: env.AEVUM_RPC_URL || "https://rpc-test.qday.info",
    chainId: Number(env.AEVUM_CHAIN_ID || "44005"),
    tusd8Address: env.TUSD8_ADDRESS || "0x456569838f1d43009A91ebA4263147Afd7233483",
    registryAddress: env.PAYEE_REGISTRY_ADDRESS || "",
    escrowAddress: env.INVOICE_ESCROW_ADDRESS || "",
    agentPrivateKey: env.AGENT_PRIVATE_KEY || "",
  };
}

module.exports = { loadConfig };
