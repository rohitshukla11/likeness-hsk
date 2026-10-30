/**
 * The payer's side of HSP Agentic Payment (guide §7–8): prepare_payment → the user's approval →
 * the wallet signs exactly the returned eip712 → finalize_payment → the user's approval again →
 * submit_payment; then query_payment every 15 s until the payment is safe, finalized or failed.
 * We never build x402 JSON, hashes or JWTs: HSP does. Nothing is signed or submitted without an
 * explicit approval, and a cancelled approval says what did and didn't happen.
 */
import type { Address, Hex, LocalAccount, TypedDataDomain } from "viem";
import { type HspAgentic, HspToolError, MERCHANT_NAME, type PaymentQuery, type PreparedPayment, QUOTE_EXPIRED_CODE } from "./client.js";

/** What the user is shown before signing and again before submitting. token_total_raw stays in raw units. */
export interface Approval {
  stage: "sign" | "submit";
  flowId: string;
  paymentRequestId: string;
  payTo: Address;
  payer: Address;
  tokenTotalRaw: string;
  token: { address: Address; decimals: number; symbol: string };
  quoteExpiresAt: string;
  /** The platform advances the network fee (not in the total) when true. */
  gasFeeAdvanced: boolean | undefined;
}
export type Approver = (a: Approval) => Promise<boolean>;

export class PaymentCancelled extends Error {}

export interface PayInput {
  hsp: HspAgentic;
  signer: LocalAccount;
  approve: Approver;
  flowId: string;
  paymentRequestId: string;
  /** What the order must pay: the creator's on-chain payout, from this payer, in this token. */
  expect: { payTo: Address; token: { address: Address; decimals: number; symbol: string; protocol: "eip3009" | "permit2" } };
  balanceOf: (token: Address, owner: Address) => Promise<bigint>;
  /** The most the brand will authorize, raw units (its budget for this render). */
  maxRaw: bigint;
  log?: (event: string, detail: string, data?: unknown) => void;
  now?: () => number;
}
export interface Submitted {
  flowId: string;
  paymentRequestId: string;
  tokenTotalRaw: string;
  /** The authorization's nonce from the signed eip712 (HSP chose it): the creator's agent checks it on chain. */
  nonce: Hex | undefined;
  submit: Record<string, unknown>;
}

const PRIMARY: Record<"eip3009" | "permit2", string> = { eip3009: "TransferWithAuthorization", permit2: "PermitTransferFrom" };
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

