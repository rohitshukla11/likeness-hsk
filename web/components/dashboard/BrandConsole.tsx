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
import { useAuth } from "@/components/site/Auth";
import { StatusBadge, Tx } from "@/components/ui";
import { RenderCard } from "@/components/dashboard/RenderCard";
import { inputClass } from "@/components/ui";
import { api, downloadAsBrand, END_STATES, fetchRenderAsBrand, fmtBytes, usd, type BundleView, type CreatorView, type JobView, type LogEvent, type Payment, type RenderView } from "@/lib/api";
import { displayOf } from "@/lib/demo";
import { chainLabel } from "@/lib/chain";

export function BrandConsole() {
  return (
    <Suspense>
      <Brand />
    </Suspense>
  );
}

function Brand() {
  const { state, refresh } = useAppState();
  const { user, me, refreshMe } = useAuth();
  const params = useSearchParams();
  const [names, setNames] = useState<Record<string, string>>({});
  const [bundles, setBundles] = useState<BundleView[] | null>(null);
  const [renders, setRenders] = useState<RenderView[]>([]);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  // The prompt panel for one render: pre-filled with the exact text sent to the model(s), editable.
  const [composer, setComposer] = useState<{ bundleId: string; licenceId: string; kind: "image" | "video"; prompt: string; motion?: string; template: { prompt: string; motion?: string } } | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [view, setView] = useState<JobView | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [paying, setPaying] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [preview, setPreview] = useState<{ hash: string; url: string; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, p, cs] = await Promise.all([api<BundleView[]>("/api/bundles?who=brand"), api<Payment[]>("/api/payments?who=brand"), api<CreatorView[]>("/api/creators")]);
    setBundles(b);
    // Galleries are private: a brand's own renders, or all of them for the operator.
    const r = await api<{ renders: RenderView[]; totalBytes?: number }>("/api/renders?who=brand").catch(() => ({ renders: [] as RenderView[], totalBytes: undefined }));
    setRenders(r.renders);
    setTotalBytes(r.totalBytes ?? null);
    setPayments(p);
    setNames(Object.fromEntries(cs.map((c) => [c.address.toLowerCase(), displayOf(c).name])));
  }, []);
  // Reloaded once the Google session is restored: a signed-in brand sees only its own bundles.
  useEffect(() => {
    if (user !== undefined) void load().catch((e) => setError((e as Error).message));
  }, [load, user, me?.account?.role]);

  async function openComposer(b: BundleView, kind: "image" | "video") {
    const licenceId = kind === "video" ? b.video!.licenceId : b.image!.licenceId;
    setError(null);
    try {
      const t = await api<{ prompt: string; motion?: string }>(`/api/brand/prompt?licenceId=${licenceId}`);
      setComposer({ bundleId: b.id, licenceId, kind, prompt: t.prompt, motion: t.motion, template: { prompt: t.prompt, motion: t.motion } });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function pay(licenceId: string, prompts?: { prompt: string; motion?: string }) {
    setError(null);
    setView(null);
    setEvents([]);
    setPreview(null);
    setPaying(licenceId);
    try {
      const start = await api<{ jobId: string; fromSeq: number }>("/api/brand/pay", { licenceId, ...(prompts ?? {}) });
      setComposer(null);
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
        if (done && v.job.state === "delivered" && v.job.assetHash) {
          // The finished ad, fetched the way the brand downloads it (claim signed by the brand wallet).
          const blob = await fetchRenderAsBrand(v.job.assetHash).catch(() => null);
          if (blob) setPreview({ hash: v.job.assetHash, url: URL.createObjectURL(blob), blob });
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
      void refreshMe();
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

  const shown = bundles ? (showEarlier ? bundles : bundles.slice(0, 3)) : [];
  const highlight = params.get("bundle");

  async function retry(bundleId: string) {
    setRetrying(bundleId);
    setError(null);
    try {
      const r = await api<{ error?: string }>("/api/brand/bundle/retry", { bundleId });
      if (r.error) setError(r.error);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(null);
    }
  }
  const j = view?.job;
  const isBrand = me?.account?.role === "brand";
  const operator = !!state?.operator || isBrand;

  return (
    <AppPage
      title="Brand console"
      description="Your payment agent: it licenses faces from creators' agents and pays each render through HSP Agentic Payment, after your two approvals."
      actions={
        <Link href="/creators" className={btnClass("lime")}>
          Request a licence
        </Link>
      }
    >

      <div className="grid grid-cols-2 gap-[14px] lg:grid-cols-4">
        <StatCard label="Shared demo agent wallet" value={state ? <a className="text-[18px]" href={`${state.explorer}/address/${state.brand}`} target="_blank" rel="noreferrer">{state.brand.slice(0, 6)}…{state.brand.slice(-4)}</a> : "…"} note="pays on behalf of every brand account (testnet)" />
        <StatCard label="Policy" value={state ? `≤ ${state.policy.maxPricePerRender}` : "…"} note={state ? `${state.token} a render · ${state.policy.dailyBudget} a day · advertising only` : undefined} />
        <StatCard label="Spent today" value={state ? usd(state.spentToday) : "…"} note={state ? `${state.token}, this server session` : undefined} />
        <StatCard
          label="Your ads today"
          value={me?.brand ? `${me.brand.image.used}/${me.brand.image.cap} · ${me.brand.video.used}/${me.brand.video.cap}` : state?.ads ? `${state.ads.usedToday.image}/${state.ads.siteCaps.image} · ${state.ads.usedToday.video}/${state.ads.siteCaps.video}` : "—"}
          note={state?.ads ? `images · videos (UTC day)${me?.brand ? ` · all brands ${state.ads.usedToday.image}/${state.ads.siteCaps.image} · ${state.ads.usedToday.video}/${state.ads.siteCaps.video}` : ", all brands"}${state.ads.ai ? "" : " · TEST RENDER mode"}` : undefined}
        />
      </div>

      {error && <ErrorCard action={<button type="button" className={btnClass("outline")} onClick={() => setError(null)}>Dismiss</button>}>{error}</ErrorCard>}

      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-[18px]">
          <Card
            title={isBrand ? "Your licence bundles" : "Licence bundles"}
            action={<span className="text-[13px] text-grey">{isBrand ? "taken by this account" : `the shared agent wallet's${totalBytes !== null ? ` · renders on disk ${fmtBytes(totalBytes)}` : ""}`}</span>}
          >
            {bundles === null ? (
              <span className="text-[14px] text-grey">Reading the chain…</span>
            ) : bundles.length === 0 ? (
              <EmptyState title="No licences yet">Request a bundle on a creator&apos;s profile: one brief, a number of images and videos.</EmptyState>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {shown.map((b) => {
                  const name = b.creatorName ?? names[b.creator.toLowerCase()] ?? `${b.creator.slice(0, 6)}…`;
                  return (
                    <li key={b.id} className={`flex flex-col gap-2 rounded-[14px] bg-paper px-3 py-3 ${highlight === b.id ? "ring-2 ring-lime" : ""}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <b className="text-[15px]">{name}</b>
                        <StatusBadge status={b.status} />
                        {b.partial && <span className="text-[13px] font-semibold text-bad">Partly issued</span>}
                        <span className="ml-auto text-[12px] text-grey">
                          {[b.image && `#${b.image.licenceId} images`, b.video && `#${b.video.licenceId} videos`].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      {b.brief && <p className="m-0 text-[13px] text-grey">&ldquo;{b.brief}&rdquo;</p>}
                      <p className="m-0 text-[14px]">
                        {b.image ? `Images ${b.image.used}/${b.image.cap}` : b.wanted.images ? `Images 0/${b.wanted.images} (not issued)` : "No images"} ·{" "}
                        {b.video ? `Videos ${b.video.used}/${b.video.cap}` : b.wanted.videos ? `Videos 0/${b.wanted.videos} (not issued)` : "No videos"}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {b.image && (
                          <button type="button" disabled={!operator || paying !== null} onClick={() => void openComposer(b, "image")} className={btnClass("ink")}>
                            {paying === b.image.licenceId ? "Paying…" : `Make image (${b.image.price})`}
                          </button>
                        )}
                        {b.video && (
                          <button type="button" disabled={!operator || paying !== null} onClick={() => void openComposer(b, "video")} className={btnClass("ink")}>
                            {paying === b.video.licenceId ? "Paying…" : `Make video (${b.video.price})`}
                          </button>
                        )}
                        {b.partial && !b.legacy && (
                          <button type="button" disabled={!operator || retrying !== null} onClick={() => void retry(b.id)} className={btnClass("outline")}>
                            {retrying === b.id ? "Retrying…" : "Retry the missing licence"}
                          </button>
                        )}
                      </div>
                      {composer?.bundleId === b.id && (
                        <form
                          className="flex flex-col gap-2 rounded-[12px] bg-white p-3"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void pay(composer.licenceId, { prompt: composer.prompt, ...(composer.kind === "video" ? { motion: composer.motion ?? "" } : {}) });
                          }}
                        >
                          <span className="text-[14px] font-semibold">{composer.kind === "video" ? "Video prompt" : "Image prompt"}: exactly what the model receives</span>
                          <label className="flex flex-col gap-1 text-[13px] text-grey">
                            {composer.kind === "video" ? "Opening frame (image model, with the creator's photo)" : "Prompt (image model, with the creator's photo)"}
                            <textarea className={`${inputClass} min-h-40 py-2 font-sans text-[14px] text-ink`} value={composer.prompt} onChange={(e) => setComposer({ ...composer, prompt: e.target.value })} maxLength={3000} />
                          </label>
                          {composer.kind === "video" && (
                            <label className="flex flex-col gap-1 text-[13px] text-grey">
                              Motion (Veo, 8 s)
                              <textarea className={`${inputClass} min-h-24 py-2 font-sans text-[14px] text-ink`} value={composer.motion ?? ""} onChange={(e) => setComposer({ ...composer, motion: e.target.value })} maxLength={2000} />
                            </label>
                          )}
                          <span className="text-[13px] text-grey">It&apos;s checked for banned uses and the creator&apos;s allowed uses before anything is signed or paid, and recorded with the render (its sha256 is shown on Verify).</span>
                          <span className="flex flex-wrap gap-2">
                            <button type="submit" disabled={paying !== null} className={btnClass("lime")}>
                              Pay and make the {composer.kind} ({composer.kind === "video" ? b.video?.price : b.image?.price})
                            </button>
                            <button type="button" onClick={() => setComposer({ ...composer, prompt: composer.template.prompt, motion: composer.template.motion })} className={btnClass("outline")}>
                              Reset to brief
                            </button>
                            <button type="button" onClick={() => setComposer(null)} className={btnClass("ghost")}>
                              Cancel
                            </button>
                          </span>
                        </form>
                      )}
                      {renders.some((r) => r.bundleId === b.id) && (
                        <details open={highlight === b.id || renders.filter((r) => r.bundleId === b.id).length <= 2} className="flex flex-col gap-2">
                          <summary className="cursor-pointer text-[13px] font-semibold text-grey">Renders ({renders.filter((r) => r.bundleId === b.id).length})</summary>
                          <div className="mt-2 flex flex-col gap-2">
                            {renders
                              .filter((r) => r.bundleId === b.id)
                              .map((r) => (
                                <RenderCard key={r.assetHash} r={r} mode="brand" />
                              ))}
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
                {bundles.length > 3 && (
                  <li>
                    <button type="button" onClick={() => setShowEarlier(!showEarlier)} className={btnClass("ghost", "px-0")}>
                      {showEarlier ? "Hide earlier bundles" : `Show earlier bundles (${bundles.length - 3})`}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </Card>

          <Card title="Payments made">
            {!payments?.length ? (
              <span className="text-[14px] text-grey">{payments ? "No payments yet." : "Reading the chain…"}</span>
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
              submission, HSP&apos;s status, the record on chain and the receipt.
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
                      ? `Paid and recorded on ${chainLabel(state?.chainId)}. Rendering…`
                      : j?.state === "generating"
                        ? `Paid and recorded on ${chainLabel(state?.chainId)}. Generating your ${j.kind === "video" ? "video" : "image"} ad: ${j.progress ?? "starting"}…`
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
                  preview={preview && preview.hash === j.assetHash ? { url: preview.url, mime: preview.blob.type } : null}
                  downloading={downloading}
                  onDownload={async () => {
                    setDownloading(true);
                    try {
                      await downloadAsBrand(j.assetHash!, j.licenceId, j.renderIndex!, preview && preview.hash === j.assetHash ? preview.blob : undefined);
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
