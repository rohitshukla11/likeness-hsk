"use client";

/**
 * Admin only: demo prep raises today's limits (AI ads per brand account and across the server, paid
 * renders, the brand agent's daily budget) until the next 00:00 UTC (05:30 IST), when they lapse by
 * themselves. Restore ends them early.
 */
import { useCallback, useEffect, useState } from "react";
import { btnClass, Card } from "@/components/ds";
import { useAppState } from "@/components/site/AppState";
import { api, rawToDecimal, type Caps } from "@/lib/api";

type Limits = { brand: Caps; site: Caps; paidRenders: number; dailyBudget: string };
type View = { active: boolean; day: string | null; until: string | null; limits: Limits; raised: Limits; normal: Limits };

const ist = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

function Row({ label, l, token }: { label: string; l: Limits; token: string }) {
  return (
    <>
      <dt className="text-grey">{label}</dt>
      <dd className="m-0">
        {l.brand.image} images + {l.brand.video} videos per brand · {l.site.image}/{l.site.video} across the server · {l.paidRenders} paid renders · budget {rawToDecimal(l.dailyBudget, 6)} {token}
      </dd>
    </>
  );
}

export function DemoPrep() {
  const { state, refresh } = useAppState();
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<View>("/api/admin/demo-prep").then(setView, (e) => setErr((e as Error).message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "raise" | "restore") => {
    setBusy(true);
    setErr(null);
    try {
      setView(await api<View>("/api/admin/demo-prep", { action }));
      void refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return err ? <p className="m-0 text-[14px] text-[#a3261b]">{err}</p> : null;
  const token = state?.token ?? "";
  return (
    <Card title="Demo prep">
      <p className="m-0 text-[14px]">
        {view.active && view.until ? (
          <>
            <b>On for {view.day} (UTC).</b> Back to normal by itself at 00:00 UTC, {ist(view.until)} IST.
          </>
        ) : (
          "Off: today's limits are the normal ones."
        )}
      </p>
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[7rem_1fr]">
        <Row label={view.active ? "Today" : "Raised"} l={view.raised} token={token} />
        <Row label="Normal" l={view.normal} token={token} />
        {state?.ads && (
          <>
            <dt className="text-grey">Used today</dt>
            <dd className="m-0">
              {state.ads.usedToday.image} images, {state.ads.usedToday.video} videos across the server{state.cap ? ` · ${state.cap.paidToday} paid renders` : ""}
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || view.active} onClick={() => void act("raise")} className={btnClass("ink")}>
          Raise limits for today (UTC)
        </button>
        <button type="button" disabled={busy || !view.active} onClick={() => void act("restore")} className={btnClass("outline")}>
          Restore normal limits now
        </button>
      </div>
      {err && <p className="m-0 text-[14px] text-[#a3261b]">{err}</p>}
    </Card>
  );
}
