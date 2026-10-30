"use client";

/**
 * A creator in the list (arc's marketplace card): 4:5 portrait with the badge, name, region and approval
 * style, price per render, uses, and View / Request licence. Terms come from HSK Chain.
 */
import Link from "next/link";
import { btnClass, TagChip } from "@/components/ds";

export type CardCreator = {
  slug: string;
  name: string;
  label: string;
  photo: string;
  region: string;
  price: string; // "0.05 USDT"
  uses: string[];
  autoApprove: boolean;
};

export function CreatorCard({ c }: { c: CardCreator }) {
  return (
    <article aria-label={`Creator ${c.name}`} className="flex min-w-0 flex-col gap-3 rounded-[20px] bg-white p-3">
      <div className="relative flex aspect-[4/5] items-end justify-center overflow-hidden rounded-[14px] bg-[linear-gradient(160deg,#D4F06A_0%,#F2FAD6_100%)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={c.photo} alt={`Portrait of ${c.name}`} className="absolute inset-0 h-full w-full object-cover object-top" />
        <span className="absolute left-2.5 top-2.5 rounded-full bg-ink px-2.5 py-1 text-[12px] font-semibold text-lime">{c.label}</span>
      </div>

      <div className="flex justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-col">
          <h2 className="m-0 truncate text-[17px] font-semibold">{c.name}</h2>
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
      </div>

      <div className="mt-auto flex gap-2">
        <Link href={`/creators/${c.slug}`} className={btnClass("outline")} aria-label={`View ${c.name}`}>
          View
        </Link>
        <Link href={`/creators/${c.slug}#request`} className={btnClass("lime", "flex-1")}>
          Request licence
        </Link>
      </div>
    </article>
  );
}
