"use client";

/**
 * Top right of every page: "Sign in with Google", or the signed-in account (its role, a link to set it
 * up) and Sign out.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { btnClass, pillClass } from "@/components/ds";
import { useAuth } from "./Auth";

export function SignIn({ light = false }: { light?: boolean }) {
  const { user, me, configured, signIn, signOut, refreshMe } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!configured || user === undefined) return null;

  if (!user)
    return (
      <span className="flex items-center gap-2">
        {err && <span role="alert" className={`text-[13px] ${light ? "text-bad" : "text-coral"}`}>{err}</span>}
        <button
          type="button"
          disabled={busy}
          className={light ? pillClass("ink", "px-5 text-[14px]") : btnClass("lime", "min-h-10")}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await signIn();
              // A new account chooses Brand or Creator first.
              const m = await refreshMe();
              if (m?.account && !m.account.role) router.push("/dashboard");
            } catch (e) {
              const code = (e as { code?: string }).code;
              if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Signing in…" : "Sign in with Google"}
        </button>
      </span>
    );

  const role = me?.account?.role;
  const text = light ? "text-ink" : "text-white";
  return (
    <span className="flex items-center gap-3">
      <Link href="/dashboard" className={`flex items-center gap-2 no-underline ${text}`} title={user.email ?? undefined}>
        {user.photoURL ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.photoURL} alt="" width={32} height={32} referrerPolicy="no-referrer" className="h-8 w-8 rounded-full" />
        ) : (
          <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-lime text-[14px] font-bold text-ink">
            {(user.displayName ?? user.email ?? "?").slice(0, 1)}
          </span>
        )}
        <span className="flex flex-col leading-tight">
          <span className="max-w-[10rem] truncate text-[14px] font-semibold">{user.displayName ?? user.email}</span>
          <span className={`text-[12px] ${light ? "text-grey" : "text-grey-dark"}`}>{role === "brand" ? "Brand" : role === "creator" ? (me?.creator?.registeredTx ? "Creator" : "Creator: finish setup") : "Choose brand or creator"}</span>
        </span>
      </Link>
      <button type="button" className={light ? pillClass("outline-dark", "min-h-9 px-4 text-[13px]") : btnClass("ghost", "min-h-9 text-grey-dark hover:text-white")} onClick={() => void signOut()}>
        Sign out
      </button>
    </span>
  );
}
