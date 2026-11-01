"use client";

/** The app header: home mark, the destinations, Google sign-in (and the admin session, when on). */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { btnClass } from "@/components/ds";
import { IconPerson } from "@/components/ds/icons";
import { api, type State } from "@/lib/api";
import { SignIn } from "./SignIn";

const NAV = [
  { href: "/creators", label: "Creators" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/verify", label: "Verify" },
  { href: "/how", label: "How it works" },
];

export function AppHeader({ state, onChange }: { state: State | null; onChange: () => void }) {
  const path = usePathname();
  return (
    <header className="on-dark text-white">
      <div className="border-b border-ink-line">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-7 gap-y-3 px-4 py-[18px] sm:px-8">
          <Link href="/" aria-label="Likeness home" className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-raised text-white">
            <IconPerson size={20} />
          </Link>
          <nav aria-label="App" className="order-3 flex w-full flex-wrap gap-x-5 gap-y-1 text-[14px] font-medium sm:order-none sm:w-auto sm:flex-1 sm:gap-x-7 sm:text-[15px]">
            {NAV.map((n) => {
              const on = path === n.href || path.startsWith(`${n.href}/`);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={on ? "page" : undefined}
                  className={`py-3 no-underline ${on ? "border-b-2 border-lime text-lime" : "text-white hover:text-lime"}`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {state?.operator && state.login && (
              <button
                type="button"
                className={btnClass("ghost", "min-h-9 text-[13px] text-lime")}
                title="Admin session (demo password): click to end it"
                onClick={async () => {
                  await api("/api/logout", {});
                  onChange();
                }}
              >
                Admin · end
              </button>
            )}
            <SignIn />
          </div>
        </div>
      </div>
    </header>
  );
}
