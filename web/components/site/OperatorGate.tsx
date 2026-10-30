"use client";

/**
 * Operator actions (take a licence, pay with the two approvals, revoke) on the public server need the
 * demo password the team gives judges; it buys an HttpOnly session cookie. Everything else is open.
 */
import { useState } from "react";
import { btnClass } from "@/components/ds";
import { inputClass } from "@/components/ui";
import { api, type State } from "@/lib/api";

export function OperatorGate({ state, onChange }: { state: State | null; onChange: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!state?.login) return null;
  if (state.operator)
    return (
      <button
        type="button"
        className={btnClass("ghost", "text-grey-dark hover:text-white")}
        onClick={async () => {
          await api("/api/logout", {});
          onChange();
        }}
      >
        Lock operator actions
      </button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api("/api/login", { password: pw });
          setPw("");
          onChange();
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="demo-pw" className="sr-only">
        Demo password
      </label>
      <input id="demo-pw" type="password" autoComplete="current-password" placeholder="Demo password" value={pw} onChange={(e) => setPw(e.target.value)} className={`${inputClass} w-44 min-h-10`} />
      <button type="submit" disabled={busy || !pw} className={btnClass("lime", "min-h-10")}>
        Unlock
      </button>
      {err && <span role="alert" className="text-[13px] text-coral">{err}</span>}
    </form>
  );
}
