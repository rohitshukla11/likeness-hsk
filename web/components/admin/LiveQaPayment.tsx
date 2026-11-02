"use client";

/**
 * Admin only: one live HSP Agentic Payment on HashKey's QA server, on Ethereum Sepolia in Circle's USDC
 * (agents/src/app/liveQa.ts). Not a render, not recorded by our HSK Chain contracts; the main flow stays
 * on the emulator. Each question waits for the admin: merchant_name, pay_to, the payer, then two approvals.
 */
import { useCallback, useEffect, useState } from "react";
import { btnClass, Card } from "@/components/ds";
import { api, rawToDecimal } from "@/lib/api";

type Approval = { stage: "sign" | "submit"; payTo: string; payer: string; tokenTotalRaw: string; token: { address: string; decimals: number; symbol: string }; quoteExpiresAt: string; gasFeeAdvanced?: boolean };
type Ask = { id: string; kind: "merchant_name" | "pay_to" | "payer"; value: string } | { id: string; kind: "sign" | "submit"; approval: Approval };
type Run = {
  id: string;
  label: string;
  source: "hashkey-qa" | "rehearsal";
  status: "asking" | "working" | "watching" | "done" | "cancelled" | "failed";
  chainId: number;
  token: string;
  amountRaw: string;
  payTo: string;
  payer: string;
  ask?: Ask;
  steps: { at: string; what: string }[];
  flowId?: string;
  paymentRequestId?: string;
  tokenTotalRaw?: string;
  paymentStatus?: string;
  note?: string;
  tx?: string;
  txUrl?: string;
  attributionVerified?: boolean;
  error?: string;
};
type View = { enabled: boolean; source: "hashkey-qa" | "rehearsal" | null; label: string; run: Run | null };

const QUESTION: Record<"merchant_name" | "pay_to" | "payer", string> = {
  merchant_name: "Confirm the merchant name for the order",
  pay_to: "Confirm pay_to: the creator's payout address that receives the USDC",
  payer: "Confirm the payer: the server's brand wallet that signs the EIP-3009 authorization",
};

export function LiveQaPayment() {
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<View>("/api/admin/live-qa").then(setView, (e) => setErr((e as Error).message)), []);
  const run = view?.run;
  const active = !!run && ["asking", "working", "watching"].includes(run.status);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [active, load]);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const answer = (yes: boolean) => run?.ask && act(() => api("/api/admin/live-qa/answer", { id: run.ask!.id, yes }));

  if (!view) return null;
  return (
    <Card title="Live HashKey QA payment">
      <span className="rounded-[10px] bg-wait-bg px-3 py-2 text-[13px] font-semibold text-ink">{run?.label ?? view.label}</span>
      {!view.enabled ? (
        <p className="m-0 text-[14px] text-grey">Not enabled on this server (HSP_QA_LIVE_RUN).</p>
      ) : (
        <p className="m-0 text-[14px] text-grey">
          {rawToDecimal(run?.amountRaw ?? "50000", 6)} USDC on Ethereum Sepolia (chain 11155111), from the server&apos;s brand wallet to the creator&apos;s payout, through {view.source === "rehearsal" ? "the offline rehearsal server (nothing is sent)" : "HashKey\u2019s QA MCP server"}. You
          confirm merchant_name, pay_to and the payer, one at a time, then approve before signing and again before submitting. It is separate from the main flow: no licence, no render, nothing recorded by our contracts.
        </p>
      )}
      {view.enabled && !active && (
        <button type="button" disabled={busy} onClick={() => void act(() => api("/api/admin/live-qa", {}))} className={btnClass("lime", "self-start")}>
          {run ? "Start another live QA payment" : "Start a live QA payment"}
        </button>
      )}

      {run?.ask && (
        <div className="flex flex-col gap-2 rounded-[14px] bg-lime/40 p-3">
          {"value" in run.ask ? (
            <>
              <b className="text-[14px]">{QUESTION[run.ask.kind]}</b>
              <code className="break-all text-[14px]">{run.ask.value}</code>
              <span className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void answer(true)} className={btnClass("ink")}>
                  Confirm
                </button>
                <button type="button" disabled={busy} onClick={() => void answer(false)} className={btnClass("outline")}>
                  Cancel
                </button>
              </span>
            </>
          ) : (
            <>
              <b className="text-[14px]">{run.ask.kind === "sign" ? "Approval 1, before signing" : "Approval 2, before submitting"}</b>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                <dt className="text-grey">Recipient (pay_to)</dt>
                <dd className="m-0 break-all font-mono">{run.ask.approval.payTo}</dd>
                <dt className="text-grey">Payer</dt>
                <dd className="m-0 break-all font-mono">{run.ask.approval.payer}</dd>
                <dt className="text-grey">token_total_raw</dt>
                <dd className="m-0 font-mono">
                  {run.ask.approval.tokenTotalRaw} ({rawToDecimal(run.ask.approval.tokenTotalRaw, run.ask.approval.token.decimals)} {run.ask.approval.token.symbol})
                </dd>
                <dt className="text-grey">Token</dt>
                <dd className="m-0 break-all font-mono">{run.ask.approval.token.address}</dd>
                <dt className="text-grey">Network fee</dt>
                <dd className="m-0">{run.ask.approval.gasFeeAdvanced === true ? "advanced by the platform (not in the total)" : run.ask.approval.gasFeeAdvanced === false ? "included in the total" : "not stated"}</dd>
                <dt className="text-grey">Quote expires</dt>
                <dd className="m-0">{run.ask.approval.quoteExpiresAt}</dd>
              </dl>
              <span className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void answer(true)} className={btnClass("ink")}>
                  {run.ask.kind === "sign" ? "Approve and sign" : "Approve and submit"}
                </button>
                <button type="button" disabled={busy} onClick={() => void answer(false)} className={btnClass("outline")}>
                  Cancel
                </button>
              </span>
            </>
          )}
        </div>
      )}

      {run && (
        <div className="flex flex-col gap-1 text-[14px]">
          <span>
            <b>{run.status === "watching" ? "Following the payment" : run.status === "done" ? "Done" : run.status === "asking" ? "Waiting for you" : run.status === "working" ? "Working" : run.status === "cancelled" ? "Cancelled" : "Failed"}</b>
            {run.paymentStatus ? ` · ${run.paymentStatus}` : ""}
          </span>
          {run.note && <span className="text-grey">{run.note}</span>}
          {run.error && <span className="text-bad">{run.error}</span>}
          {run.flowId && <span className="break-all font-mono text-[12px] text-grey">flow_id {run.flowId} · payment_request_id {run.paymentRequestId}</span>}
          {run.txUrl ? (
            <a href={run.txUrl} target="_blank" rel="noreferrer" className="break-all font-semibold">
              Sepolia transaction {run.tx}
            </a>
          ) : (
            run.tx && <span className="break-all text-grey">Rehearsal transaction id (made up, not on any chain): {run.tx}</span>
          )}
          {run.attributionVerified !== undefined && <span>attribution_verified: <b>{String(run.attributionVerified)}</b></span>}
          <details>
            <summary className="cursor-pointer text-[13px] font-semibold text-grey">Steps ({run.steps.length})</summary>
            <ol className="m-0 mt-1 flex flex-col gap-1 pl-5 text-[12px] text-grey">
              {run.steps.map((s, i) => (
                <li key={i}>
                  <span className="font-mono">{s.at.slice(11, 19)}</span> {s.what}
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
      {err && <span className="text-[14px] text-bad">{err}</span>}
    </Card>
  );
}
