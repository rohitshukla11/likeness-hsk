"use client";

/**
 * Verify: anyone drops a file (hashed in the browser, never uploaded) or pastes its sha256, and sees
 * Licensed, Revoked ("licensed when made, since revoked"), Expired or Unknown, with the creator, the
 * licensee, the HSP payment and the receipt on HSK Chain behind the answer.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, CreatorFace, ErrorCard } from "@/components/ds";
import { IconCheck, IconCross, IconQuestion, IconUpload } from "@/components/ds/icons";
import { Addr, fmtDate, fmtDay, inputClass, Tx } from "@/components/ui";
import { api, sha256Hex, type Verdict } from "@/lib/api";
import { DEMO_CREATOR } from "@/lib/demo";

const LOOK = {
  Licensed: { bg: "bg-lime", stroke: "#DCF37B", stamp: "Licensed", icon: IconCheck },
  Revoked: { bg: "bg-coral", stroke: "#F7A4A1", stamp: "Licensed when made, since revoked", icon: IconCross },
  Expired: { bg: "bg-[#D9DCE2]", stroke: "#D9DCE2", stamp: "Expired", icon: IconQuestion },
  Unknown: { bg: "bg-[#D9DCE2]", stroke: "#D9DCE2", stamp: "Unknown", icon: IconQuestion },
} as const;

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}

function Verify() {
  const params = useSearchParams();
  const [hash, setHash] = useState(params.get("hash") ?? "");
  const [checked, setChecked] = useState<string | null>(null);
  const [result, setResult] = useState<Verdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ url: string; size: number; type: string } | null>(null);

  const byHash = useCallback(async (h: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setChecked(h.trim());
      setResult(await api<Verdict>(`/api/verify?hash=${h.trim()}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const h = params.get("hash");
    if (h) void byHash(h);
  }, [params, byHash]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setFile({ url: URL.createObjectURL(f), size: f.size, type: f.type || "file" });
    const h = await sha256Hex(f);
    setHash(h);
    await byHash(h);
  }

  const look = result ? LOOK[result.verdict] : null;
  const Icon = look?.icon ?? IconUpload;
  const known = result && result.verdict !== "Unknown";

  return (
    <AppPage title="Verify a file" description="Check whether the person in an image licensed it. Anyone can use this; no account, no password.">
      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex min-w-0 flex-col gap-[14px]">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFile(e.dataTransfer.files[0]);
            }}
            className="flex min-h-16 cursor-pointer items-center gap-3 rounded-[16px] border-2 border-dashed border-[#B9BEC6] bg-white px-3.5 text-[14px] font-semibold focus-within:outline focus-within:outline-[3px] focus-within:outline-violet"
          >
            <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-lime text-ink">
              <IconUpload size={20} />
            </span>
            <span className="flex-1">{busy ? "Checking…" : "Drop a file or choose one"}</span>
            <input id="file" type="file" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) void byHash(hash);
            }}
            className="flex flex-wrap items-center gap-2 text-[14px]"
          >
            <label htmlFor="hash" className="text-grey">
              or check a sha256
            </label>
            <input id="hash" className={`${inputClass} min-w-0 flex-[1_1_220px] font-mono text-[13px]`} placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} />
            <button type="submit" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())} className={btnClass("ink")}>
              Look up
            </button>
          </form>
          <figure className="m-0 flex flex-col gap-2 rounded-[20px] bg-white p-3">
            {file ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={file.url} alt="The checked file" className="max-h-[560px] w-full rounded-[14px] bg-paper object-contain" />
            ) : (
              <div className={`flex items-center justify-center rounded-[14px] bg-paper p-4 text-center text-[14px] text-grey ${result ? "min-h-28" : "aspect-[4/5] max-h-[420px]"}`}>
                {result ? "Checked by hash only, no file" : "The file you check appears here. It is hashed in your browser; nothing is uploaded."}
              </div>
            )}
            {checked && (
              <figcaption className="tnum break-all font-mono text-[12px] text-grey">
                sha256 {checked}
                {file ? ` · ${Math.round(file.size / 102.4) / 10} KB` : ""}
              </figcaption>
            )}
          </figure>
        </div>

        <div className="flex min-w-0 flex-col gap-[14px]">
          <section id="out" aria-label="Result" aria-live="polite" className={`flex items-center gap-4 rounded-[20px] px-5 py-[18px] ${look?.bg ?? "bg-white"}`}>
            <span aria-hidden="true" className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-ink">
              <Icon size={24} stroke={look?.stroke ?? "#DCF37B"} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {result ? (
                <>
                  <span className="text-[26px] font-bold leading-tight">{look!.stamp}</span>
                  <span className="text-[14px]">{subline(result)}</span>
                </>
              ) : (
                <>
                  <span className="text-[26px] font-bold leading-tight">{busy ? "Checking…" : "Ready when you are"}</span>
                  <span className="text-[14px] text-grey">We hash the file and look up its receipt on HSK Chain. Nothing is stored.</span>
                </>
              )}
            </div>
            {known && <span className="hidden shrink-0 rounded-full bg-ink px-3 py-1 text-[12px] font-semibold text-white sm:inline">Licence #{result!.licenceId}</span>}
          </section>

          {error && <ErrorCard>{error}</ErrorCard>}

          {!result && !error && (
            <p className="m-0 text-[14px] text-grey">
              Every render made through Likeness has a receipt on HSK Chain keyed by the file&apos;s sha256, anchored only after its HSP payment was recorded.
              Edited or re-encoded copies come back Unknown.
            </p>
          )}

          {known && (
            <>
              <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-3">
                <div className="flex min-w-0 flex-col gap-2 rounded-[18px] bg-white p-4">
                  <span className="text-[13px] text-grey">Creator</span>
                  <Link href="/creators/ana-reyes" className="flex min-w-0 items-center gap-2.5 font-semibold text-ink no-underline">
                    <CreatorFace seed={result!.creator!} photo={DEMO_CREATOR.photo} size={36} />
                    <span className="truncate">{DEMO_CREATOR.name}</span>
                  </Link>
                  <span className="text-[12px] text-grey">
                    <Addr a={result!.creator!} /> · {DEMO_CREATOR.label.toLowerCase()}
                  </span>
                </div>
                <div className="flex min-w-0 flex-col gap-2 rounded-[18px] bg-white p-4">
                  <span className="text-[13px] text-grey">Licensee</span>
                  <span className="text-[14px] font-semibold">Brand agent</span>
                  <span className="text-[12px] text-grey">
                    <Addr a={result!.licensee!} />
                  </span>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5 rounded-[18px] bg-white p-4">
                  <span className="text-[13px] text-grey">Licence #{result!.licenceId} now</span>
                  <span className="text-[20px] font-bold">{result!.licenceStatus === "Exhausted" ? "Used up" : result!.licenceStatus}</span>
                  <span className="text-[12px] text-grey">{result!.licenceStatus === "Active" ? `Until ${fmtDay(result!.licenceEnd!)}` : `Licence period ${result!.licenceStatus === "Expired" ? "ended" : "ends"} ${fmtDay(result!.licenceEnd!)}`}</span>
                </div>
              </div>

              <section aria-label="Details" className="rounded-[18px] bg-white px-[18px] py-4">
                <dl className="m-0 grid grid-cols-1 gap-x-[18px] gap-y-2.5 text-[13px] sm:grid-cols-3">
                  <div>
                    <dt className="text-grey">Render</dt>
                    <dd className="m-0 mt-0.5 font-semibold">#{result!.renderIndex}</dd>
                  </div>
                  <div>
                    <dt className="text-grey">Paid</dt>
                    <dd className="m-0 mt-0.5 font-semibold">{result!.paid} USDT through HSP</dd>
                  </div>
                  <div>
                    <dt className="text-grey">Receipt anchored</dt>
                    <dd className="m-0 mt-0.5 font-semibold">{fmtDate(result!.anchoredAt!)}</dd>
                  </div>
                </dl>
              </section>

              <ul className="on-dark m-0 grid list-none grid-cols-1 gap-x-5 gap-y-3 rounded-[18px] bg-ink p-[18px] text-[14px] text-white sm:grid-cols-2">
                <Check ok>Receipt on HSK Chain {result!.anchorTx && <Tx hash={result!.anchorTx} label="view tx" />}</Check>
                <Check ok>HSP payment executed {result!.hspTxHash && <Tx hash={result!.hspTxHash} label="view tx" />}</Check>
                <Check ok={!!result!.recordTx}>Recorded by the creator&apos;s agent {result!.recordTx && <Tx hash={result!.recordTx} label="view tx" />}</Check>
                <Check ok={result!.licenceStatus === "Active"}>{result!.licenceStatus === "Active" ? "Licence still in force" : `Licence ${result!.licenceStatus?.toLowerCase()}`}</Check>
              </ul>
              <p className="m-0 text-[13px] text-grey">
                {result!.nonceBound ? "The payment's authorization was bound to this render." : "HSP chose the authorization nonce; the creator's agent attested which render it paid for."}
              </p>
            </>
          )}
          {result?.verdict === "Unknown" && <p className="m-0 text-[13px] text-grey">{result.reason}</p>}
        </div>
      </div>
    </AppPage>
  );
}

function subline(v: Verdict): string {
  switch (v.verdict) {
    case "Licensed":
      return "Made under a licence that is still in force: approved within the creator's terms, paid through HSP and recorded on HSK Chain.";
    case "Revoked":
      return "Licensed when it was made. The creator revoked the licence afterwards, so it should not be used in new placements.";
    case "Expired":
      return "Licensed when it was made. The licence period has ended.";
    default:
      return "No receipt for these exact bytes: edited, re-encoded, or never licensed.";
  }
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ok ? "bg-lime" : "bg-[#3A3D44]"}`}>
        {ok ? <IconCheck size={14} stroke="#121316" /> : <IconCross size={12} stroke="#B9BCC4" />}
      </span>
      <span className="[&_a]:text-lime">
        <span className="sr-only">{ok ? "Passed: " : "Not passed: "}</span>
        {children}
      </span>
    </li>
  );
}
