"use client";

/** Creator dashboard (App-Dashboard.dc.html), on live data: every figure comes from the chain or the app's own records. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { LicenseRegistryAbi } from "@/lib/abi/LicenseRegistry";
import { api, reason, write } from "@/lib/client/tx";
import { categoryLabels, regionLabels } from "@/lib/categories";
import { deployment } from "@/lib/deployment";
import { approvalTypedData, declineMessage, formatDuration, usdc, type Licence, type Terms, type Trust } from "@/lib/licensing";
import { toRequest } from "@/components/market/RequestLicence";
import { TermsEditor } from "@/components/TermsEditor";
import { AppPage, btnClass, Card, Initial, StatCard, StatusPill } from "@/components/ds";
import { useBrandCards } from "@/lib/client/profiles";
import { ProfileEditors, ProfileSummary, useCreatorProfile, type ProfileMode } from "@/components/profile/ProfileCard";
import { IconArrowRight } from "@/components/ds/icons";
import { fmtDay, STATUS_LABEL, Tx } from "@/components/ui";
import type { ActiveWallet } from "@/components/wallet/WalletProvider";
import { releasedMessage } from "@/lib/dashboard-copy";
import { KeyRelease } from "./KeyRelease";
import { LicenceTable } from "./LicenceTable";
import { RequestBar } from "./RequestBar";
import { ReverifyFlow, useServerLevel } from "./Reverify";

type Json<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };
export type CreatorJson = {
  address: Address;
  trust: Trust;
  terms: Json<Terms>;
  active: boolean;
  suspended: boolean;
  referenceSetHash: Hex;
  verifiedAt: number;
  upgradedAt?: number;
  payout: Address;
};
type Row = Json<Licence> & { escrow: { deposited: string; paidToCreator: string; refunded: string; balance: string }; release: { keyHeld: boolean; released: boolean } };
type Brief = { brand: string; campaign: string; use: string };
type PaidRender = { licenceId: string; renderIndex: number; assetHash: Hex; creatorAmount: string; timestamp: number; tx: Hex };
type Detail = { brief: Brief | null; renders: PaidRender[] };
type Req = { id: string; createdAt: number; licensee: Address; state: string; request: Record<string, string | number>; brief: Brief };

const WEEK = 7 * 86_400;
const money = (units: bigint) => `$${usdc.format(units)}`;
const pad = (id: string) => `#${id.padStart(4, "0")}`;

export function CreatorView({ wallet, creator, onChanged, toggle }: { wallet: ActiveWallet; creator: CreatorJson; onChanged: () => void; toggle?: React.ReactNode }) {
  const [licences, setLicences] = useState<Row[]>([]);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [requests, setRequests] = useState<Req[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<React.ReactNode>(null);
  const [editing, setEditing] = useState(false);
  const [reverify, setReverify] = useState(false);
  const { level, canUpgrade } = useServerLevel(creator.trust);

  const load = useCallback(async () => {
    const [l, r] = await Promise.all([
      api<{ licences: Row[] }>(`/api/licences?creator=${wallet.address}`),
      api<{ requests: Req[] }>(`/api/requests?creator=${wallet.address}`),
    ]);
    setLicences(l.licences);
    setRequests(r.requests.filter((x) => x.state === "pending").sort((a, b) => a.createdAt - b.createdAt));
    const d = await Promise.all(l.licences.map((x) => api<Detail>(`/api/licences/${x.id}`).then((j) => [x.id, { brief: j.brief, renders: j.renders }] as const)));
    setDetails(Object.fromEntries(d));
  }, [wallet.address]);
  useEffect(() => {
    load().catch((e) => setMsg(reason(e)));
  }, [load]);

  async function run(label: string, f: () => Promise<{ hash: string; ms: number } | void>) {
    setBusy(true);
    setMsg(label);
    try {
      const r = await f();
      setMsg(r ? <span>Done: <Tx hash={r.hash} ms={r.ms} /></span> : "Done.");
      await load();
      onChanged();
    } catch (e) {
      setMsg(<span className="text-bad">{reason(e)}</span>);
    } finally {
      setBusy(false);
    }
  }

  const terms: Terms = { ...creator.terms, maxDuration: BigInt(creator.terms.maxDuration), pricePerRender: BigInt(creator.terms.pricePerRender) };
  const allRenders = useMemo(() => Object.values(details).flatMap((d) => d.renders).sort((a, b) => b.timestamp - a.timestamp), [details]);
  const earned = licences.reduce((s, l) => s + BigInt(l.escrow.paidToCreator), 0n);
  const now = Math.floor(Date.now() / 1000);
  const earnedWeek = allRenders.filter((r) => r.timestamp >= now - WEEK).reduce((s, r) => s + BigInt(r.creatorAmount), 0n);
  const active = licences.filter((l) => l.status === "Active");
  const verified = creator.trust.level === "verified";
  const passive = creator.trust.level === "verified" && creator.trust.livenessMethod === "passive";
  const oldest = requests[0];
  // A licensee's brand profile (name, logo, badge) wins over the free-text brand in the brief.
  const cards = useBrandCards([...requests.map((r) => r.licensee), ...licences.map((l) => l.licensee)]);
  const brandOf = (id: string, licensee: string) => cards[licensee.toLowerCase()]?.name || details[id]?.brief?.brand || `Brand ${licensee.slice(0, 6)}…`;

  async function approve(r: Req) {
    const req = toRequest(r.request);
    await run("Sign the approval in your wallet…", async () => {
      const signature = await wallet.client.signTypedData({ account: wallet.client.account, ...approvalTypedData(deployment.chainId, deployment.LicenseRegistry!, req, r.licensee) });
      await api(`/api/requests/${r.id}`, { method: "POST", body: JSON.stringify({ approve: true, signature }) });
    });
  }
  async function decline(r: Req) {
    await run("Declining…", async () => {
      const signature = await wallet.client.signMessage({ account: wallet.client.account, message: declineMessage(r.id) });
      await api(`/api/requests/${r.id}`, { method: "POST", body: JSON.stringify({ approve: false, signature }) });
    });
  }

  const [profileMode, setProfileMode] = useState<ProfileMode>(null);
  const profileState = useCreatorProfile(wallet);
  const openProfile = (m: ProfileMode) => {
    setProfileMode(m);
    if (m) requestAnimationFrame(() => document.getElementById("profile-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const unreleased = active.filter((l) => !l.release.released);
  // The release box disappears once the photos are released, so the confirmation goes to the status line.
  const releasedTo = (id: string) => {
    setMsg(releasedMessage(id));
    void load();
  };

  return (
    <AppPage
      title="Dashboard"
      description="Your likeness, your licences and what you've earned."
      actions={
        <>
          {toggle}
          <button type="button" onClick={() => openProfile("samples")} className={btnClass("outline")}>
            Create sample renders
          </button>
          <button type="button" aria-expanded={editing} onClick={() => setEditing(!editing)} className={btnClass("outline")}>
            Edit terms
          </button>
        </>
      }
    >
      {oldest && (
        <RequestBar
          brand={cards[oldest.licensee.toLowerCase()]}
          fallbackName={oldest.brief.brand || `Brand ${oldest.licensee.slice(0, 6)}…`}
          waiting={requests.length}
          busy={busy}
          onApprove={() => approve(oldest)}
          onDecline={() => decline(oldest)}
          terms={
            <>
              {categoryLabels(Number(oldest.request.category)).join()} · {oldest.request.renderCap} renders · {formatDuration(BigInt(oldest.request.duration))} · {money(BigInt(oldest.request.pricePerRender))} per render
              {oldest.brief.campaign ? ` · “${oldest.brief.campaign}”` : ""}
            </>
          }
        />
      )}

      <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Earned, after fee" value={money(earned)} note={`${money(earnedWeek)} this week`} />
        <StatCard label="Renders paid" value={allRenders.length} note="each with a receipt" />
        <StatCard label="Active licences" value={active.length} note={`${requests.length} request${requests.length === 1 ? "" : "s"} waiting`} />
        <button
          type="button"
          onClick={() => canUpgrade && setReverify(true)}
          aria-disabled={!canUpgrade}
          className={`flex min-w-0 flex-col gap-1 rounded-[18px] bg-violet-deep px-[18px] py-4 text-left text-white ${canUpgrade ? "cursor-pointer hover:brightness-110" : "cursor-default"}`}
        >
          <span className="text-[13px] text-violet-soft">Verification</span>
          <span className="text-[20px] font-bold leading-tight">{!verified ? "Not verified" : passive ? "Passive liveness" : "Active liveness"}</span>
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
            {canUpgrade ? (
              <>
                Re-verify at {level} level <IconArrowRight size={14} stroke="#FFFFFF" />
              </>
            ) : (
              `Verified ${fmtDay(creator.verifiedAt)}${creator.upgradedAt ? ` · upgraded ${fmtDay(creator.upgradedAt)}` : ""}`
            )}
          </span>
        </button>
      </div>

      {reverify && (
        <Card title="Re-verify" action={<button type="button" onClick={() => setReverify(false)} className={btnClass("outline")}>Close</button>}>
          <ReverifyFlow
            referenceSetHash={creator.referenceSetHash}
            onDone={() => {
              setReverify(false);
              onChanged();
            }}
          />
        </Card>
      )}
      {editing && (
        <Card id="terms-editor" title="Edit your terms" action={<button type="button" onClick={() => setEditing(false)} className={btnClass("outline")}>Close</button>}>
          <TermsEditor
            initial={terms}
            busy={busy}
            submitLabel="Save terms on chain"
            onSubmit={(t) => run("Saving terms…", () => write(wallet, { address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "setTerms", args: [t] })).then(() => setEditing(false))}
          />
        </Card>
      )}
      <ProfileEditors state={profileState} mode={profileMode} onMode={openProfile} wallet={wallet} referenceSetHash={creator.referenceSetHash as Hex} />
      {msg && (
        <div role="status" className="rounded-[16px] bg-white px-5 py-3 text-[14px]">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-[18px] desk:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-[18px]">
          <Card
            title="Licences"
            action={
              <button
                type="button"
                disabled={busy || active.length === 0}
                onClick={() => {
                  if (confirm("Revoke every licence you have issued? New renders stop at once and brands can take back unused escrow."))
                    void run("Revoking all…", () => write(wallet, { address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "revokeAll", args: [] }));
                }}
                className={btnClass("danger", "min-h-9 px-3 text-[13px]")}
              >
                Revoke all
              </button>
            }
          >
            {unreleased.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] bg-wait-bg px-3.5 py-2.5 text-[13px] text-wait">
                <span>Renders for {pad(l.id)} wait until you release your photos to this licence.</span>
                <KeyRelease licenceId={BigInt(l.id)} referenceSetHash={creator.referenceSetHash} released={l.release.released} onDone={() => releasedTo(l.id)} />
              </div>
            ))}
            {licences.length === 0 ? (
              <p className="m-0 text-[14px] text-grey">No licences yet. When a brand requests one, it appears at the top of this page for you to approve.</p>
            ) : (
              <LicenceTable
                caption="Your licences"
                rows={licences}
                rowKey={(l) => l.id}
                muted={(l) => l.status !== "Active"}
                columns={[
                  {
                    header: "Brand",
                    cell: (l) => {
                      const card = cards[l.licensee.toLowerCase()];
                      return (
                        <span className="flex min-w-0 items-center gap-2.5">
                          {card?.logo ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={card.logo} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-full border border-field bg-white object-contain" />
                          ) : (
                            <Initial name={brandOf(l.id, l.licensee)} size={32} dark={l.status === "Active"} />
                          )}
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-semibold">
                              {brandOf(l.id, l.licensee)} <span className="text-[12px] font-normal text-grey">{pad(l.id)}</span>
                            </span>
                            <BadgeLine badge={card?.badge} />
                          </span>
                        </span>
                      );
                    },
                  },
                  { header: "Status", cell: (l) => <StatusPill kind={pillFor(l.status)}>{STATUS_LABEL[l.status]}</StatusPill> },
                  { header: "Use", cell: (l) => categoryLabels(l.category).join(", ") },
                  { header: "Renders", cell: (l) => `${l.renderCount} of ${l.renderCap}`, className: "tnum whitespace-nowrap" },
                  { header: "Earned", cell: (l) => <span className="font-semibold">{money(BigInt(l.escrow.paidToCreator))}</span>, className: "tnum" },
                  {
                    header: "Ends",
                    cell: (l) => (BigInt(l.escrow.refunded) > 0n && l.status !== "Active" ? `Refunded ${money(BigInt(l.escrow.refunded))}` : shortDay(BigInt(l.end))),
                    className: "whitespace-nowrap",
                  },
                ]}
                actions={(l) =>
                  l.status === "Active" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(`Revoking licence ${pad(l.id)}…`, () => write(wallet, { address: deployment.LicenseRegistry!, abi: LicenseRegistryAbi, functionName: "revoke", args: [BigInt(l.id)] }))}
                      className="min-h-9 rounded-[10px] bg-bad-bg px-3 text-[13px] font-semibold text-bad disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  ) : (
                    <a href="#renders" className="text-[13px] font-semibold text-ink">
                      History
                    </a>
                  )
                }
              />
            )}
          </Card>

          <Card id="renders" title="Recent renders">
            {allRenders.length === 0 ? (
              <p className="m-0 text-[14px] text-grey">No paid renders yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {allRenders.slice(0, 8).map((r) => {
                  const l = licences.find((x) => x.id === r.licenceId);
                  return (
                    <figure key={r.assetHash} className="m-0 flex flex-col gap-1.5">
                      <Link
                        href={`/verify?hash=${r.assetHash}`}
                        className="flex aspect-square flex-col items-center justify-center gap-1 rounded-[12px] bg-[#E3E6EC] p-2 text-center text-[12px] text-grey no-underline"
                      >
                        <span className="font-semibold text-ink">Render {r.renderIndex}</span>
                        <span className="tnum break-all font-mono text-[11px]">
                          {r.assetHash.slice(0, 8)}…{r.assetHash.slice(-4)}
                        </span>
                        <span className="underline">Check this file</span>
                      </Link>
                      <figcaption className="flex items-center justify-between gap-2 text-[12px] text-grey">
                        <span className="truncate">{l ? brandOf(l.id, l.licensee) : "Brand"}</span>
                        <span className="font-semibold text-ok">+{money(BigInt(r.creatorAmount))}</span>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            )}
            <p className="m-0 text-[12px] text-grey">The image files go to the brand that paid for them; each one can be checked by its receipt.</p>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-[18px]">
          <ProfileSummary state={profileState} mode={profileMode} onMode={openProfile} />
          <Card
            id="terms"
            tone="ink"
            title="Your terms"
            action={
              <button type="button" onClick={() => setEditing(!editing)} aria-expanded={editing} className="min-h-9 rounded-[10px] bg-lime px-3.5 text-[13px] font-semibold text-ink">
                {editing ? "Close" : "Edit"}
              </button>
            }
          >
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-2 text-[13px]">
              {[
                ["Uses", categoryLabels(terms.categories).join(", ")],
                ["Regions", regionLabels(terms.regions).join(", ")],
                ["Price", `${money(terms.pricePerRender)} per render`],
                ["Limits", `${terms.maxRenders} renders, ${formatDuration(terms.maxDuration)}`],
                ["Approval", terms.autoApprove ? "Automatic inside these terms" : "Ask me each time"],
                ["Never", "Political, adult, minors, impersonation, deception"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-grey-dark">{k}</dt>
                  <dd className="m-0">{v}</dd>
                </div>
              ))}
            </dl>
            <button
              type="button"
              disabled={busy || creator.suspended}
              onClick={() => run("Updating…", () => write(wallet, { address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "setActive", args: [!creator.active] }))}
              className="min-h-11 rounded-[12px] border border-ink-line-2 bg-transparent text-[14px] font-semibold text-white disabled:opacity-50"
            >
              {creator.suspended ? "Suspended by the platform" : creator.active ? "Pause new licences" : "Accept new licences"}
            </button>
          </Card>
          <Card title="Share your profile">
            <p className="m-0 text-[13px] text-grey">Brands find you in the marketplace. Send them your page so they can request a licence directly.</p>
            <div className="flex flex-wrap gap-2">
              <Link href={`/market/${creator.address}`} className={btnClass("ink")}>
                Open my profile
              </Link>
              <CopyLink path={`/market/${creator.address}`} />
            </div>
          </Card>
        </div>
      </div>
    </AppPage>
  );
}

const pillFor = (s: string) => (s === "Active" ? "licensed" : s === "Revoked" ? "revoked" : "expired") as "licensed" | "revoked" | "expired";
const shortDay = (unix: bigint) => new Date(Number(unix) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function CopyLink({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`${window.location.origin}${path}`);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {}
      }}
      className={btnClass("outline")}
    >
      <span aria-live="polite">{done ? "Copied" : "Copy link"}</span>
    </button>
  );
}

function BadgeLine({ badge }: { badge?: "verified-domain" | "unverified" }) {
  if (!badge) return <span className="text-[12px] text-grey">No brand profile</span>;
  return <span className={`text-[12px] font-semibold ${badge === "verified-domain" ? "text-ok" : "text-wait"}`}>{badge === "verified-domain" ? "Verified domain" : "Unverified brand"}</span>;
}