export async function payWithHsp(i: PayInput): Promise<Submitted> {
  const now = i.now ?? Date.now;
  const log = i.log ?? (() => undefined);
  const order = await i.hsp.getOrder(i.flowId);
  const gasFeeAdvanced = typeof order.gas_fee_advanced === "boolean" ? order.gas_fee_advanced : undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const q = await i.hsp.preparePayment({ flow_id: i.flowId, payer: i.signer.address, protocol: i.expect.token.protocol });
    checkQuote(q, i);
    log("hsp.prepare", `quote locked: ${q.token_total_raw} raw units, until ${q.quote_expires_at}`, { cart_hash: q.cart_hash, payment_request_id: q.payment_request_id });

    const total = BigInt(q.token_total_raw);
    if (total > i.maxRaw) throw new PaymentCancelled(`the quote (${q.token_total_raw} raw) is above this render's budget (${i.maxRaw} raw): nothing signed`);
    const balance = await i.balanceOf(i.expect.token.address, i.signer.address);
    if (balance < total) {
      throw new PaymentCancelled(`the payer holds ${balance} raw units of ${i.expect.token.symbol} (${i.expect.token.address}), below token_total_raw ${q.token_total_raw}: nothing signed; fund the wallet manually`);
    }

    const shown = (stage: Approval["stage"]): Approval => ({
      stage,
      flowId: i.flowId,
      paymentRequestId: q.payment_request_id ?? i.paymentRequestId,
      payTo: q.pay_to as Address,
      payer: q.payer as Address,
      tokenTotalRaw: q.token_total_raw,
      token: { address: i.expect.token.address, decimals: i.expect.token.decimals, symbol: i.expect.token.symbol },
      quoteExpiresAt: q.quote_expires_at,
      gasFeeAdvanced,
    });
    if (expired(q, now)) continue; // prepare again before asking anyone to sign
    if (!(await i.approve(shown("sign")))) throw new PaymentCancelled("cancelled before signing: nothing was signed and no money moved");
    if (expired(q, now)) {
      log("hsp.prepare", "the quote expired while waiting for approval: preparing again");
      continue;
    }

    const signature = await i.signer.signTypedData(typedData(q.eip712));
    log("wallet", `signed ${q.eip712.primaryType} (EIP-712) with ${i.signer.address}`);
    const fin = await i.hsp.finalizePayment({ signature, payment_payload: q.payment_payload, payment_mandate_contents: q.payment_mandate_contents, cart_hash: q.cart_hash });

    if (expired(q, now)) {
      log("hsp.prepare", "the quote expired before submission: preparing again (the old signature is never submitted)");
      continue;
    }
    if (!(await i.approve(shown("submit")))) {
      throw new PaymentCancelled(`cancelled before submission: the authorization was signed but never sent; it can't be used after ${q.quote_expires_at}`);
    }
    try {
      const submit = await i.hsp.submitPayment(fin.payment_mandate_json);
      log("hsp.submit", `submitted: ${String(submit.status ?? "")}`, submit);
      return { flowId: i.flowId, paymentRequestId: q.payment_request_id ?? i.paymentRequestId, tokenTotalRaw: q.token_total_raw, nonce: nonceOf(q), submit };
    } catch (e) {
      if (e instanceof HspToolError && e.code === QUOTE_EXPIRED_CODE) {
        log("hsp.submit", "30043: the quote expired; preparing again and signing the new quote");
        continue;
      }
      // An uncertain submission is checked, never blindly resubmitted.
      const status = await i.hsp.queryPayment({ flow_id: i.flowId, payment_request_id: q.payment_request_id ?? i.paymentRequestId }).catch(() => undefined);
      const s = statusOf(status);
      if (s) return { flowId: i.flowId, paymentRequestId: q.payment_request_id ?? i.paymentRequestId, tokenTotalRaw: q.token_total_raw, nonce: nonceOf(q), submit: { status: s, recoveredAfter: (e as Error).message } };
      throw e;
    }
  }
  throw new PaymentCancelled("the quote kept expiring (3 attempts): nothing was submitted");
}

/** The quote must be for this order, this payer, this recipient and this token, in the expected scheme. */
function checkQuote(q: PreparedPayment, i: PayInput) {
  if (!same(q.pay_to, i.expect.payTo)) throw new Error(`the quote pays ${q.pay_to}, not the creator's payout ${i.expect.payTo}: nothing signed`);
  if (!same(q.payer, i.signer.address)) throw new Error(`the quote is for payer ${q.payer}, not ${i.signer.address}: nothing signed`);
  if (q.eip712?.primaryType !== PRIMARY[i.expect.token.protocol]) throw new Error(`the quote asks for ${q.eip712?.primaryType}, not ${PRIMARY[i.expect.token.protocol]}: nothing signed`);
  if (!/^\d+$/.test(q.token_total_raw ?? "")) throw new Error(`token_total_raw isn't a raw integer amount: ${q.token_total_raw}`);
  const m = q.eip712.message;
  // The signed amount is the locked total, to the recipient we expect (EIP-3009), or the permitted token (Permit2).
  if (i.expect.token.protocol === "eip3009") {
    if (!same(m.to, i.expect.payTo) || String(m.value) !== q.token_total_raw || !same(m.from, i.signer.address)) throw new Error("the eip712 message doesn't match the quote: nothing signed");
    if (!same(q.eip712.domain.verifyingContract, i.expect.token.address)) throw new Error("the eip712 domain isn't the token's: nothing signed");
  } else {
    const permitted = m.permitted as { token?: unknown; amount?: unknown } | undefined;
    if (!same(permitted?.token, i.expect.token.address) || String(permitted?.amount) !== q.token_total_raw) throw new Error("the eip712 permit doesn't match the quote: nothing signed");
  }
}

