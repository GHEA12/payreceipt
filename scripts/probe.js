"use strict";

// Read-only probe of Aevum Testnet + tUSD8. Zero dependencies (raw JSON-RPC
// over fetch). Run with the sandbox proxy env:
//   NODE_USE_ENV_PROXY=1 node scripts/probe.js
// It proves the documented chain parameters from the machine that built the
// project — no wallet, no transactions.

const RPC = process.env.AEVUM_RPC_URL || "https://rpc-test.qday.info";
const TUSD8 = process.env.TUSD8_ADDRESS || "0x456569838f1d43009A91ebA4263147Afd7233483";

let id = 0;
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(method + ": " + JSON.stringify(json.error));
  return json.result;
}

function decodeString(hex) {
  const buf = Buffer.from(hex.slice(2), "hex");
  const len = Number(BigInt("0x" + buf.subarray(32, 64).toString("hex")));
  return buf.subarray(64, 64 + len).toString("utf8");
}

(async () => {
  const chainId = Number(BigInt(await rpc("eth_chainId")));
  const block = Number(BigInt(await rpc("eth_blockNumber")));
  const call = (data) => rpc("eth_call", [{ to: TUSD8, data }, "latest"]);
  const decimals = Number(BigInt(await call("0x313ce567"))); // decimals()
  const symbol = decodeString(await call("0x95d89b41")); // symbol()
  const totalSupply = BigInt(await call("0x18160ddd")); // totalSupply()
  console.log(JSON.stringify({ rpc: RPC, chainId, block, tusd8: TUSD8, symbol, decimals, totalSupply: totalSupply.toString() }, null, 2));
  if (chainId !== 44005) throw new Error("unexpected chain id");
  if (decimals !== 6) throw new Error("unexpected tUSD8 decimals");
  console.log("PROBE OK");
})().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
