"use client";

/**
 * A creator in the marketplace: 4:5 public photo with the verification badge and a save button, name,
 * region and approval style, price per render, uses, three sample thumbnails (locked until a signed-in
 * brand opens them), and View / Request licence.
 */
import Link from "next/link";
import { AiTag, btnClass, Silhouette, silhouetteFor, TagChip } from "@/components/ds";
import { IconBookmark, IconLock } from "@/components/ds/icons";

export type MarketCreator = {
  address: string;
  priceUnits: string; // USDC units, for sorting
  price: string; // "$2.00"
  region: string;
  liveness: "Passive" | "Full";
  uses: string[]; // category labels
  autoApprove: boolean;
  registeredAt: number;
  /** Public photo (512 px, watermarked). Only creators with one are listed. */
  photo: string | null;
  /** The public photo is an AI-generated Likeness sample, not a photo. */
  photoAi: boolean;
  tags: string[];
  /** Approved sample renders (the images themselves need a brand session). */
  samples: number;
};

export type SampleThumbs =
  | { state: "locked"; reason: "signed-out" | "no-brand" | "no-session" }
  | { state: "loading" }
  | { state: "shown"; items: { id: string; scene: string; url: string }[] }
  | { state: "error"; message: string };

export function CreatorCard({
  c,
  saved,
  onSave,
  requestHref,
  thumbs,
}: {
  c: MarketCreator;
  saved: boolean;
  onSave: () => void;
  requestHref: string;
  thumbs: SampleThumbs;
}) {
  const s = silhouetteFor(c.address);
  const name = `${c.address.slice(0, 6)}…${c.address.slice(-4)}`;
  return (
    <article aria-label={`Creator ${name}`} className="flex min-w-0 flex-col gap-3 rounded-[20px] bg-white p-3">
      <div className="relative flex aspect-[4/5] items-end justify-center overflow-hidden rounded-[14px]" style={{ background: s.tint }}>
        {c.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.photo} alt={`${c.photoAi ? "AI-generated public image" : "Public photo"} of creator ${name}`} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
        ) : (
          <Silhouette fill={s.sil} width="80%" />
        )}
        <span className="absolute left-2.5 top-2.5 flex flex-col items-start gap-1.5">
          <span className="rounded-full bg-ink px-2.5 py-1 text-[12px] font-semibold text-lime">Verified · {c.liveness === "Passive" ? "passive" : "full"}</span>
          {c.photo && c.photoAi && <AiTag />}
        </span>
        <button
          type="button"
          aria-label={saved ? `Remove ${name} from saved` : `Save ${name}`}
          aria-pressed={saved}
          onClick={onSave}
          className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-white/90"
        >
          <IconBookmark size={16} filled={saved} />
        </button>
      </div>

      <div className="flex justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-col">
          <h2 className="tnum m-0 truncate text-[17px] font-semibold">{name}</h2>
          <span className="truncate text-[13px] text-grey">
            {c.region} · {c.autoApprove ? "Instant" : "Asks first"}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="tnum text-[17px] font-bold">{c.price}</span>
          <span className="text-[12px] text-grey">per render</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 px-1">
        {c.uses.map((u) => (
          <TagChip key={u}>{u}</TagChip>
        ))}
        {c.tags.map((t) => (
          <span key={t} className="inline-flex items-center rounded-full border border-field px-2.5 py-1 text-[12px] capitalize text-grey">
            {t}
          </span>
        ))}
      </div>

      <SampleRow count={c.samples} thumbs={thumbs} creator={c.address} />

      <div className="mt-auto flex gap-2">
        <Link href={`/market/${c.address}`} className={btnClass("outline")} aria-label={`View ${name}`}>
          View
        </Link>
        <Link href={requestHref} className={btnClass("lime", "flex-1")}>
          Request licence
        </Link>
      </div>
    </article>
  );
}

function SampleRow({ count, thumbs, creator }: { count: number; thumbs: SampleThumbs; creator: string }) {
  if (count === 0) return <p className="m-0 px-1 text-[12px] text-grey">No sample renders yet</p>;
  const tiles = Math.min(3, count);
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <div className="flex items-center gap-1.5">
        {thumbs.state === "shown"
          ? thumbs.items.slice(0, 3).map((t) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={t.id} src={t.url} alt={`Sample render: ${t.scene}`} className="h-11 w-11 rounded-[10px] bg-paper object-cover" loading="lazy" />
            ))
          : Array.from({ length: tiles }, (_, i) => (
              <span key={i} aria-hidden="true" className={`flex h-11 w-11 items-center justify-center rounded-[10px] bg-paper text-grey ${thumbs.state === "loading" ? "animate-pulse motion-reduce:animate-none" : ""}`}>
                {thumbs.state !== "loading" && <IconLock size={15} />}
              </span>
            ))}
        <span className="pl-1 text-[12px] text-grey">
          {count} sample{count === 1 ? "" : "s"}
        </span>
      </div>
      {thumbs.state === "locked" &&
        (thumbs.reason === "no-session" ? (
          <span className="text-[12px] text-grey">Use “Show samples” above to see them</span>
        ) : (
          <Link href={`/brand/onboard?next=${encodeURIComponent(`/market/${creator}`)}`} className="text-[12px] font-semibold text-wait underline">
            {thumbs.reason === "signed-out" ? "Sign in as a brand to see samples" : "Finish your brand profile to see samples"}
          </Link>
        ))}
      {thumbs.state === "error" && <span className="text-[12px] text-bad">{thumbs.message}</span>}
    </div>
  );
}
