import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createWalletClient,
  http,
  parseAbi,
  recoverMessageAddress,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { readBody, sendJson } from "../a2a/server.js";
import { RequestVerifier } from "./auth.js";
import { cartHash, unitsOf, verifyCart, type CartMandate } from "./cart.js";
import type { PaymentRecord, PaymentStatus } from "./client.js";
import { DEFAULT_PAY_MANDATE_PATH } from "./client.js";
import { paymentMandateHash, PERMIT2, type PaymentMandate } from "./payment.js";
import { webhookSignatureHeader } from "./webhook.js";

/**
 * A local stand-in for the HSP Gateway, for tests and demos before credentials arrive. It follows
 * HashKey's published Merchant API (HMAC auth, ES256K cart JWT, the state machine, signed webhooks)
 * and the payer-side flow as we read it. It is not HashKey's service and is never presented as one.
 */
export interface EmulatorMerchant {
  appKey: string;
  appSecret: string;
  merchantPublicKeyPem: string;
  webhookUrl?: string;
}

export interface EmulatorOptions {
  chain: Chain;
  rpcUrl: string;
  publicClient: PublicClient;
  executor: LocalAccount; // broadcasts the payer's authorization (and is the Permit2 spender)
  nonceMode: "payer" | "gateway";
  jwtAudience?: string;
  stepDelayMs?: number;
}

interface Order {
  appKey: string;
  cart: CartMandate;
  flowId: string;
  status: PaymentStatus;
  statusReason?: string;
  gatewayNonce?: Hex;
  payer?: Address;
  txHash?: Hex;
  requestId?: string;
}

const tokenAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);
const permit2Abi = parseAbi([
  "function permitTransferFrom(((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (address to, uint256 requestedAmount) transferDetails, address owner, bytes signature)",
]);

const ok = (data: unknown) => ({ code: 0, msg: "success", data });
const err = (code: number, msg: string) => ({ code, msg });

export class HspGatewayEmulator {
  readonly orders = new Map<string, Order>(); // by payment_request_id
  private readonly merchants = new Map<string, EmulatorMerchant>();
  private readonly verifier = new RequestVerifier((k) => this.merchants.get(k)?.appSecret);
  private server?: Server;
  baseUrl = "";

  constructor(private readonly o: EmulatorOptions) {}

  registerMerchant(m: EmulatorMerchant) {
    this.merchants.set(m.appKey, m);
  }

  setWebhook(appKey: string, url: string) {
    const m = this.merchants.get(appKey);
    if (m) m.webhookUrl = url;
  }

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const raw = req.method === "POST" ? await readBody(req) : "";
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
        const query = url.search.slice(1);

