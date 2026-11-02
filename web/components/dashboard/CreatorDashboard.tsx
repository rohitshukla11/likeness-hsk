"use client";

/**
 * The creator's side: every licence of their likeness, with Revoke, and every payment received, recorded
 * only after the brand's authorization executed on chain. A signed-in creator sees and revokes their own
 * (signed by their own wallet); otherwise it shows Ana Reyes, the synthetic creator (revoke: admin only).
 */
import { useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, Card, ErrorCard } from "@/components/ds";
import { useAppState } from "@/components/site/AppState";
import { useAuth } from "@/components/site/Auth";
import { RenderCard } from "@/components/dashboard/RenderCard";
import { Addr, StatusBadge, Tx } from "@/components/ui";
import { api, usd, type BundleView, type Payment, type RenderView } from "@/lib/api";
import { DEMO_CREATOR } from "@/lib/demo";
import { chainLabel } from "@/lib/chain";

export function CreatorDashboard() {
  const { state } = useAppState();
  const { user, me } = useAuth();
  const mine = me?.account?.role === "creator" && me.creator?.registeredTx ? me.creator : null;
  const name = mine ? mine.name : DEMO_CREATOR.name;
  const canRevoke = !!state?.operator || !!mine;
  const [bundles, setBundles] = useState<BundleView[] | null>(null);
  const [renders, setRenders] = useState<RenderView[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; txs: { kind: string; licenceId: string; tx: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([api<BundleView[]>("/api/bundles?who=creator"), api<Payment[]>("/api/payments?who=creator")]);
    setBundles(b);
    // Every render of this creator's face, across brands (the creator's own, or the operator's view of Ana).
    setRenders((await api<{ renders: RenderView[] }>("/api/renders?who=creator").catch(() => ({ renders: [] as RenderView[] }))).renders);
    setPayments(p);
  }, []);
  // The server answers for the signed-in creator once the Google session is restored.
  useEffect(() => {
    if (user !== undefined) void load().catch((e) => setError((e as Error).message));
  }, [load, user, mine?.address]);

  /** Revokes the whole bundle: each of its active licences, one transaction per media type. */
  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const r = await api<{ txs: { kind: string; licenceId: string; tx: string }[] }>("/api/creator/revoke", { bundleId: id });
      setNote({ id, txs: r.txs });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const shown = bundles ? (showEarlier ? bundles : bundles.slice(0, 3)) : [];
  const received = (payments ?? []).reduce((s, p) => s + Number(p.amount), 0);
  return (
    <AppPage title={`${name}'s dashboard`} description={`Who licensed ${mine ? "your" : "her"} likeness, what they paid, and a one-click revoke. Read from ${chainLabel(state?.chainId)}.`}>
      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-3">
        <Card tone="lime">
          <span className="text-[13px]">Received</span>
          <span className="tnum text-[28px] font-bold leading-tight">
            {usd(received)} {state?.token}
          </span>
          <span className="text-[12px]">straight to the payout, through HSP</span>
        </Card>
        <Card>
          <span className="text-[13px] text-grey">Licence bundles</span>
          <span className="tnum text-[28px] font-bold leading-tight">{bundles?.length ?? "…"}</span>
          <span className="text-[12px] text-grey">{bundles?.filter((b) => b.status === "Active").length ?? 0} active</span>
        </Card>
        <Card>
          <span className="text-[13px] text-grey">Payout</span>
          <span className="text-[18px] font-semibold">{mine ? <Addr a={mine.payout ?? mine.address} /> : state ? <Addr a={state.payout} /> : "…"}</span>
          <span className="text-[12px] text-grey">the creator agent records each payment on chain</span>
        </Card>
      </div>

      {error && <ErrorCard>{error}</ErrorCard>}
      {note && (
        <div role="status" className="rounded-[16px] bg-bad-bg px-4 py-3 text-[14px] text-bad">
          {note.txs.length ? (
            <>
              Revoked:{" "}
              {note.txs.map((t, i) => (
                <span key={t.tx}>
                  {i ? ", " : ""}
                  {t.kind}s licence #{t.licenceId}
                  {t.tx.length === 66 && <> <Tx hash={t.tx} /></>}
                </span>
              ))}
              . The next image or video is refused before anything is signed.
            </>
          ) : (
            "Nothing left to revoke: its licences are already used up, expired or revoked."
          )}
        </div>
      )}

      <Card title={mine ? "Licence bundles of your likeness" : "Licence bundles of her likeness"}>
        {!bundles ? (
          <span className="text-[14px] text-grey">Reading the chain…</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {shown.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 rounded-[14px] bg-paper px-3 py-2.5 text-[14px]">
                <StatusBadge status={b.status} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">
                    {b.brand ?? "Brand"}
                    {b.brief ? <span className="font-normal text-grey"> · &ldquo;{b.brief}&rdquo;</span> : null}
                  </span>
                  <span className="text-[13px] text-grey">
                    {b.image ? `Images ${b.image.used}/${b.image.cap} (#${b.image.licenceId})` : "No images"} · {b.video ? `Videos ${b.video.used}/${b.video.cap} (#${b.video.licenceId})` : "No videos"}
                    {(b.image ?? b.video) && ` · until ${new Date((b.image ?? b.video)!.end * 1000).toLocaleDateString()}`}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={![b.image, b.video].some((x) => x?.status === "Active") || !canRevoke || busy !== null}
                  onClick={() => void revoke(b.id)}
                  className={btnClass("danger")}
                >
                  {busy === b.id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
            {bundles.length > 3 && (
              <li>
                <button type="button" onClick={() => setShowEarlier(!showEarlier)} className={btnClass("ghost", "px-0")}>
                  {showEarlier ? "Show fewer" : `Show earlier bundles (${bundles.length - 3})`}
                </button>
              </li>
            )}
          </ul>
        )}
        {!canRevoke && (
          <p className="m-0 text-[13px] text-grey">
            This is Ana Reyes, the synthetic demo creator; only the admin revokes her licences. Creators who sign in with Google revoke their own here.
          </p>
        )}
      </Card>

      {(mine || state?.operator) && (
        <Card title={mine ? "Ads made with your likeness" : "Ads made with her likeness"} action={<span className="text-[13px] text-grey">{renders ? `${renders.length}, every brand` : ""}</span>}>
          <p className="m-0 text-[13px] text-grey">Every image and video made of {mine ? "your" : "her"} face, newest first, with the brand, the exact prompt and its receipt. Renders under a revoked bundle stay listed, marked since revoked.</p>
          {!renders ? (
            <span className="text-[14px] text-grey">Loading…</span>
          ) : renders.length === 0 ? (
            <span className="text-[14px] text-grey">None yet.</span>
          ) : (
            <div className="flex flex-col gap-2">
              {renders.map((r) => (
                <RenderCard key={r.assetHash} r={r} mode="creator" />
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title="Payments received">
        <p className="m-0 text-[13px] text-grey">
          Each one is a stablecoin transfer HSP executed from the brand&apos;s wallet straight to the payout, recorded by the creator agent only after the chain showed the
          brand&apos;s authorization had executed.
        </p>
        {!payments?.length ? (
          <span className="text-[14px] text-grey">{payments ? "None yet." : "Reading the chain…"}</span>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-grey">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Licence · render</th>
                  <th className="py-1.5 pr-3 font-medium">From</th>
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
                      <Addr a={p.payer} />
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
    </AppPage>
  );
}
