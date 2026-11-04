"use client";

/**
 * A new Google account chooses Brand or Creator once. Creators then connect their YouTube channel (read
 * once with YouTube read access; no token kept), add the photo they consent to show, set their terms and
 * register on chain with a custodial testnet wallet this server keeps for them.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { btnClass, Card, ErrorCard, StatusPill } from "@/components/ds";
import { Addr, Field, inputClass, Tx } from "@/components/ui";
import { api, idTokenHeader, type Me, type Role } from "@/lib/api";
import { CATEGORY_LABELS } from "@/lib/demo";
import { youtubeAccessToken } from "@/lib/firebase";
import { chainLabel, tokenOf } from "@/lib/chain";
import { useAppState } from "@/components/site/AppState";

export function ChooseRole({ onDone }: { onDone: () => Promise<unknown> }) {
  const [busy, setBusy] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (role: Role) => {
    setBusy(role);
    setError(null);
    try {
      await api("/api/me/role", { role });
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p className="m-0 text-[14px] text-grey">Choose once for this Google account. To try the other side, sign in with another Google account.</p>
      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2">
        <Card title="I'm a brand">
          <p className="m-0 text-[14px] text-grey">License a creator&apos;s face for an ad. Your brand agent pays each render through HSP, after your two approvals.</p>
          <button type="button" disabled={busy !== null} onClick={() => void choose("brand")} className={btnClass("ink", "self-start")}>
            {busy === "brand" ? "Setting up…" : "Continue as a brand"}
          </button>
        </Card>
        <Card tone="lime" title="I'm a creator">
          <p className="m-0 text-[14px]">Put your own face on Likeness: verify your YouTube channel, set your price and allowed uses, get paid per render, revoke any time.</p>
          <button type="button" disabled={busy !== null} onClick={() => void choose("creator")} className={btnClass("ink", "self-start")}>
            {busy === "creator" ? "Setting up…" : "Become a creator"}
          </button>
        </Card>
      </div>
      {error && <ErrorCard>{error}</ErrorCard>}
    </>
  );
}

const PRICES = ["0.01", "0.02", "0.03", "0.04", "0.05"];

export function CreatorOnboarding({ me, onChange }: { me: Me; onChange: () => Promise<unknown> }) {
  const c = me.creator;
  const { state } = useAppState();
  const chain = chainLabel(state?.chainId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await f();
      await onChange();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!c) return null;
  const registered = !!c.registeredTx;

  return (
    <div className="flex flex-col gap-[14px]">
      {registered && (
        <Card tone="lime" title="You're a creator on Likeness">
          <p className="m-0 text-[14px]">
            Registered on {chain} <Tx hash={c.registeredTx!} label="view tx" />; the creator agent acts for you <Tx hash={c.agentTx ?? c.registeredTx!} label="view tx" />.
            Brands can now license you within your terms.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/creators/${c.address.toLowerCase()}`} className={btnClass("ink")}>
              Your public profile
            </Link>
          </div>
        </Card>
      )}

      <Step n={1} title="Connect your YouTube channel" done={!!c.youtube}>
        {c.youtube ? (
          <div className="flex items-center gap-3">
            {c.youtube.thumbnail && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.youtube.thumbnail} alt="" width={44} height={44} referrerPolicy="no-referrer" className="h-11 w-11 rounded-full" />
            )}
            <span className="flex flex-col">
              <b className="text-[15px]">{c.youtube.title}</b>
              <StatusPill kind="licensed">Verified YouTube creator</StatusPill>
            </span>
          </div>
        ) : (
          <>
            <button type="button" disabled={busy !== null || registered} onClick={() => void run("yt", async () => api("/api/me/creator/youtube", { accessToken: await youtubeAccessToken() }))} className={btnClass("ink", "self-start")}>
              {busy === "yt" ? "Waiting for Google…" : "Connect YouTube"}
            </button>
          </>
        )}
      </Step>

      <Step n={2} title="Your photo" done={!!c.photo && !!c.consentAt}>
        <PhotoStep me={me} disabled={busy !== null || registered} onSaved={onChange} />
      </Step>

      <Step n={3} title={`Your terms, registered on ${chain}`} done={registered}>
        {registered ? (
          <p className="m-0 text-[14px] text-grey">
            Wallet <Addr a={c.address} /> · payout <Addr a={c.payout ?? c.address} />. Your terms are on your public profile.
          </p>
        ) : (
          <TermsForm address={c.address} ready={!!c.youtube && !!c.photo} busy={busy} onSubmit={(t) => run("reg", () => api("/api/me/creator/register", t))} />
        )}
      </Step>
      {error && <ErrorCard>{error}</ErrorCard>}
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <h2 className="m-0 flex items-center gap-3 text-[17px] font-bold">
        <span className={`flex h-8 w-8 items-center justify-center rounded-full text-[14px] ${done ? "bg-lime text-ink" : "bg-ink text-lime"}`}>{done ? "✓" : n}</span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

function PhotoStep({ me, disabled, onSaved }: { me: Me; disabled: boolean; onSaved: () => Promise<unknown> }) {
  const c = me.creator!;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The stored photo is shown to its owner before registration, so it is fetched with the sign-in token.
  useEffect(() => {
    if (!c.photo || file) return;
    let url: string | undefined;
    void (async () => {
      const res = await fetch(c.photo!, { headers: await idTokenHeader() });
      if (res.ok) setPreview((url = URL.createObjectURL(await res.blob())));
    })();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [c.photo, file]);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const b = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
      await api("/api/me/creator/photo", { data: btoa(bin), consent });
      setFile(null);
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr]">
      <div className="relative aspect-[4/5] overflow-hidden rounded-[16px] bg-paper">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Your photo" className="absolute inset-0 h-full w-full object-cover object-top" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-[13px] text-grey">No photo yet</span>
        )}
      </div>
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[14px] text-grey">A clear, front-facing photo of yourself (JPEG, PNG or WebP, up to 3 MB). It&apos;s shown on your profile and card, and the test renders are made from it. Location data in JPEGs is removed.</p>
        <div className="flex flex-wrap items-center gap-3">
          <label className={btnClass("outline", `border-2 border-ink ${disabled ? "pointer-events-none opacity-50" : "cursor-pointer"}`)}>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={disabled}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f) setPreview(URL.createObjectURL(f));
              }}
              className="sr-only"
            />
            {c.photo || file ? "Choose another photo" : "Choose photo"}
          </label>
          <span className="min-w-0 truncate text-[14px] text-grey">{file ? file.name : c.photo ? "Photo saved" : "No file chosen"}</span>
        </div>
        <label className="flex items-start gap-2 text-[14px]">
          <input type="checkbox" checked={consent} disabled={disabled} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>I own this likeness and agree to show it publicly on this demo</span>
        </label>
        <button type="button" disabled={disabled || busy || !file || !consent} onClick={() => void upload()} className={btnClass("ink", "self-start")}>
          {busy ? "Uploading…" : c.photo ? "Replace photo" : "Save photo"}
        </button>
        {error && <ErrorCard>{error}</ErrorCard>}
      </div>
    </div>
  );
}

function TermsForm({ address, ready, busy, onSubmit }: { address: string; ready: boolean; busy: string | null; onSubmit: (t: Record<string, unknown>) => void }) {
  const { state } = useAppState();
  const chain = chainLabel(state?.chainId);
  const [price, setPrice] = useState("0.03");
  const [uses, setUses] = useState<number[]>([1 << 8, 1 << 9]);
  const [maxRenders, setMaxRenders] = useState(5);
  const [payout, setPayout] = useState("");
  const [adult, setAdult] = useState(false);
  const toggle = (bit: number) => setUses((u) => (u.includes(bit) ? u.filter((x) => x !== bit) : [...u, bit]));
  const payoutOk = !payout || /^0x[0-9a-fA-F]{40}$/.test(payout);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ price, categories: uses, maxRenders, adult, ...(payout ? { payout } : {}) });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Price per image ad" hint="A video ad licence (8 s) pays 3× this per video.">
          <select className={inputClass} value={price} onChange={(e) => setPrice(e.target.value)}>
            {PRICES.map((p) => (
              <option key={p} value={p}>
                {p} {tokenOf(state)} (testnet)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Renders per licence, at most">
          <select className={inputClass} value={maxRenders} onChange={(e) => setMaxRenders(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Allowed uses" group hint="Political, adult, minors, impersonation and deception are banned in the contract. The demo brand agent licenses advertising only.">
        <div className="flex flex-wrap gap-3">
          {CATEGORY_LABELS.map((label, i) => (
            <label key={label} className="flex items-center gap-1.5 text-[14px]">
              <input type="checkbox" checked={uses.includes(1 << (8 + i))} onChange={() => toggle(1 << (8 + i))} className="h-4 w-4" />
              {label}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Payout address (optional)" hint={`Leave empty to be paid to your Likeness testnet wallet ${address.slice(0, 6)}…${address.slice(-4)}.`}>
        <input className={`${inputClass} font-mono text-[13px]`} placeholder="0x…" value={payout} onChange={(e) => setPayout(e.target.value.trim())} />
      </Field>
      <label className="flex items-start gap-2 text-[14px]">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-1 h-4 w-4" />
        <span>I am 18 or older</span>
      </label>
      <button type="submit" disabled={!ready || busy !== null || !adult || !uses.length || !payoutOk} className={btnClass("lime", "self-start")}>
        {busy === "reg" ? `Registering on ${chain}… (about a minute)` : `Register on ${chain}`}
      </button>
      {!ready && <p className="m-0 text-[13px] text-grey">Connect YouTube and save your photo first.</p>}
    </form>
  );
}
