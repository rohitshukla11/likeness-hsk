import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import { describe, expect, it } from "vitest";
import { authHeaders, RequestVerifier, signingString } from "../src/hsp/auth.js";
import { canonicalJson, sha256Hex } from "../src/hsp/canonical.js";
import { buildCartContents, cartHash, signCart, unitsOf, usdValue, verifyCart } from "../src/hsp/cart.js";
import { DOCS_AUDIENCE, signMerchantJwt, verifyMerchantJwt } from "../src/hsp/jwt.js";
import { verifyWebhook, webhookSignatureHeader } from "../src/hsp/webhook.js";

const merchant = () => generateKeyPairSync("ec", { namedCurve: "secp256k1" });

function cart() {
  return buildCartContents({
    cartId: "LIK-177-7-0-0a1b2c3d",
    paymentRequestId: "PR-1",
    merchantName: "Ana Reyes (Likeness)",
    network: "hashkey",
    chainId: 177,
    token: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
    coin: "USDC",
    payTo: "0x441a59D4F3f9CF57bA15E87cBa5AA741bB1bfF44",
    priceUnits: 50_000n,
    itemLabel: "Likeness render 1 of 3, licence 7",
    expiresAt: new Date(Date.now() + 600_000),
  });
}

describe("canonical JSON (docs: cart-mandate.md)", () => {
  it("matches the docs example", () => {
    expect(canonicalJson({ merchant_name: "My Store", id: "cart-123", cart_expiry: "2024-03-01T12:00:00Z" })).toBe(
      '{"cart_expiry":"2024-03-01T12:00:00Z","id":"cart-123","merchant_name":"My Store"}',
    );
  });

  it("sorts nested keys, keeps array order, drops undefined", () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }, 3], a: { y: undefined, x: true } })).toBe('{"a":{"x":true},"b":[{"a":2,"z":1},3]}');
  });
});

describe("HMAC request signing (docs: authentication.md)", () => {
  const creds = { appKey: "ak_test", appSecret: "test-secret-not-real" };

  it("builds the six-line message with an empty line for no body", () => {
    expect(signingString({ method: "get", path: "/api/v1/merchant/payments", query: "cart_mandate_id=ORDER-1", timestamp: 1709123456, nonce: "a3f1b2c4d5e6" })).toBe(
      "GET\n/api/v1/merchant/payments\ncart_mandate_id=ORDER-1\n\n1709123456\na3f1b2c4d5e6",
    );
  });

  it("agrees with the docs' openssl procedure", () => {
    const rawBody = canonicalJson({ cart_mandate: { contents: cart() } });
    const h = authHeaders(creds, { method: "POST", path: "/api/v1/merchant/orders", query: "", rawBody, timestamp: 1709123456, nonce: "a3f1b2c4d5e6" });
    const bodyHash = execFileSync("openssl", ["dgst", "-sha256", "-hex"], { input: rawBody }).toString().trim().split(" ").pop();
    const message = `POST\n/api/v1/merchant/orders\n\n${bodyHash}\n1709123456\na3f1b2c4d5e6`;
    const sig = execFileSync("openssl", ["dgst", "-sha256", "-hmac", creds.appSecret, "-hex"], { input: message }).toString().trim().split(" ").pop();
    expect(h["X-Signature"]).toBe(sig);
    expect(h["X-App-Key"]).toBe("ak_test");
  });

  it("the verifier enforces signature, ±300 s and one-time nonces", () => {
    let now = 1_709_123_456;
    const v = new RequestVerifier((k) => (k === creds.appKey ? creds.appSecret : undefined), () => now);
    const req = { method: "GET", path: "/api/v1/merchant/payments", query: "flow_id=F1" };
    const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, x]) => [k.toLowerCase(), x]));
    const h = lower(authHeaders(creds, { ...req, timestamp: now, nonce: "n1" }));
    expect(v.verify(h, req)).toBe("ak_test");
    expect(() => v.verify(h, req)).toThrow("nonce reused");
    expect(() => v.verify(lower(authHeaders(creds, { ...req, timestamp: now, nonce: "n2" })), { ...req, query: "flow_id=F2" })).toThrow("bad signature");
    expect(() => v.verify(lower(authHeaders({ ...creds, appSecret: "wrong" }, { ...req, timestamp: now, nonce: "n3" })), req)).toThrow("bad signature");
    const old = lower(authHeaders(creds, { ...req, timestamp: now, nonce: "n4" }));
    now += 301;
    expect(() => v.verify(old, req)).toThrow("timestamp out of tolerance");
  });
});

