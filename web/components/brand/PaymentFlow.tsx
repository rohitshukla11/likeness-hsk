"use client";

/**
 * One paid render as the brand sees it: the two approvals (before signing, before submitting), HSP's
 * statuses, the steps matched in the agents' log, the result with its transactions and the download,
 * and "Behind the scenes": every A2A message, mandate and HSP call, raw.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { btnClass, Card, StatusPill } from "@/components/ds";
import { IconCheck } from "@/components/ds/icons";
import { Tx } from "@/components/ui";
import { HSP_STATES, rawToDecimal, type Approval, type ConfirmationView, type JobView, type LogEvent } from "@/lib/api";
import { hspLabel } from "@/lib/chain";
import { useAppState } from "@/components/site/AppState";
import { AGENTIC_STEPS } from "@/lib/steps";

/** A quote's time left, live: amber under a minute, "expired" after (HSP prepares a new quote). */
export function QuoteCountdown({ expiresAt }: { expiresAt: string }) {
  const end = Date.parse(expiresAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((end - now) / 1000));
  if (Number.isNaN(end)) return <>{expiresAt}</>;
  const at = new Date(end).toLocaleTimeString();
  return (
    <span className="tnum" role="timer" aria-live="off">
      {left > 0 ? (
        <b className={left < 60 ? "text-[#8a4b00]" : undefined}>
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
        </b>
      ) : (
        <b className="text-[#a3261b]">expired</b>
      )}{" "}
      <span className="text-[#3E4148]">(at {at})</span>
    </span>
  );
}

export function ApprovalPanel({ a, onDecide, busy }: { a: Approval; onDecide: (id: string, approve: boolean) => void; busy: boolean }) {
  const sign = a.stage === "sign";
  return (
    <section aria-label={sign ? "Approval 1: before signing" : "Approval 2: before submitting"} className="flex flex-col gap-3 rounded-[20px] border-2 border-ink bg-lime p-[18px] sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-ink px-3 py-1 text-[12px] font-semibold text-lime">Approval {sign ? "1 of 2" : "2 of 2"}</span>
        <h2 className="m-0 text-[20px] font-bold">{sign ? "Approve signing this payment?" : "Approve submitting this signed payment?"}</h2>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 text-[14px] sm:grid-cols-[11rem_1fr]">
        <dt className="text-[#3E4148]">Recipient (pay_to)</dt>
        <dd className="m-0 break-all font-mono text-[13px]">{a.payTo}</dd>
        <dt className="text-[#3E4148]">Payer</dt>
        <dd className="m-0 break-all font-mono text-[13px]">{a.payer}</dd>
        <dt className="text-[#3E4148]">token_total_raw</dt>
        <dd className="m-0">
          <b className="font-mono">{a.tokenTotalRaw}</b> raw units (≈ {rawToDecimal(a.tokenTotalRaw, a.token.decimals)} {a.token.symbol}, {a.token.decimals} decimals)
        </dd>
        <dt className="text-[#3E4148]">Token</dt>
        <dd className="m-0 break-all font-mono text-[13px]">{a.token.address}</dd>
        <dt className="text-[#3E4148]">Network fee</dt>
        <dd className="m-0">{a.gasFeeAdvanced === true ? "advanced by the platform, not in the total" : a.gasFeeAdvanced === false ? "included in the total" : "not stated"}</dd>
        <dt className="text-[#3E4148]">Quote expires</dt>
        <dd className="m-0">
          <QuoteCountdown expiresAt={a.quoteExpiresAt} />
        </dd>
      </dl>
      <p className="m-0 text-[13px] text-[#3E4148]">
        {sign ? "The brand wallet will sign exactly the authorization HSP returned. Nothing is sent yet." : "HSP will broadcast the payment. The amount is an authorization, not funds received."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => onDecide(a.id, true)} className={btnClass("ink")}>
          {sign ? "Approve and sign" : "Approve and submit"}
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide(a.id, false)} className={btnClass("outline")}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** HSP's states are sequential: one before the furthest seen was passed between two polls. */
export function HspStatusList({ view }: { view: JobView }) {
  const seen = new Set(view.statuses.map((s) => s.status));
  const furthest = Math.max(-1, ...HSP_STATES.map((st, i) => (seen.has(st) ? i : -1)));
  const failed = view.statuses.find((s) => s.status === "payment-failed");
  const { state } = useAppState();
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2">HSP payment status <span className="rounded-full bg-paper px-2 py-0.5 text-[12px] font-semibold text-grey">{hspLabel(state?.gateway, state?.chainId)}</span></span>} action={view.attribution === true ? <StatusPill kind="licensed">attribution verified</StatusPill> : view.attribution === false ? <StatusPill kind="revoked">attribution NOT verified</StatusPill> : undefined}>
      <ol className="m-0 flex list-none flex-wrap gap-2 p-0">
        {HSP_STATES.map((st, i) => (
          <li key={st} title={i < furthest && !seen.has(st) ? "passed between two polls" : undefined}>
            <StatusPill kind={i <= furthest ? "licensed" : "neutral"}>{st.replace("payment-", "")}</StatusPill>
          </li>
        ))}
        {failed && (
          <li>
            <StatusPill kind="revoked">failed</StatusPill>
          </li>
        )}
      </ol>
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[10rem_1fr]">
        {view.job.flowId && (
          <>
            <dt className="text-grey">flow_id</dt>
            <dd className="m-0 break-all font-mono">{view.job.flowId}</dd>
            <dt className="text-grey">payment_request_id</dt>
            <dd className="m-0 break-all font-mono">{view.job.paymentRequestId}</dd>
          </>
        )}
        <dt className="text-grey">transaction</dt>
        <dd className="m-0">{view.tx ? <Tx hash={view.tx} /> : "not broadcast yet"}</dd>
      </dl>
      {view.confirmations && <ConfirmationProgress c={view.confirmations} />}
    </Card>
  );
}

