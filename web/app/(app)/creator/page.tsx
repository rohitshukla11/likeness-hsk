"use client";

/**
 * The creator's side: every licence of her likeness, with Revoke (an operator action that signs as the
 * creator), and every payment received, recorded only after the brand's authorization executed on chain.
 */
import { useCallback, useEffect, useState } from "react";
import { AppPage, btnClass, Card, ErrorCard } from "@/components/ds";
import { useAppState } from "@/components/site/AppState";
import { Addr, StatusBadge, Tx } from "@/components/ui";
import { api, usd, type Licence, type Payment } from "@/lib/api";
import { DEMO_CREATOR } from "@/lib/demo";

export default function CreatorDashboard() {
  const { state } = useAppState();
  const [licences, setLicences] = useState<Licence[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; tx: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [l, p] = await Promise.all([api<Licence[]>("/api/licences?who=creator"), api<Payment[]>("/api/payments?who=creator")]);
    setLicences(l.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)));
    setPayments(p);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const r = await api<{ tx: string }>("/api/creator/revoke", { licenceId: id });
      setNote({ id, tx: r.tx });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const shown = licences ? (showEarlier ? licences : licences.slice(0, 3)) : [];
  const received = (payments ?? []).reduce((s, p) => s + Number(p.amount), 0);
  return (
    <AppPage title={`${DEMO_CREATOR.name}'s dashboard`} description="Who licensed her likeness, what they paid, and a one-click revoke. Read from HSK Chain.">
      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-3">
        <Card tone="lime">
          <span className="text-[13px]">Received</span>
          <span className="tnum text-[28px] font-bold leading-tight">
            {usd(received)} {state?.token}
          </span>
          <span className="text-[12px]">straight to her payout, through HSP</span>
        </Card>
        <Card>
          <span className="text-[13px] text-grey">Licences</span>
          <span className="tnum text-[28px] font-bold leading-tight">{licences?.length ?? "…"}</span>
          <span className="text-[12px] text-grey">{licences?.filter((l) => l.status === "Active").length ?? 0} active</span>
        </Card>
        <Card>
          <span className="text-[13px] text-grey">Payout</span>
          <span className="text-[18px] font-semibold">{state ? <Addr a={state.payout} /> : "…"}</span>
          <span className="text-[12px] text-grey">her agent records each payment on chain</span>
        </Card>
      </div>

      {error && <ErrorCard>{error}</ErrorCard>}
      {note && (
        <div role="status" className="rounded-[16px] bg-bad-bg px-4 py-3 text-[14px] text-bad">
          Licence #{note.id} revoked{note.tx.length === 66 && <> <Tx hash={note.tx} /></>}. The next payment for it is refused before anything is signed.
        </div>
      )}

      <Card title="Licences of her likeness">
        {!licences ? (
          <span className="text-[14px] text-grey">Reading HSK Chain…</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {shown.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-[14px] bg-paper px-3 py-2.5 text-[14px]">
                <span className="font-semibold">#{l.id}</span>
                <StatusBadge status={l.status} />
                <span className="text-[13px] text-grey">
                  licensee <Addr a={l.licensee} /> · {l.renderCount} / {l.renderCap} renders · until {new Date(l.end * 1000).toLocaleDateString()}
                </span>
                <button type="button" disabled={l.status !== "Active" || !state?.operator || busy !== null} onClick={() => void revoke(l.id)} className={btnClass("danger", "ml-auto")}>
                  {busy === l.id ? "Revoking…" : "Revoke"}
                </button>
              </li>
            ))}
            {licences.length > 3 && (
              <li>
                <button type="button" onClick={() => setShowEarlier(!showEarlier)} className={btnClass("ghost", "px-0")}>
                  {showEarlier ? "Show fewer" : `Show earlier licences (${licences.length - 3})`}
                </button>
              </li>
            )}
          </ul>
        )}
        {state && !state.operator && state.login && <p className="m-0 text-[13px] text-grey">Revoking is an operator action: log in with the demo password (Login, top right).</p>}
      </Card>

      <Card title="Payments received">
        <p className="m-0 text-[13px] text-grey">
          Each one is a stablecoin transfer HSP executed from the brand&apos;s wallet straight to her payout, recorded by her agent only after the chain showed the
          brand&apos;s authorization had executed.
        </p>
        {!payments?.length ? (
          <span className="text-[14px] text-grey">{payments ? "None yet." : "Reading HSK Chain…"}</span>
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
