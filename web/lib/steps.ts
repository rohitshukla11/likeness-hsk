/**
 * One paid render with HSP Agentic Payment, as the brand sees it: each step is matched in the agents'
 * message log (the same steps as the console's AGENTIC_STEPS in agents/public/app.js).
 */
import type { LogEvent } from "./api";

export type Step = { id: string; title: string; who: string; match: (e: LogEvent) => boolean; tx?: (e: LogEvent) => string | undefined; last?: boolean };

export const AGENTIC_STEPS: Step[] = [
  { id: "request", title: "Asked the creator's agent", who: "brand agent → creator agent, over A2A", match: (e) => e.actor === "brand-agent" && e.kind === "a2a.request" && /render-payment/.test(e.summary) },
  { id: "order", title: "HSP order created", who: "creator agent → HSP create_order, merchant Likeness, paid to the creator", match: (e) => e.actor === "creator-agent" && e.kind === "hsp.request" && /create_order/.test(e.summary) },
  { id: "policy", title: "Checked against the brand's policy", who: "brand agent: payee, price, budget, licence active", match: (e) => e.actor === "brand-agent" && e.kind === "policy" && /order accepted/.test(e.summary) },
  { id: "quote", title: "Payment prepared", who: "HSP prepare_payment: the authorization to sign, quoted for 5 minutes", match: (e) => e.kind === "hsp.response" && /quote locked/.test(e.summary) },
  { id: "approve-sign", title: "You approved signing", who: "approval 1", match: (e) => e.kind === "approval" && /signing approved/.test(e.summary) },
  { id: "signed", title: "Signed by the brand wallet", who: "exactly the authorization HSP returned (EIP-712)", match: (e) => e.kind === "payment-mandate" && /EIP-712/.test(e.summary) },
  { id: "approve-submit", title: "You approved submitting", who: "approval 2", match: (e) => e.kind === "approval" && /submission approved/.test(e.summary) },
  { id: "submitted", title: "Submitted to HSP", who: "HSP finalize_payment, then submit_payment", match: (e) => e.kind === "hsp.response" && /^submitted/.test(e.summary) },
  { id: "status", title: "HSP status", who: "query_payment until safe or finalized", match: (e) => e.kind === "hsp.status", tx: (e) => e.data?.payment?.tx_signature, last: true },
  { id: "recorded", title: "Recorded on HSK Chain", who: "creator agent → HspSettlement.recordPayment", match: (e) => e.kind === "tx" && /recordPayment/.test(e.summary), tx: (e) => e.data?.tx },
  { id: "receipt", title: "Receipt anchored", who: "render agent → ReceiptAnchor, keyed by the file's sha256", match: (e) => e.kind === "tx" && /receipt anchored/.test(e.summary), tx: (e) => e.data?.tx },
];
