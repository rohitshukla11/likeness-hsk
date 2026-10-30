"use client";

/** Always visible: which chain, and whether HSP is HashKey's QA server or our offline emulator. */
import { gatewayLabel, type State } from "@/lib/api";

export function ModeBanner({ state }: { state: State | null }) {
  if (!state) return null;
  const live = state.gateway === "hsp" || state.gateway === "hsp-agentic-qa";
  return (
    <div className={`border-b border-ink-line ${live ? "bg-[#1F4D3A]" : "bg-[#3A2F12]"}`}>
      <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-[13px] font-medium text-[#F6D9A8] sm:px-8">
        <span>{state.chainId === 133 ? "HSK Chain testnet (133)" : state.chainId === 177 ? "HSK Chain mainnet (177)" : `local chain ${state.chainId}`}</span>
        <span className={live ? "text-lime" : ""}>{gatewayLabel(state.gateway)}</span>
        <span>renders: {state.renderer === "gemini" ? "Gemini" : "marked TEST RENDER"}</span>
        {state.cap && <span>paid today: {state.cap.paidToday} of {state.cap.max}</span>}
        <a href="/console" className="ml-auto text-[#F6D9A8] underline-offset-2 hover:underline">
          Console view
        </a>
      </div>
    </div>
  );
}
