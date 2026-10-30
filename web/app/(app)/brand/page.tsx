"use client";

/**
 * The brand console: the brand agent's wallet, policy and caps; its licences (newest first); paying for
 * the next render with the two approvals and HSP's statuses; and the payments made, each with its
 * transactions. Paying runs as a job on the server; this page polls it.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, Card, EmptyState, ErrorCard, StatCard } from "@/components/ds";
import { ApprovalPanel, BehindTheScenes, HspStatusList, PaidResult, StepList } from "@/components/brand/PaymentFlow";
import { useAppState } from "@/components/site/AppState";
import { StatusBadge, Tx } from "@/components/ui";
import { api, downloadAsBrand, END_STATES, usd, type JobView, type Licence, type LogEvent, type Payment } from "@/lib/api";
import { DEMO_CREATOR } from "@/lib/demo";

export default function BrandPage() {
  return (
    <Suspense>
      <Brand />
    </Suspense>
  );
}

function Brand() {
  const { state, refresh } = useAppState();
  const params = useSearchParams();
  const [licences, setLicences] = useState<Licence[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [view, setView] = useState<JobView | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [paying, setPaying] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [l, p] = await Promise.all([api<Licence[]>("/api/licences?who=brand"), api<Payment[]>("/api/payments?who=brand")]);
    setLicences(l.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)));
    setPayments(p);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function pay(licenceId: string) {
    setError(null);
    setView(null);
    setEvents([]);
    setPaying(licenceId);
    try {
      const start = await api<{ jobId: string; fromSeq: number }>("/api/brand/pay", { licenceId, brief: "spring campaign hero shot" });
      let lastLog = 0;
      for (;;) {
        const v = await api<JobView>(`/api/brand/job?id=${start.jobId}`);
        setView(v);
        const done = END_STATES.includes(v.job.state);
        if (done || Date.now() - lastLog > 2000) {
          lastLog = Date.now();
          const ev = await api<LogEvent[]>(`/api/log?since=${start.fromSeq}`);
          setEvents(done ? ev.filter((e) => e.seq <= v.toSeq) : ev);
        }
        if (done) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPaying(null);
      void load();
      void refresh();
    }
  }

  async function decide(id: string, approve: boolean) {
    setDeciding(true);
    try {
      await api("/api/brand/approve", { id, decision: approve ? "approve" : "cancel" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeciding(false);
    }
  }

  const shown = licences ? (showEarlier ? licences : licences.slice(0, 1)) : [];
  const highlight = params.get("licence");
  const j = view?.job;
  const operator = !!state?.operator;

  return (
    <AppPage
      title="Brand console"
      description="Your payment agent: it licenses faces from creators' agents and pays each render through HSP Agentic Payment, after your two approvals."
      actions={
        <Link href="/creators/ana-reyes#request" className={btnClass("lime")}>
          Request a licence
        </Link>
      }
    >
      {state && !operator && state.login && (
        <Card tone="lavender">
          <p className="m-0 text-[14px]">
            Operator actions (request a licence, pay with the two approvals) need the <b>demo password</b> the team shared with judges: enter it at the top right.
            Everything else here, and Verify, is open to everyone.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-[14px] lg:grid-cols-4">
        <StatCard label="Brand wallet" value={state ? <a className="text-[18px]" href={`${state.explorer}/address/${state.brand}`} target="_blank" rel="noreferrer">{state.brand.slice(0, 6)}…{state.brand.slice(-4)}</a> : "…"} note="the brand agent's testnet wallet" />
        <StatCard label="Policy" value={state ? `≤ ${state.policy.maxPricePerRender}` : "…"} note={state ? `${state.token} a render · ${state.policy.dailyBudget} a day · advertising only` : undefined} />
        <StatCard label="Spent today" value={state ? usd(state.spentToday) : "…"} note={state ? `${state.token}, this server session` : undefined} />
        <StatCard label="Paid renders today" value={state?.cap ? `${state.cap.paidToday} / ${state.cap.max}` : "—"} note="this server's daily cap (UTC)" />
      </div>

      {error && <ErrorCard action={<button type="button" className={btnClass("outline")} onClick={() => setError(null)}>Dismiss</button>}>{error}</ErrorCard>}

      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-[18px]">
          <Card title="Licences" action={<span className="text-[13px] text-grey">from {DEMO_CREATOR.name}</span>}>
            {licences === null ? (
              <span className="text-[14px] text-grey">Reading HSK Chain…</span>
            ) : licences.length === 0 ? (
              <EmptyState title="No licences yet">Request one from the creator&apos;s profile.</EmptyState>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {shown.map((l) => (
                  <li key={l.id} className={`flex flex-wrap items-center gap-3 rounded-[14px] px-3 py-2.5 ${highlight === l.id ? "bg-lavender" : "bg-paper"}`}>
                    <span className="font-semibold">#{l.id}</span>
                    <StatusBadge status={l.status} />
                    <span className="text-[13px] text-grey">
                      {l.renderCount} / {l.renderCap} renders · until {new Date(l.end * 1000).toLocaleDateString()}
                    </span>
                    <button type="button" disabled={!operator || paying !== null} onClick={() => void pay(l.id)} className={btnClass("ink", "ml-auto")}>
                      {paying === l.id ? "Paying…" : "Pay for next render"}
                    </button>
                  </li>
                ))}
                {licences.length > 1 && (
                  <li>
                    <button type="button" onClick={() => setShowEarlier(!showEarlier)} className={btnClass("ghost", "px-0")}>
                      {showEarlier ? "Hide earlier licences" : `Show earlier licences (${licences.length - 1})`}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </Card>

          <Card title="Payments made">
            {!payments?.length ? (
              <span className="text-[14px] text-grey">{payments ? "No payments yet." : "Reading HSK Chain…"}</span>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="text-grey">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Licence · render</th>
                      <th className="py-1.5 pr-3 font-medium">Amount</th>
                      <th className="py-1.5 pr-3 font-medium">HSP payment</th>
                      <th className="py-1.5 pr-3 font-medium">Recorded</th>
                      <th className="py-1.5 font-medium">Receipt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={`${p.licenceId}-${p.renderIndex}`} className="border-t border-divider">
                        <td className="py-1.5 pr-3">
                          #{p.licenceId} · {p.renderIndex}
                        </td>
                        <td className="py-1.5 pr-3">
                          {usd(p.amount)} {state?.token}
                        </td>
                        <td className="py-1.5 pr-3">
                          <Tx hash={p.hspTx} label={`${p.hspTx.slice(0, 8)}…`} />
                        </td>
                        <td className="py-1.5 pr-3">
                          <Tx hash={p.recordTx} label={`${p.recordTx.slice(0, 8)}…`} />
                        </td>
                        <td className="py-1.5">{p.anchorTx ? <Tx hash={p.anchorTx} label={`${p.anchorTx.slice(0, 8)}…`} /> : <span className="text-grey">pending</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-[14px]">
          {!view ? (
            <EmptyState title="This render, step by step">
              Pay for a render to see each step: the A2A request, the HSP order, your policy check, the quote, approval 1, the signature, approval 2, the
              submission, HSP&apos;s status, the record on HSK Chain and the receipt.
            </EmptyState>
          ) : (
            <>
              <p className={`m-0 text-[15px] font-semibold ${j?.state === "refused" || j?.state === "failed" ? "text-bad" : ""}`}>
                {j?.state === "paying"
                  ? view.approvals.length
                    ? "Waiting for your approval."
                    : "Working with HSP…"
                  : j?.state === "submitted"
                    ? "Submitted to HSP. Following its status…"
                    : j?.state === "recorded"
                      ? "Paid and recorded on HSK Chain. Rendering…"
                      : j?.state === "refused"
                        ? j.error
                        : j?.state === "failed"
                          ? `Failed: ${j.error}`
                          : j?.state === "paid-not-recorded"
                            ? `Paid through HSP. ${j.note ?? ""}`
                            : null}
              </p>
              {view.approvals.map((a) => (
                <ApprovalPanel key={a.id} a={a} onDecide={decide} busy={deciding} />
              ))}
              {j?.state === "delivered" && (
                <PaidResult
                  view={view}
                  downloading={downloading}
                  onDownload={async () => {
                    setDownloading(true);
                    try {
                      await downloadAsBrand(j.assetHash!, j.licenceId, j.renderIndex!);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setDownloading(false);
                    }
                  }}
                />
              )}
              {j?.flowId && <HspStatusList view={view} />}
              {j?.state !== "refused" && (
                <Card title="Steps">
                  <StepList events={events} />
                </Card>
              )}
              {events.length > 0 && <BehindTheScenes events={events} />}
            </>
          )}
        </div>
      </div>
    </AppPage>
  );
}
