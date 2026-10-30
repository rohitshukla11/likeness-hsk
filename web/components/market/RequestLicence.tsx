"use client";

/**
 * A brand requests a licence. Inside the creator's auto-approve terms it is issued on chain at once;
 * otherwise the exact request goes to the creator, who signs an EIP-712 Approval, and the brand then
 * submits it. Either way the contract checks every field again.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { parseEventLogs, type Address, type Hex } from "viem";
import { LicenseRegistryAbi } from "@/lib/abi/LicenseRegistry";
import { api, reason, write } from "@/lib/client/tx";
import { CATEGORIES, REGIONS } from "@/lib/categories";
import { deployment } from "@/lib/deployment";
import { fitsTerms, usdc, type LicenceRequest, type Terms } from "@/lib/licensing";
import { useWallet } from "@/components/wallet/WalletProvider";
import { brandStatus } from "@/lib/client/brand-session";
import { btnClass, Card } from "@/components/ds";
import { Badge, Field, Tx, inputClass } from "@/components/ui";

type TermsJson = Omit<Terms, "maxDuration" | "pricePerRender"> & { maxDuration: string; pricePerRender: string };
type Stored = { id: string; state: string; request: Record<string, string | number>; brief: { campaign: string }; signature?: Hex };

const randomSalt = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;

export function toRequest(r: Record<string, string | number>): LicenceRequest {
  return {
    creator: r.creator as Address,
    category: Number(r.category),
    regions: Number(r.regions),
    duration: BigInt(r.duration),
    renderCap: Number(r.renderCap),
    pricePerRender: BigInt(r.pricePerRender),
    purposeHash: r.purposeHash as Hex,
    deadline: BigInt(r.deadline),
    salt: r.salt as Hex,
  };
}

export function issuedId(receipt: Parameters<typeof parseEventLogs>[0]["logs"]): bigint | null {
  const ev = parseEventLogs({ abi: LicenseRegistryAbi, logs: receipt, eventName: "LicenceIssued" })[0];
  return ev ? ev.args.id : null;
}

export function RequestLicence({ creator, terms: tj }: { creator: Address; terms: TermsJson }) {
  const terms: Terms = { ...tj, maxDuration: BigInt(tj.maxDuration), pricePerRender: BigInt(tj.pricePerRender) };
  const { wallet } = useWallet();
  const allowed = CATEGORIES.filter((c) => terms.categories & c.bit);
  const [category, setCategory] = useState<number>(allowed[0]?.bit ?? 0);
  const [regions, setRegions] = useState<number>(terms.regions & REGIONS.reduce((m, r) => m | r.bit, 0));
  const [days, setDays] = useState(Math.min(7, Number(terms.maxDuration / 86_400n)));
  const [cap, setCap] = useState(Math.min(10, terms.maxRenders));
  const [price, setPrice] = useState(usdc.format(terms.pricePerRender));
  const [brief, setBrief] = useState({ brand: "", campaign: "", use: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<React.ReactNode>(null);
  const [mine, setMine] = useState<Stored[]>([]);

  // The brand name comes from the brand profile; the creator sees it, with logo and badge, when asked to approve.
  useEffect(() => {
    if (!wallet) return;
    brandStatus(wallet.address)
      .then((b) => b.name && setBrief((x) => (x.brand ? x : { ...x, brand: b.name! })))
      .catch(() => {});
  }, [wallet]);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    const j = await api<{ requests: Stored[] }>(`/api/requests?licensee=${wallet.address}&creator=${creator}`);
    setMine(j.requests);
  }, [wallet, creator]);
  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  let parsedPrice = 0n;
  try {
    parsedPrice = usdc.parse(price);
  } catch {}
  const draft = { category, regions, duration: BigInt(days) * 86_400n, renderCap: cap, pricePerRender: parsedPrice };
  const outside = fitsTerms(terms, draft);

  async function issue(r: LicenceRequest, signature: Hex) {
    if (!wallet) return;
    const { hash, ms, receipt } = await write(wallet, { address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "request", args: [r, signature] });
    const id = issuedId(receipt.logs);
    setMsg(
      <span>
        Licence #{id?.toString()} issued: <Tx hash={hash} ms={ms} />. Fund its escrow from your <Link className="font-semibold text-wait underline" href="/dashboard">dashboard</Link>.
      </span>,
    );
  }

  async function submit() {
    if (!wallet) return;
    setBusy(true);
    setMsg(null);
    try {
      if (!outside) {
        const { purposeHash } = await api<{ purposeHash: Hex }>("/api/briefs", { method: "POST", body: JSON.stringify(brief) });
        await issue({ creator, ...draft, purposeHash, deadline: 0n, salt: randomSalt() }, "0x");
      } else {
        await api("/api/requests", {
          method: "POST",
          body: JSON.stringify({
            licensee: wallet.address,
            creator,
            category,
            regions,
            durationDays: days,
            renderCap: cap,
            pricePerRender: parsedPrice.toString(),
            brief,
          }),
        });
        setMsg("Sent to the creator for approval. It appears below once they sign.");
        await refresh();
      }
    } catch (e) {
      setMsg(<span className="text-bad">{reason(e)}</span>);
    } finally {
      setBusy(false);
    }
  }

  const total = parsedPrice * BigInt(Math.max(0, cap || 0));
  return (
    <Card id="request" title="Request a licence">
      <Field label="Use">
        <select className={inputClass} value={category} onChange={(e) => setCategory(Number(e.target.value))}>
          {allowed.map((c) => (
            <option key={c.key} value={c.bit}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Renders">
          <input className={inputClass} type="number" min={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </Field>
        <Field label="Length (days)">
          <input className={inputClass} type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Campaign">
        <input className={inputClass} value={brief.campaign} onChange={(e) => setBrief({ ...brief, campaign: e.target.value })} />
      </Field>
      <Field label="Intended use" hint="Stored off chain; its hash goes on chain with the licence.">
        <input className={inputClass} value={brief.use} onChange={(e) => setBrief({ ...brief, use: e.target.value })} />
      </Field>
      <details className="rounded-[14px] border border-divider px-3.5 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-[14px] font-semibold">
          Regions, price and brand <span aria-hidden="true">▾</span>
        </summary>
        <div className="flex flex-col gap-3 pb-3.5">
          <Field label="Regions" group>
            <div className="flex flex-wrap gap-1.5">
              {REGIONS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRegions(regions ^ r.bit)}
                  aria-pressed={!!(regions & r.bit)}
                  className={`inline-flex min-h-11 items-center rounded-full border px-3 text-[13px] font-semibold ${regions & r.bit ? "border-ink bg-ink text-lime" : "border-field bg-white text-ink hover:border-grey"}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Price per render (USDC)">
            <input className={inputClass} value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Brand">
            <input className={inputClass} value={brief.brand} onChange={(e) => setBrief({ ...brief, brand: e.target.value })} />
          </Field>
        </div>
      </details>
      <div className="flex items-end justify-between gap-3 border-t border-divider pt-3">
        <span className="text-[13px] text-grey">
          Total, {cap || 0} × ${usdc.format(parsedPrice)}
        </span>
        <span className="tnum text-[26px] font-bold leading-none">${usdc.format(total)}</span>
      </div>
      <button type="button" className={btnClass("lime", "w-full")} onClick={submit} disabled={!wallet || busy || !regions || parsedPrice <= 0n}>
        {outside ? "Send to creator for approval" : "Get licence now"}
      </button>
      <span className="text-[12px]">
        {outside ? <Badge tone="warn">Needs the creator&apos;s signature: {outside}</Badge> : <Badge tone="up">Inside the creator&apos;s terms: issued on chain at once</Badge>}
      </span>
      {msg && (
        <div role="status" className="text-[14px] text-grey">
          {msg}
        </div>
      )}
      {mine.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-divider pt-3">
          <h3 className="m-0 text-[15px] font-semibold">Your requests to this creator</h3>
          {mine.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 rounded-[14px] border border-divider px-3.5 py-2.5 text-[13px]">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {r.brief.campaign || "Request"} · {r.request.renderCap} renders · ${usdc.format(BigInt(r.request.pricePerRender))}
                </span>
                <Badge tone={r.state === "approved" ? "up" : r.state === "declined" ? "down" : "warn"}>{r.state}</Badge>
              </span>
              {r.state === "approved" && r.signature && (
                <button
                  type="button"
                  className={btnClass("outline", "self-start")}
                  disabled={busy}
                  onClick={() => issue(toRequest(r.request), r.signature!).catch((e) => setMsg(<span className="text-bad">{reason(e)}</span>))}
                >
                  Issue licence on chain
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
