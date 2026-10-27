import { hmacHex, safeEqualHex } from "./auth.js";

/** The payment states HSP reports by webhook (docs: webhook.md). */
export type WebhookStatus = "payment-included" | "payment-safe" | "payment-finalized" | "payment-failed";

/** Webhook payload. Amounts are token-denominated decimal strings, not base units. */
export interface PaymentWebhook {
  event_type: "payment";
  payment_request_id: string;
  request_id: string;
  cart_mandate_id: string;
  payer_address: string;
  to_pay_address: string;
  amount: string;
  token: string;
  token_address: string;
  chain: string; // CAIP-2, e.g. eip155:177
  network: string;
  status: WebhookStatus;
  status_reason?: string;
  tx_signature?: string;
  created_at: string;
  [extra: string]: unknown;
}

/** X-Signature: t=<unix>,v1=<hex(HMAC-SHA256(app_secret, t + "." + raw_body))>. */
export function webhookSignatureHeader(appSecret: string, rawBody: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmacHex(appSecret, `${t}.${rawBody}`)}`;
}

/** Throws unless the header is a valid signature of exactly these bytes, within ±300 s. */
export function verifyWebhook(
  appSecret: string,
  rawBody: string,
  header: string | undefined,
  now = Math.floor(Date.now() / 1000),
): PaymentWebhook {
  if (!header) throw new Error("missing X-Signature");
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") t = Number(v);
    if (k === "v1") v1 = v;
  }
  if (t === undefined || !Number.isInteger(t) || !v1) throw new Error("malformed X-Signature");
  if (Math.abs(now - t) > 300) throw new Error("webhook timestamp out of tolerance");
  if (!safeEqualHex(hmacHex(appSecret, `${t}.${rawBody}`), v1)) throw new Error("webhook signature mismatch");
  return JSON.parse(rawBody) as PaymentWebhook;
}
