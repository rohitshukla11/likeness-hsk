"use client";

/**
 * Operator actions (take a licence, pay with the two approvals, revoke) on the public server need the
 * demo password the team gives judges; it buys an HttpOnly session cookie. Everything else is open.
 * One Login button that opens the password field; Log out once logged in.
 */
import { useState } from "react";
import { btnClass, pillClass } from "@/components/ds";
import { inputClass } from "@/components/ui";
import { api, type State } from "@/lib/api";

export function OperatorGate({ state, onChange, light = false }: { state: State | null; onChange: () => void; light?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!state?.login) return null;
  const pill = light ? pillClass("ink", "px-5 text-[14px]") : btnClass("lime", "min-h-10");
  if (state.operator)
    return (
      <button
        type="button"
        className={light ? pillClass("outline-dark", "px-5 text-[14px]") : btnClass("ghost", "text-grey-dark hover:text-white")}
        onClick={async () => {
          await api("/api/logout", {});
          onChange();
        }}
      >
        Log out
      </button>
    );
  if (!open)
    return (
      <button type="button" className={pill} onClick={() => setOpen(true)}>
        Login
      </button>
    );
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api("/api/login", { password: pw });
          setPw("");
          setOpen(false);
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
      <input id="demo-pw" type="password" autoFocus autoComplete="current-password" placeholder="Demo password" value={pw} onChange={(e) => setPw(e.target.value)} className={`${inputClass} min-h-10 w-36 sm:w-44`} />
      <button type="submit" disabled={busy || !pw} className={pill}>
        {busy ? "Logging in…" : "Login"}
      </button>
      {err && <span role="alert" className={`text-[13px] ${light ? "text-bad" : "text-coral"}`}>{err}</span>}
    </form>
  );
}
