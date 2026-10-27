import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";

/**
 * ES256K JWT for `cart_mandate.merchant_authorization` (docs: authentication.md). The audience is
 * "HashkeyMerchant" in the docs and the Go SDK but "HashKeyMerchant" in the Node and Python SDKs; it
 * is configurable until HashKey confirms which one the Gateway checks.
 */
export const DOCS_AUDIENCE = "HashkeyMerchant";

export interface MerchantClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  cart_hash: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** PEM (PKCS8 or SEC1) or an existing KeyObject; must be a secp256k1 key. */
export function merchantKey(pem: string | KeyObject): KeyObject {
  const key = typeof pem === "string" ? createPrivateKey(pem) : pem;
  if (key.asymmetricKeyDetails?.namedCurve !== "secp256k1") throw new Error("merchant key must be secp256k1");
  return key;
}

export function signMerchantJwt(
  key: KeyObject,
  input: { issuer: string; cartHash: string; ttlSeconds?: number; audience?: string; now?: number },
): string {
  const iat = input.now ?? Math.floor(Date.now() / 1000);
  const claims: MerchantClaims = {
    iss: input.issuer,
    sub: input.issuer,
    aud: input.audience ?? DOCS_AUDIENCE,
    iat,
    exp: iat + (input.ttlSeconds ?? 3600),
    jti: `JWT-${iat}-${randomUUID()}`,
    cart_hash: input.cartHash,
  };
  const signingInput = `${b64url(JSON.stringify({ alg: "ES256K", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  // JWS ES256K: the 64-byte r || s form (RFC 8812), not DER.
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

/** Verifies signature, algorithm, audience and expiry; returns the claims. */
export function verifyMerchantJwt(
  jwt: string,
  publicKey: string | KeyObject,
  opts: { audience?: string; now?: number } = {},
): MerchantClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (header.alg !== "ES256K") throw new Error("JWT must be ES256K");
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad JWT signature");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as MerchantClaims;
  if (claims.aud !== (opts.audience ?? DOCS_AUDIENCE)) throw new Error("wrong JWT audience");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!(claims.exp > now)) throw new Error("JWT expired");
  if (!/^[0-9a-f]{64}$/.test(claims.cart_hash)) throw new Error("bad cart_hash");
  return claims;
}