describe("merchant_authorization: ES256K JWT over the cart hash", () => {
  it("is a valid ES256K JWT for jose, the library HashKey's Node SDK uses", async () => {
    const { privateKey, publicKey } = merchant();
    const c = cart();
    const jwt = signMerchantJwt(privateKey, { issuer: "Ana Reyes (Likeness)", cartHash: cartHash(c) });
    const { payload, protectedHeader } = await jose.jwtVerify(jwt, publicKey, { audience: DOCS_AUDIENCE, algorithms: ["ES256K"] });
    expect(protectedHeader).toEqual({ alg: "ES256K", typ: "JWT" });
    expect(payload.cart_hash).toBe(sha256Hex(canonicalJson(c)));
    expect(payload.iss).toBe("Ana Reyes (Likeness)");
  });

  it("verifies jose-signed JWTs too (interop both ways)", async () => {
    const { privateKey, publicKey } = merchant();
    const jwt = await new jose.SignJWT({ cart_hash: "a".repeat(64) })
      .setProtectedHeader({ alg: "ES256K" })
      .setIssuer("m")
      .setAudience(DOCS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(verifyMerchantJwt(jwt, publicKey).cart_hash).toBe("a".repeat(64));
  });

  it("the payer rejects a changed cart, another key, another audience, an expired cart", () => {
    const { privateKey, publicKey } = merchant();
    const signed = signCart(cart(), privateKey, { issuer: "m" });
    expect(verifyCart(signed, publicKey).cart_hash).toBe(cartHash(signed.contents));

    const changed = structuredClone(signed);
    changed.contents.payment_request.method_data[0]!.data.pay_to = "0x000000000000000000000000000000000000dEaD";
    expect(() => verifyCart(changed, publicKey)).toThrow("cart_hash does not match");
    expect(() => verifyCart(signed, merchant().publicKey)).toThrow("bad JWT signature");
    expect(() => verifyCart(signed, publicKey, { audience: "HashKeyMerchant" })).toThrow("wrong JWT audience");
    expect(() => verifyCart(signed, publicKey, { now: Math.floor(Date.now() / 1000) + 3 * 3600 })).toThrow();
  });

  it("rejects a non-ES256K token", () => {
    const { publicKey } = merchant();
    const fake = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`;
    expect(() => verifyMerchantJwt(fake, createPublicKey(publicKey.export({ type: "spki", format: "pem" })))).toThrow("ES256K");
  });
});

describe("webhooks (docs: webhook.md)", () => {
  const secret = "test-secret-not-real";
  const body = JSON.stringify({ event_type: "payment", status: "payment-included", payment_request_id: "PR-1" });

  it("accepts a fresh signature over exactly these bytes", () => {
    expect(verifyWebhook(secret, body, webhookSignatureHeader(secret, body)).status).toBe("payment-included");
  });

  it("rejects a changed body, another secret, an old timestamp, a missing header", () => {
    const h = webhookSignatureHeader(secret, body);
    expect(() => verifyWebhook(secret, body.replace("included", "finalized"), h)).toThrow("mismatch");
    expect(() => verifyWebhook("other", body, h)).toThrow("mismatch");
    const t = Math.floor(Date.now() / 1000) - 301;
    expect(() => verifyWebhook(secret, body, webhookSignatureHeader(secret, body, t))).toThrow("tolerance");
    expect(() => verifyWebhook(secret, body, undefined)).toThrow("missing");
  });
});

describe("amounts", () => {
  it("base units ↔ the cart's USD decimal strings, exactly", () => {
    expect(usdValue(50_000n)).toBe("0.05");
    expect(usdValue(1_000_000n)).toBe("1.00");
    expect(usdValue(1_234_567n)).toBe("1.234567");
    expect(unitsOf("0.05")).toBe(50_000n);
    expect(unitsOf("10.0")).toBe(10_000_000n);
    expect(unitsOf("1.2345670")).toBe(1_234_567n);
    expect(() => unitsOf("0.0000001")).toThrow();
    expect(() => unitsOf("-1")).toThrow();
  });
});
