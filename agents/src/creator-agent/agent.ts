import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeEventLog,
  decodeFunctionData,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { AP2_EXTENSION, A2A_PROTOCOL_VERSION, CART_MANDATE_KEY, dataOf, type AgentCard, type Message, type Task } from "../a2a/types.js";
import { sendJson, type A2AHandler } from "../a2a/server.js";
import { hspSettlementAbi, type Likeness } from "../chain/contracts.js";
import { buildCartContents, signCart, usdValue } from "../hsp/cart.js";
import type { HspClient } from "../hsp/client.js";
import { PERMIT2 } from "../hsp/payment.js";
import { verifyWebhook, type PaymentWebhook } from "../hsp/webhook.js";
import type { MessageLog } from "../log.js";

const tokenEvents = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
const permit2Abi = parseAbi([
  "function permitTransferFrom(((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, (address to, uint256 requestedAmount) transferDetails, address owner, bytes signature)",
  "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
]);

export const SKILL_TERMS = "likeness.terms";
export const SKILL_RENDER_PAYMENT = "likeness.render-payment";

export interface CreatorAgentConfig {
  creator: Address; // the creator this agent acts for
  account: LocalAccount; // the agent's own wallet, registered with HspSettlement.setAgent
  chain: Likeness;
  hsp: HspClient; // with this creator's merchant credentials
  webhookSecret: string; // the HSP app secret, used only to verify webhooks
  merchantKey: KeyObject; // ES256K key registered with HSP
  merchantName: string;
  jwtAudience?: string;
  publicUrl: string; // where this agent is reachable (card.url is publicUrl + /a2a)
  log: MessageLog;
  /** Earliest HSP state at which a payment is recorded on chain. */
  recordAt?: "payment-included" | "payment-safe" | "payment-finalized";
  cartTtlSeconds?: number;
}

/** cart_mandate_id carries the render it is for, so a webhook can be settled after a restart. */
export function cartIdFor(chainId: number, licenceId: bigint, renderIndex: number): string {
  return `LIK-${chainId}-${licenceId}-${renderIndex}-${randomUUID().slice(0, 8)}`;
}

export function parseCartId(id: string): { chainId: number; licenceId: bigint; renderIndex: number } {
  const m = /^LIK-(\d+)-(\d+)-(\d+)-[0-9a-f]{8}$/.exec(id);
  if (!m) throw new Error(`not a Likeness cart id: ${id}`);
  return { chainId: Number(m[1]), licenceId: BigInt(m[2]!), renderIndex: Number(m[3]) };
}

const STATES = ["payment-included", "payment-safe", "payment-finalized"] as const;

export class CreatorAgent implements A2AHandler {
  private readonly settling = new Map<string, Promise<unknown>>();

  constructor(private readonly c: CreatorAgentConfig) {}

  get merchantPublicKeyPem(): string {
    return createPublicKey(this.c.merchantKey).export({ type: "spki", format: "pem" }).toString();
  }

