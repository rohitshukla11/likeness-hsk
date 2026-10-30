"use client";

/** The backend state for every app page, and a way to refresh it (after unlocking, paying, revoking). */
import { createContext, useContext, type ReactNode } from "react";
import type { State } from "@/lib/api";
import { useBackend } from "@/lib/useBackend";
import { AppHeader } from "./AppHeader";

const Ctx = createContext<{ state: State | null; error: string | null; refresh: () => Promise<void> }>({ state: null, error: null, refresh: async () => {} });

export function AppShell({ children }: { children: ReactNode }) {
  const b = useBackend();
  return (
    <Ctx.Provider value={b}>
      <div className="bg-ink text-white">
        <AppHeader state={b.state} onChange={() => void b.refresh()} />
      </div>
      {b.error && <p className="mx-auto max-w-[1320px] px-4 pt-4 text-[14px] text-bad sm:px-8">The agents backend isn&apos;t answering ({b.error}).</p>}
      {children}
    </Ctx.Provider>
  );
}

export const useAppState = () => useContext(Ctx);
