"use client";

/** Transaction and address links on the chain the backend runs on (its explorer from /api/state), or one given. */
import Link from "next/link";
import { useAppState } from "@/components/site/AppState";

/** HSK Chain testnet's Blockscout explorer: the fallback before the backend's state has loaded. */
export const EXPLORER = "https://testnet-explorer.hskchain.net";

function useExplorer(explorer?: string | null) {
  const { state } = useAppState();
  return explorer ?? state?.explorer ?? EXPLORER;
}

export function Tx({ hash, label, explorer }: { hash: string; label?: string; explorer?: string | null }) {
  const base = useExplorer(explorer);
  return (
    <a className="font-mono text-[13px] text-wait underline-offset-2 hover:underline" href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label ?? `${hash.slice(0, 10)}…${hash.slice(-6)}`}
      <span className="sr-only"> (opens the block explorer)</span>
    </a>
  );
}

export function Addr({ a, href, explorer }: { a: string; href?: string; explorer?: string | null }) {
  const base = useExplorer(explorer);
  const short = `${a.slice(0, 6)}…${a.slice(-4)}`;
  return href ? (
    <Link href={href} className="tnum font-mono underline-offset-2 hover:underline">
      {short}
    </Link>
  ) : (
    <a href={`${base}/address/${a}`} target="_blank" rel="noreferrer" className="tnum font-mono underline-offset-2 hover:underline">
      {short}
      <span className="sr-only"> (opens the block explorer)</span>
    </a>
  );
}
