/**
 * The admin's live HashKey QA payment (HSP_QA_LIVE_RUN=1 on the public server): one real HSP Agentic
 * Payment on HashKey's QA MCP server, on Ethereum Sepolia in Circle's USDC (EIP-3009), from the server's
 * brand wallet to the creator's payout. It is not a render and is not recorded by our HSK Chain contracts;
 * the public site's main flow stays on the emulator.
 *
 * The order follows QA's tool descriptions: get_chain_config → confirm merchant_name, then pay_to, then the
 * payer (one at a time) → create_order → get_order → prepare_payment → approval 1 → sign → finalize_payment
 * → approval 2 → submit_payment → query_payment every 15 s until payment-safe, payment-finalized or
 * payment-failed. Every question waits for the admin; nothing is signed or sent without an answer.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Address, LocalAccount } from "viem";
import { buildCartContents } from "../hsp/cart.js";
import { chooseOption } from "../hsp/agentic/chainConfig.js";
import { type HspAgentic, MERCHANT_NAME } from "../hsp/agentic/client.js";
import { type Approval, PaymentCancelled, payWithHsp, watchPayment } from "../hsp/agentic/payer.js";

export const LIVE_QA_LABEL = "Live HashKey QA payment on Ethereum Sepolia; a test payment, not a render, not recorded by our contracts";
export const SEPOLIA = 11155111;
/** Circle's USDC on Ethereum Sepolia, as HSP QA's get_chain_config lists it (eip3009, EIP-712 "USDC" version "2"). */
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;

export type Ask = { kind: "merchant_name" | "pay_to" | "payer"; value: string } | { kind: "sign" | "submit"; approval: Approval };
export type Step = { at: string; what: string; data?: unknown };
export interface LiveQaRun {
  id: string;
  label: string;
  source: "hashkey-qa" | "rehearsal";
  status: "asking" | "working" | "watching" | "done" | "cancelled" | "failed";
  startedAt: string;
  endedAt?: string;
  chainId: number;
  token: Address;
  amountRaw: string;
  payTo: Address;
  payer: Address;
  ask?: Ask & { id: string };
  steps: Step[];
  flowId?: string;
  paymentRequestId?: string;
  paymentUrl?: string;
  tokenTotalRaw?: string;
  paymentStatus?: string;
  note?: string;
  tx?: string;
  txUrl?: string;
  attributionVerified?: boolean;
  error?: string;
}

export interface LiveQaDeps {
  /** HashKey's QA server, or the offline rehearsal (never both): its source is shown with the run. */
  connect: () => Promise<HspAgentic>;
  source: LiveQaRun["source"];
  signer: LocalAccount;
  payTo: () => Promise<Address>;
  balanceOf: (token: Address, owner: Address) => Promise<bigint>;
  chainId?: number;
  token?: Address;
  amountRaw?: bigint;
  /** Headroom for a network fee in the total (when gas_fee_advanced is false); the admin still approves the exact total. */
  feeAllowanceRaw?: bigint;
  explorerTx?: (tx: string) => string;
  pollMs?: number;
  /** Where the finished run is saved (no keys or signatures in it). */
  saveTo?: string;
}

export class LiveQa {
  private run?: LiveQaRun;
  private pending?: { id: string; resolve: (yes: boolean) => void };

  constructor(private readonly d: LiveQaDeps) {}

  current(): LiveQaRun | undefined {
    return this.run;
  }

  /** Starts one run; refuses while another is still going. */
  async start(): Promise<LiveQaRun> {
    if (this.run && ["asking", "working", "watching"].includes(this.run.status)) throw new Error("a live QA payment is already in progress");
    const run: LiveQaRun = {
      id: randomUUID(),
      label: this.d.source === "rehearsal" ? `REHEARSAL (offline, no HashKey server, no money moves): ${LIVE_QA_LABEL}` : LIVE_QA_LABEL,
      source: this.d.source,
      status: "working",
      startedAt: new Date().toISOString(),
      chainId: this.d.chainId ?? SEPOLIA,
      token: this.d.token ?? SEPOLIA_USDC,
      amountRaw: String(this.d.amountRaw ?? 50_000n),
      payTo: await this.d.payTo(),
      payer: this.d.signer.address,
      steps: [],
    };
    this.run = run;
    void this.go(run);
    return run;
  }

  /** The admin's answer to the question on screen. */
  answer(askId: string, yes: boolean): boolean {
    if (!this.pending || this.pending.id !== askId) return false;
    const p = this.pending;
    this.pending = undefined;
    p.resolve(yes);
    return true;
  }

  private step(run: LiveQaRun, what: string, data?: unknown) {
    run.steps.push({ at: new Date().toISOString(), what, ...(data === undefined ? {} : { data }) });
  }

