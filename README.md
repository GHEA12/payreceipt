# PayReceipt

**Verified invoice payments on Aevum Testnet: an agent checks every payment
before money moves, and every outcome is sealed into a hash-chained receipt.**

Built for the **Aevum Builder Challenge #1 (QDay)** — tracks: Invoice Payments +
Confirmation of Payee. Entrant: Indra Dwi Junianto (solo).

## The problem

Paying an invoice to the wrong account is one of the most common and most
expensive payment errors — a supplier's name is right, but the address was
swapped, mistyped, or spoofed. UK banking built Confirmation of Payee for
exactly this. On-chain payments have no equivalent: once a stablecoin transfer
is sent, it is gone, and nothing checks the name against the address, checks
for a duplicate invoice, or enforces a spend limit before release.

## What PayReceipt does

A payer funds an invoice into escrow on Aevum Testnet (tUSD8). Before the
escrow can release, a checking agent runs **five verifications**:

1. **Confirmation of Payee** — the name on the invoice is bound in the on-chain
   `PayeeRegistry` to the exact address being paid.
2. **Spend cap** — the amount is within the payer's per-invoice cap.
3. **Duplicate protection** — the invoice hash has never been paid or funded.
4. **Denylist** — the payee is not on the payer's denylist.
5. **Escrow readiness** — the escrow is funded and unexpired.

Only a full pass earns the agent's signature over the invoice id + the hash of
the check results (`checksHash`). `InvoiceEscrow` verifies that signature
on-chain and releases the tUSD8 **to the payee fixed at funding time** — the
agent can approve, but can never redirect funds. Every release writes a
**hash-chained on-chain receipt** (each receipt hash commits to the previous
one), and the agent mirrors it in a readable receipt log anyone can re-verify
in the browser (`verify-page/`).

If anything fails, the payment stays in escrow: the payer can cancel for a
full refund at any time (instant revocation), and after expiry anyone can
trigger the refund. A blocked payment produces a receipt too — the audit trail
covers the failures, not just the successes.

## Architecture

```
contracts/   Foundry project (Solidity 0.8, zero external dependencies)
  src/PayeeRegistry.sol    Confirmation-of-Payee name<->address bindings
  src/InvoiceEscrow.sol    escrow + agent-signed release + receipt chain
  src/MockTUSD8.sol        test-only tUSD8 stand-in (local tests)
  test/PayReceipt.t.sol    12 dependency-free Foundry tests
agent/       Node.js, zero-dependency core
  checks.js                the five checks + canonical checksHash
  receipts.js              hash-chained receipt log + verification
  chain.js                 MockChain: in-memory simulation of the contracts
  agent.js                 two-gate orchestrator (pre-screen, release)
  live.js                  the same flow against Aevum Testnet via ethers
  demo.js                  scripted end-to-end demo (mock mode)
scripts/
  probe.js                 read-only JSON-RPC probe of Aevum + tUSD8
  deploy.js                deploys both contracts to Aevum Testnet
  anvil-e2e.js             full live-path proof against a local anvil chain
verify-page/ one HTML file: recompute a receipt log's chain in the browser
```

## Chain parameters (Aevum Testnet)

| | |
|---|---|
| Chain ID | 44005 |
| RPC | https://rpc-test.qday.info |
| Explorer | https://explorer-test.qday.info |
| Gas token | tQDAY (faucet: https://faucet.qday.info, 5 tQDAY / 24 h) |
| tUSD8 | `0x456569838f1d43009A91ebA4263147Afd7233483` (ERC-20, 6 decimals) |
| PayeeRegistry | _filled in after deployment_ |
| InvoiceEscrow | _filled in after deployment_ |

## Run it

Mock mode needs nothing but Node (≥ 20):

```bash
cd agent
npm test          # 13 tests: checks, receipt chain, mock end-to-end
node demo.js      # 1 released payment, 3 blocked, chain verified
```

Prove the live code path locally (Foundry required):

```bash
cd contracts && forge build && forge test   # 12 contract tests
anvil &                                     # local chain on :8545
node scripts/anvil-e2e.js                   # real contracts + real signatures
node scripts/probe.js                       # read-only check of Aevum Testnet
```

Deploy to Aevum Testnet (needs a faucet-funded wallet — see `.env.example`):

```bash
npm install                                 # ethers, for deploy + live mode
cp .env.example .env                        # fill DEPLOYER_PRIVATE_KEY, AGENT_ADDRESS
node scripts/deploy.js
```

## Safety design

- **Least privilege:** the agent key signs approvals only. It holds no funds,
  cannot change the payee or amount, and its approvals are bound to one
  invoice + one checksHash on one chain. Rotating the agent
  (`setAgent`) instantly invalidates the old key's signatures.
- **Spend cap on-chain:** `maxAmount` is enforced by the contract at funding
  time, not just by the agent.
- **Expiry + revocation:** escrow expiry with a public refund path; payer
  cancel any time before release.
- **Auditability:** hash-chained receipts on-chain (authoritative) and in the
  agent's log (readable mirror), verifiable by anyone with `verify-page/`.

## Known constraints and roadmap

- The denylist is agent-side configuration in v1; an on-chain list governed by
  the payer is next.
- One agent key in v1; a 2-of-3 agent quorum for large payments is next.
- The payer funds escrow from their own wallet in v1; wiring QDay's ERC-4337
  smart accounts + stablecoin paymaster (live on Aevum Testnet) would let the
  desk pay gas in tUSD8.
- Mainnet path: the same contracts deploy unchanged at QDay mainnet launch;
  the registry becomes the seed of a payee directory for merchants.

## Third-party dependencies and licenses

- The agent core, contracts, demo, and verify page are original code, MIT
  (see `LICENSE`), written during the challenge build window.
- `ethers` v6 (MIT) — used only by `scripts/` and `agent/live.js`.
- Foundry (MIT/Apache-2.0) — build and test tooling for the contracts.
- `scripts/anvil-e2e.js` uses Foundry's published, public anvil dev keys
  (test-only defaults) against a local chain.
