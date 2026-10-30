"use client";

/**
 * A creator's profile: portrait, the terms her agent enforces (read from HSK Chain), and the licence
 * request. Taking a licence is an operator action: the brand's agent asks the creator's agent over A2A
 * and the licence is issued on chain.
 */
import Link from "next/link";
import { useState } from "react";
import { AppPage, btnClass, Card, ErrorCard, StatusPill, TagChip } from "@/components/ds";
import { useAppState } from "@/components/site/AppState";
import { Field, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { categoriesOf, DEMO_CREATOR } from "@/lib/demo";

export default function CreatorProfile() {
  const { state } = useAppState();
  const [renders, setRenders] = useState(3);
  const [days, setDays] = useState(7);
  const [purpose, setPurpose] = useState("Spring campaign: hero shot for social ads");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ licenceId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = state?.terms;

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await api<{ licenceId: string }>("/api/brand/license", { renderCap: renders, durationSeconds: days * 86400, purpose }));
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppPage title={DEMO_CREATOR.name} description={DEMO_CREATOR.bio}>
      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-[14px]">
          <div className="relative aspect-[4/5] overflow-hidden rounded-[20px] bg-[#E3E6EC]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={DEMO_CREATOR.photo} alt={`Illustrated portrait of ${DEMO_CREATOR.name}, a synthetic demo creator`} className="absolute inset-0 h-full w-full object-cover object-top" />
            <span className="absolute left-3 top-3 rounded-full bg-ink px-3 py-1 text-[12px] font-semibold text-lime">{DEMO_CREATOR.label}</span>
          </div>
          {state && (
            <p className="m-0 text-[13px] text-grey">
              Creator <a className="font-mono" href={`${state.explorer}/address/${state.creator}`} target="_blank" rel="noreferrer">{state.creator.slice(0, 8)}…{state.creator.slice(-6)}</a> · agent card{" "}
              <a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-[14px]">
          <Card tone="ink" title="Her terms, on HSK Chain">
            {t ? (
              <dl className="m-0 grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-[14px]">
                <dt className="text-grey-dark">Price</dt>
                <dd className="m-0 font-semibold">
                  {t.price} {state.token} per render
                </dd>
                <dt className="text-grey-dark">Uses</dt>
                <dd className="m-0 flex flex-wrap gap-1.5">
                  {categoriesOf(t.categories).map((c) => (
                    <TagChip key={c}>{c}</TagChip>
                  ))}
                </dd>
                <dt className="text-grey-dark">Renders</dt>
                <dd className="m-0">up to {t.maxRenders} per licence</dd>
                <dt className="text-grey-dark">Approval</dt>
                <dd className="m-0">{t.autoApprove ? "Instant, within these terms" : "She approves each request"}</dd>
                <dt className="text-grey-dark">Banned</dt>
                <dd className="m-0">political, adult, minors, impersonation, deception: in the contract</dd>
              </dl>
            ) : (
              <span className="text-grey-dark">Reading the chain…</span>
            )}
          </Card>

          <Card id="request" title="Request a licence" action={state && !state.operator ? <StatusPill kind="waiting">Needs the demo password</StatusPill> : undefined}>
            <p className="m-0 text-[14px] text-grey">
              The brand&apos;s agent asks {DEMO_CREATOR.name}&apos;s agent over A2A; it checks the request against her terms, and the licence is issued on chain.
              Each render is then paid separately through HSP.
            </p>
            <form onSubmit={request} className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Renders">
                  <select className={inputClass} value={renders} onChange={(e) => setRenders(Number(e.target.value))}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n} render{n === 1 ? "" : "s"}
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
              <Field label="Purpose (hashed on chain)">
                <input className={inputClass} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={140} />
              </Field>
              <p className="m-0 text-[13px] text-grey">Use: advertising · region: one market · {t ? `${t.price} ${state?.token} per render, paid when each render is made` : ""}</p>
              <button type="submit" disabled={busy || !state?.operator} className={btnClass("lime", "self-start")}>
                {busy ? "Asking her agent…" : "Request licence"}
              </button>
            </form>
            {error && <ErrorCard>{error}</ErrorCard>}
            {done && (
              <div className="flex flex-wrap items-center gap-3 rounded-[16px] bg-ok-bg px-4 py-3 text-[14px] text-ok">
                <span className="flex-1">
                  Licence #{done.licenceId} issued on HSK Chain, within her terms.
                </span>
                <Link href={`/brand?licence=${done.licenceId}`} className={btnClass("ink")}>
                  Pay for the first render
                </Link>
              </div>
            )}
          </Card>
        </div>
      </div>
    </AppPage>
  );
}

