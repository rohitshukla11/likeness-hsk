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

## The agents and the HSP client (`agents/`)

How the track spec maps onto the code:

| Track spec | Here |
|---|---|
| Receiving Agent transmits the payment conditions | **Creator agent** (`src/creator-agent`). It serves an A2A agent card at `/.well-known/agent-card.json` (AP2 merchant role) and answers `message/send`. It reads the creator's terms and the licence status on chain, refuses a revoked, expired or used-up licence, creates the HSP order, and returns the signed AP2 **Cart Mandate** (an ES256K `merchant_authorization` over the RFC 8785 cart hash). |
| Payment Agent constructs the Payment Mandate and signs | **Brand agent** (`src/brand-agent`). See the checks below. |
| HSP Gateway verifies and executes | `src/hsp/client.ts`: HMAC-signed merchant calls (`X-App-Key`, `X-Signature`, `X-Timestamp`, `X-Nonce`), the payer's mandate submission, status polling. `src/hsp/webhook.ts` verifies the Gateway's signed webhooks. |
| On-chain settlement | When the webhook arrives, the creator agent reads the transaction, checks the transfer to the payout, and records the payment in `HspSettlement`. It uses the nonce that executed (read from `AuthorizationUsed`, or from the Permit2 call). The **render agent** then anchors the receipt. |

**The brand agent's checks, before it signs:**
- the licence is active on chain;
- the terms fit the brand's policy (maximum price per render, allowed uses, daily budget);
- the cart is signed by the creator's merchant key and unchanged;
- `pay_to` is the creator's on-chain payout;
- the amount is the licence price, in the expected token.

It then signs EIP-3009 for USDC.e (Permit2 for USDT), with the render's bound nonce unless the Gateway assigns one, wraps it in an AP2 **Payment Mandate**, and submits it to the HSP Gateway.

Every step is written to a message log (`src/log.ts`) that the app will show. It holds public data only.

**Not yet confirmed by HashKey** (asked; each is isolated in one place and easy to change):
- the payer-side submit route and its authentication (`/api/v1/payment/pay-mandate`);
- where the signed authorization goes in `payment_response.details` (we use the x402 "exact" payload);
- the format of `user_authorization` (we send the payer wallet's signature over the cart hash and mandate hash);
- the JWT audience: the docs say `HashkeyMerchant`, the Node and Python SDKs say `HashKeyMerchant`. It's configurable.

**Gateway emulator.** Until credentials arrive, the tests run against `src/hsp/emulator.ts`. It's a local stand-in that follows HashKey's published Merchant API: HMAC auth, cart JWT verification, the payment state machine, signed webhooks, and on-chain execution of the payer's authorization. It is **not** HashKey's service and is never presented as one.

```sh
cd agents && pnpm install && pnpm test   # needs ../contracts built (forge build) and Foundry's anvil
```

The end-to-end tests run on a local chain with the real contracts:
- the full flow on USDC.e;
- a Gateway-assigned nonce;
- the USDT/Permit2 rail;
- refusals: revoked, used up, over budget, a tampered cart, a forged webhook.

## Contracts and tests

```sh
cd contracts
forge test                                                              # unit and fuzz tests
HSK_RPC_URL=https://mainnet.hsk.xyz forge test --match-path "test/fork/*"  # HSK mainnet fork
```

The fork suite runs a real USDC.e `transferWithAuthorization` and a real Permit2 transfer against
HSK Chain mainnet state in a local fork. Nothing is broadcast.
