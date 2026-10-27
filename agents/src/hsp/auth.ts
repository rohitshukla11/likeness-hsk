import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./canonical.js";

/** HSP app credentials. The secret never leaves the process: not logged, not sent, not stored. */
export interface AppCredentials {
  appKey: string;
  appSecret: string;
}

export interface SignedRequest {
  method: string;
  path: string; // e.g. /api/v1/merchant/orders
  query: string; // without "?", or ""
  rawBody?: string; // the exact bytes sent
  timestamp: number; // unix seconds
  nonce: string;
}

/** message = "{METHOD}\n{PATH}\n{QUERY}\n{bodyHash}\n{timestamp}\n{nonce}" (docs: authentication.md). */
export function signingString(r: SignedRequest): string {
  const bodyHash = r.rawBody ? sha256Hex(r.rawBody) : "";
  return [r.method.toUpperCase(), r.path, r.query, bodyHash, String(r.timestamp), r.nonce].join("\n");
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** X-App-Key, X-Signature, X-Timestamp, X-Nonce for one Merchant API request. */
export function authHeaders(
  creds: AppCredentials,
  req: Omit<SignedRequest, "timestamp" | "nonce"> & { timestamp?: number; nonce?: string },
): Record<string, string> {
  const r: SignedRequest = {
    ...req,
    timestamp: req.timestamp ?? Math.floor(Date.now() / 1000),
    nonce: req.nonce ?? randomBytes(16).toString("hex"),
  };
  return {
    "X-App-Key": creds.appKey,
    "X-Signature": hmacHex(creds.appSecret, signingString(r)),
    "X-Timestamp": String(r.timestamp),
    "X-Nonce": r.nonce,
  };
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The Gateway's side of the check, used by the local Gateway emulator: ±300 s skew and a nonce that
 * must not repeat for the same app key within the window.
 */
export class RequestVerifier {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly secretFor: (appKey: string) => string | undefined,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  verify(headers: Record<string, string | undefined>, req: Omit<SignedRequest, "timestamp" | "nonce">): string {
    const appKey = headers["x-app-key"];
    const signature = headers["x-signature"];
    const timestamp = Number(headers["x-timestamp"]);
    const nonce = headers["x-nonce"];
    if (!appKey || !signature || !nonce || !Number.isInteger(timestamp)) throw new Error("missing auth headers");
    const secret = this.secretFor(appKey);
    if (!secret) throw new Error("unknown app key");
    const now = this.now();
    if (Math.abs(now - timestamp) > 300) throw new Error("timestamp out of tolerance");
    for (const [k, t] of this.seen) if (now - t > 300) this.seen.delete(k);
    const key = `${appKey}:${nonce}`;
    if (this.seen.has(key)) throw new Error("nonce reused");
    const expected = hmacHex(secret, signingString({ ...req, timestamp, nonce }));
    if (!safeEqualHex(expected, signature)) throw new Error("bad signature");
    this.seen.set(key, timestamp);
    return appKey;
  }
}
