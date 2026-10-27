import { authHeaders, type AppCredentials } from "./auth.js";
import { canonicalJson } from "./canonical.js";
import type { CartMandate } from "./cart.js";
import type { PaymentMandate } from "./payment.js";
import type { WebhookStatus } from "./webhook.js";

/** Base URLs (docs: api-reference.md). QA is testnet; staging and production take mainnet tokens. */
export const HSP_HOSTS = {
  qa: "https://merchant-qa.hashkeymerchant.com",
  staging: "https://merchant-stg.hashkeymerchant.com",
  production: "https://hsp.hashkey.com",
} as const;

/**
 * Payer-side submit route. It appears in HashKey's architecture diagram but its request is not
 * published (asked); configurable until confirmed.
 */
export const DEFAULT_PAY_MANDATE_PATH = "/api/v1/payment/pay-mandate";

export type PaymentStatus =
  | "payment-required"
  | "payment-submitted"
  | "payment-verified"
  | "payment-processing"
  | WebhookStatus;

export interface PaymentRecord {
  payment_request_id: string;
  cart_mandate_id: string;
  flow_id?: string;
  payer_address?: string;
  to_pay_address?: string;
  amount?: string;
  token?: string;
  token_address?: string;
  chain?: string;
  status: PaymentStatus;
  status_reason?: string;
  tx_signature?: string;
  [extra: string]: unknown;
}

export class HspError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface HspClientOptions {
  baseUrl: string;
  credentials?: AppCredentials; // merchant calls only
  payMandatePath?: string;
  fetch?: typeof fetch;
}

export class HspClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: HspClientOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  // ---------------------------------------------------------------- merchant (HMAC)

  /** POST /api/v1/merchant/orders: returns the payment URL and ids for a one-time cart. */
  createOrder(cart: CartMandate, redirectUrl?: string) {
    return this.merchant<{ payment_request_id: string; payment_url: string; multi_pay: boolean; [k: string]: unknown }>(
      "POST",
      "/api/v1/merchant/orders",
      "",
      { cart_mandate: cart, redirect_url: redirectUrl },
    );
  }

  /** GET /api/v1/merchant/payments by exactly one id. */
  getPayment(by: { payment_request_id: string } | { cart_mandate_id: string } | { flow_id: string }) {
    const [k, v] = Object.entries(by)[0] as [string, string];
    return this.merchant<PaymentRecord>("GET", "/api/v1/merchant/payments", `${k}=${encodeURIComponent(v)}`);
  }

  /** Polls until the payment reaches `until` (or a later or terminal state). */
  async waitForStatus(
    by: { payment_request_id: string },
    until: "payment-included" | "payment-safe" | "payment-finalized" = "payment-included",
    { intervalMs = 2000, timeoutMs = 180_000 } = {},
  ): Promise<PaymentRecord> {
    const order: PaymentStatus[] = ["payment-included", "payment-safe", "payment-finalized"];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await this.getPayment(by);
      if (p.status === "payment-failed") throw new HspError(200, undefined, `payment failed: ${p.status_reason ?? ""}`);
      if (order.indexOf(p.status) >= order.indexOf(until)) return p;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${until} (last: ${p.status})`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ---------------------------------------------------------------- payer

  /** Submit the payer's AP2 Payment Mandate to the Gateway, which verifies it and executes on chain. */
  submitPaymentMandate(mandate: PaymentMandate) {
    return this.send<{ flow_id: string; tx_signature?: string; metadata?: Record<string, unknown> }>(
      "POST",
      this.opts.payMandatePath ?? DEFAULT_PAY_MANDATE_PATH,
      "",
      mandate,
      {},
    );
  }

  /** GET /api/v1/checkout/orders/{flow_id}: the public checkout view of an order (no auth). */
  checkoutOrder(flowId: string) {
    return this.send<Record<string, unknown>>("GET", `/api/v1/checkout/orders/${encodeURIComponent(flowId)}`, "", undefined, {});
  }

  // ---------------------------------------------------------------- transport

  private merchant<T>(method: string, path: string, query: string, body?: unknown): Promise<T> {
    if (!this.opts.credentials) throw new Error("merchant credentials required");
    const rawBody = body === undefined ? undefined : canonicalJson(body);
    return this.send<T>(method, path, query, body, authHeaders(this.opts.credentials, { method, path, query, rawBody }), rawBody);
  }

  private async send<T>(
    method: string,
    path: string,
    query: string,
    body: unknown,
    headers: Record<string, string>,
    rawBody = body === undefined ? undefined : canonicalJson(body),
  ): Promise<T> {
    const url = `${this.opts.baseUrl}${path}${query ? `?${query}` : ""}`;
    const res = await this.fetch(url, {
      method,
      headers: { ...(rawBody ? { "Content-Type": "application/json" } : {}), ...headers },
      body: rawBody,
    });
    const text = await res.text();
    let env: { code?: number; msg?: string; data?: T };
    try {
      env = JSON.parse(text);
    } catch {
      throw new HspError(res.status, undefined, `non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok || env.code !== 0) throw new HspError(res.status, env.code, env.msg ?? `HTTP ${res.status}`);
    return env.data as T;
  }
}