  card(): AgentCard {
    const d = this.c.chain.d;
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: `Likeness creator agent (${this.c.merchantName})`,
      description:
        "Licenses this creator's likeness for AI ads on the creator's on-chain terms, and quotes each render as an AP2 Cart Mandate paid through the HSP Gateway on HSK Chain.",
      url: `${this.c.publicUrl}/a2a`,
      preferredTransport: "JSONRPC",
      version: "0.1.0",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [
          {
            uri: AP2_EXTENSION,
            description: "AP2 merchant: returns signed Cart Mandates for the HSP Gateway",
            params: { roles: ["merchant"] },
          },
          {
            uri: "https://github.com/rohitshukla11/likeness-hsk#creator-agent",
            description: "Where this creator's terms and licences live, and the merchant key that signs carts",
            params: {
              creator: this.c.creator,
              chainId: d.chainId,
              creators: d.creators,
              licences: d.licences,
              settlement: d.settlement,
              token: d.token,
              coin: d.tokenSymbol,
              merchantName: this.c.merchantName,
              merchantPublicKey: this.merchantPublicKeyPem,
            },
          },
        ],
      },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        {
          id: SKILL_TERMS,
          name: "Licence terms",
          description: "The creator's published terms on HSK Chain: price per render, allowed uses and regions, maximum duration and render cap.",
          tags: ["licensing", "terms"],
        },
        {
          id: SKILL_RENDER_PAYMENT,
          name: "Quote a render",
          description:
            "For an active licence held by the caller's wallet: the payment conditions for its next render, as an AP2 Cart Mandate created with the HSP Gateway. Refused if the licence is revoked, expired or used up.",
          tags: ["payments", "ap2", "hsp"],
        },
      ],
    };
  }

  async onMessage(message: Message): Promise<Task> {
    const data = dataOf(message) ?? {};
    this.c.log.add("creator-agent", "a2a.request", `received ${String(data.skill ?? "message")}`, data);
    let task: Task;
    try {
      if (data.skill === SKILL_TERMS) task = await this.terms(message);
      else if (data.skill === SKILL_RENDER_PAYMENT) task = await this.quoteRender(message, BigInt(String(data.licenceId)));
      else task = this.task(message, "rejected", `unknown skill ${String(data.skill)}`);
    } catch (e) {
      task = this.task(message, "failed", e instanceof Error ? e.message : String(e));
    }
    this.c.log.add("creator-agent", "a2a.response", `${task.status.state}`, task);
    return task;
  }

  // ---------------------------------------------------------------- skills

  private async terms(message: Message): Promise<Task> {
    const ch = this.c.chain;
    const [t, payout, open] = await Promise.all([ch.terms(this.c.creator), ch.payoutOf(this.c.creator), ch.canLicense(this.c.creator)]);
    return this.task(message, "completed", open ? "terms" : "this creator is not accepting new licences", [
      {
        terms: {
          creator: this.c.creator,
          payout,
          acceptingLicences: open,
          categories: t.categories,
          regions: t.regions,
          maxDuration: t.maxDuration.toString(),
          maxRenders: t.maxRenders,
          pricePerRender: t.pricePerRender.toString(),
          autoApprove: t.autoApprove,
          token: ch.d.token,
          coin: ch.d.tokenSymbol,
          chainId: ch.d.chainId,
        },
      },
    ]);
  }

  /** Consent before money: no cart unless the licence is active, this creator's, and under its cap. */
  private async quoteRender(message: Message, licenceId: bigint): Promise<Task> {
    const ch = this.c.chain;
    const [l, status] = await Promise.all([ch.licence(licenceId), ch.status(licenceId)]);
    if (l.creator.toLowerCase() !== this.c.creator.toLowerCase()) {
      return this.refuse(message, `licence ${licenceId} is not for this creator`);
    }
    if (status !== "Active") return this.refuse(message, `licence ${licenceId} is ${status.toLowerCase()}: no further renders`);

    const renderIndex = l.renderCount;
    const payout = await ch.payoutOf(this.c.creator);
    const contents = buildCartContents({
      cartId: cartIdFor(ch.d.chainId, licenceId, renderIndex),
      paymentRequestId: `PR-${randomUUID()}`,
      merchantName: this.c.merchantName,
      network: ch.d.hspNetwork,
      chainId: ch.d.chainId,
      token: ch.d.token,
      coin: ch.d.tokenSymbol,
      payTo: payout,
      priceUnits: l.pricePerRender,
      itemLabel: `Likeness render ${renderIndex + 1} of ${l.renderCap}, licence ${licenceId}`,
      expiresAt: new Date(Date.now() + (this.c.cartTtlSeconds ?? 900) * 1000),
    });
    const cart = signCart(contents, this.c.merchantKey, { issuer: this.c.merchantName, audience: this.c.jwtAudience });
    this.c.log.add("creator-agent", "cart-mandate", `cart for licence ${licenceId} render ${renderIndex}: ${contents.payment_request.details.total.amount.value} USD`, cart);

    this.c.log.add("creator-agent", "hsp.request", "POST /api/v1/merchant/orders", { cart_mandate_id: contents.id, payment_request_id: contents.payment_request.details.id });
    const order = await this.c.hsp.createOrder(cart);
    this.c.log.add("hsp-gateway", "hsp.response", "order created", order);

    return this.task(message, "completed", `pay ${contents.payment_request.details.total.amount.value} USD for render ${renderIndex} of licence ${licenceId}`, [
      {
        [CART_MANDATE_KEY]: cart,
        hsp: { payment_request_id: order.payment_request_id, payment_url: order.payment_url, flow_id: flowIdOf(order.payment_url) },
        likeness: {
          licenceId: licenceId.toString(),
          renderIndex,
          settlement: ch.d.settlement,
          chainId: ch.d.chainId,
          boundNonce: await ch.paymentNonce(licenceId, renderIndex),
        },
      },
    ]);
  }

  // ---------------------------------------------------------------- HSP webhook → on-chain record

  async route(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<boolean> {
    if (req.method !== "POST" || req.url !== "/hsp/webhook") return false;
    const r = this.handleWebhook(rawBody, header(req, "x-signature"));
    sendJson(res, r.status, r.body);
    return true;
  }

  /**
   * Verifies an HSP webhook and starts settling it. Answers at once (HSP wants 2xx within 10 s); the
   * on-chain record happens after. Framework-agnostic: any HTTP server can call it.
   */
  handleWebhook(rawBody: string, signature: string | undefined): { status: number; body: unknown } {
    let hook: PaymentWebhook;
    try {
      hook = verifyWebhook(this.c.webhookSecret, rawBody, signature);
    } catch (e) {
      this.c.log.add("creator-agent", "refused", `webhook rejected: ${(e as Error).message}`);
      return { status: 401, body: { error: "invalid signature" } };
    }
    this.c.log.add("hsp-gateway", "hsp.webhook", `${hook.status} for ${hook.payment_request_id}`, hook);
    void this.onPaymentUpdate(hook).catch((e) => this.c.log.add("creator-agent", "error", `settling ${hook.payment_request_id} failed: ${(e as Error).message}`));
    return { status: 200, body: { ok: true } };
  }

  /** Records the payment on chain once it reaches `recordAt`. Idempotent per cart. */
  async onPaymentUpdate(p: Pick<PaymentWebhook, "cart_mandate_id" | "payment_request_id" | "status" | "tx_signature" | "status_reason">) {
    if (p.status === "payment-failed") {
      this.c.log.add("creator-agent", "info", `payment failed: ${p.status_reason ?? ""}`, p);
      return;
    }
    const at = STATES.indexOf(this.c.recordAt ?? "payment-included");
    if (STATES.indexOf(p.status as (typeof STATES)[number]) < at) return;
    const key = p.cart_mandate_id;
    if (!this.settling.has(key)) {
      const run = this.settle(p.cart_mandate_id, p.payment_request_id, p.tx_signature as Hex);
      this.settling.set(key, run);
      run.catch(() => this.settling.delete(key)); // a later webhook or poll may retry
    }
    return this.settling.get(key);
  }

  private async settle(cartId: string, paymentRequestId: string, txHash: Hex) {
    const ch = this.c.chain;
    const { chainId, licenceId, renderIndex } = parseCartId(cartId);
    if (chainId !== ch.d.chainId) throw new Error(`cart is for chain ${chainId}`);
    if (!txHash) throw new Error("webhook has no tx_signature");
    const existing = await ch.payment(licenceId, renderIndex);
    if (existing.recordedAt !== 0n) return existing;

    const l = await ch.licence(licenceId);
    const payout = await ch.payoutOf(l.creator);
    const receipt = await ch.public.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`HSP transaction ${txHash} reverted`);
    await this.atLeastBlock(receipt.blockNumber);

    // What the creator's payout actually received from the licensee in this transaction.
    let received = 0n;
    const nonces: Hex[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ch.d.token.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: tokenEvents, data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer" && same(ev.args.from, l.licensee) && same(ev.args.to, payout)) received += ev.args.value;
        if (ev.eventName === "AuthorizationUsed" && same(ev.args.authorizer, l.licensee)) nonces.push(ev.args.nonce);
      } catch {
        /* not one of ours */
      }
    }
    if (received < l.pricePerRender) {
      throw new Error(`payout received ${received}, price is ${l.pricePerRender} (tx ${txHash})`);
    }
    const nonce = await this.executedNonce(l.licensee, licenceId, renderIndex, nonces, txHash);
    const bound = nonce === (await ch.paymentNonce(licenceId, renderIndex));
    this.c.log.add("creator-agent", "info", `verified ${usdValue(received)} ${ch.d.tokenSymbol} to the payout in ${txHash}; nonce ${bound ? "bound to this render" : "chosen by the HSP Gateway"}`, {
      licenceId,
      renderIndex,
      nonce,
      received,
    });

    // A load-balanced RPC can answer the simulation from a node a block behind the payment; the
    // contract's own check (PaymentNotExecuted) is then retried, never skipped.
    let r: Awaited<ReturnType<typeof ch.write>> | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        r = await ch.write(this.c.account, {
          address: ch.d.settlement,
          abi: hspSettlementAbi,
          functionName: "recordPayment",
          args: [licenceId, renderIndex, nonce, l.pricePerRender, txHash, keccak256(toBytes(paymentRequestId))],
        });
        break;
      } catch (e) {
        if (attempt >= 6 || !String((e as Error).message).includes("PaymentNotExecuted")) throw e;
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    this.c.log.add("chain", "tx", `recordPayment(licence ${licenceId}, render ${renderIndex})`, { tx: r.transactionHash, block: r.blockNumber });
    return ch.payment(licenceId, renderIndex);
  }

  /**
   * The nonce of the licensee's authorization that executed in this transaction: from USDC.e's
   * AuthorizationUsed event (EIP-3009), or for Permit2 the bound nonce if its bit is set, else the
   * nonce in the permitTransferFrom call.
   */
  private async executedNonce(licensee: Address, licenceId: bigint, renderIndex: number, fromEvents: Hex[], txHash: Hex): Promise<Hex> {
    const ch = this.c.chain;
    const bound = await ch.paymentNonce(licenceId, renderIndex);
    if (ch.d.rail === "eip3009") {
      if (fromEvents.length === 0) throw new Error(`no AuthorizationUsed for the licensee in ${txHash}`);
      return fromEvents.find((n) => n === bound) ?? fromEvents[0]!;
    }
    const permit2 = ch.d.permit2 ?? PERMIT2;
    const n = BigInt(bound);
    const word = await ch.public.readContract({ address: permit2, abi: permit2Abi, functionName: "nonceBitmap", args: [licensee, n >> 8n] });
    if ((word >> (n & 0xffn)) & 1n) return bound;
    const tx = await ch.public.getTransaction({ hash: txHash });
    try {
      const call = decodeFunctionData({ abi: permit2Abi, data: tx.input });
      if (call.functionName === "permitTransferFrom" && same(call.args[2], licensee)) {
        return `0x${call.args[0].nonce.toString(16).padStart(64, "0")}`;
      }
    } catch {
      /* the Gateway did not call Permit2 directly */
    }
    throw new Error(`cannot read the Permit2 nonce from ${txHash}; HSP metadata needed`);
  }

  // ---------------------------------------------------------------- helpers

  private async atLeastBlock(block: bigint) {
    for (let i = 0; i < 40 && (await this.c.chain.public.getBlockNumber({ cacheTime: 0 })) < block; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private refuse(message: Message, reason: string): Task {
    this.c.log.add("creator-agent", "refused", reason);
    return this.task(message, "rejected", reason);
  }

  private task(message: Message, state: Task["status"]["state"], text: string, data: Record<string, unknown>[] = []): Task {
    const contextId = message.contextId ?? randomUUID();
    return {
      kind: "task",
      id: randomUUID(),
      contextId,
      status: {
        state,
        timestamp: new Date().toISOString(),
        message: { kind: "message", role: "agent", messageId: randomUUID(), contextId, parts: [{ kind: "text", text }] },
      },
      artifacts: data.length ? [{ artifactId: randomUUID(), name: "result", parts: data.map((d) => ({ kind: "data" as const, data: d })) }] : [],
    };
  }
}

function same(a: string | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function flowIdOf(paymentUrl: string): string | undefined {
  return /\/flow\/([^/?#]+)/.exec(paymentUrl)?.[1];
}

