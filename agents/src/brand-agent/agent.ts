import { decodeEventLog, keccak256, toBytes, type Address, type Hex, type LocalAccount } from "viem";
import { fetchAgentCard, sendMessage, userMessage } from "../a2a/client.js";
import { CART_MANDATE_KEY, dataOf, textOf, type AgentCard, type Task } from "../a2a/types.js";
import { licenseRegistryAbi, type Likeness } from "../chain/contracts.js";
import { unitsOf, usdValue, verifyCart, type CartMandate } from "../hsp/cart.js";
import type { HspClient } from "../hsp/client.js";
import { buildPaymentMandate, signEip3009, signPermit2, type ExactPayload } from "../hsp/payment.js";
import type { MessageLog } from "../log.js";
import { type HspAgentic, MERCHANT_NAME } from "../hsp/agentic/client.js";
import type { PaymentOption } from "../hsp/agentic/chainConfig.js";
import { type Approver, PaymentCancelled, payWithHsp } from "../hsp/agentic/payer.js";
import { Budget, checkTerms, type BrandPolicy, type TermsView } from "./policy.js";

const SKILL_TERMS = "likeness.terms";
const SKILL_RENDER_PAYMENT = "likeness.render-payment";

export interface BrandAgentConfig {
  account: LocalAccount; // the brand wallet: licensee and payer
  chain: Likeness;
  hsp: HspClient; // payer side (no merchant credentials)
  policy: BrandPolicy;
  log: MessageLog;
  jwtAudience?: string;
  /** The Gateway's executor address, the Permit2 spender (USDT rail only). */
  permit2Spender?: Address;
  fetch?: typeof fetch;
  /**
   * HSP Agentic Payment (MCP): HSP builds the eip712 and the JWT; this agent signs the eip712 with the
   * brand wallet, only after `approve` says yes, and again before submission. `option` is the network
   * and token chosen from get_chain_config; balances are read from the chain HSP pays on.
   */
  agentic?: { hsp: HspAgentic; option: PaymentOption; approve: Approver; balanceOf: (token: Address, owner: Address) => Promise<bigint> };
}

export interface CreatorConnection {
  card: AgentCard;
  creator: Address;
  merchantPublicKey: string;
}

export class Refused extends Error {}

export interface RenderPaid {
  licenceId: bigint;
  renderIndex: number;
  paymentRequestId: string;
  flowId?: string;
  nonce: Hex;
  nonceBound: boolean;
  txHash: Hex;
  /** HSP Agentic Payment: the locked raw amount authorized (raw token units, not funds received). */
  tokenTotalRaw?: string;
}

export class BrandAgent {
  readonly budget: Budget;

  constructor(private readonly c: BrandAgentConfig) {
    this.budget = new Budget(c.policy);
  }

  /** Reads the creator agent's card; checks it serves this chain and deployment. */
  async connect(agentUrl: string): Promise<CreatorConnection> {
    const card = await fetchAgentCard(agentUrl, this.c.fetch);
    const ext = card.capabilities.extensions?.find((e) => e.params && "merchantPublicKey" in e.params)?.params as
      | { creator: Address; chainId: number; licences: Address; settlement: Address; merchantPublicKey: string }
      | undefined;
    if (!ext) throw new Error("not a Likeness creator agent");
    const d = this.c.chain.d;
    if (ext.chainId !== d.chainId || !same(ext.licences, d.licences) || !same(ext.settlement, d.settlement)) {
      throw new Error("creator agent is on a different deployment");
    }
    this.c.log.add("brand-agent", "info", `connected to ${card.name}`, { url: card.url, creator: ext.creator });
    return { card, creator: ext.creator, merchantPublicKey: ext.merchantPublicKey };
  }

  /** Asks the creator agent for terms, then checks them against the brand's policy and the chain. */
  async terms(conn: CreatorConnection, category: number): Promise<TermsView> {
    const task = await this.ask(conn, { skill: SKILL_TERMS });
    const t = (dataOf(task.artifacts?.[0] ?? { parts: [] }) as { terms?: Record<string, unknown> })?.terms;
    if (!t) throw new Error(`no terms: ${textOf(task.status.message ?? { parts: [] })}`);
    // The chain is the source of truth; the agent's answer must agree with it.
    const onChain = await this.c.chain.terms(conn.creator);
    const view: TermsView = {
      pricePerRender: onChain.pricePerRender,
      categories: onChain.categories,
      maxRenders: onChain.maxRenders,
      autoApprove: onChain.autoApprove,
      acceptingLicences: await this.c.chain.canLicense(conn.creator),
    };
    if (String(t.pricePerRender) !== view.pricePerRender.toString()) throw new Error("creator agent's terms differ from the chain");
    const v = checkTerms(this.c.policy, view, category);
    this.c.log.add("brand-agent", "policy", v.ok ? "terms accepted" : `terms refused: ${v.reason}`, { terms: view, category });
    if (!v.ok) throw new Refused(v.reason);
    return view;
  }

