# What was reused, and what was built for HSK Chain Horizon

**Hackathon:** HSK Chain Horizon Hackathon (Mumbai), track "Agent Payments & A2A Settlement (HSP)".
The rules allow projects built or rebuilt between 23 October and 1 November 2026. All times are UTC.

## Reused

The Likeness licensing contracts come from **[likeness-arc](https://github.com/rohitshukla11/likeness-arc)**
(MIT, the same author), at commit `ea40c8e` (15 October 2026). They were copied unchanged on
27 October in commit `047e3b5`, so the starting point is visible in this repository's history.

| File | From likeness-arc | Here |
|---|---|---|
| `contracts/src/CreatorRegistry.sol` | Creator attestation and published terms (price per render, allowed categories and regions, maximum duration, render cap, auto-approve) | Reused; comments updated for USDC.e and HSP |
| `contracts/src/LicenseRegistry.sol` | Soulbound expiring licences, creator approval or auto-approve within terms, revoke, `status()` | Reused; the single writer role is renamed from escrow to settlement |
| `contracts/src/ReceiptAnchor.sol` | One receipt per delivered file hash | Reused; same rename |
| `contracts/src/Categories.sol` | Banned and licensable use categories | Reused unchanged |
| `contracts/test/CreatorRegistry.t.sol`, `LicenseRegistry.t.sol`, `test/utils/Base.t.sol` | 29 tests | Reused; the base now deploys the settlement through a hook |
| Libraries | forge-std v1.17.0, OpenZeppelin Contracts v5.7.0 | The same versions, as submodules |

**Removed** in the port (`95f0690`):
- `LicenseEscrow` and its tests: HSP now moves the money per render, so nothing is held or refunded;
- the Arc fork suite and the Arc deploy scripts.

## Built for this hackathon

| When (UTC) | Commit | What |
|---|---|---|
| 27 Oct 16:11 | `5510455` | New repository: licence, README, ignore rules for secrets and keystores |
| 27 Oct 16:13 | `95f0690` | Port to HSK Chain: `evm_version` cancun (checked against mainnet), HSK RPC endpoints, settlement role |
| 27 Oct 16:26 | `3942151` | **`HspSettlement`**, the HSP payment binding, with 34 new tests and an HSK mainnet fork suite |

**`HspSettlement` (new):**
- A render is recorded only after the brand's stablecoin authorization for **exactly that render**
  has executed on chain.
  - The payment agent signs with the nonce `keccak256(settlement, chainId, licenceId, renderIndex)`.
  - The contract checks USDC.e's `authorizationState(payer, nonce)` (EIP-3009), or the Permit2 nonce
    bitmap for the USDT fallback.
- Only the creator's own agent records, and it must report the licence price. The HSP transaction
  hash is stored once per payment.
- Receipts are anchored only for paid renders, with a render agent's signature over the file hash.
- Revoked, expired or used-up licences take no further payments.

**Tests:**
- **USDC.e rail:** 29 tests.
- **Permit2 rail:** 5 tests.
- **Reused:** the 29 registry tests.
- **HSK mainnet fork:** 3 tests. They execute a real USDC.e `transferWithAuthorization` and a real
  Permit2 transfer against chain 177 state in a local fork; nothing is broadcast.

A mutation run without the nonce check makes 6 tests fail.

Still to come, recorded here as it lands: the creator and brand agents (A2A, AP2 mandates), the HSP
Gateway integration, the app, and the mainnet deployment.
