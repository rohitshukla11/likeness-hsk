# Likeness on HSK Chain

Agent-to-agent licensing and per-render payments for AI ads that use a real person's face.

A brand's **payment agent** asks a creator's **receiving agent** for a licence. The creator's agent
answers with the payment conditions as an AP2 **Cart Mandate** (the creator's terms: price per render,
allowed use, expiry, render cap). The brand's agent checks them against the brand's policy, signs a
**Payment Mandate** with the brand wallet, and the **HSP Gateway** verifies and executes the stablecoin
payment on HSK Chain. Every paid render gets a receipt on HSK Chain mainnet; a revoked licence stops
all further payments.

Built for the HSK Chain Horizon Hackathon, track "Agent Payments & A2A Settlement (HSP)".
Work in progress.