  private ask(run: LiveQaRun, a: Ask): Promise<boolean> {
    const id = randomUUID();
    run.ask = { ...a, id };
    run.status = "asking";
    return new Promise<boolean>((resolve) => {
      this.pending = {
        id,
        resolve: (yes) => {
          run.ask = undefined;
          run.status = "working";
          this.step(run, `${yes ? "confirmed" : "declined"}: ${a.kind}${"value" in a ? ` = ${a.value}` : ` (token_total_raw ${a.approval.tokenTotalRaw})`}`);
          resolve(yes);
        },
      };
    });
  }

  private async go(run: LiveQaRun) {
    let hsp: HspAgentic | undefined;
    try {
      hsp = await this.d.connect();
      this.step(run, `connected to ${hsp.source === "hashkey-qa" ? "HashKey's QA MCP server" : "the offline rehearsal server"}: ${hsp.tools.size} tools`);
      const option = chooseOption(await hsp.getChainConfig(), { chainId: run.chainId, token: run.token });
      if (option.token.protocol !== "eip3009") throw new Error(`get_chain_config lists ${option.token.symbol} on chain ${option.chainId} as ${option.token.protocol}, not eip3009: stopping`);
      this.step(run, `get_chain_config: ${option.network} (chain ${option.chainId}), ${option.token.symbol} ${option.token.address}, ${option.token.decimals} decimals, eip3009, EIP-712 "${option.token.name}" version ${option.token.version}`, option);

      // QA's create_order: confirm merchant_name, then pay_to, one at a time; the payer is shown and confirmed too.
      if (!(await this.ask(run, { kind: "merchant_name", value: MERCHANT_NAME }))) throw new PaymentCancelled("merchant_name not confirmed: no order created");
      if (!(await this.ask(run, { kind: "pay_to", value: run.payTo }))) throw new PaymentCancelled("pay_to not confirmed: no order created");
      if (!(await this.ask(run, { kind: "payer", value: run.payer }))) throw new PaymentCancelled("payer not confirmed: no order created");

      const contents = buildCartContents({
        cartId: `live-qa-${Date.now()}`,
        paymentRequestId: `PR-${randomUUID()}`,
        merchantName: MERCHANT_NAME,
        network: option.network,
        chainId: option.chainId,
        token: option.token.address,
        coin: option.token.symbol,
        payTo: run.payTo,
        priceUnits: BigInt(run.amountRaw),
        itemLabel: "Likeness: live HashKey QA payment test on Ethereum Sepolia (not a render)",
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      const order = await hsp.createOrder({ merchant_name: MERCHANT_NAME, pay_to: run.payTo, cart_mandate: { contents } });
      Object.assign(run, { flowId: order.flow_id, paymentRequestId: order.payment_request_id, paymentUrl: order.payment_url });
      this.step(run, `create_order: flow_id ${order.flow_id}, payment_request_id ${order.payment_request_id}`, { amount_usd: contents.payment_request.details.total.amount.value });

      const sub = await payWithHsp({
        hsp,
        signer: this.d.signer,
        approve: (a) => this.ask(run, { kind: a.stage, approval: a }),
        flowId: order.flow_id,
        paymentRequestId: order.payment_request_id,
        expect: { payTo: run.payTo, token: option.token },
        balanceOf: this.d.balanceOf,
        maxRaw: BigInt(run.amountRaw) + (this.d.feeAllowanceRaw ?? 200_000n),
        log: (event, detail) => this.step(run, `${event}: ${detail}`),
      });
      run.tokenTotalRaw = sub.tokenTotalRaw;
      run.status = "watching";
      this.step(run, `submit_payment: ${String(sub.submit.status ?? "submitted")}`);

      const end = await watchPayment(
        hsp,
        { flow_id: sub.flowId, payment_request_id: sub.paymentRequestId },
        (w) => {
          run.paymentStatus = w.status;
          if (typeof w.query.attribution_verified === "boolean") run.attributionVerified = w.query.attribution_verified;
          const tx = w.query.payment?.tx_signature;
          if (tx) Object.assign(run, { tx, txUrl: this.d.explorerTx?.(tx) });
          this.step(run, `query_payment: ${w.status}${w.note ? `: ${w.note}` : ""}`, { attribution_verified: w.query.attribution_verified, tx_signature: tx || undefined });
        },
        { intervalMs: this.d.pollMs ?? 15_000, merchantName: MERCHANT_NAME },
      );
      run.note = end.note;
      run.status = end.status === "payment-failed" ? "failed" : "done";
      if (end.status === "payment-failed") run.error = end.note;
    } catch (e) {
      run.status = e instanceof PaymentCancelled ? "cancelled" : "failed";
      run.error = (e as Error).message;
      this.step(run, `${run.status}: ${run.error}`);
    } finally {
      run.ask = undefined;
      this.pending = undefined;
      run.endedAt = new Date().toISOString();
      await hsp?.close().catch(() => undefined);
      if (this.d.saveTo && run.source === "hashkey-qa") writeFileSync(this.d.saveTo, JSON.stringify(run, null, 2) + "\n");
    }
  }
}