const expired = (q: PreparedPayment, now: () => number) => Date.parse(q.quote_expires_at) <= now();

function nonceOf(q: PreparedPayment): Hex | undefined {
  const n = q.eip712.message.nonce;
  if (typeof n === "string" && /^0x[0-9a-fA-F]{64}$/.test(n)) return n as Hex;
  if (typeof n === "string" || typeof n === "number" || typeof n === "bigint") return `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
  return undefined;
}

/**
 * The returned eip712 for viem: domain, types, primaryType and message unchanged in content. Only the
 * representation changes: integer fields given as strings become bigints (the encoded value is the same),
 * and EIP712Domain is left to viem, which derives it from the domain's fields.
 */
export function typedData(e: PreparedPayment["eip712"]) {
  const { EIP712Domain: _domainType, ...types } = e.types;
  void _domainType;
  const toBig = (type: string, v: unknown): unknown => {
    if (/^u?int\d*$/.test(type) && (typeof v === "string" || typeof v === "number")) return BigInt(v);
    const struct = types[type.replace(/\[\]$/, "")];
    if (type.endsWith("[]") && Array.isArray(v)) return v.map((x) => toBig(type.slice(0, -2), x));
    if (struct && v && typeof v === "object") return Object.fromEntries(struct.map((f) => [f.name, toBig(f.type, (v as Record<string, unknown>)[f.name])]));
    return v;
  };
  const domain = { ...e.domain } as Record<string, unknown>;
  if (typeof domain.chainId === "string") domain.chainId = Number(domain.chainId);
  return {
    domain: domain as TypedDataDomain,
    types,
    primaryType: e.primaryType,
    message: toBig(e.primaryType, e.message) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------- status

export const statusOf = (q: PaymentQuery | undefined): string | undefined => (q ? (q.payment?.status ?? q.status) : undefined);

export type Watched = { status: string; final: boolean; query: PaymentQuery; note?: string };
/** What the guide says to report for each terminal state. */
export function describe(status: string, q?: PaymentQuery): string {
  if (status === "payment-safe") return "The transaction is on-chain and has received half of the required block confirmations. It is not yet finalized.";
  if (status === "payment-finalized") return "The payment has reached final confirmation.";
  if (status === "payment-failed") return `The payment failed: ${q?.payment?.status_reason ?? "no reason given"}.`;
  return status;
}

/**
 * query_payment every 15 s with the same identifiers until payment-safe, payment-finalized or
 * payment-failed. payment-timeout keeps polling (it's recoverable); after 10 minutes without an end
 * state it reports "Pending confirmation" once and keeps going. Errors and unknown states are reported
 * as they are, never turned into success or failure.
 */
export async function watchPayment(
  hsp: HspAgentic,
  ids: { flow_id: string; payment_request_id: string },
  onUpdate: (w: Watched) => void,
  o: { intervalMs?: number; pendingAfterMs?: number; signal?: AbortSignal; merchantName?: string } = {},
): Promise<Watched> {
  const interval = o.intervalMs ?? 15_000;
  const pendingAt = Date.now() + (o.pendingAfterMs ?? 600_000);
  let saidPending = false;
  let last = "";
  for (;;) {
    if (o.signal?.aborted) throw new Error(`stopped watching ${ids.flow_id} / ${ids.payment_request_id}; resume with query_payment`);
    try {
      const q = await hsp.queryPayment(ids, o.merchantName ?? MERCHANT_NAME);
      const s = statusOf(q) ?? "(no status returned)";
      const final = s === "payment-safe" || s === "payment-finalized" || s === "payment-failed";
      if (s !== last || final) onUpdate({ status: s, final, query: q, ...(final ? { note: describe(s, q) } : {}) });
      last = s;
      if (final) return { status: s, final, query: q, note: describe(s, q) };
    } catch (e) {
      onUpdate({ status: "(query failed)", final: false, query: {}, note: (e as Error).message });
    }
    if (!saidPending && Date.now() > pendingAt) {
      saidPending = true;
      onUpdate({ status: "Pending confirmation", final: false, query: {}, note: `still polling flow_id ${ids.flow_id}, payment_request_id ${ids.payment_request_id}` });
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
