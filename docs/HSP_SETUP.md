# Switching from the emulator to the real HSP Gateway

Until HashKey issues merchant credentials, the app and the testnet run use a local Gateway emulator, and
every page says so. When `.secrets/hsp/credentials.json` exists, the same code talks to HashKey's HSP
Gateway instead, and the banner switches to "HashKey (live merchant credentials)". On mainnet the app
refuses to pay without real credentials.

## Already done

- **Merchant key:** an ES256K (secp256k1) key in `.secrets/hsp/merchant_private_key.pem` (mode 600,
  gitignored). Its public key, `.secrets/hsp/merchant_public_key.pem`, is in the registration packet.
- **Registration packet** for HashKey operations: `organization_name` Likeness, `email`,
  `description`, `default_language` en, `service_rate`, `public_key`, and `supported_chain_tokens`
  (hashkey 177 USDT and hashkey-testnet 133 USDT, both Permit2).

## Fill in once HashKey replies

1. **Accept the email invite** and bind the organisation (HashKey's onboarding step 3).
2. **Create an app** in the merchant console, then copy its `app_key` and `app_secret`.
3. **Set the app's webhook URL** in the console. It must be HTTPS and reach this app's
   `/hsp/webhook`. For a local demo, use a tunnel to `http://127.0.0.1:8788`.
4. **Write `.secrets/hsp/credentials.json`** and run `chmod 600` on it:

   ```json
   {
     "baseUrl": "https://merchant-qa.hashkeymerchant.com",
     "appKey": "<app_key>",
     "appSecret": "<app_secret>",
     "permit2Spender": "<the Gateway's Permit2 spender on this chain, from HashKey>",
     "merchantName": "Likeness",
     "payMandatePath": "/api/v1/payment/pay-mandate",
     "jwtAudience": "HashkeyMerchant",
     "recordAt": "payment-included"
   }
   ```

   For mainnet, `baseUrl` is `https://hsp.hashkey.com`.

   | Field | Where it comes from | Status |
   |---|---|---|
   | `baseUrl` | HashKey docs: QA (testnet), staging or production | known |
   | `appKey`, `appSecret` | merchant console, step 2 | **waiting on HashKey** |
   | `permit2Spender` | HashKey: the address the brand's Permit2 permit must name as spender | **asked** |
   | `payMandatePath` | payer-side submit route; only shown in HashKey's architecture diagram | **asked** |
   | `jwtAudience` | docs and Go SDK say `HashkeyMerchant`; Node and Python SDKs say `HashKeyMerchant` | **asked** (the check below tells) |
   | `recordAt` | earliest HSP state at which the creator agent records on chain | our choice |

5. **Check the setup:** `cd agents && pnpm run hsp:check`.
   - It prints no secrets.
   - It checks the file's permissions, that the merchant key matches the public key sent to HashKey,
     and that HMAC authentication works, using a read-only lookup of an unknown payment.
   - `pnpm run hsp:check -- --create-order` also creates an unpaid 0.01 USD order, which proves the
     cart JWT and its audience are accepted. Nothing is paid.
6. **Run it:** `pnpm app`. The banner now reads "HSP Gateway: HashKey". Pay for one render on testnet
   and check that the webhook arrives and the payment is recorded on chain.

## Still open with HashKey

- Can the payer agent submit a Payment Mandate directly, and in what format? Specifically: where the
  Permit2 signature goes in `payment_response.details`, and the format of `user_authorization`. Both
  are isolated in `agents/src/hsp/payment.ts`.
- Does the Gateway let the payer choose the Permit2 nonce? If not, the creator agent records the nonce
  that executed (`nonceBound = false`), which already works.
- Is there a testnet USDT faucet for `0x3723…CC6`? Until then, testnet uses our `TestUSDT`.
