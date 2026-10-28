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
| 27 Oct 17:14 | (this commit) | `recordPayment` takes the nonce that actually executed, so payments still work if the HSP Gateway picks the nonce. Each nonce counts once, and every payment records whether its nonce was bound to the render. 8 more tests |

**`HspSettlement` (new):**
- A render is recorded only after the licensee's stablecoin authorization has executed on chain.
  The contract checks USDC.e's `authorizationState(payer, nonce)` (EIP-3009), or the Permit2 nonce
  bitmap for the USDT fallback.
  - **Bound nonce:** when the payment agent signs with
    `keccak256(settlement, chainId, licenceId, renderIndex)`, the chain shows the payment was for
    exactly that render.
  - **Gateway nonce:** otherwise, the creator's agent records the nonce that executed. Each nonce
    counts once.
- Only the creator's own agent records, and it must report the licence price. The HSP transaction
  hash is stored once per payment.
- Receipts are anchored only for paid renders, with a render agent's signature over the file hash.
- Revoked, expired or used-up licences take no further payments.

**Tests:**
- **USDC.e rail:** 36 tests.
- **Permit2 rail:** 6 tests.
- **Reused:** the 29 registry tests.
- **HSK mainnet fork:** 3 tests. They execute a real USDC.e `transferWithAuthorization` and a real
  Permit2 transfer against chain 177 state in a local fork; nothing is broadcast.

Mutation runs: without the executed-payment check, 9 tests fail; without the counts-once check, 2
fail. The README says plainly what the chain proves and what the creator's agent attests.

**Agents and the HSP client (new, `agents/`):**
- A2A creator agent (receiving agent and HSP merchant) and brand agent (payment agent).
- An HSP client: HMAC request signing, the ES256K cart JWT over the RFC 8785 cart hash, the AP2 Cart
  and Payment Mandates, EIP-3009 and Permit2 signatures, webhook verification, status polling.
- A render agent and a message log.
- A local HSP Gateway emulator for tests.

27 tests:
- interop with `jose`, the JWT library HashKey's Node SDK uses;
- HMAC checked against the docs' `openssl` procedure;
- end to end on a local chain, on both rails and both nonce modes, including the refusals.

A test double was corrected along the way: `MockPermit2` now has the real Permit2 EIP-712 domain,
which has no version field.

**Deployment tooling (new):**
- `scripts/deploy.ts`: the USDT / Permit2 rail. Dry run by default; mainnet only with explicit
  confirmation.
- `TestUSDT`: a testnet-only token with no value.
- `scripts/run-testnet.ts`: the agents end to end on chain 133.

**Demo app (new, `agents/src/app`, `agents/public`):**
- a brand console with the live message log, a creator page with revoke, and a Verify page;
- a fix for a hole found in the likeness-arc audit: downloading a render now needs the licensee's
  wallet signature;
- 4 integration tests, including that a stranger's or a stale signature is refused.

## HSK Chain testnet (chain 133), 28 October

Deployed on the USDT / Permit2 rail. `TestUSDT` is a testnet-only token with no value. HSP's testnet
USDT has no public faucet. All addresses are in `deployments/testnet.json`.

| Contract | Address |
|---|---|
| CreatorRegistry | [`0x388c…a6be`](https://testnet-explorer.hskchain.net/address/0x388cd6c6ee71aed1d052894b6981fdb9c7aad6be) |
| LicenseRegistry | [`0x91e2…aff4`](https://testnet-explorer.hskchain.net/address/0x91e2df3ec2188812eb026ce101af4e772a43aff4) |
| ReceiptAnchor | [`0x9da3…e4c1`](https://testnet-explorer.hskchain.net/address/0x9da3a94fc7924be25e573bafaf5ef33d2749e4c1) |
| HspSettlement | [`0x4a2b…f869`](https://testnet-explorer.hskchain.net/address/0x4a2bafa2279ea1b0ca67fb8d149eebbc890bf869) |
| TestUSDT | [`0xc033…fcea`](https://testnet-explorer.hskchain.net/address/0xc0336d73fde52b1c8463b7f746da33e71102fcea) |

**End-to-end run** (`pnpm run testnet`), with the agents and the local HSP Gateway emulator:
1. Licence 2 [issued](https://testnet-explorer.hskchain.net/tx/0x227e9e8535d990418ee133840e7ae0a685532809a8ebf20b5d793cbcea2dcf92).
2. The brand's [Permit2 payment](https://testnet-explorer.hskchain.net/tx/0xb824828c93d12195b5f7aee4f6034b3075aee9beb03f6599628ba89d72a4d047)
   of 0.05 tUSDT straight to the creator's payout.
3. The creator agent's [recordPayment](https://testnet-explorer.hskchain.net/tx/0x8fc26d6a160195968cccd46dd7e18dc6d340e9dcb470f6ae410c73e4c3aac25c),
   with the nonce bound to the render.
4. The render agent's [receipt](https://testnet-explorer.hskchain.net/tx/0xa403c6783e16d76ed03d86b3765b5950a6088badc554edf89e9cec078e8a5b95).
5. The creator [revokes](https://testnet-explorer.hskchain.net/tx/0x06c1d65ad55a3f5c94d556cb07e18659b848bc17e84258702c182439865a660f),
   and the brand agent refuses the next payment before signing.

Read back on chain afterwards: licence 2 is Revoked, the receipt exists, the payment record holds
the brand, 0.05 tUSDT, `nonceBound = true` and the HSP transaction hash, and the settlement holds
nothing.

**What the testnet run found.** The first run's payment executed, but recording it failed:
- **The cause:** the public RPC answered the contract simulation from a node that hadn't yet seen the
  payment block, so the contract returned `PaymentNotExecuted`. Reads after a receipt can also be
  stale.
- **The fix:** the creator agent waits for the payment's block and retries that revert, and nonces
  are counted locally.
- **The recovery:** `pnpm run recover` records a missed payment with the same checks. It recorded
  licence 1's payment ([tx](https://testnet-explorer.hskchain.net/tx/0x041b750681aa68a8d31514246876fe27811b818b1ea41efc015af728c0b6e68e)).

Still to come, recorded here as it lands: the real HSP Gateway (once credentials arrive) and the
mainnet deployment.
