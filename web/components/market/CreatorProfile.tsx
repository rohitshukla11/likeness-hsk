"use client";

/**
 * A creator's profile: portrait, the terms their agent enforces (read from HSK Chain), and the licence
 * request. A signed-in brand (or the admin) asks: the brand's agent asks the creator's agent over A2A
 * and the licence is issued on chain.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppPage, btnClass, Card, ErrorCard, StatusPill, TagChip } from "@/components/ds";
import { useAppState } from "@/components/site/AppState";
import { useAuth } from "@/components/site/Auth";
import { SignIn } from "@/components/site/SignIn";
import { Field, inputClass } from "@/components/ui";
import { api, type BundleView, type CreatorView } from "@/lib/api";
import { categoriesOf, displayOf } from "@/lib/demo";
import { chainLabel } from "@/lib/chain";

export function CreatorProfile({ address }: { address: string | undefined }) {
  const { state } = useAppState();
  const { user, me } = useAuth();
  const [c, setC] = useState<CreatorView | null>(null);
  const [missing, setMissing] = useState(false);
  const [images, setImages] = useState(2);
  const [videos, setVideos] = useState(1);
  const [days, setDays] = useState(7);
  const [brief, setBrief] = useState("Wearing our new running shoes on a sunny city street, bright modern ad style");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ bundle: BundleView; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    api<CreatorView>(`/api/creators/${address}`).then(setC, () => setMissing(true));
  }, [address]);

  if (missing) return <AppPage title="Creator not found" description="No registered creator at this address on this server.">{null}</AppPage>;
  const d = c ? displayOf(c) : null;
  const t = c?.terms;
  const role = me?.account?.role;
  const canRequest = !!state?.operator || role === "brand";
  const her = c?.synthetic ? "her" : "their";
  const mult = state?.ads?.videoMultiplier ?? 3;
  const total = t ? images * Number(t.price) + videos * Number(t.price) * mult : 0;

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await api<{ bundle: BundleView; error?: string }>("/api/brand/bundle", { creator: c!.address, brief, images, videos, durationSeconds: days * 86400 }));
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      setDone(await api<{ bundle: BundleView; error?: string }>("/api/brand/bundle/retry", { bundleId: done!.bundle.id }));
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const gate = canRequest ? undefined : !user ? "Sign in as a brand" : role === "creator" ? "Brand accounts only" : "Choose Brand first";

  return (
    <AppPage title={d?.name ?? "…"} description={d?.bio}>
      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-[14px]">
          <div className="relative aspect-[4/5] overflow-hidden rounded-[20px] bg-[linear-gradient(160deg,#D4F06A_0%,#F2FAD6_100%)]">
            {d?.photo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={d.photo} alt={c?.synthetic ? `Illustrated portrait of ${d.name}, a synthetic demo creator` : `Photo of ${d.name}, shared with their consent`} className="absolute inset-0 h-full w-full object-cover object-top" />
            )}
            {d && <span className="absolute left-3 top-3 rounded-full bg-ink px-3 py-1 text-[12px] font-semibold text-lime">{d.label}</span>}
          </div>
          {c?.youtube && (
            <a href={`https://www.youtube.com/channel/${c.youtube.channelId}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-[16px] bg-white px-3 py-2.5 text-ink no-underline">
              {c.youtube.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.youtube.thumbnail} alt="" width={36} height={36} referrerPolicy="no-referrer" className="h-9 w-9 rounded-full" />
              )}
              <span className="flex min-w-0 flex-col">
                <b className="truncate text-[14px]">{c.youtube.title}</b>
                <span className="text-[12px] text-grey">YouTube channel, verified by Likeness with the owner&apos;s Google account</span>
              </span>
            </a>
          )}
          {c && state && (
            <p className="m-0 text-[13px] text-grey">
              Creator <a className="font-mono" href={`${state.explorer}/address/${c.address}`} target="_blank" rel="noreferrer">{c.address.slice(0, 8)}…{c.address.slice(-6)}</a> · agent card{" "}
              <a href={c.agentCard}>{c.synthetic ? "/.well-known/agent-card.json" : "A2A card"}</a>
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-[14px]">
          <Card tone="ink" title={`${c?.synthetic ? "Her" : "Their"} terms, on ${chainLabel(state?.chainId)}`}>
            {t ? (
              <dl className="m-0 grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-[14px]">
                <dt className="text-grey-dark">Price</dt>
                <dd className="m-0 font-semibold">
                  {t.price} {state?.token ?? "USDT"} per render
                </dd>
                <dt className="text-grey-dark">Uses</dt>
                <dd className="m-0 flex flex-wrap gap-1.5">
                  {categoriesOf(t.categories).map((x) => (
                    <TagChip key={x}>{x}</TagChip>
                  ))}
                </dd>
                <dt className="text-grey-dark">Renders</dt>
                <dd className="m-0">up to {t.maxRenders} per licence</dd>
                <dt className="text-grey-dark">Approval</dt>
                <dd className="m-0">{t.autoApprove ? "Instant, within these terms" : "The creator approves each request"}</dd>
                <dt className="text-grey-dark">Banned</dt>
                <dd className="m-0">political, adult, minors, impersonation, deception: in the contract</dd>
              </dl>
            ) : (
              <span className="text-grey-dark">Reading the chain…</span>
            )}
          </Card>

          <Card id="request" title="Request a licence" action={gate ? <StatusPill kind="neutral">{gate}</StatusPill> : undefined}>
            <p className="m-0 text-[14px] text-grey">
              The brand&apos;s agent asks {d?.name ?? "the creator"}&apos;s agent over A2A; it checks the request against {her} terms, and the licence is issued on chain. Each
              render is then paid separately through HSP, from the shared demo brand agent wallet.
            </p>
            {!user && !state?.operator && (
              <div>
                <SignIn light />
              </div>
            )}
            {user && !role && (
              <Link href="/dashboard" className={btnClass("outline", "self-start")}>
                Choose Brand on your dashboard
              </Link>
            )}
            <form onSubmit={request} className="flex flex-col gap-3">
              <Field label="Brief: product, setting, style">
                <textarea className={`${inputClass} min-h-20`} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={600} />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={`Images (${t ? t.price : "…"} each)`}>
                  <select className={inputClass} value={images} onChange={(e) => setImages(Number(e.target.value))}>
                    {[0, 1, 2, 3, 4, 5].filter((n) => !t || n <= t.maxRenders).map((n) => (
                      <option key={n} value={n}>
                        {n} image{n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Videos, 8 s (${t ? (Number(t.price) * mult).toFixed(2) : "…"} each)`}>
                  <select className={inputClass} value={videos} onChange={(e) => setVideos(Number(e.target.value))}>
                    {[0, 1, 2].filter((n) => !t || n <= t.maxRenders).map((n) => (
                      <option key={n} value={n}>
                        {n} video{n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Duration">
                  <select className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    {[1, 7, 14, 30].map((n) => (
                      <option key={n} value={n}>
                        {n} day{n === 1 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="m-0 text-[14px]">
                Total up to <b>{t ? total.toFixed(2) : "…"} {state?.token ?? "USDT"}</b>
                <span className="text-grey">, paid per image or video when each is made</span>
              </p>
              <p className="m-0 text-[13px] text-grey">
                One licence bundle: on chain that&apos;s one licence per media type (images at the creator&apos;s price, videos at {mult}×). Use: advertising; the brief is checked for banned uses before anything is issued or paid, and its hash is on chain.
              </p>
              <button type="submit" disabled={busy || !canRequest || !c || images + videos === 0} className={btnClass("lime", "self-start")}>
                {busy ? "Asking the creator's agent…" : "Request licence"}
              </button>
            </form>
            {error && <ErrorCard>{error}</ErrorCard>}
            {done && (
              <div className={`flex flex-wrap items-center gap-3 rounded-[16px] px-4 py-3 text-[14px] ${done.error ? "bg-bad-bg text-bad" : "bg-ok-bg text-ok"}`}>
                <span className="flex-1">
                  {done.error ? "Partly issued: " : "Licence bundle issued on " + chainLabel(state?.chainId) + ", within " + her + " terms: "}
                  {[done.bundle.image && `images licence #${done.bundle.image.licenceId}`, done.bundle.video && `videos licence #${done.bundle.video.licenceId}`].filter(Boolean).join(", ")}
                  {done.error ? `. ${done.error}` : "."}
                </span>
                {done.error ? (
                  <button type="button" onClick={() => void retry()} disabled={busy} className={btnClass("ink")}>
                    {busy ? "Retrying…" : "Retry"}
                  </button>
                ) : (
                  <Link href={`/dashboard?bundle=${done.bundle.id}`} className={btnClass("ink")}>
                    Make the first ad
                  </Link>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </AppPage>
  );
}
