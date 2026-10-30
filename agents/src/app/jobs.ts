/**
 * One paid render, run in the background so the brand console can show the approvals while it waits:
 * the brand agent pays (with HSP Agentic Payment: two approvals, then HSP's statuses), the creator's
 * agent records the payment on chain, and the render agent delivers and anchors the render.
 */
import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { Refused } from "../brand-agent/agent.js";
import type { LogEvent, MessageLog } from "../log.js";
import type { Runtime } from "./runtime.js";

export type JobState = "paying" | "submitted" | "recorded" | "delivered" | "paid-not-recorded" | "refused" | "failed";

export interface PaymentJob {
  id: string;
  licenceId: string;
  state: JobState;
  startedAt: number;
  renderIndex?: number;
  flowId?: string;
  paymentRequestId?: string;
  /** Raw token units the brand authorized (not funds received). */
  tokenTotalRaw?: string;
  hspTx?: Hex;
  nonceBound?: boolean;
  assetHash?: Hex;
  anchorTx?: Hex;
  note?: string;
  error?: string;
}

const FINAL = new Set(["payment-safe", "payment-finalized", "payment-failed"]);

/** HSP's statuses for one flow, as the creator's agent saw them through query_payment. */
export function hspStatuses(log: MessageLog, flowId: string | undefined) {
  if (!flowId) return [];
  return log.events
    .filter((e: LogEvent) => e.kind === "hsp.status" && (e.data as { flow_id?: string } | undefined)?.flow_id === flowId)
    .map((e) => {
      const d = e.data as { attribution_verified?: boolean; payment?: { status?: string; tx_signature?: string; network?: string; to_pay_address?: string; payer_address?: string; status_reason?: string } };
      return { at: e.at, summary: e.summary, status: d.payment?.status ?? e.summary.split(":")[0]!, tx: d.payment?.tx_signature || undefined, attribution: d.attribution_verified, payment: d.payment };
    });
}

export class PaymentJobs {
  readonly jobs = new Map<string, PaymentJob>();
  constructor(private readonly rt: Runtime) {}

  start(licenceId: bigint, brief: string): PaymentJob {
    const job: PaymentJob = { id: randomUUID(), licenceId: licenceId.toString(), state: "paying", startedAt: Date.now() };
    this.jobs.set(job.id, job);
    void this.run(job, licenceId, brief).catch((e) => {
      job.state = e instanceof Refused ? "refused" : "failed";
      job.error = (e as Error).message.split("\n")[0];
    });
    return job;
  }

  private async run(job: PaymentJob, id: bigint, brief: string) {
    const rt = this.rt;
    const paid = await rt.brand.payForRender(await rt.connect(), id);
    Object.assign(job, { state: "submitted", renderIndex: paid.renderIndex, flowId: paid.flowId, paymentRequestId: paid.paymentRequestId, tokenTotalRaw: paid.tokenTotalRaw });

    if (rt.agentic) {
      // HSP's statuses, until safe, finalized or failed (the creator's agent queries every 15 s).
      for (;;) {
        const last = hspStatuses(rt.log, job.flowId).at(-1);
        if (last && FINAL.has(last.status)) {
          if (last.status === "payment-failed") throw new Error(`HSP: payment failed: ${last.payment?.status_reason ?? "no reason given"}`);
          job.hspTx = last.tx as Hex | undefined;
          break;
        }
        if (Date.now() - job.startedAt > 30 * 60_000) throw new Error(`HSP: still pending after 30 minutes; flow_id ${job.flowId}, payment_request_id ${job.paymentRequestId}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!rt.agentic.recordable) {
        job.state = "paid-not-recorded";
        job.note = `Paid through HSP in ${rt.agentic.option.token.symbol} ${rt.agentic.option.token.address}; HspSettlement is deployed for ${rt.chain.d.token}, so the payment isn't recorded on chain until the contracts are redeployed with HSP's token.`;
        return;
      }
    }
    const p = await rt.brand.waitRecorded(id, paid.renderIndex, { timeoutMs: 300_000 });
    Object.assign(job, { state: "recorded", hspTx: p.hspTxHash, nonceBound: p.nonceBound });
    const out = await rt.render.renderAndAnchor(id, paid.renderIndex, brief);
    rt.store.save(out.assetHash, out.bytes, { mime: out.mime, licenceId: id.toString(), renderIndex: paid.renderIndex });
    Object.assign(job, { state: "delivered", assetHash: out.assetHash, anchorTx: out.tx });
  }
}
