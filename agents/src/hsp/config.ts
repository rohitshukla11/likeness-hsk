import { createPrivateKey, createPublicKey, createHash, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Address } from "viem";
import { DOCS_AUDIENCE } from "./jwt.js";
import { DEFAULT_PAY_MANDATE_PATH, HSP_HOSTS } from "./client.js";

/**
 * Everything the real HSP Gateway path needs, from `.secrets/hsp/credentials.json` (gitignored,
 * mode 600). See docs/HSP_SETUP.md for what HashKey supplies and where each value goes.
 */
export interface HspConfig {
  baseUrl: string; // https://hsp.hashkey.com (production) or https://merchant-qa.hashkeymerchant.com (QA, testnet)
  appKey: string; // X-App-Key, from the merchant console
  appSecret: string; // HMAC secret, from the merchant console (never logged)
  merchantKeyPath: string; // ES256K private key registered with HashKey (PEM)
  merchantName: string; // iss/sub of the cart JWT and the cart's merchant_name
  permit2Spender: Address; // the Gateway's executor on this chain: the spender the brand's permit names
  payMandatePath: string; // payer-side submit route (unconfirmed: /api/v1/payment/pay-mandate)
  jwtAudience: string; // "HashkeyMerchant" (docs, Go SDK) or "HashKeyMerchant" (Node/Python SDKs)
  recordAt: "payment-included" | "payment-safe" | "payment-finalized";
}

export interface LoadedHspConfig extends HspConfig {
  merchantKey: KeyObject;
  merchantKeyFingerprint: string; // sha256 of the SPKI public key, safe to show
}

export function hspConfigPath(root: string): string {
  return `${root}.secrets/hsp/credentials.json`;
}

/** Undefined when there are no credentials (the emulator is used on testnet). Throws if they are unsafe or incomplete. */
export function loadHspConfig(root: string): LoadedHspConfig | undefined {
  const path = hspConfigPath(root);
  if (!existsSync(path)) return undefined;
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must be readable by its owner only (chmod 600)`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HspConfig>;
  const missing = (["baseUrl", "appKey", "appSecret", "permit2Spender"] as const).filter((k) => !raw[k]);
  if (missing.length) throw new Error(`HSP credentials incomplete: ${missing.join(", ")} (see docs/HSP_SETUP.md)`);
  if (!raw.baseUrl!.startsWith("https://")) throw new Error("HSP baseUrl must be https");
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw.permit2Spender!)) throw new Error("permit2Spender must be an address");
  const merchantKeyPath = raw.merchantKeyPath ?? `${root}.secrets/hsp/merchant_private_key.pem`;
  const merchantKey = createPrivateKey(readFileSync(merchantKeyPath, "utf8"));
  if (merchantKey.asymmetricKeyDetails?.namedCurve !== "secp256k1") throw new Error("merchant key must be secp256k1 (ES256K)");
  const spki = createPublicKey(merchantKey).export({ type: "spki", format: "der" });
  return {
    baseUrl: raw.baseUrl!.replace(/\/$/, ""),
    appKey: raw.appKey!,
    appSecret: raw.appSecret!,
    merchantKeyPath,
    merchantName: raw.merchantName ?? "Likeness",
    permit2Spender: raw.permit2Spender! as Address,
    payMandatePath: raw.payMandatePath ?? DEFAULT_PAY_MANDATE_PATH,
    jwtAudience: raw.jwtAudience ?? DOCS_AUDIENCE,
    recordAt: raw.recordAt ?? "payment-included",
    merchantKey,
    merchantKeyFingerprint: createHash("sha256").update(spki).digest("hex").slice(0, 16),
  };
}

export function isKnownHspHost(baseUrl: string): boolean {
  return Object.values(HSP_HOSTS).some((h) => baseUrl.startsWith(h));
}
