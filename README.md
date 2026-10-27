# Likeness on HSK Chain

Agent-to-agent licensing and per-render payments for AI ads that use a real person's face.

A brand's **payment agent** asks a creator's **receiving agent** for a licence. The creator's agent
answers with the payment conditions as an AP2 **Cart Mandate** (the creator's terms: price per render,
allowed use, expiry, render cap). The brand's agent checks them against the brand's policy, signs a
**Payment Mandate** with the brand wallet, and the **HSP Gateway** verifies and executes the stablecoin
payment on HSK Chain. Every paid render gets a receipt on HSK Chain mainnet; a revoked licence stops
all further payments.

Built for the HSK Chain Horizon Hackathon, track "Agent Payments & A2A Settlement (HSP)".
Work in progress. What was reused and what is new: [docs/HACKATHON.md](docs/HACKATHON.md).

## How a payment becomes a licensed render

1. **Payment:** the HSP Gateway executes the brand's signed authorization. The stablecoin goes
   straight from the brand's wallet to the creator's payout. These contracts never hold money, so
   there is nothing to refund.
2. **Record:** the creator's agent records the payment in `HspSettlement.recordPayment`. It's
   accepted only if:
   - the licence is active (not revoked, expired or used up);
   - this is the licence's next render;
   - the amount is the licence price;
   - the HSP transaction hash hasn't been used before;
   - **the licensee's authorization with the given nonce has executed on chain**, read from the
     token's own nonce registry (USDC.e `authorizationState` under EIP-3009, or Permit2's nonce
     bitmap for USDT);
   - that nonce has never been recorded before, so one payment can't pay for two renders.
3. **Receipt:** once a render is paid, `anchorRender` writes its receipt, keyed by the sha256 of the
   delivered file. It needs a platform render agent's signature over that file hash. Anyone can look
   a file up on HSK Chain.

## What the chain proves, and what an agent attests

**Bound nonce (preferred).** When the payment agent can choose the nonce, it uses
`paymentNonce(licenceId, renderIndex) = keccak256(settlement, chainId, licenceId, renderIndex)`.
The chain itself then shows that the licensee's payment for **exactly this render** executed. The
payment is stored with `nonceBound = true`.

**Gateway nonce.** If the HSP Gateway chooses the nonce instead, the creator's agent records the nonce
the executed authorization actually used. It reads it from the transaction: the `AuthorizationUsed`
event for USDC.e, or the Permit2 call for USDT. The chain still shows that the licensee's
authorization with that nonce executed, and that it counts once. Which licence and render it paid
for is the creator agent's attestation. The payment is stored with `nonceBound = false`.

**In both cases**, the token's nonce registry doesn't show the amount or the recipient. The creator's
agent attests those:
- it's the only party that can record a payment for its creator;
- it checks the transfer it actually received;
- it stores the HSP transaction hash with the payment, so anyone can audit it on the explorer.

So a brand can't underpay. A creator's agent can only act for its own creator. A licence that is
revoked, expired or used up takes no further payments, whichever nonce was used.

## Contracts and tests

```sh
cd contracts
forge test                                                              # unit and fuzz tests
HSK_RPC_URL=https://mainnet.hsk.xyz forge test --match-path "test/fork/*"  # HSK mainnet fork
```

The fork suite runs a real USDC.e `transferWithAuthorization` and a real Permit2 transfer against
HSK Chain mainnet state in a local fork. Nothing is broadcast.
