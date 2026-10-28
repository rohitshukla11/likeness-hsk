// Checks the real HSP Gateway setup without printing any secret.
//
//   pnpm run hsp:check                      config, merchant key, and a read-only HMAC call
//   pnpm run hsp:check -- --create-order    also creates a 0.01 USD one-time order (nothing is paid)
import { createPublicKey, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCartContents, signCart } from "../src/hsp/cart.js";
import { HspClient, HspError } from "../src/hsp/client.js";
import { hspConfigPath, isKnownHspHost, loadHspConfig } from "../src/hsp/config.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => {
  console.log(`  FAIL  ${m}`);
  process.exitCode = 1;
};

console.log(`HSP setup check (${hspConfigPath(root)})`);
const c = loadHspConfig(root);
if (!c) {
  bad("no credentials file yet: the app uses the local emulator on testnet (see docs/HSP_SETUP.md)");
  process.exit(1);
}
ok(`file is private; base URL ${c.baseUrl}${isKnownHspHost(c.baseUrl) ? "" : " (not one of HashKey's documented hosts)"}`);
ok(`app key ${c.appKey.slice(0, 4)}… (secret loaded, not shown)`);
ok(`merchant key secp256k1, fingerprint ${c.merchantKeyFingerprint}`);
const registered = readFileSync(`${root}.secrets/hsp/merchant_public_key.pem`, "utf8").trim();
const mine = createPublicKey(c.merchantKey).export({ type: "spki", format: "pem" }).toString().trim();
mine === registered ? ok("merchant key matches merchant_public_key.pem (the one sent to HashKey)") : bad("merchant key does NOT match merchant_public_key.pem");
ok(`Permit2 spender ${c.permit2Spender}; payer submit path ${c.payMandatePath}; JWT audience ${c.jwtAudience}; record at ${c.recordAt}`);

const hsp = new HspClient({ baseUrl: c.baseUrl, credentials: { appKey: c.appKey, appSecret: c.appSecret }, payMandatePath: c.payMandatePath });
try {
  await hsp.getPayment({ payment_request_id: `likeness-hsp-check-${randomUUID()}` });
  ok("HMAC auth accepted (an unknown id was answered)");
} catch (e) {
  if (e instanceof HspError && e.code === 10003) ok("HMAC auth accepted (unknown payment id → 10003 not found, as expected)");
  else if (e instanceof HspError && e.code === 10002) bad("HMAC auth rejected (10002): app key, secret or clock");
  else bad(`Gateway call failed: ${(e as Error).message}`);
}

if (process.argv.includes("--create-order")) {
  const dep = JSON.parse(readFileSync(`${root}deployments/${process.env.LIKENESS_MODE === "mainnet" ? "mainnet" : "testnet"}.json`, "utf8"));
  const contents = buildCartContents({
    cartId: `LIK-CHECK-${randomUUID().slice(0, 8)}`,
    paymentRequestId: `PR-CHECK-${randomUUID()}`,
    merchantName: c.merchantName,
    network: dep.hspNetwork,
    chainId: dep.chainId,
    token: dep.testToken ? "0x372325443233fEbaC1F6998aC750276468c83CC6" : dep.token,
    coin: "USDT",
    payTo: dep.owner,
    priceUnits: 10_000n,
    itemLabel: "Likeness HSP setup check (not for payment)",
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  try {
    const order = await hsp.createOrder(signCart(contents, c.merchantKey, { issuer: c.merchantName, audience: c.jwtAudience }));
    ok(`cart JWT accepted; order ${order.payment_request_id} created (payment URL ${order.payment_url}); it expires unpaid in 10 minutes`);
  } catch (e) {
    bad(`order rejected: ${(e as Error).message} — if 10002, try jwtAudience "HashKeyMerchant"`);
  }
}