  /** Takes an auto-approved licence on chain, within the creator's published terms. */
  async license(
    conn: CreatorConnection,
    r: { category: number; regions: number; durationSeconds: bigint; renderCap: number; purpose: string },
  ): Promise<bigint> {
    const t = await this.terms(conn, r.category);
    if (r.renderCap > this.c.policy.maxRendersPerLicence) throw new Refused("render cap above the brand's policy");
    const ch = this.c.chain;
    const receipt = await ch.write(this.c.account, {
      address: ch.d.licences,
      abi: licenseRegistryAbi,
      functionName: "request",
      args: [
        {
          creator: conn.creator,
          category: r.category,
          regions: r.regions,
          duration: r.durationSeconds,
          renderCap: r.renderCap,
          pricePerRender: t.pricePerRender,
          purposeHash: keccak256(toBytes(r.purpose)),
          deadline: 0n,
          salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
        },
        "0x",
      ],
    });
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: licenseRegistryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "LicenceIssued") {
          this.c.log.add("chain", "tx", `licence ${ev.args.id} issued`, { tx: receipt.transactionHash, id: ev.args.id });
          return ev.args.id;
        }
      } catch {
        /* other events */
      }
    }
    throw new Error("no LicenceIssued event");
  }

  /**
   * One paid render: consent first (licence active on chain, else nothing is signed), then the cart
   * from the creator's agent, every field checked, then the wallet signature and the HSP Gateway.
   */
  async payForRender(conn: CreatorConnection, licenceId: bigint): Promise<RenderPaid> {
    const ch = this.c.chain;
    const me = this.c.account.address;
    const [l, status] = await Promise.all([ch.licence(licenceId), ch.status(licenceId)]);
    if (!same(l.licensee, me)) throw new Refused(`licence ${licenceId} is not held by this brand`);
    if (status !== "Active") return this.refuse(`licence ${licenceId} is ${status.toLowerCase()}: not paying`);

    const task = await this.ask(conn, { skill: SKILL_RENDER_PAYMENT, licenceId: licenceId.toString() });
    if (task.status.state !== "completed") return this.refuse(`creator agent ${task.status.state}: ${textOf(task.status.message ?? { parts: [] })}`);
    if (this.c.agentic) return this.payAgentic(conn, licenceId, l, task);
    const art = dataOf(task.artifacts?.[0] ?? { parts: [] }) as {
      [CART_MANDATE_KEY]: CartMandate;
      hsp: { payment_request_id: string; payment_url: string; flow_id?: string };
      likeness: { licenceId: string; renderIndex: number };
    };
    const cart = art[CART_MANDATE_KEY];

    // 1. The merchant signed exactly this cart, and it is current.
    verifyCart(cart, conn.merchantPublicKey, { audience: this.c.jwtAudience });
    // 2. It is for this licence's next render, paid to the creator's payout, at the licence price, in our token.
    const renderIndex = l.renderCount;
    if (art.likeness.licenceId !== licenceId.toString() || art.likeness.renderIndex !== renderIndex) {
      throw new Error("cart is for a different render");
    }
    const method = cart.contents.payment_request.method_data[0];
    if (!method) throw new Error("cart has no payment method");
    const payout = await ch.payoutOf(conn.creator);
    if (method.data.chain_id !== ch.d.chainId) throw new Error("cart is for another chain");
    if (!same(method.data.contract_address, ch.d.token)) throw new Error("cart asks for another token");
    if (!same(method.data.pay_to, payout)) throw new Error("cart pays someone other than the creator's on-chain payout");
    const amount = unitsOf(cart.contents.payment_request.details.total.amount.value);
    if (amount !== l.pricePerRender) throw new Error(`cart total ${usdValue(amount)} is not the licence price ${usdValue(l.pricePerRender)}`);
    // 3. Within the brand's budget.
    const b = this.budget.check(amount);
    if (!b.ok) return this.refuse(b.reason);
    this.c.log.add("brand-agent", "policy", `cart accepted: ${usdValue(amount)} USD to ${payout} for render ${renderIndex}`, {
      payment_request_id: art.hsp.payment_request_id,
    });

    // 4. The nonce: bound to this render, unless the Gateway assigns one for this checkout.
    const bound = await ch.paymentNonce(licenceId, renderIndex);
    const assigned = art.hsp.flow_id ? await this.gatewayNonce(art.hsp.flow_id) : undefined;
    const nonce = assigned ?? bound;

    // 5. Sign, wrap in the AP2 Payment Mandate, submit to the HSP Gateway.
    const payload = await this.sign(payout, amount, nonce);
    const mandate = await buildPaymentMandate(this.c.account, cart, payload);
    this.c.log.add("brand-agent", "payment-mandate", `signed ${ch.d.rail === "eip3009" ? "EIP-3009" : "Permit2"} authorization, nonce ${nonce === bound ? "bound to the render" : "from the Gateway"}`, mandate);
    this.c.log.add("brand-agent", "hsp.request", "submit Payment Mandate", { payment_mandate_id: mandate.payment_mandate_contents.payment_mandate_id });
    const submitted = await this.c.hsp.submitPaymentMandate(mandate);
    this.c.log.add("hsp-gateway", "hsp.response", "Payment Mandate accepted", submitted);
    this.budget.record(amount);

    return {
      licenceId,
      renderIndex,
      paymentRequestId: art.hsp.payment_request_id,
      flowId: submitted.flow_id ?? art.hsp.flow_id,
      nonce,
      nonceBound: nonce === bound,
      txHash: (submitted.tx_signature ?? "0x") as Hex,
    };
  }

  /**
   * HSP Agentic Payment: the order the creator's agent created is checked against the licence (team
   * name, the creator's on-chain payout, the price in USD, the chain and token from get_chain_config)
   * and the brand's budget; then prepare → approval → sign the returned eip712 → finalize → approval →
   * submit. Nothing is signed or submitted without the approvals.
   */
  private async payAgentic(conn: CreatorConnection, licenceId: bigint, l: Awaited<ReturnType<Likeness["licence"]>>, task: Task): Promise<RenderPaid> {
    const { hsp, option, approve, balanceOf } = this.c.agentic!;
    const ch = this.c.chain;
    const art = dataOf(task.artifacts?.[0] ?? { parts: [] }) as { hsp: { flow_id: string; payment_request_id: string }; likeness: { licenceId: string; renderIndex: number } };
    const renderIndex = l.renderCount;
    if (art.likeness?.licenceId !== licenceId.toString() || art.likeness.renderIndex !== renderIndex) throw new Error("the order is for a different render");
    if (!art.hsp?.flow_id) throw new Error("the creator agent returned no HSP order");

    const order = await hsp.getOrder(art.hsp.flow_id);
    const payout = await ch.payoutOf(conn.creator);
    const contents = ((order.cart_mandate as { contents?: Record<string, unknown> } | undefined)?.contents ?? {}) as { payment_request?: { method_data?: { data?: { chain_id?: number; contract_address?: string } }[]; details?: { total?: { amount?: { currency?: string; value?: string } } } } };
    if (order.merchant_name !== undefined && order.merchant_name !== MERCHANT_NAME) throw new Error(`the order is for "${String(order.merchant_name)}", not ${MERCHANT_NAME}`);
    if (order.pay_to !== undefined && String(order.pay_to).toLowerCase() !== payout.toLowerCase()) throw new Error("the order pays someone other than the creator's on-chain payout: nothing signed");
    const total = contents.payment_request?.details?.total?.amount;
    if (total && (total.currency !== "USD" || total.value !== usdValue(l.pricePerRender))) throw new Error(`the order's total ${total.value} ${total.currency} isn't the licence price ${usdValue(l.pricePerRender)} USD`);
    const method = contents.payment_request?.method_data?.[0]?.data;
    if (method && (Number(method.chain_id) !== option.chainId || String(method.contract_address).toLowerCase() !== option.token.address.toLowerCase())) throw new Error("the order is for another chain or token");

    const b = this.budget.check(l.pricePerRender);
    if (!b.ok) return this.refuse(b.reason);
    this.c.log.add("brand-agent", "policy", `order accepted: ${usdValue(l.pricePerRender)} USD to ${payout} for render ${renderIndex}`, { flow_id: art.hsp.flow_id, payment_request_id: art.hsp.payment_request_id });

    // The most this brand authorizes for one render: its per-render cap, in the token's raw units.
    const maxRaw = unitsOf(usdValue(this.c.policy.maxPricePerRender), option.token.decimals);
    let submitted;
    try {
      submitted = await payWithHsp({
        hsp,
        signer: this.c.account,
        approve: async (a) => {
          this.c.log.add("brand-agent", "approval", `asking to approve ${a.stage === "sign" ? "signing" : "submission"}: ${a.tokenTotalRaw} raw to ${a.payTo} from ${a.payer}`, a);
          const yes = await approve(a);
          this.c.log.add("brand-agent", "approval", `${a.stage === "sign" ? "signing" : "submission"} ${yes ? "approved" : "cancelled"}`);
          return yes;
        },
        flowId: art.hsp.flow_id,
        paymentRequestId: art.hsp.payment_request_id,
        expect: { payTo: payout, token: option.token },
        balanceOf,
        maxRaw,
        log: (event, detail, data) => this.c.log.add(event.startsWith("wallet") ? "brand-agent" : "hsp-gateway", event === "wallet" ? "payment-mandate" : "hsp.response", detail, data),
      });
    } catch (e) {
      if (e instanceof PaymentCancelled) return this.refuse(e.message);
      throw e;
    }
    this.budget.record(l.pricePerRender);
    if (submitted.nonce) {
      // For the creator's agent, to read a Permit2 payment the Gateway broadcast; it checks the nonce on chain.
      await this.ask(conn, { skill: SKILL_RENDER_PAYMENT, submitted: true, flow_id: submitted.flowId, nonce: submitted.nonce }).catch(() => undefined);
    }
    return {
      licenceId,
      renderIndex,
      paymentRequestId: submitted.paymentRequestId,
      flowId: submitted.flowId,
      nonce: submitted.nonce ?? ("0x" as Hex),
      nonceBound: false,
      txHash: "0x" as Hex, // known once HSP broadcasts: query_payment's payment.tx_signature
      tokenTotalRaw: submitted.tokenTotalRaw,
    };
  }

  /** Waits until the creator's agent has recorded the payment on chain. */
  async waitRecorded(licenceId: bigint, renderIndex: number, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await this.c.chain.payment(licenceId, renderIndex);
      if (p.recordedAt !== 0n) return p;
      if (Date.now() > deadline) throw new Error(`payment for licence ${licenceId} render ${renderIndex} not recorded in time`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ---------------------------------------------------------------- internals

  private async sign(payTo: Address, amount: bigint, nonce: Hex): Promise<ExactPayload> {
    const d = this.c.chain.d;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (d.rail === "eip3009") {
      return signEip3009(this.c.account, d.tokenDomain, {
        from: this.c.account.address,
        to: payTo,
        value: amount,
        validAfter: 0n,
        validBefore: now + 600n,
        nonce,
      });
    }
    if (!this.c.permit2Spender) throw new Error("Permit2 rail needs the Gateway's spender address");
    return signPermit2(
      this.c.account,
      d.chainId,
      { token: d.token, amount, spender: this.c.permit2Spender, nonce: BigInt(nonce), deadline: now + 600n },
      d.permit2,
    );
  }

  /** If the Gateway's checkout assigns the authorization nonce, use it (field name unconfirmed). */
  private async gatewayNonce(flowId: string): Promise<Hex | undefined> {
    try {
      const order = await this.c.hsp.checkoutOrder(flowId);
      const n = (order.authorization_nonce ?? order.nonce) as string | undefined;
      return n && /^0x[0-9a-fA-F]{64}$/.test(n) ? (n as Hex) : undefined;
    } catch {
      return undefined;
    }
  }

  private async ask(conn: CreatorConnection, data: Record<string, unknown>): Promise<Task> {
    const msg = userMessage([{ kind: "data", data }]);
    this.c.log.add("brand-agent", "a2a.request", `message/send ${String(data.skill)}`, msg);
    const task = await sendMessage(conn.card, msg, this.c.fetch);
    this.c.log.add("creator-agent", "a2a.response", `${task.status.state}: ${textOf(task.status.message ?? { parts: [] })}`, { taskId: task.id });
    return task;
  }

  private refuse(reason: string): never {
    this.c.log.add("brand-agent", "refused", reason);
    throw new Refused(reason);
  }
}

function same(a: string | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}
