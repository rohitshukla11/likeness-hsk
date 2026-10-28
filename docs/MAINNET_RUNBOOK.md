# Mainnet runbook (HSK Chain, chain 177)

About 45 minutes. Nothing here runs without your word.
- **Funding:** the scripts check for `LIKENESS_MAINNET_FUND=yes`, set only on your **"fund"**.
- **Deploying and running:** they check for `LIKENESS_MAINNET_DEPLOY=yes` / `LIKENESS_MAINNET_RUN=yes`,
  set only on your **"deploy"**.
- **Dry runs:** every script prints a dry run first.

**Rehearsed** on 28 Oct, steps 1–7, on a local fork of HSK mainnet. It used real USDT, the real
Permit2 and the real HSKSwap pool state, with fake HSK. All steps passed: fund, the swap to 1.515
USDT, deploy, Safe ownership, then register → Permit2 approval → licence → 0.05 USDT HSP payment →
recorded with the bound nonce → receipt → revoke → refused.

## Before you start

- **HSK at the deployer:** about 50 HSK, from KuCoin on the "HashKey" network, at
  `0x80Bc5b9E582ebB58031FDbCA9C015c8e9EE85AA7`.
- **HSP mainnet credentials** in `.secrets/hsp/credentials.json`, with `baseUrl`
  `https://hsp.hashkey.com` and the Gateway's mainnet Permit2 spender. See `docs/HSP_SETUP.md`.
  Without them, steps 1–5 still work, but step 7 refuses, because the emulator never stands in for HSP
  on mainnet.
- **Your own wallet address** to co-own the Safe, so the deployer key alone isn't the only way in.

## Steps (from `agents/`)

| # | What | Command | Gas (measured) | HSK at 500 gwei |
|---|---|---|---|---|
| 1 | Dry run: balances, transfers, swap quote | `pnpm run fund -- --network mainnet --swap-usdt 1.5` | — | — |
| 2 | **"fund"**: gas to creator (1), creator agent (1.5), brand (1.5), render agent (2); swap HSK → 1.5 USDT for the brand (HSKSwap SwapRouter02, minimum 1.5 USDT out) | `LIKENESS_MAINNET_FUND=yes pnpm run fund -- --network mainnet --swap-usdt 1.5 --broadcast` | 4 × 21k + ≈ 130k | 6 sent + ≈ 17.1 swapped + 0.1 |
| 3 | Dry run of the deploy: plan and estimate | `pnpm run deploy -- --network mainnet` | — | — |
| 4 | **"deploy"**: CreatorRegistry, LicenseRegistry, ReceiptAnchor, HspSettlement (Permit2 rail, HSP's USDT `0xF1B5…9029`), wiring | `LIKENESS_MAINNET_DEPLOY=yes pnpm run deploy -- --network mainnet --broadcast` | 8.0M | ≈ 4.0 |
| 5 | Safe{Wallet} v1.4.1 owns all four (Ownable2Step: offer, then the Safe accepts) | `LIKENESS_MAINNET_DEPLOY=yes pnpm run safe -- --network mainnet --owners <your wallet> --broadcast` | 0.70M | ≈ 0.35 |
| 6 | Verify the source on Blockscout (free) | `pnpm run verify -- --network mainnet` | — | 0 |
| 7 | **One real run**: register the synthetic creator, name its agent, the brand's bounded Permit2 approval (1.5 USDT), licence → 0.05 USDT through HSP → recorded → receipt → revoke → refused | `pnpm run hsp:check` then `LIKENESS_MAINNET_RUN=yes pnpm run demo -- --network mainnet` | 0.96M | ≈ 0.48 |
| 8 | The app on mainnet (operator on this machine) | `LIKENESS_MODE=mainnet LIKENESS_OPERATOR=1 pnpm app` | per render ≈ 0.36M | ≈ 0.18 per render |

**Totals:**
- **Gas:** about 5 HSK, plus about 6 HSK passed to the other wallets and about 17 HSK swapped to USDT.
- **L1 data fees:** negligible (a measured 0.00001 HSK on a mainnet transaction).
- **Price per render:** 0.05 USDT, from the brand to the creator, plus whatever HSP's fees turn out
  to be.

## After the run

- Commit `deployments/mainnet.json` (public addresses and transaction hashes).
- Add the mainnet links to the README and `docs/HACKATHON.md` (Claude does this).
- Open the app's Verify page with the receipt's file hash.

## If something goes wrong

| Problem | What to do |
|---|---|
| A step stops partway | Every script is safe to rerun: it skips what's already done (deployed contracts excepted; don't rerun step 4 once it has written `deployments/mainnet.json`). |
| A payment executed but wasn't recorded | `pnpm run recover -- --network mainnet --cart <cart id> --request <payment_request_id> --tx <hash>`. The ids are in the HSP webhook or the console. |
| The webhook can't reach this machine | The run polls the Gateway instead; or set `PUBLIC_URL` to an HTTPS tunnel and register it as the app's webhook URL. |
| `hsp:check` says 10002 | Wrong app key or secret, or the clock is off; for the cart JWT, try `"jwtAudience": "HashKeyMerchant"`. |
