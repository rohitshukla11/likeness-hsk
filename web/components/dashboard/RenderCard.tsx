"use client";

/**
 * One delivered render (as in likeness-ai's gallery): the image, or the video's poster with play, then
 * its type and label, the parties, the licence status now ("since revoked"), the exact prompt (collapsed)
 * with its sha256, Download, Verify this file, and the payment and receipt transactions. Files load with
 * the sign-in token: renders have no public URL.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { btnClass } from "@/components/ds";
import { Tx } from "@/components/ui";
import { authedBlob, fmtBytes, saveBlob, type RenderView } from "@/lib/api";

function useBlobUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let u: string | undefined;
    let live = true;
    authedBlob(path).then(
      (b) => {
        if (!live) return;
        u = URL.createObjectURL(b);
        setUrl(u);
      },
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
  return { url, error };
}

export function RenderCard({ r, mode }: { r: RenderView; mode: "brand" | "creator" }) {
  const isVideo = r.kind === "video";
  const base = `/api/renders/${r.assetHash}`;
  const poster = useBlobUrl(isVideo ? (r.hasPoster ? `${base}/poster` : null) : `${base}/file`);
  const [playing, setPlaying] = useState(false);
  const video = useBlobUrl(isVideo && playing ? `${base}/file` : null);
  const [big, setBig] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const revoked = r.licenceStatus === "Revoked";
  const test = !r.model;
  const box = `w-[240px] rounded-[12px] ${isVideo ? "aspect-video" : "aspect-square"}`;

  const media = isVideo ? (
    video.url ? (
      <video className={`${box} bg-ink`} src={video.url} controls autoPlay muted playsInline />
    ) : (
      <button type="button" onClick={() => setPlaying(true)} aria-label="Play the video" className={`${box} relative block overflow-hidden bg-ink p-0`}>
        {poster.url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster.url} alt="" className="h-full w-full object-cover" />
        )}
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-lime text-[18px] text-ink">▶</span>
        </span>
        {playing && <span className="absolute bottom-2 left-2 text-[12px] text-white">Loading…</span>}
      </button>
    )
  ) : poster.url ? (
    <button type="button" onClick={() => setBig(true)} aria-label="Enlarge image" className="block rounded-[12px] p-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={poster.url} alt={`Image ad of ${r.creatorName ?? "the creator"}`} className={`${box} bg-paper object-cover`} />
    </button>
  ) : (
    <div className={`${box} flex items-center justify-center bg-paper p-3 text-center text-[13px] ${poster.error ? "text-bad" : "animate-pulse text-grey"}`}>{poster.error ?? ""}</div>
  );

  return (
    <div className="flex flex-col gap-3 rounded-[16px] bg-white p-3 sm:flex-row">
      <div className="shrink-0">{media}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-[14px]">
        <span className="flex flex-wrap items-center gap-2">
          <b>{isVideo ? "Video ad" : "Image ad"}</b>
          <span className="rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-semibold text-lime">{test ? "TEST RENDER" : "AI-generated · licensed via Likeness"}</span>
          {revoked && <span className="rounded-full bg-bad-bg px-2.5 py-0.5 text-[12px] font-semibold text-bad">Licensed when made, since revoked</span>}
        </span>
        <span className="text-grey">
          {new Date(r.createdAt).toLocaleString()} · {mode === "brand" ? `Creator: ${r.creatorName ?? "Ana Reyes"}` : `Brand: ${r.brand ?? "the demo brand agent"}`} · licence #{r.licenceId}, render {r.renderIndex}
          {r.size ? ` · ${fmtBytes(r.size)}` : ""}
        </span>
        {r.note && <span className="text-[13px] text-wait">{r.note}</span>}
        {r.prompt ? (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-grey">Prompt{r.model ? ` (${r.model})` : ""}</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-[10px] bg-paper p-2 font-sans text-[13px]">{r.prompt}</pre>
            <span className="break-all font-mono text-[11px] text-grey">sha256 {r.promptSha256}</span>
          </details>
        ) : (
          <span className="text-[13px] text-grey">No prompt recorded (made before prompts were recorded).</span>
        )}
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnClass("outline", "min-h-9 px-3 text-[13px]")}
            onClick={() =>
              authedBlob(`${base}/file`).then(
                (b) => saveBlob(b, `likeness-${r.licenceId}-${r.renderIndex}${isVideo ? ".mp4" : r.mime === "image/svg+xml" ? ".svg" : ".jpg"}`),
                (e) => setMsg((e as Error).message),
              )
            }
          >
            Download
          </button>
          <Link href={`/verify?hash=${r.assetHash}`} className={btnClass("outline", "min-h-9 px-3 text-[13px]")}>
            Verify this file
          </Link>
          {r.hspTx && <span className="text-[13px] text-grey">payment <Tx hash={r.hspTx} label={`${r.hspTx.slice(0, 8)}…`} /></span>}
          {r.anchorTx && <span className="text-[13px] text-grey">receipt <Tx hash={r.anchorTx} label={`${r.anchorTx.slice(0, 8)}…`} /></span>}
        </span>
        {msg && <span className="text-[13px] text-bad">{msg}</span>}
      </div>
      {big && poster.url && (
        <div role="dialog" aria-label="Image ad, full size" className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6" onClick={() => setBig(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={poster.url} alt="" className="max-h-full max-w-full rounded-[14px]" />
        </div>
      )}
    </div>
  );
}