        if (url.pathname.startsWith("/api/v1/merchant/")) {
          let appKey: string;
          try {
            appKey = this.verifier.verify(headers, { method: req.method ?? "GET", path: url.pathname, query, rawBody: raw || undefined });
          } catch (e) {
            return sendJson(res, 401, err(10002, `unauthorized: ${(e as Error).message}`));
          }
          if (req.method === "POST" && url.pathname === "/api/v1/merchant/orders") return this.createOrder(res, appKey, raw);
          if (req.method === "GET" && url.pathname === "/api/v1/merchant/payments") return this.getPayment(res, appKey, url.searchParams);
          return sendJson(res, 404, err(10003, "not found"));
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/v1/checkout/orders/")) {
          const flowId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
          const o = [...this.orders.values()].find((x) => x.flowId === flowId);
          if (!o) return sendJson(res, 404, err(10003, "not found"));
          return sendJson(res, 200, ok({ flow_id: o.flowId, payment_request_id: o.cart.contents.payment_request.details.id, status: o.status, authorization_nonce: o.gatewayNonce }));
        }
        if (req.method === "POST" && url.pathname === DEFAULT_PAY_MANDATE_PATH) return await this.payMandate(res, raw);
        return sendJson(res, 404, err(10003, "not found"));
      } catch (e) {
        return sendJson(res, 500, err(10005, (e as Error).message));
      }
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    const a = this.server.address();
    this.baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    return this.baseUrl;
  }

  stop() {
    this.server?.close();
  }

  // ---------------------------------------------------------------- merchant

  private createOrder(res: Parameters<typeof sendJson>[0], appKey: string, raw: string) {
    const body = JSON.parse(raw) as { cart_mandate?: CartMandate };
    const cart = body.cart_mandate;
    if (!cart?.contents?.payment_request?.details?.id) return sendJson(res, 400, err(10001, "invalid parameters"));
    try {
      verifyCart(cart, this.merchants.get(appKey)!.merchantPublicKeyPem, { audience: this.o.jwtAudience });
    } catch (e) {
      return sendJson(res, 401, err(10002, `merchant_authorization: ${(e as Error).message}`));
    }
    const id = cart.contents.payment_request.details.id;
    if (this.orders.has(id)) return sendJson(res, 409, err(10004, "duplicate payment_request_id"));
    const flowId = randomUUID();
    this.orders.set(id, {
      appKey,
      cart,
      flowId,
      status: "payment-required",
      gatewayNonce: this.o.nonceMode === "gateway" ? (`0x${randomBytes(32).toString("hex")}` as Hex) : undefined,
    });
    return sendJson(res, 200, ok({ payment_request_id: id, payment_url: `${this.baseUrl}/flow/${flowId}`, multi_pay: false }));
  }

  private getPayment(res: Parameters<typeof sendJson>[0], appKey: string, q: URLSearchParams) {
    const o = [...this.orders.values()].find(
      (x) =>
        x.appKey === appKey &&
        (x.cart.contents.payment_request.details.id === q.get("payment_request_id") ||
          x.cart.contents.id === q.get("cart_mandate_id") ||
          x.flowId === q.get("flow_id")),
    );
    if (!o) return sendJson(res, 404, err(10003, "not found"));
    return sendJson(res, 200, ok(this.record(o)));
  }

  private record(o: Order): PaymentRecord {
    const m = o.cart.contents.payment_request.method_data[0]!;
    return {
      payment_request_id: o.cart.contents.payment_request.details.id,
      cart_mandate_id: o.cart.contents.id,
      request_id: o.requestId,
      flow_id: o.flowId,
      payer_address: o.payer,
      to_pay_address: m.data.pay_to,
      amount: o.cart.contents.payment_request.details.total.amount.value,
      token: m.data.coin,
      token_address: m.data.contract_address,
      chain: `eip155:${m.data.chain_id}`,
      network: m.data.network,
      status: o.status,
      status_reason: o.statusReason,
      tx_signature: o.txHash,
      created_at: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------- payer

  private async payMandate(res: Parameters<typeof sendJson>[0], raw: string) {
    const m = JSON.parse(raw) as PaymentMandate;
    const c = m.payment_mandate_contents;
    const o = c && this.orders.get(c.payment_mandate_id);
    if (!o) return sendJson(res, 404, err(10003, "unknown payment_mandate_id"));
    if (o.status !== "payment-required") return sendJson(res, 400, err(40001, "mandate already consumed"));
    if (Date.parse(o.cart.contents.cart_expiry) <= Date.now()) return sendJson(res, 400, err(40001, "cart expired"));
    const method = o.cart.contents.payment_request.method_data[0]!;
    const total = o.cart.contents.payment_request.details.total;
    if (c.payment_details_total.amount.value !== total.amount.value) return sendJson(res, 400, err(10001, "total does not match the cart"));
    const p = c.payment_response.details.payload;
    const units = unitsOf(total.amount.value);

    // The payer's binding of its signature to this cart and this mandate.
    let payer: Address;
    try {
      const ua = JSON.parse(Buffer.from(m.user_authorization, "base64url").toString("utf8"));
      if (ua.cart_hash !== cartHash(o.cart.contents) || ua.payment_mandate_hash !== paymentMandateHash(c)) throw new Error("hash mismatch");
      const message = `HSP payment mandate\ncart_hash:${ua.cart_hash}\npayment_mandate_hash:${ua.payment_mandate_hash}`;
      payer = await recoverMessageAddress({ message, signature: ua.signature });
    } catch (e) {
      return sendJson(res, 401, err(10002, `user_authorization: ${(e as Error).message}`));
    }

    let nonce: Hex;
    if (p.rail === "eip3009") {
      const a = p.authorization;
      if (a.from.toLowerCase() !== payer.toLowerCase()) return sendJson(res, 401, err(10002, "authorization is not from the payer"));
      if (a.to.toLowerCase() !== method.data.pay_to.toLowerCase() || BigInt(a.value) !== units) {
        return sendJson(res, 400, err(10001, "authorization does not match the cart"));
      }
      nonce = a.nonce;
    } else {
      if (p.owner.toLowerCase() !== payer.toLowerCase()) return sendJson(res, 401, err(10002, "permit is not from the payer"));
      if (p.permit.spender.toLowerCase() !== this.o.executor.address.toLowerCase() || BigInt(p.permit.amount) !== units) {
        return sendJson(res, 400, err(10001, "permit does not match the cart"));
      }
      nonce = `0x${BigInt(p.permit.nonce).toString(16).padStart(64, "0")}`;
    }
    if (o.gatewayNonce && nonce !== o.gatewayNonce) return sendJson(res, 400, err(10001, "authorization must use the nonce this checkout assigned"));

    o.payer = payer;
    o.requestId = c.payment_details_id;
    o.status = "payment-submitted";
    o.status = "payment-verified";
    o.status = "payment-processing";
    const wallet = createWalletClient({ account: this.o.executor, chain: this.o.chain, transport: http(this.o.rpcUrl) });
    let hash: Hex;
    try {
      hash =
        p.rail === "eip3009"
          ? await wallet.writeContract({
              address: method.data.contract_address as Address,
              abi: tokenAbi,
              functionName: "transferWithAuthorization",
              args: [p.authorization.from, p.authorization.to, units, BigInt(p.authorization.validAfter), BigInt(p.authorization.validBefore), p.authorization.nonce, p.signature],
            })
          : await wallet.writeContract({
              address: (this.permit2 ?? PERMIT2) as Address,
              abi: permit2Abi,
              functionName: "permitTransferFrom",
              args: [
                { permitted: { token: p.permit.token, amount: units }, nonce: BigInt(p.permit.nonce), deadline: BigInt(p.permit.deadline) },
                { to: method.data.pay_to as Address, requestedAmount: units },
                p.owner,
                p.signature,
              ],
            });
      const r = await this.o.publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("reverted");
    } catch (e) {
      o.status = "payment-failed";
      o.statusReason = `on-chain execution failed: ${(e as Error).message.split("\n")[0]}`;
      void this.notify(o);
      return sendJson(res, 400, err(10001, o.statusReason));
    }
    o.txHash = hash;
    o.status = "payment-included";
    void this.progress(o);
    return sendJson(res, 200, ok({ flow_id: o.flowId, tx_signature: hash }));
  }

  /** For the Permit2 rail in tests, where Permit2 is a local deployment. */
  permit2?: Address;

  private async progress(o: Order) {
    await this.notify(o);
    for (const s of ["payment-safe", "payment-finalized"] as const) {
      await new Promise((r) => setTimeout(r, this.o.stepDelayMs ?? 50));
      o.status = s;
      if (s === "payment-finalized") o.statusReason = "Block finalized (emulator)";
      await this.notify(o);
    }
  }

  private async notify(o: Order) {
    const m = this.merchants.get(o.appKey);
    if (!m?.webhookUrl) return;
    const body = JSON.stringify({ event_type: "payment", ...this.record(o) });
    await fetch(m.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Signature": webhookSignatureHeader(m.appSecret, body) },
      body,
    }).catch(() => undefined);
  }
}