/** The payment's confirmations on chain while HSP hasn't reported it safe yet. */
export function ConfirmationProgress({ c }: { c: ConfirmationView }) {
  const shown = Math.min(c.count, c.target);
  const mins = Math.ceil(c.etaSeconds / 60);
  return (
    <div className="flex flex-col gap-1.5" aria-label="Confirmations">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[14px]">
        <span>
          Sepolia confirmations <b className="tnum">{shown}/{c.target}</b>
        </span>
        <span className="text-[13px] text-grey">
          {c.etaSeconds > 0 ? `~${mins} min left` : "waiting for HSP's next status check (every 15 s)"}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[#ECEEE8]" role="progressbar" aria-valuemin={0} aria-valuemax={c.target} aria-valuenow={shown}>
        <div className="h-full rounded-full bg-[#3b6e25] transition-[width] duration-700" style={{ width: `${(shown / c.target) * 100}%` }} />
      </div>
      <span className="text-[12px] text-grey">HashKey QA reports payment-safe at about {c.target} blocks (12 s each); the payment is recorded and the ad made only then.</span>
    </div>
  );
}

export function StepList({ events }: { events: LogEvent[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-0 p-0">
      {AGENTIC_STEPS.map((s, i) => {
        const hits = events.filter(s.match);
        const e = s.last ? hits.at(-1) : hits[0];
        const tx = e && s.tx ? s.tx(e) : undefined;
        return (
          <li key={s.id} className="flex gap-3 border-l-2 border-divider pb-3 pl-4 last:pb-0" style={{ borderColor: e ? "#3b6e25" : undefined }}>
            <span aria-hidden="true" className={`-ml-[27px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${e ? "bg-lime text-ink" : "bg-[#ECEEE8] text-grey"}`}>
              {e ? <IconCheck size={13} stroke="#121316" /> : i + 1}
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="text-[14px] font-semibold">{s.title}</span>
              <span className="text-[12px] text-grey">{s.who}</span>
              {e && (
                <span className="text-[13px]">
                  {e.summary} {tx && <Tx hash={tx} />}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function BehindTheScenes({ events }: { events: LogEvent[] }) {
  return (
    <details className="group rounded-[20px] bg-ink p-[18px] text-white sm:px-5 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold">
        Behind the scenes: {events.length} A2A, mandate and HSP messages
        <span aria-hidden="true" className="transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <ol className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
        {events.map((e) => (
          <li key={e.seq} className="rounded-[12px] bg-ink-raised px-3 py-2 text-[13px]">
            <div className="flex flex-wrap gap-x-3">
              <span className="font-mono text-grey-dark">{e.at.slice(11, 19)}</span>
              <span className="font-semibold text-lime">{e.actor}</span>
              <span className="text-grey-dark">{e.kind}</span>
              <span className="min-w-0 break-words">{e.summary}</span>
            </div>
            {e.data && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12px] text-grey-dark">message</summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-black/40 p-2 text-[11px]">{JSON.stringify(e.data, null, 2)}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function PaidResult({ view, onDownload, downloading, preview }: { view: JobView; onDownload: () => void; downloading: boolean; preview?: { url: string; mime: string } | null }) {
  const j = view.job;
  return (
    <section aria-label="Result" className="flex flex-col gap-2 rounded-[20px] bg-white p-[18px] sm:px-5">
      <h2 className="m-0 text-[18px] font-bold">
        {j.kind === "video" ? "Video" : "Image"} ad {j.renderIndex} of licence #{j.licenceId}: paid, recorded and delivered
      </h2>
      {preview &&
        (preview.mime.startsWith("video/") ? (
          <video src={preview.url} controls autoPlay muted loop playsInline className="w-full rounded-[14px] bg-ink" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview.url} alt={`The ${j.kind === "video" ? "video" : "image"} ad`} className="w-full rounded-[14px] bg-paper object-contain" />
        ))}
      {j.note && <p className="m-0 text-[13px] text-grey">{j.note}</p>}
      {j.model && <p className="m-0 text-[13px] text-grey">Made with {j.model} on Vertex AI, from the creator&apos;s consented photo, after the payment was recorded.</p>}
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-[14px] sm:grid-cols-[10rem_1fr]">
        <dt className="text-grey">HSP payment</dt>
        <dd className="m-0">{j.hspTx ? <Tx hash={j.hspTx} /> : "—"}</dd>
        <dt className="text-grey">Receipt</dt>
        <dd className="m-0">{j.anchorTx ? <Tx hash={j.anchorTx} /> : "—"}</dd>
        <dt className="text-grey">File sha256</dt>
        <dd className="m-0 break-all font-mono text-[12px]">{j.assetHash}</dd>
      </dl>
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" onClick={onDownload} disabled={downloading} className={btnClass("lime")}>
          {downloading ? "Downloading…" : "Download (signed by the brand wallet)"}
        </button>
        <Link href={`/verify?hash=${j.assetHash}`} className={btnClass("outline")}>
          Verify this file
        </Link>
      </div>
    </section>
  );
}
